/**
 * Extraction des champs Booking depuis un email (IA + fallback regex).
 * Distingue : analyse réelle sans donnée utile vs réponse fournisseur inexploitable.
 */

import {
  retryableBookingError,
  type ClassifiedBookingError,
} from "@/lib/booking/booking-gmail-errors"

export type BookingParsedFields = Record<string, string | null>

export const BOOKING_FIELD_KEYS = [
  "propertyName",
  "address",
  "city",
  "zipCode",
  "startDate",
  "endDate",
  "doorCode",
  "contactName",
  "contactPhone",
  "notes",
  "teamName",
] as const

export type BookingFieldKey = (typeof BOOKING_FIELD_KEYS)[number]

/** Client IA minimal (injectable pour tests). */
export type BookingAiClient = {
  messages: {
    create: (params: {
      model: string
      max_tokens: number
      system: string
      messages: Array<{ role: "user" | "assistant"; content: string }>
    }) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

const FRENCH_MONTHS: Record<string, string> = {
  janvier: "01",
  février: "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  août: "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  décembre: "12",
  decembre: "12",
}

function emptyBookingFields(): BookingParsedFields {
  return {
    propertyName: null,
    address: null,
    city: null,
    zipCode: null,
    startDate: null,
    endDate: null,
    doorCode: null,
    contactPhone: null,
    contactName: null,
    teamName: null,
    notes: null,
  }
}

export function hasUsefulBookingData(parsed: BookingParsedFields): boolean {
  return Boolean(
    parsed.address || parsed.startDate || parsed.endDate || parsed.propertyName
  )
}

export function parseFrenchDate(raw: string): string | null {
  const m = raw.match(/(\d{1,2})\s+([a-zéûô\.]+)\s+(\d{4})/i)
  if (m) {
    const day = m[1].padStart(2, "0")
    const month = FRENCH_MONTHS[m[2].toLowerCase().replace(".", "")] ?? null
    if (month) return `${m[3]}-${month}-${day}`
  }
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const slashes = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (slashes) {
    return `${slashes[3]}-${slashes[2].padStart(2, "0")}-${slashes[1].padStart(2, "0")}`
  }
  return null
}

export function regexFallbackParser(text: string): BookingParsedFields {
  const result = emptyBookingFields()

  const propMatch = text.match(
    /(?:appartement|appart|logement|villa|studio|maison|résidence)\s*[:\-]?\s*([A-Z][^\n]{3,60})/i
  )
  if (propMatch) result.propertyName = propMatch[1].trim()

  const addrMatch = text.match(
    /(\d{1,4}[\s,]+(?:rue|avenue|av\.|boulevard|bd\.?|chemin|impasse|allée|place|route|voie)[^\n,]{3,60})/i
  )
  if (addrMatch) result.address = addrMatch[1].trim()

  const zipMatch = text.match(/\b((?:0[1-9]|[1-8]\d|9[0-5])\d{3})\b/)
  if (zipMatch) result.zipCode = zipMatch[1]

  if (result.zipCode) {
    const cityMatch = text.match(
      new RegExp(result.zipCode + "\\s+([A-ZÀ-Ÿ][a-zà-ÿA-ZÀ-Ÿ\\s\\-]{2,40})")
    )
    if (cityMatch) result.city = cityMatch[1].trim()
  }

  const DATE_PAT =
    "(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\\s*(\\d{1,2}[\\s\\/\\-][a-zéûôA-Z\\d]{2,12}[\\s\\/\\-]\\d{4}|\\d{4}-\\d{2}-\\d{2})"

  const startMatch = text.match(
    new RegExp("(?:arrivée|arrivee|check[\\s\\-]in)[\\s\\S]{0,30}?" + DATE_PAT, "i")
  )
  if (startMatch) result.startDate = parseFrenchDate(startMatch[1] ?? startMatch[0])

  const endMatch = text.match(
    new RegExp("(?:départ|depart|check[\\s\\-]out)[\\s\\S]{0,30}?" + DATE_PAT, "i")
  )
  if (endMatch) result.endDate = parseFrenchDate(endMatch[1] ?? endMatch[0])

  if (!result.startDate || !result.endDate) {
    const duAuMatch = text.match(
      /du\s+(\d{1,2}\s+[a-zéûô]+\s+\d{4})\s+au\s+(\d{1,2}\s+[a-zéûô]+\s+\d{4})/i
    )
    if (duAuMatch) {
      if (!result.startDate) result.startDate = parseFrenchDate(duAuMatch[1])
      if (!result.endDate) result.endDate = parseFrenchDate(duAuMatch[2])
    }
  }

  const doorMatch = text.match(
    /(?:code[^:]*|digicode[^:]*)\s*[:\-]\s*([A-Z0-9#\*]{3,10})/i
  )
  if (doorMatch) result.doorCode = doorMatch[1].trim()

  const phoneMatch = text.match(/(?:\+33|0033|0)\s*[1-9](?:[\s.\-]?\d{2}){4}/)
  if (phoneMatch) result.contactPhone = phoneMatch[0].replace(/\s/g, "")

  const teamMatch = text.match(
    /(?:for\s+guest|guest|réservation de|reservation de|booked by)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝ][a-zà-ÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝ][a-zà-ÿ]+)?)/i
  )
  if (teamMatch) result.teamName = teamMatch[1].trim()

  return result
}

/**
 * Normalise une charge JSON IA. Retourne null si structure inexploitable
 * (non-objet, tableau, champs de type invalide, texte vide après parse).
 */
export function normalizeAiBookingJson(raw: unknown): BookingParsedFields | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null
  }
  const src = raw as Record<string, unknown>
  const out = emptyBookingFields()
  for (const key of BOOKING_FIELD_KEYS) {
    if (!(key in src)) continue
    const v = src[key]
    if (v === null || v === undefined) {
      out[key] = null
      continue
    }
    if (typeof v !== "string") {
      return null
    }
    out[key] = v
  }
  return out
}

/**
 * Interprète un bloc de contenu IA. Retourne les champs ou null si inexploitable.
 */
export function tryParseAiBookingContent(content: {
  type: string
  text?: string
}): BookingParsedFields | null {
  if (content.type !== "text") return null
  const text = content.text?.trim() ?? ""
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return normalizeAiBookingJson(parsed)
}

function throwProviderInvalidOrContinueWithRegex(
  emailText: string,
  reason: string
): BookingParsedFields {
  const fallback = regexFallbackParser(emailText)
  if (hasUsefulBookingData(fallback)) {
    return fallback
  }
  throw retryableBookingError(
    "PROVIDER_INVALID_RESPONSE",
    reason || "Réponse fournisseur IA inexploitable et regex vide"
  )
}

function throwProviderTemporaryOrContinueWithRegex(
  emailText: string,
  err: unknown
): BookingParsedFields {
  const fallback = regexFallbackParser(emailText)
  if (hasUsefulBookingData(fallback)) {
    return fallback
  }
  throw retryableBookingError(
    "PROVIDER_TEMPORARY",
    err instanceof Error ? err.message : "Claude unavailable and regex empty"
  )
}

/**
 * Extraction Booking : IA si disponible, sinon regex.
 * - Réponse IA valide (même sans donnée utile) → retourne le parse (permanent décidé en aval).
 * - Réponse IA inexploitable + regex utile → fallback.
 * - Réponse IA inexploitable + regex vide → RETRYABLE (jamais NO_USEFUL ici).
 */
export async function extractBookingFields(
  emailText: string,
  messageId: string,
  anthropic: BookingAiClient | null
): Promise<BookingParsedFields> {
  if (!anthropic) {
    console.warn(
      `[gmail-scan] No ANTHROPIC_API_KEY – using regex fallback for message ${messageId}`
    )
    return regexFallbackParser(emailText)
  }

  try {
    const today = new Date().toISOString().split("T")[0]
    const aiRes = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: `Tu analyses des emails de confirmation Booking.com et extrais les informations de logement.
Aujourd'hui nous sommes le ${today}.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans balises de code.
Format (toutes les valeurs peuvent être null si non trouvées) :
{
  "propertyName": "nom du logement",
  "address": "adresse complète (rue + numéro)",
  "city": "ville",
  "zipCode": "code postal",
  "startDate": "YYYY-MM-DD (date d'arrivée/check-in)",
  "endDate": "YYYY-MM-DD (date de départ/check-out)",
  "doorCode": "code d'accès ou digicode si mentionné",
  "contactName": "nom du propriétaire ou hôte",
  "contactPhone": "numéro de téléphone de contact",
  "notes": "numéro de confirmation et autres infos utiles",
  "teamName": "prénom ou nom de l'équipe mentionné dans la réservation (ex: dans 'Réservation de Makram', extraire 'Makram'). null si non trouvé."
}`,
      messages: [{ role: "user", content: `Email à analyser :\n\n${emailText}` }],
    })

    const aiContent = aiRes.content[0]
    if (!aiContent) {
      console.warn(
        `[gmail-scan] Empty AI content for message ${messageId}, switching to regex fallback`
      )
      return throwProviderInvalidOrContinueWithRegex(
        emailText,
        "Réponse IA vide (aucun bloc de contenu)"
      )
    }

    const normalized = tryParseAiBookingContent(aiContent)
    if (normalized) {
      return normalized
    }

    const reason =
      aiContent.type !== "text"
        ? "Contenu IA non textuel"
        : !(aiContent.text?.trim() ?? "")
          ? "Réponse IA vide ou tronquée"
          : "JSON IA invalide ou structure inexploitable"

    console.warn(
      `[gmail-scan] ${reason} for message ${messageId}, switching to regex fallback`
    )
    const fallback = throwProviderInvalidOrContinueWithRegex(emailText, reason)
    console.log(`[gmail-scan] Regex fallback used for ${messageId}`)
    return fallback
  } catch (claudeErr) {
    if (
      claudeErr &&
      typeof claudeErr === "object" &&
      "kind" in claudeErr &&
      (claudeErr as ClassifiedBookingError).kind === "RETRYABLE"
    ) {
      throw claudeErr
    }
    console.warn(
      `[gmail-scan] Claude API error for message ${messageId}, switching to regex fallback`
    )
    const fallback = throwProviderTemporaryOrContinueWithRegex(emailText, claudeErr)
    console.log(`[gmail-scan] Regex fallback used for ${messageId}`)
    return fallback
  }
}
