/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Family Normalizer MESSAGE — sans I/O Prisma.
 */

import {
  normalizedMessageSchema,
  type NormalizedMessage,
} from "@/lib/integration/contracts/normalized-message"
import type { MailShadowInputDto } from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import { computeNormalizedMessageHash } from "@/lib/integration/normalizers/message/normalized-hash"

export type MessageNormalizeSuccess = {
  ok: true
  message: NormalizedMessage
  normalizedHash: string
}

export type MessageNormalizeFailure = {
  ok: false
  errorCode: "NORMALIZE_VALIDATION"
  message: string
}

export type MessageNormalizeResult = MessageNormalizeSuccess | MessageNormalizeFailure

/**
 * Produit NormalizedMessage + hash à partir du DTO déjà parsé.
 */
export function normalizeMessageFamily(
  dto: MailShadowInputDto
): MessageNormalizeResult {
  try {
    const message = normalizedMessageSchema.parse(dto.message)
    const normalizedHash = computeNormalizedMessageHash(message)
    return { ok: true, message, normalizedHash }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "normalize validation failed"
    return { ok: false, errorCode: "NORMALIZE_VALIDATION", message }
  }
}
