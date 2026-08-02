/**
 * PLAN-BOOKING-PARSER-003 — Gate d’intent avant extract / Anthropic.
 * Core fin partagé : appelé par gmail-scan et testé directement.
 */

import {
  classifyBookingEmailIntent,
  resolveBookingIntentScanDisposition,
  type BookingEmailClassification,
  type BookingIntentScanStatsKey,
} from "@/lib/booking/booking-email-intent"
import type { ClassifiedBookingError } from "@/lib/booking/booking-gmail-errors"
import {
  permanentBookingError,
  retryableBookingError,
} from "@/lib/booking/booking-gmail-errors"

/** Compteurs d’intent du run cron (emails classifiés, pas pendings créés). */
export type BookingEmailIntentGateStats = Record<BookingIntentScanStatsKey, number>

/** Statuts lifecycle connus côté gate (union stricte). */
export type BookingEmailIntentLifecycleStatus =
  | "PERMANENTLY_IGNORED"
  | "RETRYABLE_FAILURE"
  | "SUCCEEDED"
  | "PROCESSING"
  | "UNKNOWN"

export type BookingEmailIntentLifecycleRow = {
  status: string
  errorCode: string | null
  nextRetryAt?: Date | null
}

/**
 * Télémétrie run : permanent / retryable uniquement pour les statuts exacts.
 * SUCCEEDED (course) et autres = explicites, jamais assimilés à permanent.
 */
export type BookingIntentGateTelemetryKind =
  | "permanent_ignored"
  | "retryable_failure"
  | "lifecycle_race_succeeded"
  | "lifecycle_unexpected"

export type ApplyBookingEmailIntentGateInput = {
  companyId: string
  messageId: string
  subject: string
  bodyText: string
  stats: BookingEmailIntentGateStats
  markPermanentIgnored: (
    companyId: string,
    messageId: string,
    error: ClassifiedBookingError
  ) => Promise<BookingEmailIntentLifecycleRow>
  markFailure: (input: {
    companyId: string
    messageId: string
    error: ClassifiedBookingError
  }) => Promise<BookingEmailIntentLifecycleRow>
  /**
   * Injection tests / override — défaut = classifieur réel.
   */
  classify?: typeof classifyBookingEmailIntent
}

export type ApplyBookingEmailIntentGateResult =
  | {
      action: "CONTINUE_CONFIRMATION"
      classification: BookingEmailClassification
    }
  | {
      action: "STOP"
      classification: BookingEmailClassification
      code: string
      reason: "PERMANENT_IGNORE" | "RETRYABLE_AMBIGUOUS"
      telemetryKind: BookingIntentGateTelemetryKind
      lifecycleStatus: BookingEmailIntentLifecycleStatus
      lifecycle: BookingEmailIntentLifecycleRow
    }

export function normalizeBookingIntentLifecycleStatus(
  status: string
): BookingEmailIntentLifecycleStatus {
  switch (status) {
    case "PERMANENTLY_IGNORED":
    case "RETRYABLE_FAILURE":
    case "SUCCEEDED":
    case "PROCESSING":
      return status
    default:
      return "UNKNOWN"
  }
}

export function telemetryKindFromLifecycleStatus(
  status: BookingEmailIntentLifecycleStatus
): BookingIntentGateTelemetryKind {
  switch (status) {
    case "PERMANENTLY_IGNORED":
      return "permanent_ignored"
    case "RETRYABLE_FAILURE":
      return "retryable_failure"
    case "SUCCEEDED":
      return "lifecycle_race_succeeded"
    default:
      return "lifecycle_unexpected"
  }
}

/**
 * Classifie subject+body, applique lifecycle hors-confirmation / ambigu,
 * incrémente les compteurs d’intent après succès lifecycle attendu uniquement.
 * Ne crée jamais de pending ; n’appelle jamais Anthropic.
 */
export async function applyBookingEmailIntentGate(
  input: ApplyBookingEmailIntentGateInput
): Promise<ApplyBookingEmailIntentGateResult> {
  const classify = input.classify ?? classifyBookingEmailIntent
  const classification = classify({
    subject: input.subject,
    bodyText: input.bodyText,
  })
  const disposition = resolveBookingIntentScanDisposition(classification)

  if (disposition.action === "PROCEED_CONFIRMATION") {
    input.stats.confirmationCount++
    return { action: "CONTINUE_CONFIRMATION", classification }
  }

  if (disposition.action === "PERMANENT_IGNORE") {
    const lifecycle = await input.markPermanentIgnored(
      input.companyId,
      input.messageId,
      permanentBookingError(disposition.code, disposition.message)
    )
    const lifecycleStatus = normalizeBookingIntentLifecycleStatus(lifecycle.status)
    const telemetryKind = telemetryKindFromLifecycleStatus(lifecycleStatus)
    // Compteur intent uniquement si ignore permanent réellement appliqué
    if (telemetryKind === "permanent_ignored") {
      input.stats[disposition.statsKey]++
    }
    return {
      action: "STOP",
      classification,
      code: disposition.code,
      reason: "PERMANENT_IGNORE",
      telemetryKind,
      lifecycleStatus,
      lifecycle,
    }
  }

  // RETRYABLE_AMBIGUOUS — aucun Anthropic, aucun pending
  const lifecycle = await input.markFailure({
    companyId: input.companyId,
    messageId: input.messageId,
    error: retryableBookingError(disposition.code, disposition.message),
  })
  const lifecycleStatus = normalizeBookingIntentLifecycleStatus(lifecycle.status)
  const telemetryKind = telemetryKindFromLifecycleStatus(lifecycleStatus)
  // Compteur ambigu seulement si le lifecycle a bien enregistré l’échec (retry ou plafond)
  if (
    telemetryKind === "retryable_failure" ||
    telemetryKind === "permanent_ignored"
  ) {
    input.stats.ambiguousCount++
  }
  return {
    action: "STOP",
    classification,
    code: disposition.code,
    reason: "RETRYABLE_AMBIGUOUS",
    telemetryKind,
    lifecycleStatus,
    lifecycle,
  }
}
