// Import CSV de devis (SPEC-BILLING-C1 §3.8) — analyse pure, sans base. Inspiré de l'import PrintManager Pro
// (détection du séparateur, en-tête obligatoire, rapport ligne par ligne, aucune formule évaluée).
import { MoneyError, computeDocumentTotals } from "@/lib/billing/money"
import { parseQuoteForm, type ParsedQuote } from "./quote-schemas"

export const MAX_IMPORT_ROWS = 500
export const MAX_IMPORT_BYTES = 1_000_000

/** Analyse CSV minimaliste (RFC 4180 : guillemets, « "" », retours à la ligne dans les cellules). */
export function parseCsv(text: string, delimiter: "," | ";"): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = "", quoted = false
  const src = text.replace(/^﻿/, "")
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false }
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) { row.push(cell); cell = "" }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++
      row.push(cell); rows.push(row); row = []; cell = ""
    } else cell += c
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ""))
}

export function detectDelimiter(firstLine: string): "," | ";" {
  const semi = (firstLine.match(/;/g) ?? []).length
  const comma = (firstLine.match(/,/g) ?? []).length
  return semi >= comma ? ";" : ","
}

const REQUIRED = ["reference", "chantier", "designation", "quantite", "prix_unitaire_ht", "tva"] as const
const OPTIONAL = ["unite", "remise", "description", "validite", "notes", "objet", "remise_globale", "autoliquidation"] as const
type Column = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number]

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}
const ALIASES: Record<string, Column> = {
  reference: "reference", ref: "reference", numero: "reference", n: "reference",
  chantier: "chantier", worksite: "chantier",
  designation: "designation", libelle: "designation", description_ligne: "designation",
  quantite: "quantite", qte: "quantite", quantity: "quantite",
  prix_unitaire_ht: "prix_unitaire_ht", pu_ht: "prix_unitaire_ht", prix_unitaire: "prix_unitaire_ht", unit_price: "prix_unitaire_ht",
  tva: "tva", taux_tva: "tva", vat: "tva",
  unite: "unite", unit: "unite", remise: "remise", remise_pct: "remise", discount: "remise",
  description: "description", detail: "description", validite: "validite", valid_until: "validite", date_validite: "validite",
  notes: "notes", note: "notes", objet: "objet", subject: "objet", remise_globale: "remise_globale", autoliquidation: "autoliquidation",
}

export interface ImportedQuoteCandidate {
  reference: string
  worksiteName: string
  rowNumbers: number[]
  form: {
    issueDate: string; validUntil: string; subject: string; notes: string; globalDiscount: string; vatReverseCharge: boolean
    lines: { designation: string; description: string | null; unit: string; quantity: string; unitPrice: string; discount: string; vatRate: string }[]
  }
}

export interface ImportParseResult {
  candidates: ImportedQuoteCandidate[]
  /** Références rejetées (ligne invalide ⇒ devis entier rejeté). */
  invalid: { reference: string; rows: number[]; errors: string[] }[]
  fatal?: string
}

/** Première passe : lecture + regroupement par référence + validation des montants (sans base). */
export function parseQuoteImport(text: string, today: string): ImportParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { candidates: [], invalid: [], fatal: "Fichier trop volumineux (1 Mo maximum)." }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
  const rows = parseCsv(text, detectDelimiter(firstLine))
  if (rows.length < 2) return { candidates: [], invalid: [], fatal: "Fichier vide ou sans ligne de données (en-tête obligatoire)." }
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { candidates: [], invalid: [], fatal: `Trop de lignes (${rows.length - 1}, maximum ${MAX_IMPORT_ROWS}).` }
  const header = rows[0].map(normalizeHeader).map((h) => ALIASES[h] ?? null)
  const missing = REQUIRED.filter((c) => !header.includes(c))
  if (missing.length) return { candidates: [], invalid: [], fatal: `Colonnes manquantes : ${missing.join(", ")}.` }
  const col = (r: string[], c: Column) => { const i = header.indexOf(c); return i === -1 ? "" : (r[i] ?? "").trim() }

  const groups = new Map<string, { worksiteName: string; rows: number[]; lines: ImportedQuoteCandidate["form"]["lines"]; meta: Partial<ImportedQuoteCandidate["form"]>; errors: string[] }>()
  rows.slice(1).forEach((r, idx) => {
    const n = idx + 1
    const reference = col(r, "reference").slice(0, 64)
    if (!reference) { groups.set(`__row${n}`, { worksiteName: "", rows: [n], lines: [], meta: {}, errors: [`ligne ${n} : référence vide`] }); return }
    const g = groups.get(reference) ?? { worksiteName: col(r, "chantier"), rows: [], lines: [], meta: {}, errors: [] }
    g.rows.push(n)
    if (!g.worksiteName) g.worksiteName = col(r, "chantier")
    else if (col(r, "chantier") && col(r, "chantier") !== g.worksiteName) g.errors.push(`ligne ${n} : chantier différent des autres lignes de la référence`)
    const vat = col(r, "tva")
    g.lines.push({
      designation: col(r, "designation").slice(0, 200),
      description: col(r, "description") ? col(r, "description").slice(0, 1000) : null,
      unit: col(r, "unite") ? col(r, "unite").slice(0, 20) : "u",
      quantity: col(r, "quantite"), unitPrice: col(r, "prix_unitaire_ht"), discount: col(r, "remise"), vatRate: vat === "" ? "20" : vat,
    })
    if (col(r, "validite")) g.meta.validUntil = col(r, "validite")
    if (col(r, "notes")) g.meta.notes = col(r, "notes").slice(0, 2000)
    if (col(r, "objet")) g.meta.subject = col(r, "objet").slice(0, 200)
    if (col(r, "remise_globale")) g.meta.globalDiscount = col(r, "remise_globale")
    if (/^(1|oui|true|x)$/i.test(col(r, "autoliquidation"))) g.meta.vatReverseCharge = true
    groups.set(reference, g)
  })

  const candidates: ImportedQuoteCandidate[] = []
  const invalid: ImportParseResult["invalid"] = []
  for (const [reference, g] of groups) {
    const form: ImportedQuoteCandidate["form"] = {
      issueDate: today, validUntil: g.meta.validUntil ?? "", subject: g.meta.subject ?? "", notes: g.meta.notes ?? "",
      globalDiscount: g.meta.globalDiscount ?? "", vatReverseCharge: g.meta.vatReverseCharge === true, lines: g.lines,
    }
    const errors = [...g.errors]
    if (!g.worksiteName) errors.push("chantier vide")
    // Validation des montants via le même analyseur que le formulaire (worksiteId factice, résolu plus tard).
    const parsed = parseQuoteForm({ worksiteId: "__pending__", ...form })
    if (!parsed.ok) errors.push(parsed.error)
    if (errors.length) invalid.push({ reference: reference.startsWith("__row") ? "(sans référence)" : reference, rows: g.rows, errors })
    else candidates.push({ reference, worksiteName: g.worksiteName, rowNumbers: g.rows, form })
  }
  return { candidates, invalid }
}

/** Convertit un candidat en devis analysé (après résolution du chantier). */
export function candidateToParsedQuote(c: ImportedQuoteCandidate, worksiteId: string): ParsedQuote {
  const parsed = parseQuoteForm({ worksiteId, ...c.form })
  if (!parsed.ok) throw new MoneyError("IMPORT_INVALID")
  // Sécurité : recalcul des totaux (déjà fait dans parseQuoteForm) — évite toute divergence.
  parsed.value.totals = computeDocumentTotals(parsed.value.lines, { globalDiscountBp: parsed.value.globalDiscountBp, vatReverseCharge: parsed.value.vatReverseCharge })
  return parsed.value
}
