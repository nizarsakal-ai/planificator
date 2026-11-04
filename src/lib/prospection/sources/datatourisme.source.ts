/**
 * Veille prospection — adaptateur DATAtourisme (« Fêtes et manifestations »), Licence Ouverte 2.0.
 *
 * Désactivé tant que `DATATOURISME_FLUX_URL` n'est pas renseignée (compte gratuit à créer sur diffuseur.datatourisme.fr,
 * flux au format JSON-LD en fichier unique). Lecture défensive : seuls le libellé, les dates, la commune et le code postal
 * sont repris. Les contacts (`hasContact`, `hasBookingContact`…) ne sont jamais lus.
 *
 * À valider sur un vrai flux dès que la clé existe : la forme exacte du JSON-LD dépend du paramétrage du flux.
 */
import type { ProspectCandidate } from "@/lib/prospection/prospection.types"

const REQUEST_TIMEOUT_MS = 60_000

const EVENT_TYPES = new Set([
  "schema:Event", "Event", "EntertainmentAndEvent", "FairOrShow", "CulturalEvent", "SaleEvent",
  "SportsEvent", "SocialEvent", "BusinessEvent", "ShowEvent",
])

export type DatatourismeFetchResult =
  | { status: "DISABLED"; candidates: [] }
  | { status: "OK"; candidates: ProspectCandidate[] }

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function pick(object: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) if (object[key] !== undefined) return object[key]
  return undefined
}

/** Libellé français : chaîne, `{ fr: [...] }`, `{ "@value", "@language" }` ou liste de ces formes. */
function readLabel(value: unknown): string | null {
  for (const item of toList(value)) {
    if (typeof item === "string" && item.trim()) return item.trim()
    if (isObject(item)) {
      const fr = item.fr ?? item["@value"]
      const text = toList(fr).find((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      if (text) return text.trim()
    }
  }
  return null
}

function readString(value: unknown): string | null {
  const first = toList(value).find((entry) => typeof entry === "string" || (isObject(entry) && typeof entry["@value"] === "string"))
  const text = typeof first === "string" ? first : isObject(first) ? (first["@value"] as string) : null
  return text && text.trim() ? text.trim() : null
}

function readDate(value: unknown): Date | null {
  const raw = readString(value)
  if (!raw) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Code postal → département (Corse : 200xx-201xx → 2A, 202xx → 2B ; outre-mer sur 3 chiffres). */
export function departmentFromPostalCode(postalCode: string | null): string | null {
  if (!postalCode || !/^\d{5}$/.test(postalCode)) return null
  if (postalCode.startsWith("97")) return postalCode.slice(0, 3)
  if (postalCode.startsWith("20")) return Number(postalCode) < 20200 ? "2A" : "2B"
  return postalCode.slice(0, 2)
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(date)
}

export function mapDatatourismeEvent(node: unknown): ProspectCandidate | null {
  if (!isObject(node)) return null
  const types = toList(node["@type"]).filter((type): type is string => typeof type === "string")
  if (!types.some((type) => EVENT_TYPES.has(type))) return null

  const sourceId = readString(pick(node, "dc:identifier", "@id"))
  const title = readLabel(pick(node, "rdfs:label", "label"))
  if (!sourceId || !title) return null

  const period = toList(pick(node, "takesPlaceAt", ":takesPlaceAt")).find(isObject)
  const start = period ? readDate(pick(period, "startDate", "schema:startDate", ":startDate")) : null
  const end = period ? readDate(pick(period, "endDate", "schema:endDate", ":endDate")) : null

  const place = toList(pick(node, "isLocatedAt", ":isLocatedAt")).find(isObject)
  const address = place ? toList(pick(place, "schema:address", "address")).find(isObject) : undefined
  const postalCode = address ? readString(pick(address, "schema:postalCode", "postalCode")) : null
  const locality = address ? readString(pick(address, "schema:addressLocality", "addressLocality")) : null
  const department = departmentFromPostalCode(postalCode)

  return {
    source: "DATATOURISME",
    sourceId,
    kind: "EVENT",
    title,
    organization: null,
    departmentCodes: department ? [department] : [],
    locality,
    publishedAt: null,
    deadlineAt: null,
    eventStartAt: start,
    eventPeriod: start ? (end && end.getTime() !== start.getTime() ? `Du ${formatDay(start)} au ${formatDay(end)}` : `Le ${formatDay(start)}`) : null,
    url: readString(pick(node, "@id")),
    winners: [],
    linkedSourceIds: [],
    descriptors: types.filter((type) => !type.includes(":") && type !== "PointOfInterest"),
    noticeNature: null,
    reach: null,
    creationYear: null,
  }
}

export function mapDatatourismePayload(payload: unknown): ProspectCandidate[] {
  const nodes = isObject(payload) ? toList(payload["@graph"]) : toList(payload)
  return nodes.map(mapDatatourismeEvent).filter((candidate): candidate is ProspectCandidate => candidate !== null)
}

export async function fetchDatatourismeCandidates(input: {
  fluxUrl: string | null
  fetchImpl?: typeof fetch
}): Promise<DatatourismeFetchResult> {
  if (!input.fluxUrl) return { status: "DISABLED", candidates: [] }
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(input.fluxUrl, {
    headers: { accept: "application/ld+json, application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // Le message d'erreur ne reprend jamais l'URL : elle contient la clé d'application.
  if (!response.ok) throw new Error(`DATATOURISME_HTTP_${response.status}`)
  return { status: "OK", candidates: mapDatatourismePayload(await response.json()) }
}
