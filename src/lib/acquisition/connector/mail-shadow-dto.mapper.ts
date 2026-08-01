/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Mapper Acquisition → MailShadowInputDto — PUR (aucun repository).
 */

import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { MailShadowInputDtoInput } from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { normalizeSubject } from "@/lib/integration/normalizers/message/normalize-subject"

export type MailShadowDtoMapperContext = {
  companyId: string
  connectionId: string
  /** Instant ISO Z — défaut receivedAt message. */
  nowIso?: string
}

/**
 * Construit un DTO neutre. Aucune I/O.
 * payloadRef = référence opaque (externalMessageId) — jamais de body inline.
 */
export function mapCanonicalMailToShadowDto(
  message: CanonicalMailMessage,
  ctx: MailShadowDtoMapperContext
): MailShadowDtoMapperResult {
  if (!ctx.companyId || !ctx.connectionId) {
    return { ok: false, errorCode: "MISSING_CONTEXT" }
  }
  if (!message.externalMessageId) {
    return { ok: false, errorCode: "MISSING_EXTERNAL_ID" }
  }

  const receivedAt =
    message.receivedAt instanceof Date
      ? message.receivedAt.toISOString()
      : typeof message.receivedAt === "string"
        ? message.receivedAt
        : ctx.nowIso ?? new Date().toISOString()

  const senderEmail = message.fromHeader?.trim()
  const domain = senderEmail?.includes("@")
    ? senderEmail.split("@")[1]?.toLowerCase()
    : undefined

  // LOT-2A — subject optionnel déjà présent dans le poll (aucun second fetch).
  // Invariant : normalizeSubject obligatoire (borne 512 Unicode-safe).
  const subject = normalizeSubject(message.subject)

  const dto: MailShadowInputDtoInput = {
    companyId: ctx.companyId,
    connectionId: ctx.connectionId,
    externalId: message.externalMessageId,
    idempotencyKey: message.externalMessageId,
    receivedAt,
    occurredAt: receivedAt,
    payloadRef: `mail:${message.externalMessageId}`,
    contentType: "message/rfc822",
    message: {
      externalMessageId: message.externalMessageId,
      contentCapabilities: [
        MESSAGE_CONTENT_CAPABILITIES.CONTENT_FETCHABLE,
        MESSAGE_CONTENT_CAPABILITIES.ATTACHMENTS_FETCHABLE,
      ],
      ...(senderEmail || domain
        ? {
            sender: {
              ...(senderEmail ? { email: senderEmail } : {}),
              ...(domain ? { domain } : {}),
            },
          }
        : {}),
      ...(subject ? { subject } : {}),
    },
  }

  return { ok: true, dto }
}

export type MailShadowDtoMapperResult =
  | { ok: true; dto: MailShadowInputDtoInput }
  | { ok: false; errorCode: string }
