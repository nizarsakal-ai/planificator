/**
 * Veille prospection — source BOAMP (DILA), API Opendatasoft publique, sans clé, Licence Ouverte 2.0.
 *
 * Seuls les champs listés dans `BOAMP_SELECTED_FIELDS` sont demandés. Les champs `donnees` et `gestion`
 * ne le sont jamais : ils contiennent l'identité des correspondants des acheteurs (données personnelles).
 */
import type { ProspectCandidate } from "@/lib/prospection/prospection.types"

export const BOAMP_RECORDS_URL = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records"

export const BOAMP_SELECTED_FIELDS = [
  "idweb",
  "objet",
  "dateparution",
  "datelimitereponse",
  "nomacheteur",
  "titulaire",
  "code_departement",
  "code_departement_prestation",
  "nature",
  "descripteur_libelle",
  "type_marche",
  "annonce_lie",
  "url_avis",
] as const

/** Descripteurs BOAMP et mots de l'objet qui délimitent la collecte (le score trie ensuite). */
const BOAMP_DESCRIPTORS = ["Tente", "Stand", "Evénementiel"] as const
const BOAMP_OBJECT_TERMS = ["chapiteau", "chapiteaux", "barnum", "podium", "gradins", "tribunes", "structures temporaires"] as const

const PAGE_SIZE = 100
const DEFAULT_MAX_RECORDS = 500
const REQUEST_TIMEOUT_MS = 15_000

export interface BoampRecord {
  idweb?: unknown
  objet?: unknown
  dateparution?: unknown
  datelimitereponse?: unknown
  nomacheteur?: unknown
  titulaire?: unknown
  code_departement?: unknown
  code_departement_prestation?: unknown
  nature?: unknown
  descripteur_libelle?: unknown
  type_marche?: unknown
  annonce_lie?: unknown
  url_avis?: unknown
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.replace(/\s+/g, " ").trim()
  return trimmed === "" ? null : trimmed
}

function asStringList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  return list.map(asString).filter((item): item is string => item !== null)
}

function asDate(value: unknown): Date | null {
  const raw = asString(value)
  if (!raw) return null
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/** « 6 » → « 06 », « 2a » → « 2A », « 971 » inchangé ; toute autre forme est écartée. */
export function normalizeDepartmentCode(value: string): string | null {
  const code = value.trim().toUpperCase()
  if (/^\d$/.test(code)) return `0${code}`
  if (/^(\d{2}|2A|2B|97\d)$/.test(code)) return code
  return null
}

export function mapBoampRecord(record: BoampRecord): ProspectCandidate | null {
  const sourceId = asString(record.idweb)
  const title = asString(record.objet)
  if (!sourceId || !title) return null

  const nature = asString(record.nature)
  const departments = [...asStringList(record.code_departement_prestation), ...asStringList(record.code_departement)]
    .map(normalizeDepartmentCode)
    .filter((code): code is string => code !== null)

  return {
    source: "BOAMP",
    sourceId,
    kind: nature === "ATTRIBUTION" ? "AWARD" : "TENDER",
    title,
    organization: asString(record.nomacheteur),
    departmentCodes: [...new Set(departments)],
    locality: null,
    publishedAt: asDate(record.dateparution),
    deadlineAt: asDate(record.datelimitereponse),
    eventStartAt: null,
    eventPeriod: null,
    url: asString(record.url_avis) ?? `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(sourceId)}`,
    winners: [...new Set(asStringList(record.titulaire))],
    linkedSourceIds: asStringList(record.annonce_lie),
    descriptors: [...asStringList(record.descripteur_libelle), ...asStringList(record.type_marche)],
    noticeNature: nature,
    reach: null,
    creationYear: null,
  }
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Clause ODSQL : avis parus depuis `since`, ciblés par descripteur ou par mot de l'objet. */
export function buildBoampWhereClause(since: Date): string {
  const filters = [
    ...BOAMP_DESCRIPTORS.map((descriptor) => `descripteur_libelle="${descriptor}"`),
    ...BOAMP_OBJECT_TERMS.map((term) => `search(objet,"${term}")`),
  ]
  return `dateparution >= date'${isoDay(since)}' AND (${filters.join(" OR ")})`
}

export function buildBoampRequestUrl(since: Date, offset: number): string {
  const params = new URLSearchParams({
    select: BOAMP_SELECTED_FIELDS.join(","),
    where: buildBoampWhereClause(since),
    order_by: "dateparution desc",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  })
  return `${BOAMP_RECORDS_URL}?${params.toString()}`
}

export async function fetchBoampCandidates(input: {
  now: Date
  lookbackDays: number
  fetchImpl?: typeof fetch
  maxRecords?: number
}): Promise<ProspectCandidate[]> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxRecords = input.maxRecords ?? DEFAULT_MAX_RECORDS
  const since = new Date(input.now.getTime() - input.lookbackDays * 24 * 60 * 60 * 1000)
  const candidates: ProspectCandidate[] = []

  for (let offset = 0; offset < maxRecords; offset += PAGE_SIZE) {
    const response = await fetchImpl(buildBoampRequestUrl(since, offset), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`BOAMP_HTTP_${response.status}`)
    const body = (await response.json()) as { results?: BoampRecord[] }
    const page = Array.isArray(body.results) ? body.results : []
    for (const record of page) {
      const candidate = mapBoampRecord(record)
      if (candidate) candidates.push(candidate)
    }
    if (page.length < PAGE_SIZE) break
  }

  return candidates
}
