import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type { AcquisitionScanCursorRepositoryPort } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import type {
  MailPaginationMode,
  MailSyncResult,
  MailSyncStats,
} from "@/lib/acquisition/connector/connector.types"

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

  // Pagination complète : parcourir toutes les pages jusqu'à absence de nextPageToken.
  // pageSize borne uniquement chaque appel Gmail — jamais de limite globale de messages.
  while (true) {
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
      const message = e instanceof Error ? e.message : "PROVIDER_LIST_FAILED"
      await cursorRepository.recordFailure(companyId, provider.source, "PROVIDER_LIST_FAILED", now())
      return {
        ...base,
        status: "FAILED",
        stats: { ...base.stats },
        nextHistoryId: finalHistoryId,
        error: { code: "PROVIDER_LIST_FAILED", message, retryable: true },
      }
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
      } catch {
        base.stats.failed++
        return {
          ...base,
          status: "PARTIAL",
          partialReason: "MESSAGE_INGESTION_FAILED",
          error: {
            code: "MESSAGE_INGESTION_FAILED",
            message: "Au moins un message n'a pas pu être persisté",
            retryable: true,
          },
        }
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
      return { ...base, status: "SUCCESS" }
    }

    if (pagesProcessed >= maxPagesPerRun) {
      return {
        ...base,
        status: "PARTIAL",
        partialReason: "PAGE_LIMIT_REACHED",
        nextHistoryId: finalHistoryId,
        error: {
          code: "PAGE_LIMIT_REACHED",
          message: `Limite défensive maxPagesPerRun (${maxPagesPerRun}) atteinte avec des pages restantes`,
          retryable: true,
        },
      }
    }

    pageToken = page.nextPageToken
  }
}
