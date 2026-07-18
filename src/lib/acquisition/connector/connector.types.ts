import type { AcquisitionSource } from "@prisma/client"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"

/** Métadonnées d'une pièce jointe — aucun contenu binaire. */
export interface CanonicalMailAttachment {
  externalAttachmentId?: string
  partId?: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/**
 * Message mail normalisé, provider-agnostique.
 * Aucun corps intégral, token ou secret.
 */
export interface CanonicalMailMessage {
  externalMessageId: string
  threadId: string | null
  /** Header From brut tel que fourni par le provider. */
  fromHeader: string
  subject: string
  receivedAt: Date
  labels: string[]
  snippet: string | null
  attachments: CanonicalMailAttachment[]
  /** Métadonnées provider limitées (historyId, etc.) — jamais de secrets. */
  providerMetadata: Record<string, unknown>
}

/** Mode de pagination Gmail pour la page suivante. */
export type MailPaginationMode = "history" | "lookback"

/** Page de messages retournée par un provider mail. */
export interface MailPage {
  messages: CanonicalMailMessage[]
  /** Curseur technique temporaire (Gmail pageToken) — jamais persisté. */
  nextPageToken: string | null
  /** Watermark Gmail à persister après scan complet — null si inchangé. */
  nextHistoryId: string | null
  hasMore: boolean
  /** Indique quel mode utiliser pour la page suivante. */
  paginationMode: MailPaginationMode
}

export type MailSyncStatus = "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"

export interface MailSyncStats {
  fetched: number
  ingested: number
  skippedDuplicate: number
  rejected: number
  failed: number
}

export interface MailSyncError {
  code: string
  message: string
  retryable: boolean
}

export type MailSyncPartialReason =
  | "PAGE_LIMIT_REACHED"
  | "MESSAGE_INGESTION_FAILED"

/** Résultat d'une synchronisation pour un tenant. */
export interface MailSyncResult {
  companyId: string
  source: AcquisitionSource
  status: MailSyncStatus
  skipReason?: "FEATURE_DISABLED"
  partialReason?: MailSyncPartialReason
  stats: MailSyncStats
  error?: MailSyncError
  nextHistoryId: string | null
}

export type { RegisterIncomingMessageInput }
