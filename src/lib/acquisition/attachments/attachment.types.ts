/** Codes d'erreur contrôlés pour le téléchargement de pièces jointes Acquisition. */
export type AttachmentDownloadErrorCode =
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_ALREADY_STORED"
  | "ATTACHMENT_DOWNLOAD_DISABLED"
  | "GMAIL_ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_MIME_NOT_ALLOWED"
  | "ATTACHMENT_SIGNATURE_MISMATCH"
  | "ATTACHMENT_DECODE_FAILED"
  | "ATTACHMENT_STORAGE_FAILED"
  | "ATTACHMENT_STORAGE_COLLISION"
  | "ATTACHMENT_PERSISTENCE_FAILED"
  | "ATTACHMENT_COMPENSATION_FAILED"
  | "ATTACHMENT_ALREADY_IN_PROGRESS"
  | "GMAIL_NOT_CONNECTED"
  | "TENANT_MISMATCH"

export type AttachmentDownloadOutcome =
  | "STORED"
  | "ALREADY_STORED"
  | "ALREADY_IN_PROGRESS"
  | "REJECTED"
  | "FAILED"
  | "SKIPPED"

export interface AttachmentDownloadResult {
  outcome: AttachmentDownloadOutcome
  attachmentId: string
  errorCode?: AttachmentDownloadErrorCode
  sha256?: string
  storagePublicId?: string
  storedAt?: string
}

export interface AttachmentRecord {
  id: string
  companyId: string
  acquisitionMessageId: string
  externalAttachmentId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  status: string
  sha256: string | null
  storageUrl: string | null
  storagePublicId: string | null
  storedAt: Date | null
  lastErrorCode: string | null
}

export interface AttachmentMessageContext {
  id: string
  companyId: string
  externalMessageId: string
}

export interface GmailAttachmentFetchInput {
  companyId: string
  externalMessageId: string
  externalAttachmentId: string
}

export interface GmailAttachmentFetchResult {
  data: Buffer
  sizeBytes: number
}

export interface AttachmentStorageInput {
  companyId: string
  acquisitionMessageId: string
  attachmentId: string
  buffer: Buffer
  mimeType: string
  generatedFilename: string
}

export interface AttachmentStorageResult {
  /** true uniquement si ce worker a créé l'objet Cloudinary lors de cet appel store(). */
  created: boolean
  storagePublicId: string
  /** Obligatoire lorsque created === true. Absent si created === false (collision). */
  storageUrl?: string
}

export interface AttachmentStorageDestroyInput {
  storagePublicId: string
  resourceType?: "raw"
  type?: "authenticated"
}

export interface StoredAttachmentUpdate {
  sha256: string
  storageUrl: string
  storagePublicId: string
  storedAt: Date
  sizeBytes: number
  mimeType: string
}

export interface AttachmentFailureUpdate {
  status: "FAILED" | "REJECTED"
  errorCode: AttachmentDownloadErrorCode
  failedAt: Date
}

export type ClaimForDownloadResult =
  | { status: "CLAIMED"; attachment: AttachmentRecord }
  | { status: "ALREADY_STORED"; attachment: AttachmentRecord }
  | { status: "ALREADY_IN_PROGRESS" }
  | { status: "NOT_RETRYABLE"; attachment: AttachmentRecord }
  | { status: "NOT_FOUND" }

export type MarkStoredResult =
  | { status: "STORED"; attachment: AttachmentRecord }
  | { status: "ALREADY_STORED"; attachment: AttachmentRecord }
  | { status: "FAILED" }
