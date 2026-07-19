import {
  getAttachmentDownloadCronConfig,
  isAttachmentDownloadCronEnabled,
  type AttachmentDownloadCronConfig,
} from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"
import {
  emptyOutcomeStats,
  recordOutcome,
  safeAttachmentDownloadCronInternalErrorCode,
  toPublicAttachmentDownloadCronError,
  type AttachmentDownloadCronBudgetReason,
  type AttachmentDownloadCronCompanyResult,
  type AttachmentDownloadCronCompanyStatus,
  type AttachmentDownloadCronRunResult,
  type AttachmentDownloadCronRunStatus,
  type AttachmentDownloadOrchestratorDownloadPort,
  type AttachmentDownloadOrchestratorRepository,
} from "@/lib/acquisition/attachments/attachment-download-orchestrator.types"

const LOG_PREFIX = "[acquisition-attachment-download-cron]"

export interface RunAttachmentDownloadOrchestratorInput {
  repository: AttachmentDownloadOrchestratorRepository
  downloadAttachment: AttachmentDownloadOrchestratorDownloadPort
  logger?: (event: string, payload?: Record<string, unknown>) => void
  clock?: () => Date
  createRunId?: () => string
  config?: AttachmentDownloadCronConfig
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function companyLogEvent(status: AttachmentDownloadCronCompanyStatus): string {
  switch (status) {
    case "SUCCESS":
      return "DOWNLOAD_COMPANY_SUCCESS"
    case "PARTIAL":
      return "DOWNLOAD_COMPANY_PARTIAL"
    case "FAILED":
      return "DOWNLOAD_COMPANY_FAILED"
    case "SKIPPED":
      return "DOWNLOAD_COMPANY_SKIPPED"
  }
}

function isTimeBudgetExceeded(startedAt: Date, now: Date, maxDurationMs: number): boolean {
  return now.getTime() - startedAt.getTime() >= maxDurationMs
}

/**
 * Orchestrateur cron download PJ — sélection + batch uniquement.
 * Aucun reclaim / retry FAILED (PLAN-ACQ-004D). Aucun I/O Gmail/Cloudinary direct.
 */
export async function runAcquisitionAttachmentDownloadOrchestrator(
  input: RunAttachmentDownloadOrchestratorInput
): Promise<AttachmentDownloadCronRunResult> {
  const clock = input.clock ?? (() => new Date())
  const log = input.logger ?? defaultLog
  const createRunId = input.createRunId ?? (() => crypto.randomUUID())
  const config = input.config ?? getAttachmentDownloadCronConfig()
  const runId = createRunId()
  const startedAt = clock()
  const globalStats = emptyOutcomeStats()

  log("DOWNLOAD_CRON_START", {
    runId,
    at: startedAt.toISOString(),
    config,
  })

  if (!isAttachmentDownloadCronEnabled()) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    log("DOWNLOAD_CRON_FINISHED", {
      runId,
      status: "SKIPPED",
      skipReason: "CRON_DISABLED",
      durationMs,
    })
    return {
      status: "SKIPPED",
      runId,
      skipReason: "CRON_DISABLED",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      companiesTotal: 0,
      companiesSucceeded: 0,
      companiesPartial: 0,
      companiesFailed: 0,
      companiesSkipped: 0,
      globalStats,
      companies: [],
      config,
    }
  }

  let companyIds: string[]
  let hasMoreCompanies = false
  try {
    const listed = await input.repository.listCompanyIdsWithDiscoveredAttachments({
      limit: config.maxCompaniesPerRun + 1,
    })
    hasMoreCompanies = listed.length > config.maxCompaniesPerRun
    companyIds = listed.slice(0, config.maxCompaniesPerRun)
  } catch (error) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const publicError = toPublicAttachmentDownloadCronError("ATTACHMENT_CANDIDATE_LISTING_FAILED")
    log("DOWNLOAD_CRON_FINISHED", {
      runId,
      status: "FAILED",
      durationMs,
      errorCode: publicError.code,
      internalCode: safeAttachmentDownloadCronInternalErrorCode(error),
    })
    return {
      status: "FAILED",
      runId,
      error: publicError,
      errorCode: publicError.code,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      companiesTotal: 0,
      companiesSucceeded: 0,
      companiesPartial: 0,
      companiesFailed: 0,
      companiesSkipped: 0,
      globalStats,
      companies: [],
      config,
    }
  }

  const companies: AttachmentDownloadCronCompanyResult[] = []
  let companiesSucceeded = 0
  let companiesPartial = 0
  let companiesFailed = 0
  let companiesSkipped = 0
  let budgetReached: AttachmentDownloadCronBudgetReason | undefined

  for (const companyId of companyIds) {
    if (globalStats.attempted >= config.maxPerRun) {
      budgetReached = "MAX_ATTACHMENTS_PER_RUN"
      log("DOWNLOAD_BUDGET_REACHED", { runId, reason: budgetReached })
      break
    }
    if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
      budgetReached = "MAX_DURATION_MS"
      log("DOWNLOAD_BUDGET_REACHED", { runId, reason: budgetReached })
      break
    }

    const companyStart = clock()
    log("DOWNLOAD_COMPANY_START", { runId, companyId })

    const companyStats = emptyOutcomeStats()
    let companyStatus: AttachmentDownloadCronCompanyStatus = "SUCCESS"
    let companyPartialReason: AttachmentDownloadCronCompanyResult["partialReason"]
    let companySkipReason: AttachmentDownloadCronCompanyResult["skipReason"]
    let companyError: AttachmentDownloadCronCompanyResult["error"]

    let candidates: Awaited<
      ReturnType<AttachmentDownloadOrchestratorRepository["listDiscoveredAttachmentsForCompany"]>
    >
    try {
      candidates = await input.repository.listDiscoveredAttachmentsForCompany({
        companyId,
        limit: config.maxPerCompany,
      })
    } catch (error) {
      const companyEnd = clock()
      const durationMs = companyEnd.getTime() - companyStart.getTime()
      companiesFailed++
      companyError = toPublicAttachmentDownloadCronError("COMPANY_ATTACHMENT_DOWNLOAD_FAILED")
      log("DOWNLOAD_COMPANY_FAILED", {
        runId,
        companyId,
        durationMs,
        code: companyError.code,
        internalCode: safeAttachmentDownloadCronInternalErrorCode(error),
      })
      companies.push({
        companyId,
        status: "FAILED",
        durationMs,
        stats: companyStats,
        error: companyError,
      })
      continue
    }

    if (candidates.length === 0) {
      const companyEnd = clock()
      const durationMs = companyEnd.getTime() - companyStart.getTime()
      companiesSkipped++
      companySkipReason = "NO_CANDIDATES"
      log("DOWNLOAD_COMPANY_SKIPPED", {
        runId,
        companyId,
        durationMs,
        skipReason: companySkipReason,
      })
      companies.push({
        companyId,
        status: "SKIPPED",
        durationMs,
        stats: companyStats,
        skipReason: companySkipReason,
      })
      continue
    }

    let stoppedByBudget = false
    for (const candidate of candidates) {
      if (globalStats.attempted >= config.maxPerRun) {
        budgetReached = "MAX_ATTACHMENTS_PER_RUN"
        stoppedByBudget = true
        log("DOWNLOAD_BUDGET_REACHED", { runId, reason: budgetReached, companyId })
        break
      }
      if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
        budgetReached = "MAX_DURATION_MS"
        stoppedByBudget = true
        log("DOWNLOAD_BUDGET_REACHED", { runId, reason: budgetReached, companyId })
        break
      }

      try {
        const result = await input.downloadAttachment({
          companyId: candidate.companyId,
          attachmentId: candidate.id,
        })
        recordOutcome(companyStats, result.outcome)
        recordOutcome(globalStats, result.outcome)
      } catch (error) {
        companyStats.attempted += 1
        companyStats.failed += 1
        globalStats.attempted += 1
        globalStats.failed += 1
        log("DOWNLOAD_ATTACHMENT_THREW", {
          runId,
          companyId,
          attachmentId: candidate.id,
          internalCode: safeAttachmentDownloadCronInternalErrorCode(error),
        })
      }
    }

    if (stoppedByBudget) {
      companyStatus = companyStats.attempted === 0 ? "SKIPPED" : "PARTIAL"
      if (companyStatus === "SKIPPED") {
        companySkipReason = "BUDGET_REACHED"
      } else {
        companyPartialReason = budgetReached
      }
    } else if (companyStats.failed > 0) {
      companyStatus = "PARTIAL"
      companyPartialReason = "HAS_FAILURES"
      companyError = toPublicAttachmentDownloadCronError("COMPANY_ATTACHMENT_DOWNLOAD_PARTIAL")
    } else {
      companyStatus = "SUCCESS"
    }

    const companyEnd = clock()
    const durationMs = companyEnd.getTime() - companyStart.getTime()

    if (companyStatus === "SUCCESS") companiesSucceeded++
    else if (companyStatus === "PARTIAL") companiesPartial++
    else companiesSkipped++

    log(companyLogEvent(companyStatus), {
      runId,
      companyId,
      durationMs,
      status: companyStatus,
      stats: companyStats,
      ...(companySkipReason ? { skipReason: companySkipReason } : {}),
      ...(companyPartialReason ? { partialReason: companyPartialReason } : {}),
      ...(companyError ? { code: companyError.code } : {}),
    })

    companies.push({
      companyId,
      status: companyStatus,
      durationMs,
      stats: companyStats,
      error: companyError,
      skipReason: companySkipReason,
      partialReason: companyPartialReason,
    })

    if (stoppedByBudget) break
  }

  if (!budgetReached && hasMoreCompanies) {
    budgetReached = "MAX_COMPANIES_PER_RUN"
    log("DOWNLOAD_BUDGET_REACHED", { runId, reason: budgetReached })
  }

  const finishedAt = clock()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const runStatus = computeRunStatus({
    companiesTotal: companyIds.length,
    companiesSucceeded,
    companiesPartial,
    companiesFailed,
    companiesSkipped,
    budgetReached,
    globalFailed: globalStats.failed,
  })

  log("DOWNLOAD_CRON_FINISHED", {
    runId,
    status: runStatus,
    durationMs,
    companiesTotal: companyIds.length,
    companiesSucceeded,
    companiesPartial,
    companiesFailed,
    companiesSkipped,
    globalStats,
    ...(budgetReached ? { budgetReached } : {}),
  })

  return {
    status: runStatus,
    runId,
    ...(budgetReached ? { budgetReached } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    companiesTotal: companyIds.length,
    companiesSucceeded,
    companiesPartial,
    companiesFailed,
    companiesSkipped,
    globalStats,
    companies,
    config,
  }
}

function computeRunStatus(input: {
  companiesTotal: number
  companiesSucceeded: number
  companiesPartial: number
  companiesFailed: number
  companiesSkipped: number
  budgetReached?: AttachmentDownloadCronBudgetReason
  globalFailed: number
}): AttachmentDownloadCronRunStatus {
  if (input.budgetReached) return "PARTIAL"
  if (input.globalFailed > 0 || input.companiesFailed > 0 || input.companiesPartial > 0) {
    return "PARTIAL"
  }
  if (input.companiesTotal === 0) return "SUCCESS"
  if (input.companiesSkipped === input.companiesTotal) return "SUCCESS"
  return "SUCCESS"
}
