import type { MailSyncResult, MailSyncStats } from "@/lib/acquisition/connector/connector.types"
import type { AcquisitionGmailConnectionRef } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import {
  logAcquisitionFlagSkip,
  resolveAcquisitionGmailCronGate,
  type AcquisitionCronSkipReason,
} from "@/lib/acquisition/acquisition-flag-matrix"
import {
  mapCompanySyncStatusToPublicError,
  safeInternalErrorCode,
  toPublicCronError,
  type PublicCronError,
} from "@/lib/acquisition/connector/acquisition-gmail-cron.errors"

const LOG_PREFIX = "[acquisition-gmail-cron]"

export type AcquisitionGmailCronRunStatus = "SKIPPED" | "SUCCESS" | "PARTIAL" | "FAILED"

export interface AcquisitionGmailCronCompanyResult {
  companyId: string
  connectionId: string
  gmailAddress: string
  status: MailSyncResult["status"]
  durationMs: number
  stats: MailSyncStats
  error?: PublicCronError
  skipReason?: MailSyncResult["skipReason"]
  partialReason?: MailSyncResult["partialReason"]
}

export interface AcquisitionGmailCronRunResult {
  status: AcquisitionGmailCronRunStatus
  skipReason?: AcquisitionCronSkipReason
  error?: PublicCronError
  errorCode?: string
  startedAt: string
  finishedAt: string
  durationMs: number
  companiesTotal: number
  companiesSucceeded: number
  companiesFailed: number
  companiesPartial: number
  companiesSkipped: number
  globalStats: MailSyncStats
  companies: AcquisitionGmailCronCompanyResult[]
}

export interface RunAcquisitionGmailSyncDriverInput {
  listConnections: () => Promise<AcquisitionGmailConnectionRef[]>
  runSyncForConnection: (connection: AcquisitionGmailConnectionRef) => Promise<MailSyncResult>
  now?: () => Date
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function emptyStats(): MailSyncStats {
  return { fetched: 0, ingested: 0, skippedDuplicate: 0, rejected: 0, failed: 0 }
}

function mergeStats(target: MailSyncStats, source: MailSyncStats): void {
  target.fetched += source.fetched
  target.ingested += source.ingested
  target.skippedDuplicate += source.skippedDuplicate
  target.rejected += source.rejected
  target.failed += source.failed
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.log(`${LOG_PREFIX} ${event}`, payload)
  } else {
    console.log(`${LOG_PREFIX} ${event}`)
  }
}

function companyLogEvent(status: MailSyncResult["status"]): string {
  switch (status) {
    case "SUCCESS":
      return "SYNC_COMPANY_SUCCESS"
    case "PARTIAL":
      return "SYNC_COMPANY_PARTIAL"
    case "FAILED":
      return "SYNC_COMPANY_FAILED"
    case "SKIPPED":
      return "SYNC_COMPANY_SKIPPED"
  }
}

function computeGlobalStatus(
  companiesTotal: number,
  companiesSucceeded: number,
  companiesFailed: number,
  companiesPartial: number,
  companiesSkipped: number
): AcquisitionGmailCronRunStatus {
  if (companiesTotal === 0) return "SUCCESS"
  if (companiesFailed > 0 || companiesPartial > 0) return "PARTIAL"
  if (companiesSkipped === companiesTotal) return "SKIPPED"
  return "SUCCESS"
}

function buildListingFailedResult(
  startedAt: Date,
  finishedAt: Date,
  globalStats: MailSyncStats,
  log: (event: string, payload?: Record<string, unknown>) => void,
  internalCode: string
): AcquisitionGmailCronRunResult {
  const publicError = toPublicCronError("GMAIL_CONNECTION_LISTING_FAILED")
  log("SYNC_LISTING_FAILED", { code: publicError.code, internalCode })
  log("SYNC_FINISHED", {
    status: "FAILED",
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    companiesTotal: 0,
    errorCode: publicError.code,
  })
  return {
    status: "FAILED",
    error: publicError,
    errorCode: publicError.code,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    companiesTotal: 0,
    companiesSucceeded: 0,
    companiesFailed: 0,
    companiesPartial: 0,
    companiesSkipped: 0,
    globalStats,
    companies: [],
  }
}

/**
 * Driver cron Acquisition Gmail — listing multi-connexion, boucle, journalisation.
 * Aucune logique métier. Sync par connexion Gmail, pas uniquement par companyId.
 */
export async function runAcquisitionGmailSyncDriver(
  input: RunAcquisitionGmailSyncDriverInput
): Promise<AcquisitionGmailCronRunResult> {
  const now = input.now ?? (() => new Date())
  const log = input.log ?? defaultLog
  const startedAt = now()
  const globalStats = emptyStats()

  log("SYNC_START", { at: startedAt.toISOString() })

  const gate = resolveAcquisitionGmailCronGate()
  if (!gate.allowed) {
    const finishedAt = now()
    const skipReason = gate.skipReason ?? "CRON_DISABLED"
    logAcquisitionFlagSkip(log, {
      scope: "acquisition-gmail-cron",
      capability: "gmail_sync",
      outcome: skipReason,
    })
    log("SYNC_FINISHED", {
      status: "SKIPPED",
      skipReason,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    })
    return {
      status: "SKIPPED",
      skipReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      companiesTotal: 0,
      companiesSucceeded: 0,
      companiesFailed: 0,
      companiesPartial: 0,
      companiesSkipped: 0,
      globalStats,
      companies: [],
    }
  }

  let connections: AcquisitionGmailConnectionRef[]
  try {
    connections = await input.listConnections()
  } catch (error) {
    const finishedAt = now()
    return buildListingFailedResult(
      startedAt,
      finishedAt,
      globalStats,
      log,
      safeInternalErrorCode(error)
    )
  }

  const companies: AcquisitionGmailCronCompanyResult[] = []
  let companiesSucceeded = 0
  let companiesFailed = 0
  let companiesPartial = 0
  let companiesSkipped = 0

  for (const connection of connections) {
    const companyStart = now()
    const { companyId, connectionId, gmailAddress } = connection
    log("SYNC_COMPANY_START", { companyId, connectionId, gmailAddress })

    let result: MailSyncResult
    try {
      result = await input.runSyncForConnection(connection)
    } catch (error) {
      const companyEnd = now()
      const durationMs = companyEnd.getTime() - companyStart.getTime()
      companiesFailed++
      const publicError = toPublicCronError("COMPANY_SYNC_FAILED")
      log("SYNC_COMPANY_FAILED", {
        companyId,
        connectionId,
        gmailAddress,
        durationMs,
        code: publicError.code,
        internalCode: safeInternalErrorCode(error),
      })
      companies.push({
        companyId,
        connectionId,
        gmailAddress,
        status: "FAILED",
        durationMs,
        stats: emptyStats(),
        error: publicError,
      })
      continue
    }

    const companyEnd = now()
    const durationMs = companyEnd.getTime() - companyStart.getTime()
    mergeStats(globalStats, result.stats)

    const publicError = mapCompanySyncStatusToPublicError(result.status)

    companies.push({
      companyId,
      connectionId,
      gmailAddress,
      status: result.status,
      durationMs,
      stats: result.stats,
      error: publicError,
      skipReason: result.skipReason,
      partialReason: result.partialReason,
    })

    log(companyLogEvent(result.status), {
      companyId,
      connectionId,
      gmailAddress,
      durationMs,
      status: result.status,
      ...(result.status === "SUCCESS" || result.status === "PARTIAL" ? { stats: result.stats } : {}),
      ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      ...(publicError ? { code: publicError.code } : {}),
    })

    if (result.status === "SKIPPED") companiesSkipped++
    else if (result.status === "SUCCESS") companiesSucceeded++
    else if (result.status === "PARTIAL") companiesPartial++
    else companiesFailed++
  }

  const finishedAt = now()
  const durationMs = finishedAt.getTime() - startedAt.getTime()
  const runStatus = computeGlobalStatus(
    connections.length,
    companiesSucceeded,
    companiesFailed,
    companiesPartial,
    companiesSkipped
  )

  log("SYNC_FINISHED", {
    status: runStatus,
    durationMs,
    companiesTotal: connections.length,
    companiesSucceeded,
    companiesFailed,
    companiesPartial,
    companiesSkipped,
    globalStats,
  })

  return {
    status: runStatus,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    companiesTotal: connections.length,
    companiesSucceeded,
    companiesFailed,
    companiesPartial,
    companiesSkipped,
    globalStats,
    companies,
  }
}
