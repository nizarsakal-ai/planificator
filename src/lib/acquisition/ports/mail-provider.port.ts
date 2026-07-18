import type { AcquisitionSource } from "@prisma/client"
import type { MailPage, MailPaginationMode } from "@/lib/acquisition/connector/connector.types"

export interface ListMessagesPageInput {
  companyId: string
  /** Watermark provider (Gmail historyId) — null pour premier scan. */
  cursor: string | null
  /** Curseur technique temporaire de pagination Gmail — jamais persisté. */
  pageToken?: string | null
  /** Taille de la page Gmail pour cet appel list/history. */
  pageSize: number
  /** Mode de pagination pour cette page (history ou lookback messages.list). */
  paginationMode?: MailPaginationMode
}

/** Contrat minimal pour lister des messages mail — provider-agnostique. */
export interface MailProviderPort {
  readonly source: AcquisitionSource
  listMessagesPage(input: ListMessagesPageInput): Promise<MailPage>
}
