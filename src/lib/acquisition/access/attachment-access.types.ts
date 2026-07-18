import type { Role } from "@prisma/client"

/** Codes internes — jamais exposés tels quels au client HTTP. */
export type AttachmentAccessReasonCode =
  | "ATTACHMENT_ACCESS_DISABLED"
  | "ATTACHMENT_ACCESS_UNAUTHENTICATED"
  | "ATTACHMENT_ACCESS_FORBIDDEN"
  | "ATTACHMENT_ACCESS_NOT_FOUND"
  | "ATTACHMENT_ACCESS_SIGN_FAILED"
  | "ATTACHMENT_ACCESS_FETCH_FAILED"
  | "ATTACHMENT_ACCESS_AUDIT_FAILED"

export type AttachmentAccessMode = "VIEW" | "DOWNLOAD"

export type AttachmentAccessAction = "VIEW" | "DOWNLOAD"

export type AttachmentAccessOutcomeKind =
  | "OK"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "DISABLED"
  | "SERVICE_UNAVAILABLE"
  | "BAD_GATEWAY"

export interface AttachmentAccessContext {
  userId: string
  role: Role
  companyId: string | null
}

/** Enregistrement consultable — storagePublicId reste confiné au domaine serveur. */
export interface ConsultableAttachmentRecord {
  id: string
  companyId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePublicId: string
  sha256: string
  storedAt: Date
}

export interface AttachmentAccessAuditEntry {
  companyId: string
  attachmentId: string | null
  requestedAttachmentId: string
  userId: string
  action: AttachmentAccessAction
  outcome: "GRANTED" | "DENIED"
  reasonCode: AttachmentAccessReasonCode | null
}

export interface AttachmentAccessSuccess {
  kind: "OK"
  stream: ReadableStream<Uint8Array>
  filename: string
  mimeType: string
  contentLength: number | null
  mode: AttachmentAccessMode
}

export interface AttachmentAccessFailure {
  kind: Exclude<AttachmentAccessOutcomeKind, "OK">
  reasonCode: AttachmentAccessReasonCode
}

export type AttachmentAccessResult = AttachmentAccessSuccess | AttachmentAccessFailure

export interface FindConsultableAttachmentInput {
  companyId: string
  attachmentId: string
}

export interface CreateSignedUrlInput {
  storagePublicId: string
  expiresAt: Date
}

export interface SignedUrlResult {
  url: string
}

export interface FetchSignedResourceInput {
  url: string
}

export interface FetchSignedResourceResult {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  contentLength: number | null
}

export const DEFAULT_SIGNED_URL_TTL_SECONDS = 120
export const MIN_SIGNED_URL_TTL_SECONDS = 30
export const MAX_SIGNED_URL_TTL_SECONDS = 300

export function isAttachmentAccessEnabled(): boolean {
  return process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED === "true"
}

export function getSignedUrlTtlSeconds(now: () => Date = () => new Date()): number {
  void now
  const raw = process.env.ACQUISITION_ATTACHMENT_SIGNED_URL_TTL_SECONDS
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_SIGNED_URL_TTL_SECONDS
  if (!Number.isFinite(parsed)) return DEFAULT_SIGNED_URL_TTL_SECONDS
  return Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.max(MIN_SIGNED_URL_TTL_SECONDS, parsed))
}

export function resolveMimeType(stored: string, filename: string): string {
  if (stored && stored !== "application/octet-stream") return stored
  const lower = filename.toLowerCase()
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
  return stored || "application/octet-stream"
}
