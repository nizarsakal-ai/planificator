/**
 * Normalisation d'affichage UI Booking — chaînes destinées à l'écran uniquement.
 * Aucune logique métier / ingestion / persistance.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/**
 * Décode les entités HTML courantes (&amp;, &#39;, &#x27;, etc.) sans dépendance.
 * Les accents UTF-8 déjà présents sont laissés intacts.
 */
export function decodeHtmlEntities(input: string): string {
  let s = input
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : full
    }
    if (key.startsWith("#")) {
      const code = Number(key.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : full
    }
    return NAMED_ENTITIES[key] ?? full
  })
  return s
}

/** Retire les balises HTML résiduelles (ex. `</title>`) sans interpréter le HTML. */
export function stripResidualHtmlTags(input: string): string {
  return input.replace(/<\/?[a-zA-Z][^>]*>/g, " ")
}

/**
 * Texte prêt pour l'UI Booking (hotelName / propertyName, adresse, snippet…).
 * - strip balises
 * - décode entités
 * - collapse espaces / trim
 * - conserve les accents
 */
export function normalizeBookingDisplayText(input: string | null | undefined): string {
  if (input == null) return ""
  let s = String(input)
  s = stripResidualHtmlTags(s)
  s = decodeHtmlEntities(s)
  // Seconde passe légère : entités exposées après strip (ex. &amp;lt;)
  s = decodeHtmlEntities(s)
  s = s.replace(/\u00a0/g, " ")
  s = s.replace(/[ \t\f\v]+/g, " ")
  s = s.replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

/** Variante nullable pour props UI optionnelles. */
export function normalizeBookingDisplayTextOrNull(
  input: string | null | undefined
): string | null {
  const normalized = normalizeBookingDisplayText(input)
  return normalized.length > 0 ? normalized : null
}
