/**
 * Critères minimaux avant création PendingAccommodation / Accommodation (gmail-scan).
 * L’équipe n’est pas un critère — choisie à la confirmation humaine.
 *
 * Décisions :
 * - ACCEPT → continuer (Pending ou Acc selon flags)
 * - PERMANENT_IGNORE → uniquement BEFORE_CUTOFF (start valide &lt; cutoff)
 * - RETRYABLE_REJECT → champs manquants / invalides (pas de Pending/Acc)
 */

import { hasBookingAddress } from "@/lib/booking/booking-pending-merge"
import {
  isCalendarRangeValid,
  parseStrictCalendarYmd,
} from "@/lib/booking/booking-date-only"

export type BookingParsedForPendingGate = {
  startDate?: string | null
  endDate?: string | null
  address?: string | null
}

export type PendingCreationRetryableCode =
  | "MISSING_START_DATE"
  | "MISSING_END_DATE"
  | "MISSING_ADDRESS"
  | "INVALID_START_DATE"
  | "INVALID_END_DATE"
  | "INVALID_DATE_RANGE"

export type PendingCreationGateResult =
  | { decision: "ACCEPT" }
  | {
      decision: "PERMANENT_IGNORE"
      code: "BEFORE_CUTOFF"
      message: string
    }
  | {
      decision: "RETRYABLE_REJECT"
      code: PendingCreationRetryableCode
      message: string
    }

function hasNonEmptyString(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Ordre : présence start → validité start → présence end → validité end →
 * adresse → plage end>=start → cutoff (permanent si start &lt; cutoff).
 */
export function evaluatePendingCreationGate(
  parsed: BookingParsedForPendingGate,
  cutoff: Date
): PendingCreationGateResult {
  if (!hasNonEmptyString(parsed.startDate)) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "MISSING_START_DATE",
      message: "Date d'arrivée absente après extraction",
    }
  }
  const startDate = parseStrictCalendarYmd(parsed.startDate!)
  if (!startDate) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "INVALID_START_DATE",
      message: "Date d'arrivée invalide (YYYY-MM-DD calendaire)",
    }
  }

  if (!hasNonEmptyString(parsed.endDate)) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "MISSING_END_DATE",
      message: "Date de départ absente après extraction",
    }
  }
  const endDate = parseStrictCalendarYmd(parsed.endDate!)
  if (!endDate) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "INVALID_END_DATE",
      message: "Date de départ invalide (YYYY-MM-DD calendaire)",
    }
  }

  if (!hasBookingAddress(parsed)) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "MISSING_ADDRESS",
      message: "Adresse absente ou vide après extraction",
    }
  }

  if (!isCalendarRangeValid(startDate, endDate)) {
    return {
      decision: "RETRYABLE_REJECT",
      code: "INVALID_DATE_RANGE",
      message: "Date de départ antérieure à la date d'arrivée",
    }
  }

  if (startDate.getTime() < cutoff.getTime()) {
    return {
      decision: "PERMANENT_IGNORE",
      code: "BEFORE_CUTOFF",
      message: "Date d'arrivée antérieure à la coupure de scan",
    }
  }

  return { decision: "ACCEPT" }
}
