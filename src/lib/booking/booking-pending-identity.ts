/**
 * PLAN-BOOKING-FINAL-2 — Identités PendingAccommodation.
 * Séparation stricte : Gmail ID ≠ bookingReference ≠ idempotencyKey.
 * Bornes = octets UTF-8 (alignées migration octet_length).
 */

import { z } from "zod"

export const PENDING_SOURCE_KIND = {
  GMAIL: "GMAIL",
  N8N: "N8N",
  AGENT: "AGENT",
  MANUAL: "MANUAL",
} as const

export type PendingSourceKind =
  (typeof PENDING_SOURCE_KIND)[keyof typeof PENDING_SOURCE_KIND]

/** Limites en octets UTF-8 (pas en nombre de caractères). */
export const BOOKING_REFERENCE_MAX_BYTES = 128
export const EXTERNAL_SOURCE_ID_MAX_BYTES = 128
export const GMAIL_MESSAGE_ID_MAX_BYTES = 256
export const IDEMPOTENCY_KEY_MAX_BYTES = 512

/** Alias de compatibilité (tests / imports existants) — valeurs = octets. */
export const BOOKING_REFERENCE_MAX_LENGTH = BOOKING_REFERENCE_MAX_BYTES
export const EXTERNAL_SOURCE_ID_MAX_LENGTH = EXTERNAL_SOURCE_ID_MAX_BYTES
export const GMAIL_MESSAGE_ID_MAX_LENGTH = GMAIL_MESSAGE_ID_MAX_BYTES
export const IDEMPOTENCY_KEY_MAX_LENGTH = IDEMPOTENCY_KEY_MAX_BYTES

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function assertUtf8MaxBytes(
  value: string,
  maxBytes: number,
  label: string
): void {
  if (utf8ByteLength(value) > maxBytes) {
    throw new Error(`${label} dépasse ${maxBytes} octets UTF-8`)
  }
}

/** Zod string : borne caractères préliminaire + refine octets stricte. */
export function zodUtf8Max(maxBytes: number, label: string) {
  return z
    .string()
    .max(maxBytes)
    .superRefine((val, ctx) => {
      if (utf8ByteLength(val) > maxBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} dépasse ${maxBytes} octets UTF-8`,
        })
      }
    })
}

/** Champ optionnel/nullable avec borne octets. */
export function zodUtf8MaxNullish(maxBytes: number, label: string) {
  return zodUtf8Max(maxBytes, label).nullish()
}

export function gmailPendingIdempotencyKey(gmailMessageId: string): string {
  if (!gmailMessageId) {
    throw new Error("gmailMessageId requis pour clé gmail:")
  }
  assertUtf8MaxBytes(
    gmailMessageId,
    GMAIL_MESSAGE_ID_MAX_BYTES,
    "gmailMessageId"
  )
  const key = `gmail:${gmailMessageId}`
  assertUtf8MaxBytes(key, IDEMPOTENCY_KEY_MAX_BYTES, "idempotencyKey")
  return key
}

export function n8nPendingIdempotencyKey(bookingReference: string): string {
  if (!bookingReference) {
    throw new Error("bookingReference requis pour clé n8n:")
  }
  assertUtf8MaxBytes(
    bookingReference,
    BOOKING_REFERENCE_MAX_BYTES,
    "bookingReference"
  )
  const key = `n8n:${bookingReference}`
  assertUtf8MaxBytes(key, IDEMPOTENCY_KEY_MAX_BYTES, "idempotencyKey")
  return key
}

export function agentPendingIdempotencyKey(stableId: string): string {
  if (!stableId) {
    throw new Error("stableId requis pour clé agent:")
  }
  assertUtf8MaxBytes(
    stableId,
    EXTERNAL_SOURCE_ID_MAX_BYTES,
    "identifiant agent"
  )
  const key = `agent:${stableId}`
  assertUtf8MaxBytes(key, IDEMPOTENCY_KEY_MAX_BYTES, "idempotencyKey")
  return key
}

export type AgentPendingIdentityOk = {
  ok: true
  stableId: string
  idempotencyKey: string
  externalSourceId: string | null
}

export type AgentPendingIdentityErr = {
  ok: false
  error: string
}

export function resolveAgentPendingIdentity(input: {
  bookingReference?: string | null
  externalEventId?: string | null
}): AgentPendingIdentityOk | AgentPendingIdentityErr {
  const eventId = input.externalEventId?.trim() || null
  const ref = input.bookingReference?.trim() || null

  try {
    if (eventId) {
      assertUtf8MaxBytes(
        eventId,
        EXTERNAL_SOURCE_ID_MAX_BYTES,
        "externalEventId"
      )
    }
    if (ref) {
      assertUtf8MaxBytes(ref, BOOKING_REFERENCE_MAX_BYTES, "bookingReference")
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  if (eventId) {
    try {
      return {
        ok: true,
        stableId: eventId,
        idempotencyKey: agentPendingIdempotencyKey(eventId),
        externalSourceId: ref,
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (ref) {
    try {
      return {
        ok: true,
        stableId: ref,
        idempotencyKey: agentPendingIdempotencyKey(ref),
        externalSourceId: ref,
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return {
    ok: false,
    error:
      "Identifiant stable requis (externalEventId ou bookingReference) pour créer un pending Agent.",
  }
}

export type PendingIdentityFields = {
  sourceKind: PendingSourceKind | string
  gmailMessageId: string | null
  externalSourceId: string | null
  idempotencyKey: string
}

export function accommodationFieldsFromPendingIdentity(
  pending: PendingIdentityFields
): {
  gmailSourceMessageId: string | null
  bookingReference: string | null
  source: string
} {
  switch (pending.sourceKind) {
    case PENDING_SOURCE_KIND.N8N:
      return {
        gmailSourceMessageId: null,
        bookingReference: pending.externalSourceId,
        source: "n8n",
      }
    case PENDING_SOURCE_KIND.AGENT:
      return {
        gmailSourceMessageId: null,
        bookingReference: pending.externalSourceId,
        source: "agent",
      }
    case PENDING_SOURCE_KIND.MANUAL:
      return {
        gmailSourceMessageId: null,
        bookingReference: pending.externalSourceId,
        source: "manual",
      }
    case PENDING_SOURCE_KIND.GMAIL:
    default:
      return {
        gmailSourceMessageId: pending.gmailMessageId,
        bookingReference: null,
        source: "gmail-scan",
      }
  }
}

export function isGmailAutoProcessSafe(pending: {
  sourceKind?: string | null
  gmailMessageId?: string | null
}): boolean {
  if (pending.sourceKind === PENDING_SOURCE_KIND.GMAIL) return true
  if (
    (pending.sourceKind == null || pending.sourceKind === "") &&
    Boolean(pending.gmailMessageId)
  ) {
    return true
  }
  return false
}
