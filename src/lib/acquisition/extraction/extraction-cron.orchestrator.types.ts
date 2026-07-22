/** PLAN-ACQ-OPS-004 — Types orchestrateur cron extraction. */

import type { ExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import type { AcquisitionCronSkipReason } from "@/lib/acquisition/acquisition-flag-matrix"
import type {
  ExtractionCronCandidate,
  ExtractionCronSelectionRepository,
} from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"

export type ExtractionCronRunStatus = "SKIPPED" | "SUCCESS" | "PARTIAL" | "FAILED"

export type ExtractionCronBudgetReason =
  | "MAX_DRAFTS_PER_RUN"
  | "MAX_COMPANIES_PER_RUN"
  | "MAX_DURATION_MS"
  | "PROVIDER_TIMEOUT_BUDGET"

export interface ExtractionCronRunStats {
  selected: number
  extracted: number
  alreadyExtracted: number
  inProgress: number
  stateChanged: number
  staleContent: number
  contentMissing: number
  retryAllowed: number
  maxAttemptsReached: number
  failed: number
  unexpectedFailed: number
  skipped: number
}

export function emptyExtractionCronRunStats(): ExtractionCronRunStats {
  return {
    selected: 0,
    extracted: 0,
    alreadyExtracted: 0,
    inProgress: 0,
    stateChanged: 0,
    staleContent: 0,
    contentMissing: 0,
    retryAllowed: 0,
    maxAttemptsReached: 0,
    failed: 0,
    unexpectedFailed: 0,
    skipped: 0,
  }
}

export interface ExtractionCronCompanyResult {
  companyId: string
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  durationMs: number
  stats: ExtractionCronRunStats
  skipReason?: "NO_CANDIDATES" | "BUDGET_REACHED"
  errorCode?: string
}

export interface ExtractionCronRunResult {
  status: ExtractionCronRunStatus
  runId: string
  skipReason?: AcquisitionCronSkipReason
  budgetReached?: ExtractionCronBudgetReason
  startedAt: string
  finishedAt: string
  durationMs: number
  companiesSelected: number
  companiesProcessed: number
  companiesSucceeded: number
  companiesPartial: number
  companiesFailed: number
  companiesSkipped: number
  selected: number
  extracted: number
  alreadyExtracted: number
  inProgress: number
  stateChanged: number
  staleContent: number
  contentMissing: number
  retryAllowed: number
  maxAttemptsReached: number
  failed: number
  unexpectedFailed: number
  skipped: number
  companies: ExtractionCronCompanyResult[]
  config: ExtractionCronConfig
}

export type ExtractionCronExtractPort = (input: {
  companyId: string
  draftId: string
  now?: () => Date
}) => Promise<ExtractDraftResult>

export type {
  ExtractionCronCandidate,
  ExtractionCronSelectionRepository,
}
