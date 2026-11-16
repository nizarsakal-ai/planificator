import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"

const FORBIDDEN_METADATA_KEYS = [
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "cookie",
  "secret",
] as const

function sanitizeProviderMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase()
    if (FORBIDDEN_METADATA_KEYS.some((f) => lower.includes(f))) continue
    out[key] = value
  }
  return out
}

/**
 * Bornes alignées sur `registerIncomingMessageSchema` : un e-mail réel ne doit jamais
 * échouer la validation pour une question de longueur (sujet, nom de PJ…), sinon il
 * bloque la synchronisation de toute la boîte.
 */
export const MAPPER_LIMITS = {
  subject: 500,
  senderEmail: 320,
  threadId: 255,
  filename: 255,
  mimeType: 127,
  partId: 64,
  attachments: 50,
  rawMetadataBytes: 10_000,
} as const

const FALLBACK_MIME_TYPE = "application/octet-stream"
const FALLBACK_FILENAME = "piece-jointe"
/** Placeholder ≥ 3 caractères : le service le classera INVALID_SENDER (REJECTED, visible). */
const UNKNOWN_SENDER = "unknown-sender"

function truncate(value: string, max: number): string {
  // Array.from : ne coupe pas une paire de substitution UTF-16 (emoji) en deux.
  const chars = Array.from(value)
  return chars.length <= max ? value : chars.slice(0, max).join("")
}

/** Tronque un nom de fichier en conservant son extension (utile à la catégorisation). */
export function truncateFilename(filename: string, max: number = MAPPER_LIMITS.filename): string {
  const trimmed = filename.trim()
  if (!trimmed) return FALLBACK_FILENAME
  if (Array.from(trimmed).length <= max) return trimmed
  const dot = trimmed.lastIndexOf(".")
  const ext = dot > 0 ? trimmed.slice(dot) : ""
  if (ext && Array.from(ext).length <= 16 && Array.from(ext).length < max) {
    return truncate(trimmed.slice(0, dot), max - Array.from(ext).length) + ext
  }
  return truncate(trimmed, max)
}

function normalizeMimeType(mimeType: string): string {
  const trimmed = mimeType.trim()
  if (!trimmed || trimmed.length > MAPPER_LIMITS.mimeType) return FALLBACK_MIME_TYPE
  return trimmed
}

function normalizeSizeBytes(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 0
  return Math.floor(sizeBytes)
}

function normalizeSender(fromHeader: string): string {
  const trimmed = (fromHeader ?? "").trim()
  if (trimmed.length < 3) return UNKNOWN_SENDER
  return truncate(trimmed, MAPPER_LIMITS.senderEmail)
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length
}

/**
 * rawMetadata ≤ 10 Ko : on retire d'abord les champs les moins utiles
 * (métadonnées provider, puis snippet, puis labels) plutôt que de rejeter le message.
 */
function boundRawMetadata(
  essential: Record<string, unknown>,
  optional: Array<Record<string, unknown>>
): Record<string, unknown> {
  const layers = [...optional]
  while (layers.length > 0) {
    const candidate = Object.assign({}, essential, ...layers)
    if (jsonSize(candidate) <= MAPPER_LIMITS.rawMetadataBytes) return candidate
    layers.pop()
  }
  return essential
}

/**
 * Transforme un message Gmail normalisé en entrée du service d'acquisition.
 * Aucune règle LAURALU — l'éligibilité est déléguée à acquisition.service.ts.
 */
export function mapGmailMessageToAcquisitionInput(
  message: CanonicalMailMessage,
  companyId: string,
  sourceMailboxKey = ""
): RegisterIncomingMessageInput {
  const threadId =
    message.threadId && message.threadId.trim() && message.threadId.length <= MAPPER_LIMITS.threadId
      ? message.threadId
      : null

  const essential: Record<string, unknown> = {
    threadId,
    ...(sourceMailboxKey ? { acquisitionGmailConnectionId: sourceMailboxKey } : {}),
  }
  const rawMetadata = boundRawMetadata(essential, [
    { labels: message.labels },
    ...(message.snippet ? [{ snippet: message.snippet.slice(0, 500) }] : []),
    sanitizeProviderMetadata(message.providerMetadata),
  ])

  return {
    companyId,
    source: "GMAIL",
    externalMessageId: message.externalMessageId,
    sourceMailboxKey,
    threadId,
    senderEmail: normalizeSender(message.fromHeader),
    subject: truncate(message.subject ?? "", MAPPER_LIMITS.subject),
    receivedAt: message.receivedAt,
    rawMetadata,
    // Ordre MIME conservé (ordinal stable) ; au-delà de 50 PJ, les suivantes sont ignorées.
    attachments: message.attachments.slice(0, MAPPER_LIMITS.attachments).map((a) => ({
      externalAttachmentId: a.externalAttachmentId,
      partId: a.partId && a.partId.length <= MAPPER_LIMITS.partId ? a.partId : undefined,
      filename: truncateFilename(a.filename ?? ""),
      mimeType: normalizeMimeType(a.mimeType ?? ""),
      sizeBytes: normalizeSizeBytes(a.sizeBytes),
    })),
  }
}
