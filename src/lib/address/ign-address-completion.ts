/**
 * Autocomplétion d'adresses françaises — Géoplateforme IGN (API publique, gratuite, sans clé).
 *
 *   GET https://data.geopf.fr/geocodage/completion/?text=<saisie>&type=StreetAddress&maximumResponses=5
 *
 * Règles :
 *   - seul le texte saisi dans le champ d'adresse est envoyé (aucun autre paramètre métier,
 *     aucun cookie : `credentials: "omit"`, `referrerPolicy: "no-referrer"`) ;
 *   - recherche à partir de 3 caractères (hors espaces de début et de fin) ;
 *   - limite IGN : 10 requêtes par seconde et par IP → limiteur partagé côté navigateur à 8/s
 *     (marge), en plus de l'attente de 300 ms sans frappe dans le composant ;
 *   - toute panne (réseau, délai, HTTP 429/5xx, réponse invalide) renvoie une liste vide avec
 *     un statut : la saisie et l'enregistrement manuels restent toujours possibles.
 */

export const IGN_COMPLETION_URL = "https://data.geopf.fr/geocodage/completion/"
export const ADDRESS_MIN_CHARS = 3
export const ADDRESS_DEBOUNCE_MS = 300
export const ADDRESS_MAX_SUGGESTIONS = 5
/** Marge sous la limite IGN de 10 requêtes/s/IP. */
export const IGN_MAX_REQUESTS_PER_SECOND = 8
export const IGN_TIMEOUT_MS = 4_000
const MAX_QUERY_LENGTH = 200

export interface AddressSuggestion {
  /** Clé stable pour l'affichage. */
  id: string
  /** Adresse complète proposée au remplissage (« 12 Rue des Lilas, 75001 Paris »). */
  label: string
  housenumber: string | null
  street: string | null
  postcode: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
}

export type AddressCompletionStatus = "ok" | "empty" | "error" | "timeout" | "rate_limited" | "aborted"

export interface AddressCompletionResult {
  status: AddressCompletionStatus
  suggestions: AddressSuggestion[]
}

/** Texte réellement recherché : espaces de début/fin retirés, longueur bornée. */
export function normalizeAddressQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH)
}

export function shouldSearchAddress(text: string): boolean {
  return normalizeAddressQuery(text).length >= ADDRESS_MIN_CHARS
}

export function buildIgnCompletionUrl(text: string): string {
  const url = new URL(IGN_COMPLETION_URL)
  url.searchParams.set("text", normalizeAddressQuery(text))
  url.searchParams.set("type", "StreetAddress")
  url.searchParams.set("maximumResponses", String(ADDRESS_MAX_SUGGESTIONS))
  return url.href
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** « 12 », « 12 bis », « 3B » en tête du texte complet, quand l'API ne fournit pas le numéro à part. */
function leadingHouseNumber(fulltext: string | null): string | null {
  const m = fulltext?.match(/^(\d+\s?(?:bis|ter|quater|[a-z])?)\b/i)
  return m ? m[1].trim() : null
}

export function formatAddressLabel(parts: Pick<AddressSuggestion, "housenumber" | "street" | "postcode" | "city">): string {
  const line1 = [parts.housenumber, parts.street].filter(Boolean).join(" ")
  const line2 = [parts.postcode, parts.city].filter(Boolean).join(" ")
  return [line1, line2].filter(Boolean).join(", ")
}

/** Lecture défensive de la réponse IGN : tout champ inattendu est ignoré, jamais d'exception. */
export function parseIgnCompletionResponse(json: unknown): AddressSuggestion[] {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  const seen = new Set<string>()
  const out: AddressSuggestion[] = []
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const fulltext = str(r.fulltext)
    const street = str(r.street)
    const postcode = str(r.zipcode) ?? str(r.postcode)
    const city = str(r.city)
    const housenumber = str(r.housenumber) ?? (street && fulltext?.toLowerCase().includes(street.toLowerCase()) ? leadingHouseNumber(fulltext) : null)
    const label = street || postcode || city ? formatAddressLabel({ housenumber, street, postcode, city }) : fulltext
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `${out.length}-${key}`,
      label,
      housenumber,
      street,
      postcode,
      city,
      latitude: num(r.y),
      longitude: num(r.x),
    })
    if (out.length >= ADDRESS_MAX_SUGGESTIONS) break
  }
  return out
}

/** Fenêtre glissante d'une seconde ; partagée par tous les champs d'adresse de la page. */
export function createRateLimiter(maxPerSecond: number, now: () => number = Date.now) {
  const stamps: number[] = []
  return {
    tryAcquire(): boolean {
      const t = now()
      while (stamps.length && t - stamps[0] >= 1_000) stamps.shift()
      if (stamps.length >= maxPerSecond) return false
      stamps.push(t)
      return true
    },
  }
}

export const ignRateLimiter = createRateLimiter(IGN_MAX_REQUESTS_PER_SECOND)

export async function fetchAddressSuggestions(
  text: string,
  options: {
    signal?: AbortSignal
    fetchFn?: typeof fetch
    limiter?: { tryAcquire(): boolean }
    timeoutMs?: number
  } = {},
): Promise<AddressCompletionResult> {
  if (!shouldSearchAddress(text)) return { status: "empty", suggestions: [] }
  const limiter = options.limiter ?? ignRateLimiter
  if (!limiter.tryAcquire()) return { status: "rate_limited", suggestions: [] }
  const fetchFn = options.fetchFn ?? fetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? IGN_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const response = await fetchFn(buildIgnCompletionUrl(text), {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    })
    if (response.status === 429) return { status: "rate_limited", suggestions: [] }
    if (!response.ok) return { status: "error", suggestions: [] }
    const suggestions = parseIgnCompletionResponse(await response.json())
    return { status: suggestions.length ? "ok" : "empty", suggestions }
  } catch {
    if (options.signal?.aborted) return { status: "aborted", suggestions: [] }
    return { status: timedOut ? "timeout" : "error", suggestions: [] }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
