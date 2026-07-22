/**
 * PLAN-ACQ-OPS-004 — Orchestrateur cron extraction.
 * Sélection + budgets + agrégation ; 005B via wrapper système uniquement.
 */

import {
  getExtractionCronConfig,
  type ExtractionCronConfig,
} from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import {
  logAcquisitionFlagSkip,
  resolveAcquisitionExtractionCronGate,
} from "@/lib/acquisition/acquisition-flag-matrix"
import { resolveExtractionProvider } from "@/lib/acquisition/extraction/extraction-provider.factory"
import { runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"
import {
  emptyExtractionCronRunStats,
  type ExtractionCronBudgetReason,
  type ExtractionCronCompanyResult,
  type ExtractionCronExtractPort,
  type ExtractionCronRunResult,
  type ExtractionCronRunStats,
  type ExtractionCronSelectionRepository,
} from "@/lib/acquisition/extraction/extraction-cron.orchestrator.types"

const LOG_PREFIX = "[acquisition-extraction-cron]"

export interface RunExtractionCronOrchestratorInput {
  repository: ExtractionCronSelectionRepository
  extractDraft: ExtractionCronExtractPort
  isProviderConfigured?: () => boolean
  logger?: (event: string, payload?: Record<string, unknown>) => void
  clock?: () => Date
  createRunId?: () => string
  config?: ExtractionCronConfig
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function mergeStats(target: ExtractionCronRunStats, source: ExtractionCronRunStats): void {
  target.selected += source.selected
  target.extracted += source.extracted
  target.alreadyExtracted += source.alreadyExtracted
  target.inProgress += source.inProgress
  target.stateChanged += source.stateChanged
  target.staleContent += source.staleContent
  target.contentMissing += source.contentMissing
  target.retryAllowed += source.retryAllowed
  target.maxAttemptsReached += source.maxAttemptsReached
  target.failed += source.failed
  target.unexpectedFailed += source.unexpectedFailed
  target.skipped += source.skipped
}

/** Mapping exclusif ExtractDraftResult → compteur (aucun double comptage). */
export function mapExtractionOutcomeToStats(
  stats: ExtractionCronRunStats,
  result: ExtractDraftResult,
  log: (event: string, payload?: Record<string, unknown>) => void,
  ctx: { companyId: string; draftId: string; acquisitionMessageId?: string }
): void {
  if (result.ok) {
    if (result.outcome === "EXTRACTED") {
      stats.extracted++
      log("EXTRACTION_DRAFT_EXTRACTED", { ...ctx, outcome: result.outcome })
      return
    }
    stats.alreadyExtracted++
    log("EXTRACTION_DRAFT_ALREADY_EXTRACTED", { ...ctx, outcome: result.outcome })
    return
  }

  switch (result.outcome) {
    case "IN_PROGRESS":
      stats.inProgress++
      log("EXTRACTION_DRAFT_IN_PROGRESS", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    case "STATE_CHANGED":
      stats.stateChanged++
      log("EXTRACTION_DRAFT_STATE_CHANGED", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    case "STALE_CONTENT":
      stats.staleContent++
      log("EXTRACTION_DRAFT_STALE_CONTENT", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    case "CONTENT_MISSING":
      stats.contentMissing++
      log("EXTRACTION_DRAFT_CONTENT_MISSING", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    case "RETRY_ALLOWED":
      stats.retryAllowed++
      log("EXTRACTION_DRAFT_RETRY_ALLOWED", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    case "MAX_ATTEMPTS_REACHED":
      stats.maxAttemptsReached++
      log("EXTRACTION_DRAFT_MAX_ATTEMPTS", { ...ctx, outcome: result.outcome, errorCode: result.code })
      return
    default:
      stats.failed++
      log("EXTRACTION_DRAFT_FAILED", {
        ...ctx,
        outcome: result.outcome,
        errorCode: result.code,
      })
  }
}

function remainingBudgetMs(startedAt: Date, now: Date, maxDurationMs: number): number {
  return maxDurationMs - (now.getTime() - startedAt.getTime())
}

export function canStartExtractionWithinBudget(input: {
  startedAt: Date
  now: Date
  maxDurationMs: number
  providerTimeoutMs: number
  safetyMarginMs: number
}): boolean {
  const remaining = remainingBudgetMs(input.startedAt, input.now, input.maxDurationMs)
  return remaining >= input.providerTimeoutMs + input.safetyMarginMs
}

function hasUsefulProgress(stats: ExtractionCronRunStats): boolean {
  return (
    stats.extracted > 0 ||
    stats.alreadyExtracted > 0 ||
    stats.inProgress > 0 ||
    stats.stateChanged > 0 ||
    stats.staleContent > 0 ||
    stats.contentMissing > 0 ||
    stats.retryAllowed > 0 ||
    stats.maxAttemptsReached > 0 ||
    stats.failed > 0 ||
    stats.unexpectedFailed > 0
  )
}

function resolveRunStatus(input: {
  companiesFailed: number
  companiesPartial: number
  budgetReached?: ExtractionCronBudgetReason
  global: ExtractionCronRunStats
  providerConfigFailed?: boolean
}): ExtractionCronRunResult["status"] {
  if (input.providerConfigFailed) {
    return hasUsefulProgress(input.global) ? "PARTIAL" : "FAILED"
  }
  if (input.budgetReached) return "PARTIAL"
  if (input.companiesFailed > 0 && !hasUsefulProgress(input.global)) {
    return "FAILED"
  }
  if (input.companiesPartial > 0 || input.companiesFailed > 0) return "PARTIAL"
  if (input.global.unexpectedFailed > 0 || input.global.failed > 0) return "PARTIAL"
  if (
    input.global.retryAllowed > 0 ||
    input.global.contentMissing > 0 ||
    input.global.maxAttemptsReached > 0
  ) {
    return "PARTIAL"
  }
  return "SUCCESS"
}

function companyStatusFromStats(
  stats: ExtractionCronRunStats,
  budgetHit: boolean
): ExtractionCronCompanyResult["status"] {
  if (budgetHit) return "PARTIAL"
  if (stats.unexpectedFailed > 0 || stats.failed > 0) return "PARTIAL"
  if (
    stats.retryAllowed > 0 ||
    stats.contentMissing > 0 ||
    stats.maxAttemptsReached > 0 ||
    stats.inProgress > 0 ||
    stats.stateChanged > 0 ||
    stats.staleContent > 0
  ) {
    return "PARTIAL"
  }
  return "SUCCESS"
}

/**
 * Orchestrateur OPS-004 — un appel système max par draft et par run.
 */
export async function runAcquisitionExtractionCronOrchestrator(
  input: RunExtractionCronOrchestratorInput
): Promise<ExtractionCronRunResult> {
  const clock = input.clock ?? (() => new Date())
  const log = input.logger ?? defaultLog
  const createRunId = input.createRunId ?? (() => crypto.randomUUID())
  const config = input.config ?? getExtractionCronConfig()
  const runId = createRunId()
  const startedAt = clock()
  const globalStats = emptyExtractionCronRunStats()
  const processedDraftIds = new Set<string>()

  log("EXTRACTION_RUN_STARTED", {
    runId,
    at: startedAt.toISOString(),
    config: {
      maxPerCompany: config.maxPerCompany,
      maxPerRun: config.maxPerRun,
      maxCompaniesPerRun: config.maxCompaniesPerRun,
      maxDurationMs: config.maxDurationMs,
      safetyMarginMs: config.safetyMarginMs,
      providerTimeoutMs: config.providerTimeoutMs,
      maxAttempts: config.maxAttempts,
    },
  })

  const gate = resolveAcquisitionExtractionCronGate()
  if (!gate.allowed) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const skipReason = gate.skipReason ?? "CRON_DISABLED"
    logAcquisitionFlagSkip(log, {
      scope: "acquisition-extraction-cron",
      capability: "extraction_cron",
      outcome: skipReason,
    })
    log("EXTRACTION_CRON_SKIPPED", { runId, skipReason, durationMs })
    log("EXTRACTION_RUN_FINISHED", { runId, status: "SKIPPED", skipReason, durationMs })
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
      ...emptyExtractionCronRunStats(),
      companies: [],
      config,
    }
  }

  const isProviderConfigured =
    input.isProviderConfigured ?? (() => resolveExtractionProvider() != null)

  if (!isProviderConfigured()) {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    log("EXTRACTION_RUN_FINISHED", {
      runId,
      status: "FAILED",
      errorCode: "PROVIDER_NOT_CONFIGURED",
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
      ...emptyExtractionCronRunStats(),
      companies: [],
      config,
    }
  }

  let companyIds: string[]
  let hasMoreCompanies = false
  try {
    const listed = await input.repository.listCompanyIdsWithEligibleExtraction({
      limit: config.maxCompaniesPerRun + 1,
      now: clock(),
      maxAttempts: config.maxAttempts,
      reclaimTtlMs: config.reclaimTtlMs,
    })
    hasMoreCompanies = listed.length > config.maxCompaniesPerRun
    companyIds = listed.slice(0, config.maxCompaniesPerRun)
  } catch {
    const finishedAt = clock()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    log("EXTRACTION_RUN_FINISHED", {
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
      ...emptyExtractionCronRunStats(),
      companies: [],
      config,
    }
  }

  const companies: ExtractionCronCompanyResult[] = []
  let companiesSucceeded = 0
  let companiesPartial = 0
  let companiesFailed = 0
  let companiesSkipped = 0
  let budgetReached: ExtractionCronBudgetReason | undefined
  let remainingRun = config.maxPerRun

  if (hasMoreCompanies) {
    budgetReached = "MAX_COMPANIES_PER_RUN"
  }

  for (const companyId of companyIds) {
    if (remainingRun <= 0) {
      budgetReached = "MAX_DRAFTS_PER_RUN"
      break
    }
    if (
      !canStartExtractionWithinBudget({
        startedAt,
        now: clock(),
        maxDurationMs: config.maxDurationMs,
        providerTimeoutMs: config.providerTimeoutMs,
        safetyMarginMs: config.safetyMarginMs,
      })
    ) {
      budgetReached = "PROVIDER_TIMEOUT_BUDGET"
      break
    }

    const companyStarted = clock()
    const stats = emptyExtractionCronRunStats()
    let companyStatus: ExtractionCronCompanyResult["status"] = "SUCCESS"
    let skipReason: ExtractionCronCompanyResult["skipReason"]
    let errorCode: string | undefined
    let companyBudgetHit = false

    let candidates
    try {
      candidates = await input.repository.listEligibleCandidatesForCompany({
        companyId,
        limit: Math.min(config.maxPerCompany, remainingRun),
        now: clock(),
        maxAttempts: config.maxAttempts,
        reclaimTtlMs: config.reclaimTtlMs,
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
      companiesSkipped++
      companies.push({
        companyId,
        status: "SKIPPED",
        durationMs: clock().getTime() - companyStarted.getTime(),
        stats,
        skipReason: "NO_CANDIDATES",
      })
      continue
    }

    for (const candidate of candidates) {
      if (remainingRun <= 0) {
        budgetReached = "MAX_DRAFTS_PER_RUN"
        companyBudgetHit = true
        break
      }
      if (processedDraftIds.has(candidate.draftId)) {
        stats.skipped++
        continue
      }
      if (
        !canStartExtractionWithinBudget({
          startedAt,
          now: clock(),
          maxDurationMs: config.maxDurationMs,
          providerTimeoutMs: config.providerTimeoutMs,
          safetyMarginMs: config.safetyMarginMs,
        })
      ) {
        budgetReached = "PROVIDER_TIMEOUT_BUDGET"
        companyBudgetHit = true
        break
      }

      processedDraftIds.add(candidate.draftId)
      stats.selected++
      remainingRun--

      const ctx = {
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        acquisitionMessageId: candidate.acquisitionMessageId,
      }

      try {
        const result = await input.extractDraft({
          companyId: candidate.companyId,
          draftId: candidate.draftId,
          now: clock,
        })
        mapExtractionOutcomeToStats(stats, result, log, ctx)
      } catch {
        stats.unexpectedFailed++
        log("EXTRACTION_UNEXPECTED_FAILURE", ctx)
      }
    }

    companyStatus = companyStatusFromStats(stats, companyBudgetHit)
    if (companyBudgetHit) {
      skipReason = "BUDGET_REACHED"
    }

    if (companyStatus === "SUCCESS") companiesSucceeded++
    else if (companyStatus === "PARTIAL") companiesPartial++
    else if (companyStatus === "FAILED") companiesFailed++

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

  log("EXTRACTION_RUN_FINISHED", {
    runId,
    status,
    durationMs,
    budgetReached,
    selected: globalStats.selected,
    extracted: globalStats.extracted,
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
    companies,
    config,
  }
}

export async function runAcquisitionExtractionCronOrchestratorDefault(input?: {
  config?: ExtractionCronConfig
}): Promise<ExtractionCronRunResult> {
  return runAcquisitionExtractionCronOrchestrator({
    repository: acquisitionExtractionCronSelectionRepository,
    extractDraft: ({ companyId, draftId, now }) =>
      runDraftExtractionSystem({ companyId, draftId, now }),
    config: input?.config,
  })
}
