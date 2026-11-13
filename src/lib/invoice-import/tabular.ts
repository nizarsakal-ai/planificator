// SPEC-INVOICE-IMPORT-001 — lecture d'un export tabulaire (CSV ou XLSX) et association des colonnes. Pur (aucune base).
// Aucun format propriétaire n'est codé en dur : l'association est devinée à partir des en-têtes puis confirmée par l'utilisateur.
import { createHash } from "node:crypto"
import ExcelJS from "exceljs"
import { detectDelimiter, parseCsv } from "@/lib/billing/quotes/quote-import"
import { completeAmounts, detectKind, mapStatus, parseImportAmount, parseImportDate } from "./normalize"
import { isZip } from "./zip"
import type { ColumnMapping, ImportField, PreviewRow } from "./types"

export const MAX_TABLE_ROWS = 2000
export const MAX_TABLE_BYTES = 4 * 1024 * 1024
export const MAX_TABLE_COLUMNS = 80

export class TabularError extends Error { constructor(message: string) { super(message); this.name = "TabularError" } }

export type Cell = string | number | Date | null
export interface Table { rows: Cell[][]; sheetName: string | null }

/** UTF-8 (avec ou sans BOM), sinon Windows-1252/Latin-1 (exports français courants). */
export function decodeText(buf: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "") } catch { return new TextDecoder("windows-1252").decode(buf) }
}

export function looksLikeXlsx(buf: Buffer, name: string): boolean {
  return isZip(buf) && /\.xlsx$/i.test(name)
}

function excelCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === "string" || typeof v === "number" || v instanceof Date) return v
  if (typeof v === "boolean") return v ? "oui" : "non"
  if (typeof v === "object") {
    // Formule : seule la valeur calculée enregistrée est lue (jamais évaluée) ; texte enrichi / lien : texte brut.
    if ("result" in v) return excelCell(v.result as ExcelJS.CellValue)
    if ("richText" in v) return v.richText.map((t) => t.text).join("")
    if ("text" in v) return String(v.text)
  }
  return null
}

/** Lecture XLSX avec exceljs (lecteur déjà retenu par le dépôt pour les classeurs non fiables), CSV avec le lecteur des devis. */
export async function readTable(buf: Buffer, name: string): Promise<Table> {
  if (buf.length === 0 || buf.length > MAX_TABLE_BYTES) throw new TabularError("Fichier de données vide ou trop volumineux (4 Mo maximum).")
  let rows: Cell[][]
  let sheetName: string | null = null
  if (looksLikeXlsx(buf, name)) {
    const wb = new ExcelJS.Workbook()
    try { await wb.xlsx.load(buf as unknown as ArrayBuffer) } catch { throw new TabularError("Classeur Excel illisible.") }
    const ws = wb.worksheets[0]
    if (!ws) throw new TabularError("Classeur Excel sans feuille.")
    sheetName = ws.name
    if (ws.actualRowCount > MAX_TABLE_ROWS + 10) throw new TabularError(`Trop de lignes (maximum ${MAX_TABLE_ROWS}).`)
    if (ws.actualColumnCount > MAX_TABLE_COLUMNS) throw new TabularError(`Trop de colonnes (maximum ${MAX_TABLE_COLUMNS}).`)
    rows = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: Cell[] = []
      for (let c = 1; c <= Math.min(row.cellCount, MAX_TABLE_COLUMNS); c++) cells.push(excelCell(row.getCell(c).value))
      if (cells.some((c) => c !== null && String(c).trim() !== "")) rows.push(cells)
    })
  } else if (/\.xls$/i.test(name)) {
    throw new TabularError("Ancien format .xls non pris en charge : enregistrez le fichier en .xlsx ou .csv.")
  } else {
    const text = decodeText(buf)
    if (text.includes("\u0000")) throw new TabularError("Fichier de données illisible (contenu binaire).")
    rows = parseCsv(text, detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "")).filter((r) => r.some((c) => c.trim() !== ""))
  }
  if (rows.length > MAX_TABLE_ROWS + 10) throw new TabularError(`Trop de lignes (maximum ${MAX_TABLE_ROWS}).`)
  if (rows.some((r) => r.length > MAX_TABLE_COLUMNS)) throw new TabularError(`Trop de colonnes (maximum ${MAX_TABLE_COLUMNS}).`)
  return { rows, sheetName }
}

const norm = (v: Cell): string => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** Synonymes d'en-têtes (français/anglais), du plus spécifique au plus général ; « exclusions » évite les faux positifs. */
const SYNONYMS: Record<ImportField, { any: string[]; not?: string[] }> = {
  creditedNumber: { any: ["facture d origine", "facture origine", "facture liee", "facture associee", "facture initiale", "original invoice", "related invoice", "avoir sur"] },
  fileName: { any: ["fichier", "pdf", "piece jointe", "attachment", "file", "document"], not: ["type"] },
  kind: { any: ["type de document", "type de piece", "type document", "type", "nature", "document type"] },
  number: { any: ["numero de facture", "numero facture", "n facture", "no facture", "numero de piece", "numero", "invoice number", "number", "reference facture", "n"], not: ["client", "commande", "siret", "tva", "origine", "devis"] },
  client: { any: ["nom du client", "client", "customer", "destinataire", "tiers", "raison sociale"], not: ["numero", "code", "email", "adresse", "id"] },
  dueDate: { any: ["date d echeance", "echeance", "due date", "date limite"] },
  issueDate: { any: ["date d emission", "date de facturation", "date facture", "date de facture", "emission", "invoice date", "issue date", "date"], not: ["echeance", "paiement", "reglement", "due", "creation", "modification"] },
  totalHT: { any: ["total ht", "montant ht", "ht", "hors taxe", "net amount", "subtotal", "excl"], not: ["restant", "paye"] },
  vat: { any: ["total tva", "montant tva", "tva", "vat", "tax amount", "taxes"], not: ["taux", "rate", "numero", "intracom", "ht", "ttc"] },
  totalTTC: { any: ["total ttc", "montant ttc", "ttc", "total amount", "gross", "incl", "total"], not: ["ht", "tva", "restant", "paye", "du"] },
  status: { any: ["statut", "etat", "status", "state"] },
  reference: { any: ["identifiant", "id", "uuid", "reference externe", "reference"], not: ["client", "facture", "commande"] },
}
const GUESS_ORDER: ImportField[] = ["creditedNumber", "fileName", "kind", "dueDate", "issueDate", "totalHT", "vat", "totalTTC", "status", "client", "number", "reference"]

/** Ligne d'en-tête = première ligne (dans les 10 premières) comportant au moins 3 cellules textuelles reconnues ou non numériques. */
export function detectHeaderRow(rows: Cell[][]): number {
  const limit = Math.min(rows.length, 10)
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(norm).filter((c) => c !== "")
    if (cells.length >= 3 && cells.filter((c) => !/^[\d ]+$/.test(c)).length >= 3 && cells.some((c) => /numero|number|facture|invoice|date|client|montant|total/.test(c))) return i
  }
  return 0
}

export function guessMapping(rows: Cell[][]): ColumnMapping {
  const headerIndex = detectHeaderRow(rows)
  const header = (rows[headerIndex] ?? []).map(norm)
  const mapping: ColumnMapping = { headerRows: headerIndex + 1 }
  const used = new Set<number>()
  for (const field of GUESS_ORDER) {
    const { any, not = [] } = SYNONYMS[field]
    let best = -1
    for (const key of any) {
      // Correspondance exacte d'abord, puis par mot entier, dans l'ordre des synonymes.
      best = header.findIndex((h, i) => !used.has(i) && h === key)
      if (best < 0) best = header.findIndex((h, i) => !used.has(i) && (` ${h} `).includes(` ${key} `) && !not.some((n) => (` ${h} `).includes(` ${n} `)))
      if (best >= 0) break
    }
    if (best >= 0) { mapping[field] = best; used.add(best) }
  }
  return mapping
}

/** Signature stable des en-têtes : retrouve l'association mémorisée pour le même export. */
export function headerSignature(rows: Cell[][], headerRows: number): string {
  const header = (rows[Math.max(0, headerRows - 1)] ?? []).map(norm)
  return createHash("sha256").update(header.join("|")).digest("hex").slice(0, 32)
}

export function headerLabels(rows: Cell[][], headerRows: number): string[] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const header = rows[Math.max(0, headerRows - 1)] ?? []
  return Array.from({ length: width }, (_, i) => (headerRows > 0 ? String(header[i] ?? "").trim() : "") || `Colonne ${i + 1}`)
}

/** Vérifie qu'une association (devinée, mémorisée ou saisie) est applicable à ce tableau. */
export function validateMapping(mapping: ColumnMapping, width: number): string | null {
  if (!Number.isInteger(mapping.headerRows) || mapping.headerRows < 0 || mapping.headerRows > 20) return "Nombre de lignes d'en-tête invalide."
  const seen = new Set<number>()
  for (const [field, index] of Object.entries(mapping)) {
    if (field === "headerRows" || index === undefined) continue
    if (!Number.isInteger(index) || index < 0 || index >= width) return "Colonne associée inexistante dans ce fichier."
    if (seen.has(index)) return "Une même colonne est associée à deux champs."
    seen.add(index)
  }
  if (mapping.number === undefined) return "Associez au minimum la colonne du numéro de pièce."
  return null
}

const text = (v: Cell, max: number): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max)

/** Transforme les lignes du tableau en lignes d'aperçu (aucun accès base ; rapprochements faits par l'analyse). */
export function tableToPreviewRows(table: Table, mapping: ColumnMapping, fileName: string, newId: () => string): PreviewRow[] {
  const out: PreviewRow[] = []
  const get = (r: Cell[], f: ImportField): Cell => (mapping[f] === undefined ? null : r[mapping[f] as number] ?? null)
  table.rows.slice(mapping.headerRows).forEach((r, i) => {
    const number = text(get(r, "number"), 64)
    const client = text(get(r, "client"), 200)
    const rawTtc = parseImportAmount(get(r, "totalTTC")), rawHt = parseImportAmount(get(r, "totalHT"))
    // Ligne vide ou ligne de total (ni numéro ni client) : ignorée.
    if (!number && !client) return
    const amounts = completeAmounts({ ht: rawHt, vat: parseImportAmount(get(r, "vat")), ttc: rawTtc })
    const sourceStatus = text(get(r, "status"), 80) || null
    const expected = text(get(r, "fileName"), 200) || null
    out.push({
      id: newId(), origin: { type: "table", file: fileName.slice(0, 200), line: i + 1 + mapping.headerRows },
      kind: detectKind(text(get(r, "kind"), 80), number, rawTtc ?? rawHt), number, clientName: client, clientId: null, createClient: false, worksiteId: null,
      issueDate: parseImportDate(get(r, "issueDate")), dueDate: parseImportDate(get(r, "dueDate")),
      htCents: amounts.ht?.toString() ?? null, vatCents: amounts.vat?.toString() ?? null, ttcCents: amounts.ttc?.toString() ?? null,
      sourceStatus, status: mapStatus(sourceStatus), sourceReference: text(get(r, "reference"), 120) || null, creditedNumber: text(get(r, "creditedNumber"), 64) || null,
      fileId: null, fileName: null, expectedFileName: expected ? expected.replace(/\\/g, "/").split("/").pop() ?? null : null,
      decision: null, excluded: false, extractionNote: null,
    })
  })
  return out
}
