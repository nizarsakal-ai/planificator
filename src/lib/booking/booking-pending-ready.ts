/**
 * PLAN-BOOKING-UX-002 R1+ — Complétude PendingAccommodation (UI / validation métier).
 * Pas de statut Prisma.
 *
 * Concepts séparés :
 * A. Identité pending exploitable : propertyName OU address (affichage / revue).
 * B. Créabilité Accommodation (schéma actuel, address NOT NULL) :
 *    address + startDate + endDate cohérentes.
 * C. teamId : gate du bouton seulement — n’altère pas le badge banner/dialog.
 *
 * Interdit : persister propertyName dans Accommodation.address.
 */

import { isCalendarRangeValid } from "@/lib/booking/booking-date-only"

export type PendingCompletenessStatus =
  | "READY"
  | "NEEDS_REVIEW"
  | "ACTION_REQUIRED"

export type PendingCompletenessInput = {
  propertyName?: string | null
  address?: string | null
  city?: string | null
  zipCode?: string | null
  startDate?: Date | string | null
  endDate?: Date | string | null
  doorCode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  notes?: string | null
  /** Présent uniquement dans le dialog (sélection équipe). */
  teamId?: string | null
  /**
   * Signal explicite de doute / faible confiance (extraction, ops).
   * Ne pas déduire uniquement d’un téléphone/CP/digicode absent.
   */
  requiresHumanReview?: boolean
}

export type PendingCompletenessResult = {
  status: PendingCompletenessStatus
  /** address + dates présentes et cohérentes (aligné refus serveur). */
  canCreate: boolean
  /** canCreate + équipe sélectionnée (si teamId dans le scope). */
  canValidate: boolean
  /** Identité pending : nom OU adresse (indépendant de la créabilité). */
  hasIdentityLabel: boolean
  missingRequired: string[]
  missingOptional: string[]
  label: string
  hint: string | null
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function hasDate(value: Date | string | null | undefined): boolean {
  if (value == null || value === "") return false
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  return String(value).trim().length > 0
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!hasDate(value)) return null
  if (value instanceof Date) return value
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Identifiant exploitable du pending : nom logement OU adresse. */
export function hasPendingIdentityLabel(p: {
  propertyName?: string | null
  address?: string | null
}): boolean {
  return Boolean(nonEmpty(p.propertyName) || nonEmpty(p.address))
}

/**
 * Adresse pour confirm → Accommodation.address (NOT NULL).
 * Uniquement override ou address réelle — jamais propertyName.
 */
export function resolveConfirmAccommodationAddress(input: {
  address?: string | null
  overrideAddress?: string | null
}): string | null {
  return nonEmpty(input.overrideAddress) ?? nonEmpty(input.address)
}

function formatMissingHint(missing: string[]): string {
  if (missing.length === 0) return "Informations indispensables manquantes."
  if (missing.length === 1) {
    return `Champ bloquant : ${missing[0]}. Complétez-le pour créer le logement.`
  }
  return `Champs bloquants : ${missing.join(", ")}. Complétez-les pour créer le logement.`
}

export function evaluatePendingCompleteness(
  p: PendingCompletenessInput
): PendingCompletenessResult {
  const missingRequired: string[] = []
  const missingOptional: string[] = []

  const hasName = Boolean(nonEmpty(p.propertyName))
  const hasAddress = Boolean(nonEmpty(p.address))
  const hasIdentityLabel = hasName || hasAddress

  // Créabilité Accommodation : address obligatoire (pas propertyName).
  if (!hasAddress) missingRequired.push("adresse")
  if (!hasDate(p.startDate)) missingRequired.push("arrivée")
  if (!hasDate(p.endDate)) missingRequired.push("départ")

  // Facultatifs — informatifs seulement, jamais cause de NEEDS_REVIEW seuls.
  if (!hasName && hasAddress) missingOptional.push("nom logement")
  if (!nonEmpty(p.city)) missingOptional.push("ville")
  if (!nonEmpty(p.zipCode)) missingOptional.push("code postal")
  if (!nonEmpty(p.doorCode)) missingOptional.push("digicode")
  if (!nonEmpty(p.contactName)) missingOptional.push("contact")
  if (!nonEmpty(p.contactPhone)) missingOptional.push("téléphone")
  if (!nonEmpty(p.notes)) missingOptional.push("remarques")

  const teamInScope = p.teamId !== undefined
  const teamSelected =
    !teamInScope || Boolean(nonEmpty(p.teamId ?? null))

  if (missingRequired.length > 0) {
    return {
      status: "ACTION_REQUIRED",
      canCreate: false,
      canValidate: false,
      hasIdentityLabel,
      missingRequired,
      missingOptional,
      label: "Action requise",
      hint: formatMissingHint(missingRequired),
    }
  }

  const start = asDate(p.startDate)
  const end = asDate(p.endDate)
  const datesIncoherent =
    start != null && end != null && !isCalendarRangeValid(start, end)

  // Aligné serveur : range invalide → pas de création / pas de bouton actif.
  if (datesIncoherent) {
    return {
      status: "NEEDS_REVIEW",
      canCreate: false,
      canValidate: false,
      hasIdentityLabel,
      missingRequired,
      missingOptional,
      label: "À vérifier",
      hint: "Champ à vérifier : les dates (le départ doit être après l'arrivée).",
    }
  }

  const canCreate = true
  const canValidate = canCreate && teamSelected

  if (p.requiresHumanReview) {
    return {
      status: "NEEDS_REVIEW",
      canCreate,
      canValidate,
      hasIdentityLabel,
      missingRequired,
      missingOptional,
      label: "À vérifier",
      hint: "Certaines données extraites demandent une vérification humaine avant création.",
    }
  }

  // PRÊT : données de création présentes ; facultatifs absents OK.
  // Équipe manquante : badge reste Prêt ; seul le bouton est désactivé.
  return {
    status: "READY",
    canCreate,
    canValidate,
    hasIdentityLabel,
    missingRequired,
    missingOptional,
    label: "Prêt",
    hint: teamSelected
      ? null
      : "Sélectionnez une équipe pour activer « Valider et créer ».",
  }
}

/**
 * Compatibilité UX-001 / bannière : créable Accommodation = address + dates cohérentes.
 */
export function isPendingReady(p: {
  propertyName?: string | null
  address: string | null | undefined
  startDate: Date | string | null | undefined
  endDate: Date | string | null | undefined
}): boolean {
  return evaluatePendingCompleteness({
    propertyName: p.propertyName,
    address: p.address,
    startDate: p.startDate,
    endDate: p.endDate,
  }).canCreate
}
