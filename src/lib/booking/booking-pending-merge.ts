/**
 * Fusion idempotente des champs PendingAccommodation (rejeu scan).
 * N’écrase jamais une valeur non vide par null / vide.
 * Ne touche pas status / décisions humaines (CONFIRMED / DISMISSED).
 *
 * Contrat `rawEmailSnippet` (nom historique) :
 * - côté serveur : contenu de reprise borné (jusqu’à BOOKING_EMAIL_BODY_PERSIST_MAX)
 *   pour autoProcess / rejeu — PAS un mere snippet Gmail ;
 * - côté UI : uniquement via `toBookingUiEmailPreview` (≤ BOOKING_UI_EMAIL_PREVIEW_MAX).
 * Ne jamais envoyer le corps complet au navigateur.
 */

import type { PendingAccommodation, PendingAccommodationStatus } from "@prisma/client"

export type BookingFieldPatch = Record<string, string | null>

/** Persistance serveur (reprise) — pas pour le client. */
export const BOOKING_EMAIL_BODY_PERSIST_MAX = 4000

/**
 * Défaut / bornes pour le texte passé à l’extraction (≠ persistance).
 * Configurable via `BOOKING_EMAIL_EXTRACT_MAX` (entier positif borné).
 */
export const BOOKING_EMAIL_EXTRACT_MAX_DEFAULT = 16000
export const BOOKING_EMAIL_EXTRACT_MAX_MIN = 4000
export const BOOKING_EMAIL_EXTRACT_MAX_CEILING = 64000

/** Aperçu UI uniquement — jamais le corps complet. */
export const BOOKING_UI_EMAIL_PREVIEW_MAX = 500

/** Snippet Gmail trop court pour une 2ᵉ extraction fiable. */
export const BOOKING_SNIPPET_RICH_MIN = 501

/**
 * Limite d’extraction : entier positif dans [MIN, CEILING], sinon défaut 16000.
 * N’utilise jamais une valeur illimitée.
 */
export function getBookingEmailExtractMax(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.BOOKING_EMAIL_EXTRACT_MAX
  if (raw === undefined) return BOOKING_EMAIL_EXTRACT_MAX_DEFAULT
  const trimmed = raw.trim()
  if (!trimmed) return BOOKING_EMAIL_EXTRACT_MAX_DEFAULT
  const n = Number(trimmed)
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < BOOKING_EMAIL_EXTRACT_MAX_MIN ||
    n > BOOKING_EMAIL_EXTRACT_MAX_CEILING
  ) {
    return BOOKING_EMAIL_EXTRACT_MAX_DEFAULT
  }
  return n
}

/** Tronque pour `extractBookingFields` / rejeu d’extraction. */
export function truncateBookingEmailForExtract(text: string): string {
  return text.substring(0, getBookingEmailExtractMax())
}

/** Tronque pour `rawEmailSnippet` / persistance serveur. */
export function truncateBookingEmailForPersist(text: string): string {
  return text.substring(0, BOOKING_EMAIL_BODY_PERSIST_MAX)
}

/**
 * Représentation UI bornée du contenu email (aperçu).
 * Ne modifie pas la donnée persistée ; pure / testable.
 */
export function toBookingUiEmailPreview(
  rawEmailSnippet: string | null | undefined
): string | null {
  const t = rawEmailSnippet?.trim()
  if (!t) return null
  return t.length <= BOOKING_UI_EMAIL_PREVIEW_MAX
    ? t
    : t.slice(0, BOOKING_UI_EMAIL_PREVIEW_MAX)
}

export type PendingMergeSource = Pick<
  PendingAccommodation,
  | "status"
  | "propertyName"
  | "address"
  | "city"
  | "zipCode"
  | "startDate"
  | "endDate"
  | "doorCode"
  | "contactName"
  | "contactPhone"
  | "notes"
  | "rawEmailSnippet"
>

function nonEmpty(value: string | null | undefined): string | null {
  const t = value?.trim()
  return t ? t : null
}

function preferExisting(
  current: string | null | undefined,
  incoming: string | null | undefined
): string | null {
  return nonEmpty(current) ?? nonEmpty(incoming)
}

function preferExistingDate(
  current: Date | null | undefined,
  incomingIso: string | null | undefined
): Date | null | undefined {
  if (current) return undefined // pas de changement
  const iso = nonEmpty(incomingIso)
  if (!iso) return undefined
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Construit le patch Prisma pour enrichir un pending PENDING.
 * Retourne null si statut non fusionnable ou aucun champ à mettre à jour.
 */
export function buildPendingEnrichmentUpdate(
  existing: PendingMergeSource,
  parsed: BookingFieldPatch,
  emailBodyForPersist?: string | null
): Record<string, unknown> | null {
  if (existing.status !== ("PENDING" satisfies PendingAccommodationStatus)) {
    return null
  }

  const data: Record<string, unknown> = {}

  const propertyName = preferExisting(existing.propertyName, parsed.propertyName)
  if (propertyName !== (existing.propertyName ?? null)) data.propertyName = propertyName

  const address = preferExisting(existing.address, parsed.address)
  if (address !== (existing.address ?? null)) data.address = address

  const city = preferExisting(existing.city, parsed.city)
  if (city !== (existing.city ?? null)) data.city = city

  const zipCode = preferExisting(existing.zipCode, parsed.zipCode)
  if (zipCode !== (existing.zipCode ?? null)) data.zipCode = zipCode

  const doorCode = preferExisting(existing.doorCode, parsed.doorCode)
  if (doorCode !== (existing.doorCode ?? null)) data.doorCode = doorCode

  const contactName = preferExisting(existing.contactName, parsed.contactName)
  if (contactName !== (existing.contactName ?? null)) data.contactName = contactName

  const contactPhone = preferExisting(existing.contactPhone, parsed.contactPhone)
  if (contactPhone !== (existing.contactPhone ?? null)) data.contactPhone = contactPhone

  const notes = preferExisting(existing.notes, parsed.notes)
  if (notes !== (existing.notes ?? null)) data.notes = notes

  const startDate = preferExistingDate(existing.startDate, parsed.startDate)
  if (startDate !== undefined) data.startDate = startDate

  const endDate = preferExistingDate(existing.endDate, parsed.endDate)
  if (endDate !== undefined) data.endDate = endDate

  const incomingRaw = nonEmpty(emailBodyForPersist)
  const incomingBody = incomingRaw
    ? truncateBookingEmailForPersist(incomingRaw)
    : undefined
  if (incomingBody) {
    const current = existing.rawEmailSnippet ?? ""
    if (incomingBody.length > current.length) {
      data.rawEmailSnippet = incomingBody
    }
  }

  return Object.keys(data).length > 0 ? data : null
}

export function hasBookingAddress(parsed: BookingFieldPatch): boolean {
  return Boolean(nonEmpty(parsed.address))
}

/**
 * Résolution d’adresse pour confirmPendingAccommodation (extrait / override).
 */
export function resolveConfirmAddress(
  pendingAddress: string | null | undefined,
  overrideAddress?: string | null
): string | null {
  return nonEmpty(pendingAddress) ?? nonEmpty(overrideAddress)
}

/**
 * Choisit le texte pour une 2ᵉ extraction (autoProcess).
 * Ordre : corps persisté riche → corps Gmail → snippet / propertyName.
 */
export function pickEmailTextForReprocess(input: {
  propertyName: string | null
  persistedText: string | null
  gmailBody: string | null
  snippetFallback: string | null
}): { text: string; source: "persisted" | "gmail" | "snippet" | "empty" } {
  const persisted = nonEmpty(input.persistedText)
  if (persisted && persisted.length >= BOOKING_SNIPPET_RICH_MIN) {
    return { text: truncateBookingEmailForExtract(persisted), source: "persisted" }
  }

  const gmail = nonEmpty(input.gmailBody)
  if (gmail) {
    return { text: truncateBookingEmailForExtract(gmail), source: "gmail" }
  }

  if (persisted) {
    return { text: truncateBookingEmailForExtract(persisted), source: "persisted" }
  }

  const parts = [nonEmpty(input.propertyName), nonEmpty(input.snippetFallback)].filter(
    Boolean
  ) as string[]
  if (parts.length === 0) return { text: "", source: "empty" }
  return { text: truncateBookingEmailForExtract(parts.join("\n")), source: "snippet" }
}
