import type { Role } from "@prisma/client"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import type {
  AttachmentAccessAuditRepositoryPort,
  AttachmentAccessFetcherPort,
  AttachmentAccessRepositoryPort,
  AttachmentAccessServiceDeps,
  AttachmentUrlSignerPort,
} from "@/lib/acquisition/access/attachment-access.port"
import { attachmentAccessAuditRepository } from "@/lib/acquisition/access/attachment-access-audit.repository"
import { attachmentAccessRepository } from "@/lib/acquisition/access/attachment-access.repository"
import { cloudinaryAttachmentUrlSigner } from "@/lib/acquisition/access/attachment-url-signer"
import type {
  AttachmentAccessAuditEntry,
  AttachmentAccessContext,
  AttachmentAccessFailure,
  AttachmentAccessMode,
  AttachmentAccessReasonCode,
  AttachmentAccessResult,
  AttachmentAccessSuccess,
} from "@/lib/acquisition/access/attachment-access.types"
import {
  getSignedUrlTtlSeconds,
  isAttachmentAccessEnabled,
} from "@/lib/acquisition/access/attachment-access.types"

const LOG_PREFIX = "[acquisition-attachment-access]"

const ALLOWED_ROLES = new Set<Role>(["ADMIN", "TEAM_LEADER", "SUPER_ADMIN"])

export interface AccessAcquisitionAttachmentInput {
  context: AttachmentAccessContext
  attachmentId: string
  mode: AttachmentAccessMode
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function failure(
  kind: AttachmentAccessFailure["kind"],
  reasonCode: AttachmentAccessReasonCode
): AttachmentAccessFailure {
  return { kind, reasonCode }
}

function defaultFetcher(): AttachmentAccessFetcherPort {
  return {
    fetchSignedResource: async ({ url }) => {
      try {
        const response = await fetch(url)
        const contentLengthHeader = response.headers.get("content-length")
        const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null
        return {
          ok: response.ok,
          status: response.status,
          body: response.body,
          contentLength: Number.isFinite(contentLength ?? NaN) ? contentLength : null,
        }
      } catch {
        return { ok: false, status: 0, body: null, contentLength: null }
      }
    },
  }
}

async function writeAudit(
  auditRepository: AttachmentAccessAuditRepositoryPort,
  entry: AttachmentAccessAuditEntry
): Promise<boolean> {
  try {
    await auditRepository.record(entry)
    return true
  } catch {
    return false
  }
}

function isRoleAllowed(context: AttachmentAccessContext): boolean {
  if (!ALLOWED_ROLES.has(context.role)) return false
  if (context.role === "SUPER_ADMIN") return Boolean(context.companyId)
  return Boolean(context.companyId)
}

/**
 * Consultation sécurisée d'une pièce jointe STORED — proxy streaming, audit fail-closed.
 */
export async function accessAcquisitionAttachment(
  input: AccessAcquisitionAttachmentInput,
  deps: AttachmentAccessServiceDeps = {}
): Promise<AttachmentAccessResult> {
  const repository = deps.repository ?? attachmentAccessRepository
  const signer = deps.signer ?? cloudinaryAttachmentUrlSigner
  const fetcher = deps.fetcher ?? defaultFetcher()
  const auditRepository = deps.auditRepository ?? attachmentAccessAuditRepository
  const clock = deps.clock ?? (() => new Date())
  const log = deps.log ?? defaultLog

  const action = input.mode === "DOWNLOAD" ? "DOWNLOAD" : "VIEW"

  if (!isAcquisitionEnabled() || !isAttachmentAccessEnabled()) {
    log("ACCESS_DISABLED")
    return failure("DISABLED", "ATTACHMENT_ACCESS_DISABLED")
  }

  if (!input.context.userId) {
    return failure("UNAUTHORIZED", "ATTACHMENT_ACCESS_UNAUTHENTICATED")
  }

  if (!isRoleAllowed(input.context)) {
    return failure("FORBIDDEN", "ATTACHMENT_ACCESS_FORBIDDEN")
  }

  const companyId = input.context.companyId!
  const auditBase = {
    companyId,
    requestedAttachmentId: input.attachmentId,
    userId: input.context.userId,
    action,
  } satisfies Pick<
    AttachmentAccessAuditEntry,
    "companyId" | "requestedAttachmentId" | "userId" | "action"
  >

  const attachment = await repository.findConsultableAttachment({
    companyId,
    attachmentId: input.attachmentId,
  })

  if (!attachment) {
    const audited = await writeAudit(auditRepository, {
      ...auditBase,
      attachmentId: null,
      outcome: "DENIED",
      reasonCode: "ATTACHMENT_ACCESS_NOT_FOUND",
    })
    if (!audited) {
      log("AUDIT_FAILED", { outcome: "DENIED" })
      return failure("SERVICE_UNAVAILABLE", "ATTACHMENT_ACCESS_AUDIT_FAILED")
    }
    log("ACCESS_DENIED", { reasonCode: "ATTACHMENT_ACCESS_NOT_FOUND" })
    return failure("NOT_FOUND", "ATTACHMENT_ACCESS_NOT_FOUND")
  }

  let signedUrl: string
  try {
    const ttlSeconds = getSignedUrlTtlSeconds(clock)
    const expiresAt = new Date(clock().getTime() + ttlSeconds * 1000)
    const signed = await signer.createSignedUrl({
      storagePublicId: attachment.storagePublicId,
      expiresAt,
    })
    signedUrl = signed.url
  } catch {
    log("SIGN_FAILED", { attachmentId: attachment.id })
    return failure("BAD_GATEWAY", "ATTACHMENT_ACCESS_SIGN_FAILED")
  }

  const fetched = await fetcher.fetchSignedResource({ url: signedUrl })
  if (!fetched.ok || !fetched.body) {
    log("FETCH_FAILED", { attachmentId: attachment.id, status: fetched.status })
    return failure("BAD_GATEWAY", "ATTACHMENT_ACCESS_FETCH_FAILED")
  }

  const audited = await writeAudit(auditRepository, {
    ...auditBase,
    attachmentId: attachment.id,
    outcome: "GRANTED",
    reasonCode: null,
  })

  if (!audited) {
    try {
      await fetched.body.cancel()
    } catch {
      /* ignore */
    }
    log("AUDIT_FAILED", { outcome: "GRANTED" })
    return failure("SERVICE_UNAVAILABLE", "ATTACHMENT_ACCESS_AUDIT_FAILED")
  }

  log("ACCESS_GRANTED", {
    attachmentId: attachment.id,
    companyId,
    userId: input.context.userId,
    mode: input.mode,
  })

  const success: AttachmentAccessSuccess = {
    kind: "OK",
    stream: fetched.body,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    contentLength: fetched.contentLength,
    mode: input.mode,
  }
  return success
}

export function mapAccessResultToStatus(result: AttachmentAccessResult): number {
  switch (result.kind) {
    case "OK":
      return 200
    case "UNAUTHORIZED":
      return 401
    case "FORBIDDEN":
      return 403
    case "NOT_FOUND":
      return 404
    case "DISABLED":
      return 503
    case "SERVICE_UNAVAILABLE":
      return 503
    case "BAD_GATEWAY":
      return 502
    default:
      return 500
  }
}

export function mapAccessResultToPublicMessage(result: AttachmentAccessFailure): string {
  switch (result.kind) {
    case "UNAUTHORIZED":
      return "Non autorisé"
    case "FORBIDDEN":
      return "Accès refusé"
    case "NOT_FOUND":
      return "Pièce jointe introuvable"
    case "DISABLED":
    case "SERVICE_UNAVAILABLE":
      return "Service indisponible"
    case "BAD_GATEWAY":
      return "Impossible de récupérer le fichier"
    default:
      return "Erreur interne"
  }
}

export function buildAccessResponseHeaders(
  result: AttachmentAccessSuccess
): Record<string, string> {
  const dispositionType = result.mode === "DOWNLOAD" ? "attachment" : "inline"
  const headers: Record<string, string> = {
    "Content-Type": result.mimeType,
    "Content-Disposition": `${dispositionType}; filename="${encodeURIComponent(result.filename)}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  }
  if (result.contentLength != null) {
    headers["Content-Length"] = String(result.contentLength)
  }
  return headers
}
