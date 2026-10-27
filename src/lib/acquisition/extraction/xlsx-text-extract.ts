/**
 * PLAN-ACQ-MULTIMODAL — Lecture texte d'un classeur .xlsx via exceljs.
 *
 * - Valeurs de cellules uniquement : une formule n'est JAMAIS évaluée, seul son
 *   résultat mis en cache dans le fichier est repris (s'il existe).
 * - Aucune macro : seul .xlsx est accepté en amont (signature ZIP + extension) ;
 *   exceljs n'exécute rien.
 * - Rendu feuille par feuille, une ligne par rangée, cellules séparées par " | ".
 * - Plafonds : taille fichier, taille décompressée déclarée (anti zip-bomb),
 *   nb feuilles, nb lignes, nb caractères ; timeout / échéance appliqués
 *   rangée par rangée (lecture en flux, abandon réel).
 * - Jamais d'exception : statut par fichier.
 *
 * Choix : `exceljs` et non `xlsx` 0.18.5 (vulnérable, prototype pollution / ReDoS).
 */

import { Readable } from "node:stream"
import ExcelJS from "exceljs"

export type XlsxTextExtractStatus =
  | "XLSX_TEXT_EXTRACTED"
  | "XLSX_TEXT_TRUNCATED"
  | "XLSX_EMPTY"
  | "XLSX_TOO_LARGE"
  | "XLSX_PARSE_FAILED"

export type XlsxTextExtractResult = {
  status: XlsxTextExtractStatus
  text: string
  truncated: boolean
}

export const XLSX_DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Taille décompressée totale déclarée par le répertoire central ZIP. */
export const XLSX_DEFAULT_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
export const XLSX_DEFAULT_MAX_SHEETS = 10
export const XLSX_DEFAULT_MAX_ROWS_PER_SHEET = 500
export const XLSX_DEFAULT_MAX_CELLS_PER_ROW = 50
export const XLSX_DEFAULT_MAX_CELL_CHARS = 500
const DEFAULT_MAX_CHARS = 8_000
const DEFAULT_TIMEOUT_MS = 5_000

export type XlsxExtractOptions = {
  maxChars?: number
  timeoutMs?: number
  maxBytes?: number
  maxUncompressedBytes?: number
  maxSheets?: number
  maxRowsPerSheet?: number
  /** Échéance absolue (ms epoch) — la lecture s'arrête réellement au-delà. */
  deadlineAt?: number
}

function result(status: XlsxTextExtractStatus, text = "", truncated = false): XlsxTextExtractResult {
  return { status, text, truncated }
}

/**
 * Somme des tailles décompressées déclarées (répertoire central ZIP).
 * null si structure illisible (→ refus prudent par l'appelant).
 */
export function zipDeclaredUncompressedBytes(buf: Buffer): number | null {
  try {
    const EOCD_SIG = 0x06054b50
    const minEocd = 22
    if (buf.length < minEocd) return null
    const searchStart = Math.max(0, buf.length - (minEocd + 0xffff))
    let eocd = -1
    for (let i = buf.length - minEocd; i >= searchStart; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const entries = buf.readUInt16LE(eocd + 10)
    const cdSize = buf.readUInt32LE(eocd + 12)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    if (cdOffset + cdSize > buf.length) return null
    let p = cdOffset
    let total = 0
    for (let n = 0; n < entries; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
      const uncompressed = buf.readUInt32LE(p + 24)
      // ZIP64 (0xffffffff) : taille inconnue ici → refus prudent.
      if (uncompressed === 0xffffffff) return null
      total += uncompressed
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      p += 46 + nameLen + extraLen + commentLen
    }
    return total
  } catch {
    return null
  }
}

function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return ""
  const iso = d.toISOString()
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ")
}

/** Valeur d'affichage d'une cellule — jamais d'évaluation de formule. */
export function cellValueToText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "VRAI" : "FAUX"
  if (value instanceof Date) return formatDate(value)
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: unknown }>)
        .map((r) => (typeof r?.text === "string" ? r.text : ""))
        .join("")
    }
    if ("formula" in v || "sharedFormula" in v) {
      // Résultat mis en cache par le tableur uniquement ; erreurs ignorées.
      const cached = v.result
      if (cached && typeof cached === "object" && !(cached instanceof Date)) return ""
      return cellValueToText(cached)
    }
    if (typeof v.text === "string") return v.text
    if (typeof v.text === "object" && v.text && Array.isArray((v.text as { richText?: unknown }).richText)) {
      return cellValueToText(v.text)
    }
    // CellErrorValue ({ error }) ou objet inconnu → ignoré.
    return ""
  }
  return ""
}

function cleanCell(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, XLSX_DEFAULT_MAX_CELL_CHARS)
}

/**
 * Lecture en flux (WorkbookReader) : chaque rangée est lue à la demande, ce qui
 * permet d'ABANDONNER réellement le parsing (sortie de l'itérateur + destruction
 * du flux source) à l'échéance, et d'éviter de charger tout le classeur.
 */
async function parseWorkbook(
  buf: Buffer,
  opts: Required<Pick<XlsxExtractOptions, "maxChars" | "maxSheets" | "maxRowsPerSheet">> & {
    deadlineAt: number
  }
): Promise<XlsxTextExtractResult> {
  const source = Readable.from(buf)
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "ignore",
  })

  const lines: string[] = []
  let chars = 0
  let truncated = false
  let anyValue = false
  let sheetIndex = 0
  let timedOut = false

  const push = (line: string): boolean => {
    const cost = line.length + 1
    if (chars + cost > opts.maxChars) {
      const room = opts.maxChars - chars - 1
      if (room > 0) lines.push(line.slice(0, room))
      truncated = true
      return false
    }
    lines.push(line)
    chars += cost
    return true
  }

  try {
    outer: for await (const sheet of reader) {
      if (Date.now() > opts.deadlineAt) {
        timedOut = true
        break
      }
      sheetIndex++
      if (sheetIndex > opts.maxSheets) {
        truncated = true
        break
      }
      const sheetLines: string[] = []
      let rowCount = 0
      for await (const row of sheet) {
        if (Date.now() > opts.deadlineAt) {
          timedOut = true
          break outer
        }
        if (rowCount >= opts.maxRowsPerSheet) {
          truncated = true
          break
        }
        const cells: string[] = []
        const values = Array.isArray(row.values) ? row.values : []
        for (let i = 1; i < values.length && cells.length < XLSX_DEFAULT_MAX_CELLS_PER_ROW; i++) {
          const text = cleanCell(cellValueToText(values[i]))
          if (text) cells.push(text)
        }
        if (cells.length === 0) continue
        rowCount++
        sheetLines.push(cells.join(" | "))
      }
      if (sheetLines.length === 0) continue
      anyValue = true
      const rawName = (sheet as unknown as { name?: unknown }).name
      const name = cleanCell(typeof rawName === "string" && rawName ? rawName : `Feuille ${sheetIndex}`).slice(0, 64)
      if (!push(`--- Feuille: ${name} ---`)) break
      for (const line of sheetLines) {
        if (!push(line)) break outer
      }
    }
  } finally {
    source.destroy()
  }

  if (timedOut) return result("XLSX_PARSE_FAILED")
  if (!anyValue) return result("XLSX_EMPTY")
  const text = lines.join("\n").trim()
  return result(truncated ? "XLSX_TEXT_TRUNCATED" : "XLSX_TEXT_EXTRACTED", text, truncated)
}

/**
 * Extrait le texte d'un .xlsx. Aucune exception propagée.
 */
export async function extractXlsxText(
  input: Buffer | Uint8Array,
  opts?: XlsxExtractOptions
): Promise<XlsxTextExtractResult> {
  const maxBytes = opts?.maxBytes ?? XLSX_DEFAULT_MAX_BYTES
  const maxUncompressed = opts?.maxUncompressedBytes ?? XLSX_DEFAULT_MAX_UNCOMPRESSED_BYTES
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return result("XLSX_PARSE_FAILED")
    if (buf.byteLength > maxBytes) return result("XLSX_TOO_LARGE")
    const declared = zipDeclaredUncompressedBytes(buf)
    if (declared == null) return result("XLSX_PARSE_FAILED")
    if (declared > maxUncompressed) return result("XLSX_TOO_LARGE")

    const deadlineAt = Math.min(Date.now() + timeoutMs, opts?.deadlineAt ?? Number.POSITIVE_INFINITY)
    return await parseWorkbook(buf, {
      maxChars: opts?.maxChars ?? DEFAULT_MAX_CHARS,
      maxSheets: opts?.maxSheets ?? XLSX_DEFAULT_MAX_SHEETS,
      maxRowsPerSheet: opts?.maxRowsPerSheet ?? XLSX_DEFAULT_MAX_ROWS_PER_SHEET,
      deadlineAt,
    }).catch(() => result("XLSX_PARSE_FAILED"))
  } catch {
    return result("XLSX_PARSE_FAILED")
  }
}
