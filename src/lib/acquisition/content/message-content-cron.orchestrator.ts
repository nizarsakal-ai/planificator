import {
  getContentCronConfig,
  type ContentCronConfig,
} from "@/lib/acquisition/content/content-cron-feature-flag"
import {
  logAcquisitionFlagSkip,
  resolveAcquisitionContentCronGate,
} from "@/lib/acquisition/acquisition-flag-matrix"
import { classifyContentFetchError } from "@/lib/acquisition/content/message-content-fetch-error-policy"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import { acquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import {
  emptyContentCronRunStats,
  type ContentCronBudgetReason,
  type ContentCronCompanyResult,
  type ContentCronFetchPort,
  type ContentCronRunResult,
  type ContentCronRunStats,
  type ContentFetchOrchestratorRepository,
} from "@/lib/acquisition/content/message-content-cron.orchestrator.types"
import type { FetchMessageContentResult } from "@/lib/acquisition/content/message-content.types"

const LOG_PREFIX = "[acquisition-content-cron]"
const BUDGET_MARGIN_MS = 5_000

export interface RunContentCronOrchestratorInput {
  repository: ContentFetchOrchestratorRepository
  fetchContent: ContentCronFetchPort
  logger?: (event: string, payload?: Record<string, unknown>) => void
  clock?: () => Date
  createRunId?: () => string
  config?: ContentCronConfig
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function mergeStats(target: ContentCronRunStats, source: ContentCronRunStats): void {
  target.selected += source.selected
  target.fetched += source.fetched
  target.alreadyPresent += source.alreadyPresent
  target.updated += source.updated
  target.retryableFailed += source.retryableFailed
  target.permanentFailed += source.permanentFailed
  target.skipped += source.skipped
  target.duplicateFetchSuspected += source.duplicateFetchSuspected
}

function isTimeBudgetExceeded(startedAt: Date, now: Date, maxDurationMs: number): boolean {
  return now.getTime() - startedAt.getTime() >= maxDurationMs - BUDGET_MARGIN_MS
}

function resolveRunStatus(input: {
  companiesFailed: number
  companiesPartial: number
  budgetReached?: ContentCronBudgetReason
  global: ContentCronRunStats
}): ContentCronRunResult["status"] {
  if (input.budgetReached) return "PARTIAL"
  if (input.companiesFailed > 0 && input.global.fetched + input.global.alreadyPresent === 0) {
    return "FAILED"
  }
  if (input.companiesPartial > 0 || input.companiesFailed > 0) return "PARTIAL"
  if (input.global.retryableFailed > 0 || input.global.permanentFailed > 0) return "PARTIAL"
  return "SUCCESS"
}

/**
 * Orchestrateur cron content — Option A sans claim.
 * Correct sous chevauchement accidentel (upsert/P2002) ; double fetch Gmail mesuré.
 */
export async function runAcquisitionContentCronOrchestrator(
  input: RunContentCronOrchestratorInput
): Promise<ContentCronRunResult> {
  const clock = input.clock ?? (() => new Date())
  const log = input.logger ?? defaultLog
  const createRunId = input.createRunId ?? (() => crypto.randomUUID())
  const config = input.config ?? getContentCronConfig()
  const runId = createRunId()
  const startedAt = clock()
  const globalStats = emptyContentCronRunStats()

  log("CONTENT_RUN_STARTED", {
    runId,
    at: startedAt.toISOString(),
    config,
  })

  const gate = resolveAcquisitionContentCronGate()
  if (!gate.allowed) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const skipReason = gate.skipReason ?? "CRON_DISABLED"
    logAcquisitionFlagSkip(log, {
      scope: "acquisition-content-cron",
      capability: "content_cron",
      outcome: skipReason,
    })
    log("CONTENT_CRON_SKIPPED", { runId, skipReason, durationMs })
    log("CONTENT_RUN_FINISHED", { runId, status: "SKIPPED", skipReason, durationMs })
    return {
      status: "SKIPPED",
      runId,
      skipReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      companiesSelected: 0,
      companiesProcessed: 0,
      companiesSucceeded: 0,
      companiesPartial: 0,
      companiesFailed: 0,
      companiesSkipped: 0,
      ...emptyContentCronRunStats(),
      companies: [],
      config,
    }
  }

  let companyIds: string[]
  let hasMoreCompanies = false
  try {
    const listed = await input.repository.listCompanyIdsWithEligibleContentFetch({
      limit: config.maxCompaniesPerRun + 1,
      now: clock(),
    })
    hasMoreCompanies = listed.length > config.maxCompaniesPerRun
    companyIds = listed.slice(0, config.maxCompaniesPerRun)
  } catch {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    log("CONTENT_RUN_FINISHED", {
      runId,
      status: "FAILED",
      errorCode: "CANDIDATE_LISTING_FAILED",
      durationMs,
    })
    return {
      status: "FAILED",
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      companiesSelected: 0,
      companiesProcessed: 0,
      companiesSucceeded: 0,
      companiesPartial: 0,
      companiesFailed: 0,
      companiesSkipped: 0,
      ...emptyContentCronRunStats(),
      companies: [],
      config,
    }
  }

  const companies: ContentCronCompanyResult[] = []
  let companiesSucceeded = 0
  let companiesPartial = 0
  let companiesFailed = 0
  let companiesSkipped = 0
  let budgetReached: ContentCronBudgetReason | undefined
  let remainingRun = config.maxPerRun
  let backlogHint = 0

  if (hasMoreCompanies) {
    budgetReached = "MAX_COMPANIES_PER_RUN"
  }

  for (const companyId of companyIds) {
    if (remainingRun <= 0) {
      budgetReached = "MAX_MESSAGES_PER_RUN"
      break
    }
    if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
      budgetReached = "MAX_DURATION_MS"
      break
    }

    const companyStarted = clock()
    const stats = emptyContentCronRunStats()
    let companyStatus: ContentCronCompanyResult["status"] = "SUCCESS"
    let skipReason: ContentCronCompanyResult["skipReason"]
    let errorCode: string | undefined

    let candidates
    try {
      candidates = await input.repository.listEligibleCandidatesForCompany({
        companyId,
        limit: Math.min(config.maxPerCompany, remainingRun),
        now: clock(),
      })
    } catch {
      companyStatus = "FAILED"
      errorCode = "CANDIDATE_LISTING_FAILED"
      companiesFailed++
      companies.push({
        companyId,
        status: companyStatus,
        durationMs: clock().getTime() - companyStarted.getTime(),
        stats,
        errorCode,
      })
      continue
    }

    if (candidates.length === 0) {
      companyStatus = "SKIPPED"
      skipReason = "NO_CANDIDATES"
      companiesSkipped++
      companies.push({
        companyId,
        status: companyStatus,
        durationMs: clock().getTime() - companyStarted.getTime(),
        stats,
        skipReason,
      })
      continue
    }

    if (candidates.length >= Math.min(config.maxPerCompany, remainingRun)) {
      backlogHint += 1
    }

    let stopCompany = false
    for (const candidate of candidates) {
      if (remainingRun <= 0) {
        budgetReached = "MAX_MESSAGES_PER_RUN"
        skipReason = "BUDGET_REACHED"
        companyStatus = "PARTIAL"
        stopCompany = true
        break
      }
      if (isTimeBudgetExceeded(startedAt, clock(), config.maxDurationMs)) {
        budgetReached = "MAX_DURATION_MS"
        skipReason = "BUDGET_REACHED"
        companyStatus = "PARTIAL"
        stopCompany = true
        break
      }

      stats.selected++
      remainingRun--

      const fetchStartedAt = clock()
      let result: FetchMessageContentResult
      try {
        result = await input.fetchContent({
          companyId: candidate.companyId,
          acquisitionMessageId: candidate.acquisitionMessageId,
          logActorId: `cron:${runId}`,
        })
      } catch {
        // Throw inattendu du port : isoler le candidat, traiter comme retryable sûr.
        const durationMs = clock().getTime() - fetchStartedAt.getTime()
        log("CONTENT_FETCH_UNEXPECTED_FAILURE", {
          companyId,
          acquisitionMessageId: candidate.acquisitionMessageId,
          draftId: candidate.draftId,
          errorCode: "CONTENT_FETCH_FAILED",
          durationMs,
        })
        result = {
          ok: false,
          outcome: "FAILED",
          code: "CONTENT_FETCH_FAILED",
          message: "CONTENT_FETCH_FAILED",
        }
      }

      if (result.ok) {
        if (result.outcome === "FETCHED") {
          stats.fetched++
          log("CONTENT_FETCH_OK", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: result.outcome,
          })
        } else if (result.outcome === "UPDATED") {
          stats.updated++
          log("CONTENT_FETCH_OK", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: result.outcome,
          })
        } else {
          stats.alreadyPresent++
          stats.duplicateFetchSuspected++
          log("CONTENT_FETCH_ALREADY_PRESENT", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: result.outcome,
          })
        }
        continue
      }

      const category = classifyContentFetchError(result.code)
      const now = clock()

      if (category === "CONFIG_TENANT") {
        stats.skipped++
        companyStatus = "SKIPPED"
        skipReason = "CONFIG_TENANT"
        errorCode = result.code
        stopCompany = true
        log("CONTENT_FETCH_TENANT_CONFIGURATION_FAILURE", {
          companyId,
          acquisitionMessageId: candidate.acquisitionMessageId,
          draftId: candidate.draftId,
          outcome: "CONFIG_TENANT",
          errorCode: result.code,
        })
        break
      }

      if (category === "UI_ONLY" || result.code === "CONTENT_FETCH_DISABLED") {
        stats.skipped++
        companyStatus = "PARTIAL"
        errorCode = result.code
        continue
      }

      if (category === "PERMANENT") {
        try {
          const marked = await input.repository.markPermanentFailure({
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            errorCode: result.code,
            now,
          })
          if (marked.skippedDueToContent) {
            stats.alreadyPresent++
            stats.duplicateFetchSuspected++
            log("CONTENT_FETCH_ALREADY_PRESENT", {
              companyId,
              acquisitionMessageId: candidate.acquisitionMessageId,
              draftId: candidate.draftId,
              outcome: "ALREADY_FETCHED",
            })
            continue
          }
          stats.permanentFailed++
          companyStatus = companyStatus === "SUCCESS" ? "PARTIAL" : companyStatus
          log("CONTENT_FETCH_PERMANENT_FAILURE", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: "PERMANENT",
            errorCode: result.code,
          })
        } catch {
          stats.skipped++
          companyStatus = companyStatus === "SUCCESS" ? "PARTIAL" : companyStatus
          errorCode = "CONTENT_FETCH_STATE_MARK_FAILED"
          log("CONTENT_FETCH_STATE_MARK_FAILED", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: "MARK_FAILED",
            errorCode: result.code,
          })
        }
        continue
      }

      // RETRYABLE
      try {
        const marked = await input.repository.markRetryableFailure({
          companyId,
          acquisitionMessageId: candidate.acquisitionMessageId,
          errorCode: result.code,
          now,
          maxAttempts: config.maxAttempts,
        })
        if (marked.skippedDueToContent) {
          stats.alreadyPresent++
          stats.duplicateFetchSuspected++
          log("CONTENT_FETCH_ALREADY_PRESENT", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: "ALREADY_FETCHED",
          })
          continue
        }
        if (marked.terminal) {
          stats.permanentFailed++
          log("CONTENT_FETCH_PERMANENT_FAILURE", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: "MAX_ATTEMPTS",
            errorCode: result.code,
          })
        } else {
          stats.retryableFailed++
          log("CONTENT_FETCH_RETRYABLE_FAILURE", {
            companyId,
            acquisitionMessageId: candidate.acquisitionMessageId,
            draftId: candidate.draftId,
            outcome: "RETRYABLE",
            errorCode: result.code,
          })
        }
        companyStatus = companyStatus === "SUCCESS" ? "PARTIAL" : companyStatus
      } catch {
        stats.skipped++
        companyStatus = companyStatus === "SUCCESS" ? "PARTIAL" : companyStatus
        errorCode = "CONTENT_FETCH_STATE_MARK_FAILED"
        log("CONTENT_FETCH_STATE_MARK_FAILED", {
          companyId,
          acquisitionMessageId: candidate.acquisitionMessageId,
          draftId: candidate.draftId,
          outcome: "MARK_FAILED",
          errorCode: result.code,
        })
      }
    }

    if (stopCompany && companyStatus === "SUCCESS") {
      companyStatus = "PARTIAL"
    }

    if (companyStatus === "SUCCESS") companiesSucceeded++
    else if (companyStatus === "PARTIAL") companiesPartial++
    else if (companyStatus === "SKIPPED") companiesSkipped++
    else companiesFailed++

    mergeStats(globalStats, stats)
    companies.push({
      companyId,
      status: companyStatus,
      durationMs: clock().getTime() - companyStarted.getTime(),
      stats,
      skipReason,
      errorCode,
    })
  }

  const finishedAt = clock()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const status = resolveRunStatus({
    companiesFailed,
    companiesPartial,
    budgetReached,
    global: globalStats,
  })

  log("CONTENT_RUN_FINISHED", {
    runId,
    status,
    durationMs,
    budgetReached,
    ...globalStats,
    companiesSelected: companyIds.length,
    companiesProcessed: companies.length,
  })

  return {
    status,
    runId,
    budgetReached,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    companiesSelected: companyIds.length,
    companiesProcessed: companies.length,
    companiesSucceeded,
    companiesPartial,
    companiesFailed,
    companiesSkipped,
    ...globalStats,
    backlogRemaining: backlogHint > 0 ? backlogHint : undefined,
    companies,
    config,
  }
}

export async function runAcquisitionContentCronOrchestratorDefault(
  overrides: Partial<RunContentCronOrchestratorInput> = {}
): Promise<ContentCronRunResult> {
  return runAcquisitionContentCronOrchestrator({
    repository: overrides.repository ?? acquisitionContentFetchStateRepository,
    fetchContent:
      overrides.fetchContent ??
      ((input) =>
        fetchAndStoreMessageContentCore({
          companyId: input.companyId,
          acquisitionMessageId: input.acquisitionMessageId,
          logActorId: input.logActorId,
        })),
    logger: overrides.logger,
    clock: overrides.clock,
    createRunId: overrides.createRunId,
    config: overrides.config,
  })
}
