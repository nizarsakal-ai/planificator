import { createHash } from "node:crypto"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import type { AcquisitionAttachmentRepositoryPort } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import {
  extensionFromFilename,
  generateStorageFilename,
  getAttachmentMaxBytes,
  isAttachmentDownloadEnabled,
  validateAttachmentContent,
} from "@/lib/acquisition/attachments/attachment-policy"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"
import { cloudinaryAttachmentStorage } from "@/lib/acquisition/attachments/attachment-storage.port"
import type { GmailAttachmentSourcePort } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import { gmailAttachmentSource } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import { getAttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import { isRetryableAttachmentErrorCode } from "@/lib/acquisition/attachments/attachment-retry.policy"
import { computeRetrySchedule } from "@/lib/acquisition/attachments/attachment-retry-schedule"
import type {
  AttachmentDownloadErrorCode,
  AttachmentDownloadResult,
  AttachmentFailureUpdate,
  AttachmentRecord,
  AttachmentStorageResult,
  MarkFailureResult,
} from "@/lib/acquisition/attachments/attachment.types"

const LOG_PREFIX = "[acquisition-attachment-download]"

export interface DownloadAcquisitionAttachmentInput {
  companyId: string
  attachmentId: string
  now?: () => Date
  random?: () => number
}

export interface AttachmentDownloadServiceDeps {
  repository?: AcquisitionAttachmentRepositoryPort
  gmailSource?: GmailAttachmentSourcePort
  storage?: AttachmentStoragePort
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function failureResult(
  attachmentId: string,
  errorCode: AttachmentDownloadErrorCode
): AttachmentDownloadResult {
  return { outcome: "FAILED", attachmentId, errorCode }
}

function rejectedResult(
  attachmentId: string,
  errorCode: AttachmentDownloadErrorCode
): AttachmentDownloadResult {
  return { outcome: "REJECTED", attachmentId, errorCode }
}

function alreadyStoredResult(
  attachmentId: string,
  sha256: string,
  storagePublicId: string,
  storedAt?: Date | null
): AttachmentDownloadResult {
  return {
    outcome: "ALREADY_STORED",
    attachmentId,
    sha256,
    storagePublicId,
    storedAt: storedAt?.toISOString(),
  }
}

function policyFailureStatus(code: AttachmentDownloadErrorCode): "FAILED" | "REJECTED" {
  if (
    code === "ATTACHMENT_MIME_NOT_ALLOWED" ||
    code === "ATTACHMENT_TOO_LARGE" ||
    code === "ATTACHMENT_SIGNATURE_MISMATCH"
  ) {
    return "REJECTED"
  }
  return "FAILED"
}

async function compensateCloudinaryUpload(
  storage: AttachmentStoragePort,
  stored: AttachmentStorageResult,
  log: (event: string, payload?: Record<string, unknown>) => void,
  attachmentId: string
): Promise<void> {
  if (!stored.created) return
  try {
    await storage.destroy({ storagePublicId: stored.storagePublicId })
  } catch {
    log("COMPENSATION_FAILED", {
      attachmentId,
      errorCode: "ATTACHMENT_COMPENSATION_FAILED",
    })
  }
}

function buildFailureUpdate(input: {
  status: "FAILED" | "REJECTED"
  errorCode: AttachmentDownloadErrorCode
  failedAt: Date
  currentRetryCount: number
  random: () => number
}): AttachmentFailureUpdate {
  if (input.status === "REJECTED") {
    return {
      status: "REJECTED",
      errorCode: input.errorCode,
      failedAt: input.failedAt,
      nextRetryAt: null,
    }
  }

  const newRetryCount = input.currentRetryCount + 1
  const config = getAttachmentRecoveryCronConfig()
  const retryable = isRetryableAttachmentErrorCode(input.errorCode)

  if (retryable && newRetryCount <= config.maxRetries) {
    const schedule = computeRetrySchedule({
      retryCount: newRetryCount,
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      now: input.failedAt,
      random: input.random,
    })
    return {
      status: "FAILED",
      errorCode: input.errorCode,
      failedAt: input.failedAt,
      nextRetryAt: schedule.nextRetryAt,
    }
  }

  return {
    status: "FAILED",
    errorCode: input.errorCode,
    failedAt: input.failedAt,
    nextRetryAt: null,
  }
}

async function persistDownloadFailure(input: {
  repository: AcquisitionAttachmentRepositoryPort
  companyId: string
  attachmentId: string
  claimed: AttachmentRecord
  status: "FAILED" | "REJECTED"
  errorCode: AttachmentDownloadErrorCode
  failedAt: Date
  random: () => number
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<MarkFailureResult> {
  const update = buildFailureUpdate({
    status: input.status,
    errorCode: input.errorCode,
    failedAt: input.failedAt,
    currentRetryCount: input.claimed.downloadRetryCount ?? 0,
    random: input.random,
  })

  const result = await input.repository.markFailure(
    input.companyId,
    input.attachmentId,
    update
  )

  if (
    result.outcome === "MARKED_FAILED" &&
    isRetryableAttachmentErrorCode(input.errorCode) &&
    update.nextRetryAt == null
  ) {
    input.log("RETRY_ABANDONED", {
      attachmentId: input.attachmentId,
      companyId: input.companyId,
      errorCode: input.errorCode,
      downloadRetryCount: result.attachment.downloadRetryCount,
    })
  }

  return result
}

/**
 * Télécharge et stocke une pièce jointe Gmail admissible.
 * Service appelable — orchestré par PLAN-ACQ-004C (cron), sans logique cron ici.
 */
export async function downloadAcquisitionAttachment(
  input: DownloadAcquisitionAttachmentInput,
  deps: AttachmentDownloadServiceDeps = {}
): Promise<AttachmentDownloadResult> {
  const repository = deps.repository ?? acquisitionAttachmentRepository
  const gmailSource = deps.gmailSource ?? gmailAttachmentSource
  const storage = deps.storage ?? cloudinaryAttachmentStorage
  const log = deps.log ?? defaultLog
  const now = input.now ?? (() => new Date())
  const random = input.random ?? Math.random

  if (!input.companyId || !input.attachmentId) {
    return failureResult(input.attachmentId ?? "", "ATTACHMENT_NOT_FOUND")
  }

  if (!isAcquisitionEnabled()) {
    log("DOWNLOAD_SKIPPED", { reason: "ACQUISITION_DISABLED" })
    return { outcome: "SKIPPED", attachmentId: input.attachmentId, errorCode: "ACQUISITION_DISABLED" }
  }
  if (!isAttachmentDownloadEnabled()) {
    log("DOWNLOAD_SKIPPED", { reason: "ATTACHMENT_DOWNLOAD_DISABLED" })
    return { outcome: "SKIPPED", attachmentId: input.attachmentId, errorCode: "ATTACHMENT_DOWNLOAD_DISABLED" }
  }

  const scoped = await repository.findAttachmentWithMessage(input.companyId, input.attachmentId)
  if (!scoped) {
    return failureResult(input.attachmentId, "ATTACHMENT_NOT_FOUND")
  }

  if (scoped.message.companyId !== input.companyId) {
    return failureResult(input.attachmentId, "TENANT_MISMATCH")
  }

  const claim = await repository.claimForDownload(input.companyId, input.attachmentId)
  switch (claim.status) {
    case "NOT_FOUND":
      return failureResult(input.attachmentId, "ATTACHMENT_NOT_FOUND")
    case "ALREADY_STORED":
      return alreadyStoredResult(
        claim.attachment.id,
        claim.attachment.sha256!,
        claim.attachment.storagePublicId!,
        claim.attachment.storedAt
      )
    case "ALREADY_IN_PROGRESS":
      return {
        outcome: "ALREADY_IN_PROGRESS",
        attachmentId: input.attachmentId,
        errorCode: "ATTACHMENT_ALREADY_IN_PROGRESS",
      }
    case "NOT_RETRYABLE":
      if (claim.attachment.status === "REJECTED") {
        return rejectedResult(input.attachmentId, "ATTACHMENT_MIME_NOT_ALLOWED")
      }
      return failureResult(
        input.attachmentId,
        safePersistedErrorCode(claim.attachment.lastErrorCode)
      )
    case "CLAIMED":
      break
  }

  const claimed = claim.attachment

  const markFail = (
    status: "FAILED" | "REJECTED",
    errorCode: AttachmentDownloadErrorCode
  ) =>
    persistDownloadFailure({
      repository,
      companyId: input.companyId,
      attachmentId: input.attachmentId,
      claimed,
      status,
      errorCode,
      failedAt: now(),
      random,
      log,
    })

  if (!claimed.externalAttachmentId) {
    await markFail("FAILED", "GMAIL_ATTACHMENT_NOT_FOUND")
    return failureResult(input.attachmentId, "GMAIL_ATTACHMENT_NOT_FOUND")
  }

  let binary: Buffer
  try {
    const fetched = await gmailSource.fetchAttachment({
      companyId: input.companyId,
      externalMessageId: scoped.message.externalMessageId,
      externalAttachmentId: claimed.externalAttachmentId,
    })
    binary = fetched.data
  } catch (error) {
    const code = safeErrorCode(error, "GMAIL_ATTACHMENT_NOT_FOUND")
    await markFail("FAILED", code)
    log("DOWNLOAD_FAILED", { attachmentId: input.attachmentId, errorCode: code })
    return failureResult(input.attachmentId, code)
  }

  const maxBytes = getAttachmentMaxBytes()
  if (binary.length > maxBytes) {
    await markFail("REJECTED", "ATTACHMENT_TOO_LARGE")
    return rejectedResult(input.attachmentId, "ATTACHMENT_TOO_LARGE")
  }

  const validation = validateAttachmentContent({
    filename: claimed.filename,
    declaredMimeType: claimed.mimeType,
    buffer: binary,
  })

  if (!validation.allowed) {
    const code = validation.errorCode ?? "ATTACHMENT_MIME_NOT_ALLOWED"
    await markFail(policyFailureStatus(code), code)
    return rejectedResult(input.attachmentId, code)
  }

  const sha256 = createHash("sha256").update(binary).digest("hex")
  const ext = extensionFromFilename(claimed.filename)
  const generatedFilename = generateStorageFilename(claimed.id, sha256, ext)

  let stored: AttachmentStorageResult
  try {
    stored = await storage.store({
      companyId: input.companyId,
      acquisitionMessageId: scoped.message.id,
      attachmentId: claimed.id,
      buffer: binary,
      mimeType: validation.resolvedMimeType,
      generatedFilename,
    })
  } catch {
    await markFail("FAILED", "ATTACHMENT_STORAGE_FAILED")
    log("STORAGE_FAILED", { attachmentId: input.attachmentId })
    return failureResult(input.attachmentId, "ATTACHMENT_STORAGE_FAILED")
  }

  if (!stored.created) {
    await markFail("FAILED", "ATTACHMENT_STORAGE_COLLISION")
    log("STORAGE_COLLISION", { attachmentId: input.attachmentId })
    return failureResult(input.attachmentId, "ATTACHMENT_STORAGE_COLLISION")
  }

  if (!stored.storageUrl) {
    await markFail("FAILED", "ATTACHMENT_STORAGE_FAILED")
    log("STORAGE_FAILED", { attachmentId: input.attachmentId, reason: "missing_storage_url" })
    return failureResult(input.attachmentId, "ATTACHMENT_STORAGE_FAILED")
  }

  const storedAt = now()
  const persist = await repository.markStored(input.companyId, input.attachmentId, {
    sha256,
    storageUrl: stored.storageUrl,
    storagePublicId: stored.storagePublicId,
    storedAt,
    sizeBytes: binary.length,
    mimeType: validation.resolvedMimeType,
  })

  if (persist.status === "STORED") {
    log("DOWNLOAD_STORED", {
      attachmentId: input.attachmentId,
      companyId: input.companyId,
      sha256Prefix: sha256.slice(0, 8),
    })
    return {
      outcome: "STORED",
      attachmentId: input.attachmentId,
      sha256,
      storagePublicId: stored.storagePublicId,
      storedAt: storedAt.toISOString(),
    }
  }

  if (persist.status === "ALREADY_STORED") {
    await compensateCloudinaryUpload(storage, stored, log, input.attachmentId)
    return alreadyStoredResult(
      persist.attachment.id,
      persist.attachment.sha256!,
      persist.attachment.storagePublicId!,
      persist.attachment.storedAt
    )
  }

  await compensateCloudinaryUpload(storage, stored, log, input.attachmentId)
  await markFail("FAILED", "ATTACHMENT_PERSISTENCE_FAILED")
  return failureResult(input.attachmentId, "ATTACHMENT_PERSISTENCE_FAILED")
}

function safeErrorCode(error: unknown, fallback: AttachmentDownloadErrorCode): AttachmentDownloadErrorCode {
  if (error instanceof Error) {
    const code = error.message as AttachmentDownloadErrorCode
    const allowed: AttachmentDownloadErrorCode[] = [
      "GMAIL_ATTACHMENT_NOT_FOUND",
      "GMAIL_NOT_CONNECTED",
      "ATTACHMENT_DECODE_FAILED",
    ]
    if (allowed.includes(code)) return code
  }
  return fallback
}

function safePersistedErrorCode(code: string | null): AttachmentDownloadErrorCode {
  const allowed: AttachmentDownloadErrorCode[] = [
    "ATTACHMENT_PERSISTENCE_FAILED",
    "ATTACHMENT_STORAGE_FAILED",
    "ATTACHMENT_STORAGE_COLLISION",
    "GMAIL_ATTACHMENT_NOT_FOUND",
    "GMAIL_NOT_CONNECTED",
    "ATTACHMENT_DECODE_FAILED",
  ]
  if (code && allowed.includes(code as AttachmentDownloadErrorCode)) {
    return code as AttachmentDownloadErrorCode
  }
  return "ATTACHMENT_PERSISTENCE_FAILED"
}
