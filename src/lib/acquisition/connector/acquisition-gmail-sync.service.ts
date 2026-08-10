import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type { AcquisitionScanCursorRepositoryPort } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import type {
  MailPaginationMode,
  MailSyncResult,
  MailSyncStats,
} from "@/lib/acquisition/connector/connector.types"
import {
  prepareMailShadowRun,
  projectMailShadowAfterLegacy,
  type MailShadowRunContext,
} from "@/lib/acquisition/connector/mail-shadow-hook"
import type { MailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import {
  GmailProviderError,
  type GmailErrorCode,
} from "@/lib/acquisition/connector/gmail.errors"

/**
 * Instrumentation temporaire (PLAN-RUNTIME-DIAGNOSTIC-001) :
 * si `ACQUISITION_GMAIL_DIAGNOSTIC === "true"`, logue sur FAILED cursor/provider
 * uniquement des littéraux / codes allowlistés. Jamais message, stack, token, ni body.
 * Flag OFF → retour immédiat sans inspection de l'erreur.
 */
type AcquisitionGmailDiagPhase = "cursor" | "provider_list"

type AcquisitionGmailDiagErrorName =
  | "GmailProviderError"
  | "Error"
  | "UnknownError"

type AcquisitionGmailDiagPayload = {
  phase: AcquisitionGmailDiagPhase
  internalCode: string
  errorName: AcquisitionGmailDiagErrorName
  retryable: boolean
}

/** Codes GmailProviderError connus — seuls autorisés dans internalCode diag. */
const GMAIL_DIAG_INTERNAL_CODE_ALLOWLIST: ReadonlySet<GmailErrorCode> = new Set([
  "GMAIL_NOT_CONNECTED",
  "GMAIL_TOKEN_REFRESH_FAILED",
  "GMAIL_UNAUTHORIZED",
  "GMAIL_RATE_LIMITED",
  "GMAIL_HISTORY_EXPIRED",
  "GMAIL_UNAVAILABLE",
  "GMAIL_MESSAGE_NOT_FOUND",
  "GMAIL_MESSAGE_PARSE_ERROR",
  "NO_ACTIVE_PARTNER_IDENTITIES",
])

function isAcquisitionGmailDiagnosticEnabled(): boolean {
  return process.env.ACQUISITION_GMAIL_DIAGNOSTIC === "true"
}

function logAcquisitionGmailCursorDiag(error: unknown): void {
  if (!isAcquisitionGmailDiagnosticEnabled()) return
  const payload: AcquisitionGmailDiagPayload = {
    phase: "cursor",
    internalCode: "CURSOR_LOAD_FAILED",
    errorName: error instanceof Error ? "Error" : "UnknownError",
    retryable: true,
  }
  console.info(`[acquisition-gmail-diag] ${JSON.stringify(payload)}`)
}

function logAcquisitionGmailProviderListDiag(error: unknown): void {
  if (!isAcquisitionGmailDiagnosticEnabled()) return

  let internalCode = "PROVIDER_LIST_FAILED"
  let errorName: AcquisitionGmailDiagErrorName = "UnknownError"
  let retryable = true

  try {
    if (error instanceof GmailProviderError) {
      errorName = "GmailProviderError"

      let rawCode: unknown
      try {
        rawCode = error.code
      } catch {
        rawCode = undefined
      }
      if (
        typeof rawCode === "string" &&
        GMAIL_DIAG_INTERNAL_CODE_ALLOWLIST.has(rawCode as GmailErrorCode)
      ) {
        internalCode = rawCode
      }

      let rawRetryable: unknown
      try {
        rawRetryable = error.retryable
      } catch {
        rawRetryable = undefined
      }
      retryable = typeof rawRetryable === "boolean" ? rawRetryable : true
    } else if (error instanceof Error) {
      errorName = "Error"
    }
  } catch {
    internalCode = "PROVIDER_LIST_FAILED"
    errorName =
      error instanceof GmailProviderError
        ? "GmailProviderError"
        : error instanceof Error
          ? "Error"
          : "UnknownError"
    retryable = true
  }

  const payload: AcquisitionGmailDiagPayload = {
    phase: "provider_list",
    internalCode,
    errorName,
    retryable,
  }
  console.info(`[acquisition-gmail-diag] ${JSON.stringify(payload)}`)
}

function withShadow<T extends object>(
  result: T,
  mailShadowCtx: MailShadowRunContext | null
): T & { shadowStats?: MailShadowRunStats } {
  if (!mailShadowCtx) return result
  return { ...result, shadowStats: mailShadowCtx.stats }
}

/** Taille de page Gmail par appel list/history (max API messages.list : 500). */
export const DEFAULT_GMAIL_PAGE_SIZE = 50
export const MAX_GMAIL_PAGE_SIZE = 500

/** Garde-fou défensif — ne remplace pas la pagination normale. */
export const DEFAULT_MAX_PAGES_PER_RUN = 100

const emptyStats = (): MailSyncStats => ({
  fetched: 0,
  ingested: 0,
  skippedDuplicate: 0,
  rejected: 0,
  failed: 0,
})

function clampPageSize(pageSize: number): number {
  return Math.min(Math.max(1, pageSize), MAX_GMAIL_PAGE_SIZE)
}

export interface SyncAcquisitionMailForCompanyInput {
  companyId: string
  provider: MailProviderPort
  ingestion: AcquisitionIngestionPort
  cursorRepository: AcquisitionScanCursorRepositoryPort
  /** Taille de chaque page Gmail — pas de limite globale de messages. */
  pageSize?: number
  /** Limite défensive de pages par exécution (anti-boucle infinie). */
  maxPagesPerRun?: number
  now?: () => Date
  /** Deadline budget orchestrateur (ms epoch) — arrêt coopératif. */
  deadlineAtMs?: number
  /** Fence : false → stop immédiat (lease perdu). */
  shouldContinue?: () => boolean | Promise<boolean>
  /**
   * LOT-1C — injecter un contexte shadow (tests) ; sinon préparé si flags ON.
   * `false` désactive explicitement le shadow pour ce run.
   */
  mailShadow?: MailShadowRunContext | false
}

/**
 * Synchronise tous les messages Gmail d'un scan complet en parcourant
 * les pages jusqu'à épuisement du nextPageToken.
 * Le lastHistoryId n'est persisté qu'après la dernière page réussie.
 * Le pageToken reste en mémoire uniquement — jamais persisté.
 */
export async function syncAcquisitionMailForCompany(
  input: SyncAcquisitionMailForCompanyInput
): Promise<MailSyncResult> {
  const { companyId, provider, ingestion, cursorRepository } = input
  const pageSize = clampPageSize(input.pageSize ?? DEFAULT_GMAIL_PAGE_SIZE)
  const maxPagesPerRun = input.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN
  const now = input.now ?? (() => new Date())

  if (!companyId) throw new Error("companyId requis")

  const base = {
    companyId,
    source: provider.source,
    stats: emptyStats(),
    nextHistoryId: null as string | null,
  }

  if (!ingestion.isEnabled()) {
    return {
      ...base,
      status: "SKIPPED",
      skipReason: "FEATURE_DISABLED",
    }
  }

  let cursorRecord
  try {
    cursorRecord = await cursorRepository.getOrCreate(companyId, provider.source)
  } catch (e) {
    const message = e instanceof Error ? e.message : "CURSOR_LOAD_FAILED"
    logAcquisitionGmailCursorDiag(e)
    await cursorRepository.recordFailure(companyId, provider.source, "CURSOR_LOAD_FAILED", now())
    return {
      ...base,
      status: "FAILED",
      error: { code: "CURSOR_LOAD_FAILED", message, retryable: true },
    }
  }

  let pageToken: string | null = null
  let paginationMode: MailPaginationMode | undefined = undefined
  let finalHistoryId: string | null = null
  let pagesProcessed = 0
  const deadlineAtMs = input.deadlineAtMs
  const shouldContinue = input.shouldContinue

  let mailShadowCtx: MailShadowRunContext | null = null
  if (input.mailShadow === false) {
    mailShadowCtx = null
  } else if (input.mailShadow) {
    mailShadowCtx = input.mailShadow
  } else {
    try {
      mailShadowCtx = await prepareMailShadowRun(companyId)
    } catch {
      mailShadowCtx = null
    }
  }

  // Pagination complète : parcourir toutes les pages jusqu'à absence de nextPageToken.
  // pageSize borne uniquement chaque appel Gmail — jamais de limite globale de messages.
  while (true) {
    if (deadlineAtMs != null && Date.now() >= deadlineAtMs) {
      return withShadow({
        ...base,
        status: pagesProcessed > 0 ? "PARTIAL" : "SKIPPED",
        ...(pagesProcessed > 0
          ? { partialReason: "BUDGET_EXHAUSTED" as const }
          : { skipReason: "BUDGET_EXHAUSTED" as const }),
        nextHistoryId: finalHistoryId,
        error: {
          code: "BUDGET_EXHAUSTED",
          message: "Budget orchestrateur épuisé pendant sync Gmail",
          retryable: true,
        },
      }, mailShadowCtx)
    }
    if (shouldContinue) {
      const ok = await shouldContinue()
      if (!ok) {
        return withShadow({
          ...base,
          status: "PARTIAL",
          partialReason: "BUDGET_EXHAUSTED",
          nextHistoryId: finalHistoryId,
          error: {
            code: "LEASE_STOLEN",
            message: "Lease orchestrateur perdu pendant sync Gmail",
            retryable: true,
          },
        }, mailShadowCtx)
      }
    }

    let page
    try {
      page = await provider.listMessagesPage({
        companyId,
        cursor: cursorRecord.lastHistoryId,
        pageToken,
        pageSize,
        paginationMode,
      })
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as { code: unknown }).code)
          : "PROVIDER_LIST_FAILED"
      if (code === "NO_ACTIVE_PARTNER_IDENTITIES") {
        return {
          ...base,
          status: "SKIPPED",
          skipReason: "NO_ACTIVE_PARTNER_IDENTITIES",
          error: {
            code: "NO_ACTIVE_PARTNER_IDENTITIES",
            message: "Aucune identité partenaire active — scan Gmail refusé",
            retryable: false,
          },
        }
      }
      const message = e instanceof Error ? e.message : "PROVIDER_LIST_FAILED"
      logAcquisitionGmailProviderListDiag(e)
      await cursorRepository.recordFailure(companyId, provider.source, "PROVIDER_LIST_FAILED", now())
      return withShadow({
        ...base,
        status: "FAILED",
        stats: { ...base.stats },
        nextHistoryId: finalHistoryId,
        error: { code: "PROVIDER_LIST_FAILED", message, retryable: true },
      }, mailShadowCtx)
    }

    pagesProcessed++
    paginationMode = page.paginationMode
    if (page.nextHistoryId !== null) {
      finalHistoryId = page.nextHistoryId
    }
    base.stats.fetched += page.messages.length
    base.nextHistoryId = finalHistoryId

    for (const message of page.messages) {
      try {
        const registerInput = mapGmailMessageToAcquisitionInput(message, companyId)
        const result = await ingestion.registerIncomingMessage(registerInput)

        if (result.outcome === "DRAFT_CREATED") {
          if (result.created) base.stats.ingested++
          else base.stats.skippedDuplicate++
        } else if (result.created) {
          base.stats.rejected++
        } else {
          base.stats.skippedDuplicate++
        }

        // LOT-1C — shadow après legacy ; best-effort ; n’altère pas stats métier
        if (mailShadowCtx) {
          await projectMailShadowAfterLegacy(message, companyId, mailShadowCtx)
        }
      } catch {
        base.stats.failed++
        return withShadow({
          ...base,
          status: "PARTIAL",
          partialReason: "MESSAGE_INGESTION_FAILED",
          error: {
            code: "MESSAGE_INGESTION_FAILED",
            message: "Au moins un message n'a pas pu être persisté",
            retryable: true,
          },
        }, mailShadowCtx)
      }
    }

    const hasNextPage = page.hasMore && page.nextPageToken
    if (!hasNextPage) {
      if (finalHistoryId !== cursorRecord.lastHistoryId) {
        await cursorRepository.saveSuccessfulPage(
          companyId,
          provider.source,
          finalHistoryId,
          now()
        )
      }
      return withShadow({ ...base, status: "SUCCESS" }, mailShadowCtx)
    }

    if (pagesProcessed >= maxPagesPerRun) {
      return withShadow({
        ...base,
        status: "PARTIAL",
        partialReason: "PAGE_LIMIT_REACHED",
        nextHistoryId: finalHistoryId,
        error: {
          code: "PAGE_LIMIT_REACHED",
          message: `Limite défensive maxPagesPerRun (${maxPagesPerRun}) atteinte avec des pages restantes`,
          retryable: true,
        },
      }, mailShadowCtx)
    }

    pageToken = page.nextPageToken
  }
}
