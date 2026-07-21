import {
  getAttachmentRecoveryCronConfig,
  type AttachmentRecoveryCronConfig,
} from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import {
  logAcquisitionFlagSkip,
  resolveAcquisitionAttachmentRecoveryCronGate,
} from "@/lib/acquisition/acquisition-flag-matrix"
import { RETRYABLE_ATTACHMENT_ERROR_CODES } from "@/lib/acquisition/attachments/attachment-retry.policy"
import {
  emptyPhaseStats,
  safeAttachmentRecoveryCronInternalErrorCode,
  toPublicAttachmentRecoveryCronError,
  type AttachmentRecoveryCronBudgetReason,
  type AttachmentRecoveryCronCompanyResult,
  type AttachmentRecoveryCronCompanyStatus,
  type AttachmentRecoveryCronRunResult,
  type AttachmentRecoveryCronRunStatus,
  type AttachmentRecoveryOrchestratorRepository,
  type AttachmentRecoveryPhaseStats,
} from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"

const LOG_PREFIX = "[acquisition-attachment-recovery]"

export interface RunAttachmentRecoveryOrchestratorInput {
  repository: AttachmentRecoveryOrchestratorRepository
  logger?: (event: string, payload?: Record<string, unknown>) => void
  clock?: () => Date
  createRunId?: () => string
  config?: AttachmentRecoveryCronConfig
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function isTimeBudgetExceeded(startedAt: Date, now: Date, maxDurationMs: number): boolean {
  return now.getTime() - startedAt.getTime() >= maxDurationMs
}

function aggregateStatus(
  reclaim: AttachmentRecoveryPhaseStats,
  retry: AttachmentRecoveryPhaseStats,
  budgetReason: AttachmentRecoveryCronBudgetReason | undefined,
  hadCompanyFailure: boolean
): AttachmentRecoveryCronRunStatus {
  if (hadCompanyFailure && reclaim.transitioned === 0 && retry.transitioned === 0) {
    return "FAILED"
  }
  if (budgetReason || hadCompanyFailure || reclaim.companiesPartial > 0 || retry.companiesPartial > 0) {
    return "PARTIAL"
  }
  return "SUCCESS"
}

/**
 * Moteur Recovery & Retry — transitions d'état uniquement (PLAN-ACQ-004D).
 * Aucun Gmail / Cloudinary / downloadAcquisitionAttachment.
 */
export async function runAcquisitionAttachmentRecoveryOrchestrator(
  input: RunAttachmentRecoveryOrchestratorInput
): Promise<AttachmentRecoveryCronRunResult> {
  const clock = input.clock ?? (() => new Date())
  const log = input.logger ?? defaultLog
  const createRunId = input.createRunId ?? (() => crypto.randomUUID())
  const config = input.config ?? getAttachmentRecoveryCronConfig()
  const runId = createRunId()
  const startedAt = clock()
  const reclaim = emptyPhaseStats()
  const retry = emptyPhaseStats()
  const companies: AttachmentRecoveryCronCompanyResult[] = []
  let budgetReason: AttachmentRecoveryCronBudgetReason | undefined
  let hadCompanyFailure = false
  let globalTransitioned = 0

  const publicConfig = {
    reclaimTtlMs: config.reclaimTtlMs,
    maxRetries: config.maxRetries,
    maxPerCompany: config.maxPerCompany,
    maxPerRun: config.maxPerRun,
    maxCompaniesPerRun: config.maxCompaniesPerRun,
    maxDurationMs: config.maxDurationMs,
  }

  log("RECOVERY_CRON_START", {
    runId,
    at: startedAt.toISOString(),
    config: publicConfig,
  })

  const gate = resolveAcquisitionAttachmentRecoveryCronGate()
  if (!gate.allowed) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const skipReason = gate.skipReason ?? "CRON_DISABLED"
    logAcquisitionFlagSkip(log, {
      scope: "acquisition-attachment-recovery",
      capability: "attachment_recovery_cron",
      outcome: skipReason,
    })
    log("RECOVERY_CRON_FINISHED", {
      runId,
      status: "SKIPPED",
      skipReason,
      durationMs,
    })
    return {
      status: "SKIPPED",
      runId,
      skipReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      reclaim,
      retry,
      companies: [],
      config: publicConfig,
    }
  }

  const olderThan = new Date(startedAt.getTime() - config.reclaimTtlMs)
  const retryableErrorCodes = [...RETRYABLE_ATTACHMENT_ERROR_CODES]

  // ── Phase RECLAIM ──────────────────────────────────────────────────────────
  let reclaimCompanyIds: string[] = []
  let reclaimHasMoreCompanies = false
  try {
    const listed = await input.repository.listCompanyIdsWithReclaimCandidates({
      olderThan,
      limit: config.maxCompaniesPerRun + 1,
    })
    reclaimHasMoreCompanies = listed.length > config.maxCompaniesPerRun
    reclaimCompanyIds = listed.slice(0, config.maxCompaniesPerRun)
  } catch (error) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const publicError = toPublicAttachmentRecoveryCronError("ATTACHMENT_RECOVERY_LISTING_FAILED")
    log("RECOVERY_CRON_FINISHED", {
      runId,
      status: "FAILED",
      durationMs,
      errorCode: publicError.code,
      internalCode: safeAttachmentRecoveryCronInternalErrorCode(error),
    })
    return {
      status: "FAILED",
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      reclaim,
      retry,
      companies: [],
      config: publicConfig,
    }
  }

  if (reclaimHasMoreCompanies) {
    budgetReason = "MAX_COMPANIES_PER_RUN"
    log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RECLAIM" })
  }

  for (const companyId of reclaimCompanyIds) {
    if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
      budgetReason = "MAX_DURATION_MS"
      log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RECLAIM" })
      break
    }
    if (globalTransitioned >= config.maxPerRun) {
      budgetReason = "MAX_PER_RUN"
      log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RECLAIM" })
      break
    }

    log("RECLAIM_COMPANY_START", { runId, companyId })
    reclaim.companiesProcessed++

    let companyStatus: AttachmentRecoveryCronCompanyStatus = "SUCCESS"
    let attempted = 0
    let transitioned = 0
    let noop = 0
    let errorCode: string | undefined

    try {
      const remainingRun = config.maxPerRun - globalTransitioned
      const companyLimit = Math.min(config.maxPerCompany, remainingRun)
      const candidates = await input.repository.listPendingDownloadsForReclaim({
        companyId,
        olderThan,
        limit: companyLimit,
      })

      if (candidates.length === 0) {
        companyStatus = "SKIPPED"
        reclaim.companiesSkipped++
      } else {
        for (const candidate of candidates) {
          if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
            budgetReason = "MAX_DURATION_MS"
            companyStatus = "PARTIAL"
            log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RECLAIM" })
            break
          }
          attempted++
          const result = await input.repository.reclaimPendingDownload({
            companyId,
            attachmentId: candidate.id,
            olderThan,
          })
          if (result === "RECLAIMED") {
            transitioned++
            globalTransitioned++
            log("RECLAIM_COMPLETED", {
              runId,
              companyId,
              attachmentId: candidate.id,
            })
          } else {
            noop++
          }
        }
        if (companyStatus !== "PARTIAL") {
          companyStatus = "SUCCESS"
        }
        if (companyStatus === "SUCCESS") reclaim.companiesSucceeded++
        else reclaim.companiesPartial++
      }
    } catch (error) {
      hadCompanyFailure = true
      companyStatus = "FAILED"
      reclaim.companiesFailed++
      errorCode = toPublicAttachmentRecoveryCronError("COMPANY_ATTACHMENT_RECOVERY_FAILED").code
      void safeAttachmentRecoveryCronInternalErrorCode(error)
    }

    reclaim.attempted += attempted
    reclaim.transitioned += transitioned
    reclaim.noop += noop
    companies.push({
      companyId,
      phase: "RECLAIM",
      status: companyStatus,
      attempted,
      transitioned,
      noop,
      errorCode,
    })
  }

  // ── Phase RETRY ────────────────────────────────────────────────────────────
  let retryCompanyIds: string[] = []
  let retryHasMoreCompanies = false

  const canStartRetry =
    !isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs) &&
    globalTransitioned < config.maxPerRun

  if (canStartRetry) {
    try {
      const listed = await input.repository.listCompanyIdsWithRetryCandidates({
        now: clock(),
        maxRetries: config.maxRetries,
        limit: config.maxCompaniesPerRun + 1,
      })
      retryHasMoreCompanies = listed.length > config.maxCompaniesPerRun
      retryCompanyIds = listed.slice(0, config.maxCompaniesPerRun)
    } catch (error) {
      hadCompanyFailure = true
      void safeAttachmentRecoveryCronInternalErrorCode(error)
      log("RECOVERY_BUDGET_REACHED", {
        runId,
        reason: "LISTING_RETRY_FAILED",
        internalCode: safeAttachmentRecoveryCronInternalErrorCode(error),
      })
    }

    if (retryHasMoreCompanies && !budgetReason) {
      budgetReason = "MAX_COMPANIES_PER_RUN"
      log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RETRY" })
    }

    for (const companyId of retryCompanyIds) {
      if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
        budgetReason = "MAX_DURATION_MS"
        log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RETRY" })
        break
      }
      if (globalTransitioned >= config.maxPerRun) {
        budgetReason = "MAX_PER_RUN"
        log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RETRY" })
        break
      }

      log("RETRY_COMPANY_START", { runId, companyId })
      retry.companiesProcessed++

      let companyStatus: AttachmentRecoveryCronCompanyStatus = "SUCCESS"
      let attempted = 0
      let transitioned = 0
      let noop = 0
      let errorCode: string | undefined
      const now = clock()

      try {
        const remainingRun = config.maxPerRun - globalTransitioned
        const companyLimit = Math.min(config.maxPerCompany, remainingRun)
        const candidates = await input.repository.listFailedAttachmentsForRetry({
          companyId,
          now,
          limit: companyLimit,
          maxRetries: config.maxRetries,
          retryableErrorCodes,
        })

        if (candidates.length === 0) {
          companyStatus = "SKIPPED"
          retry.companiesSkipped++
        } else {
          for (const candidate of candidates) {
            if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
              budgetReason = "MAX_DURATION_MS"
              companyStatus = "PARTIAL"
              log("RECOVERY_BUDGET_REACHED", { runId, reason: budgetReason, phase: "RETRY" })
              break
            }
            attempted++
            const result = await input.repository.scheduleRetryToDiscovered({
              companyId,
              attachmentId: candidate.id,
              now,
              maxRetries: config.maxRetries,
              retryableErrorCodes,
            })
            if (result === "TRANSITIONED") {
              transitioned++
              globalTransitioned++
              log("RETRY_TRANSITIONED", {
                runId,
                companyId,
                attachmentId: candidate.id,
              })
            } else {
              noop++
            }
          }
          if (companyStatus !== "PARTIAL") companyStatus = "SUCCESS"
          if (companyStatus === "SUCCESS") retry.companiesSucceeded++
          else retry.companiesPartial++
        }
      } catch (error) {
        hadCompanyFailure = true
        companyStatus = "FAILED"
        retry.companiesFailed++
        errorCode = toPublicAttachmentRecoveryCronError("COMPANY_ATTACHMENT_RECOVERY_FAILED").code
        void safeAttachmentRecoveryCronInternalErrorCode(error)
      }

      retry.attempted += attempted
      retry.transitioned += transitioned
      retry.noop += noop
      companies.push({
        companyId,
        phase: "RETRY",
        status: companyStatus,
        attempted,
        transitioned,
        noop,
        errorCode,
      })
    }
  }

  const finishedAt = clock()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const status = aggregateStatus(reclaim, retry, budgetReason, hadCompanyFailure)

  log("RECOVERY_CRON_FINISHED", {
    runId,
    status,
    durationMs,
    reclaimTransitioned: reclaim.transitioned,
    retryTransitioned: retry.transitioned,
    budgetReason,
  })

  return {
    status,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    budgetReason,
    reclaim,
    retry,
    companies,
    config: publicConfig,
  }
}
