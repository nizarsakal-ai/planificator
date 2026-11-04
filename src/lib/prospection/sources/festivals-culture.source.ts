/**
 * Veille prospection — « Liste des festivals en France » (ministère de la Culture, data.gouv.fr, Licence Ouverte 2.0).
 *
 * Calendrier de festivals récurrents : on garde le nom, la commune, le département, la période, la discipline,
 * l'envergure, l'année de création et le site internet. Les colonnes « Adresse e-mail » et l'adresse postale
 * ne sont jamais lues : elles peuvent désigner des particuliers (bénévoles, responsables d'association).
 */
import type { ProspectCandidate } from "@/lib/prospection/prospection.types"
import { departmentCodeFromName } from "@/lib/prospection/sources/departments"

export const FESTIVALS_DATASET_API_URL = "https://www.data.gouv.fr/api/1/datasets/liste-des-festivals-en-france/"
export const FESTIVALS_DATASET_PAGE_URL = "https://www.data.gouv.fr/datasets/liste-des-festivals-en-france"

const REQUEST_TIMEOUT_MS = 30_000

/** Colonnes lues, et elles seules. */
export const FESTIVAL_COLUMNS = {
  name: "Nom du festival",
  reach: "Envergure territoriale",
  department: "Département principal de déroulement",
  locality: "Commune principale de déroulement",
  website: "Site internet du festival",
  creationYear: "Année de création du festival",
  discipline: "Discipline dominante",
  period: "Période principale de déroulement du festival",
  id: "Identifiant",
} as const

/** Parseur CSV minimal (séparateur `;`, guillemets doublés, CRLF), suffisant pour ce jeu de données. */
export function parseSemicolonCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const input = text.replace(/^﻿+/, "")

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ";") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++
      row.push(field)
      if (row.some((cell) => cell.trim() !== "")) rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== "")) rows.push(row)
  return rows
}

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim()
  return trimmed === "" ? null : trimmed
}

function websiteUrl(value: string | null): string | null {
  if (!value || /\s/.test(value) || value.includes("@")) return null
  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    return new URL(url).toString()
  } catch {
    return null
  }
}

export function mapFestivalRow(row: Readonly<Record<string, string | undefined>>): ProspectCandidate | null {
  const sourceId = clean(row[FESTIVAL_COLUMNS.id])
  const title = clean(row[FESTIVAL_COLUMNS.name])
  if (!sourceId || !title) return null

  const departmentCode = departmentCodeFromName(row[FESTIVAL_COLUMNS.department])
  const year = Number.parseInt(row[FESTIVAL_COLUMNS.creationYear] ?? "", 10)
  const discipline = clean(row[FESTIVAL_COLUMNS.discipline])

  return {
    source: "FESTIVALS_CULTURE",
    sourceId,
    kind: "EVENT",
    title,
    organization: null,
    departmentCodes: departmentCode ? [departmentCode] : [],
    locality: clean(row[FESTIVAL_COLUMNS.locality]),
    publishedAt: null,
    deadlineAt: null,
    eventStartAt: null,
    eventPeriod: clean(row[FESTIVAL_COLUMNS.period]),
    url: websiteUrl(clean(row[FESTIVAL_COLUMNS.website])),
    winners: [],
    linkedSourceIds: [],
    descriptors: discipline ? [discipline] : [],
    noticeNature: null,
    reach: clean(row[FESTIVAL_COLUMNS.reach]),
    creationYear: Number.isFinite(year) && year > 1800 ? year : null,
  }
}

export function mapFestivalsCsv(text: string): ProspectCandidate[] {
  const [header, ...rows] = parseSemicolonCsv(text)
  if (!header) return []
  const columns = header.map((name) => name.replace(/﻿/g, "").trim())
  const wanted = new Set<string>(Object.values(FESTIVAL_COLUMNS))
  const candidates: ProspectCandidate[] = []
  for (const cells of rows) {
    const record: Record<string, string> = {}
    columns.forEach((name, index) => {
      if (wanted.has(name)) record[name] = cells[index] ?? ""
    })
    const candidate = mapFestivalRow(record)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

/** Résout l'URL du CSV courant via l'API data.gouv (le nom du fichier change à chaque mise à jour). */
export async function fetchFestivalCandidates(input: { fetchImpl?: typeof fetch } = {}): Promise<ProspectCandidate[]> {
  const fetchImpl = input.fetchImpl ?? fetch
  const meta = await fetchImpl(FESTIVALS_DATASET_API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!meta.ok) throw new Error(`FESTIVALS_META_HTTP_${meta.status}`)
  const dataset = (await meta.json()) as { resources?: Array<{ format?: string; url?: string }> }
  const csv = dataset.resources?.find((resource) => resource.format?.toLowerCase() === "csv" && resource.url?.startsWith("https://"))
  if (!csv?.url) throw new Error("FESTIVALS_CSV_NOT_FOUND")

  const response = await fetchImpl(csv.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`FESTIVALS_CSV_HTTP_${response.status}`)
  return mapFestivalsCsv(await response.text())
}
