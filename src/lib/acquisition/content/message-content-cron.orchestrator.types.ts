import type { ContentCronConfig } from "@/lib/acquisition/content/content-cron-feature-flag"
import type { AcquisitionCronSkipReason } from "@/lib/acquisition/acquisition-flag-matrix"
import type { FetchMessageContentResult } from "@/lib/acquisition/content/message-content.types"
import type {
  ContentFetchCandidate,
  ContentFetchOrchestratorRepository,
} from "@/lib/acquisition/content/message-content-fetch-state.repository"

export type ContentCronRunStatus = "SKIPPED" | "SUCCESS" | "PARTIAL" | "FAILED"

export type ContentCronBudgetReason =
  | "MAX_MESSAGES_PER_RUN"
  | "MAX_COMPANIES_PER_RUN"
  | "MAX_DURATION_MS"

export interface ContentCronRunStats {
  selected: number
  fetched: number
  alreadyPresent: number
  updated: number
  retryableFailed: number
  permanentFailed: number
  skipped: number
  duplicateFetchSuspected: number
}

export function emptyContentCronRunStats(): ContentCronRunStats {
  return {
    selected: 0,
    fetched: 0,
    alreadyPresent: 0,
    updated: 0,
    retryableFailed: 0,
    permanentFailed: 0,
    skipped: 0,
    duplicateFetchSuspected: 0,
  }
}

export interface ContentCronCompanyResult {
  companyId: string
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  durationMs: number
  stats: ContentCronRunStats
  skipReason?: "NO_CANDIDATES" | "BUDGET_REACHED" | "CONFIG_TENANT"
  errorCode?: string
}

export interface ContentCronRunResult {
  status: ContentCronRunStatus
  runId: string
  skipReason?: AcquisitionCronSkipReason
  budgetReached?: ContentCronBudgetReason
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
  fetched: number
  alreadyPresent: number
  updated: number
  retryableFailed: number
  permanentFailed: number
  skipped: number
  duplicateFetchSuspected: number
  backlogRemaining?: number
  companies: ContentCronCompanyResult[]
  config: ContentCronConfig
}

export type ContentCronFetchPort = (input: {
  companyId: string
  acquisitionMessageId: string
  logActorId?: string
}) => Promise<FetchMessageContentResult>

export type {
  ContentFetchCandidate,
  ContentFetchOrchestratorRepository,
  MarkFailureResult,
} from "@/lib/acquisition/content/message-content-fetch-state.repository"
