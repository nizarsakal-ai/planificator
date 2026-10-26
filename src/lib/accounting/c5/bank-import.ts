// Import de relevés bancaires CSV (SPEC-BILLING-C5 §3.5) — analyse pure : séparateur, aperçu, mapping de colonnes,
// dates JJ/MM/AAAA ou AAAA-MM-JJ, montants « 1 234,56 », débit/crédit séparés, identité des opérations.
//
// Correctif P2-01 (revue Codex) — identité d'une opération :
// - identifiant bancaire STABLE (colonne « bankId » du mapping, ex. FITID/référence unique de la banque) ⇒ identité certaine,
//   empreinte dérivée de cet identifiant seul, unique par société ;
// - sinon, empreinte (date, montant, libellé, référence) + rang d'OCCURRENCE du même tuple dans le fichier : deux opérations
//   réellement identiques d'un même relevé sont conservées (occurrences 1 et 2), le réimport du même fichier n'ajoute rien,
//   des relevés qui se chevauchent conservent le maximum d'occurrences observé ; l'empreinte de l'occurrence 1 garde le format
//   antérieur (lignes déjà importées valides sans recalcul) ;
// - une ligne dont le tuple est répété dans le fichier (sans identifiant bancaire) est marquée « identité ambiguë » : conservée,
//   jamais rapprochée automatiquement, résolution explicite par rapprochement manuel.
import { createHash } from "node:crypto"
import { parseCsv, detectDelimiter } from "@/lib/billing/quotes/quote-import"

export interface BankColumnMapping { date: number; label: number; amount?: number; debit?: number; credit?: number; reference?: number; bankId?: number; headerRows: number }
export interface ParsedBankLine { date: Date; label: string; amountCents: bigint; reference: string | null; externalId: string | null; occurrence: number; identityAmbiguous: boolean; fingerprint: string; row: number }
export interface BankParseResult { lines: ParsedBankLine[]; invalid: { row: number; error: string }[] }

export const MAX_BANK_ROWS = 5000
export const MAX_BANK_BYTES = 2_000_000

export function previewCsv(text: string, rows = 5): { delimiter: string; header: string[]; sample: string[][] } {
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "")
  const all = parseCsv(text, delimiter)
  return { delimiter, header: all[0] ?? [], sample: all.slice(1, 1 + rows) }
}

export function parseBankDate(raw: string): Date | null {
  const s = raw.trim()
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (m) { const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))); return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[1]) ? null : d }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) { const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : d }
  return null
}

/** « 1 234,56 », « -12.5 », « (12,00) », « 12,00 € » → centimes signés ; vide ⇒ null. */
export function parseBankAmount(raw: string): bigint | null {
  let s = raw.replace(/[\s  €]/g, "").replace(/EUR$/i, "")
  if (s === "") return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1) } else if (s.startsWith("+")) s = s.slice(1)
  // Séparateur décimal : la dernière virgule ou le dernier point ; les autres sont des milliers.
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".")
  const decPos = Math.max(lastComma, lastDot)
  let units = s, dec = ""
  if (decPos >= 0 && s.length - decPos - 1 <= 2) { units = s.slice(0, decPos); dec = s.slice(decPos + 1) }
  units = units.replace(/[.,]/g, "")
  if (!/^\d+$/.test(units) || !/^\d{0,2}$/.test(dec)) return null
  const cents = BigInt(units) * BigInt(100) + BigInt(dec.padEnd(2, "0") || "0")
  return neg ? -cents : cents
}

/** Empreinte de base (date, montant, libellé, référence) — format du Lot C5 conservé pour l'occurrence 1. */
export function bankFingerprint(companyId: string, date: Date, amountCents: bigint, label: string, reference: string | null, occurrence = 1): string {
  const base = `${companyId}|${date.toISOString().slice(0, 10)}|${amountCents}|${label.trim().toLowerCase()}|${(reference ?? "").trim().toLowerCase()}`
  return createHash("sha256").update(occurrence > 1 ? `${base}|#${occurrence}` : base).digest("hex")
}

/** Empreinte d'une opération identifiée par un identifiant bancaire stable (unique par société). */
export function bankExternalFingerprint(companyId: string, externalId: string): string {
  return createHash("sha256").update(`${companyId}|EXT|${externalId.trim()}`).digest("hex")
}

export function parseBankCsv(companyId: string, text: string, mapping: BankColumnMapping): BankParseResult {
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "")
  const rows = parseCsv(text, delimiter).slice(Math.max(0, mapping.headerRows))
  const out: BankParseResult = { lines: [], invalid: [] }
  if (rows.length > MAX_BANK_ROWS) { out.invalid.push({ row: 0, error: `Trop de lignes (${rows.length}, maximum ${MAX_BANK_ROWS}).` }); return out }
  const cell = (r: string[], i: number | undefined) => (i === undefined || i < 0 ? "" : (r[i] ?? "").trim())
  const tupleCount = new Map<string, number>()
  const seenExternal = new Set<string>()
  rows.forEach((r, idx) => {
    const row = idx + 1 + mapping.headerRows
    const date = parseBankDate(cell(r, mapping.date))
    if (!date) { out.invalid.push({ row, error: "date invalide" }); return }
    let amount: bigint | null = null
    if (mapping.amount !== undefined) amount = parseBankAmount(cell(r, mapping.amount))
    else {
      const d = parseBankAmount(cell(r, mapping.debit)), c = parseBankAmount(cell(r, mapping.credit))
      if (d !== null && d !== BigInt(0)) amount = -(d < BigInt(0) ? -d : d)
      else if (c !== null && c !== BigInt(0)) amount = c < BigInt(0) ? -c : c
      else if (d === BigInt(0) || c === BigInt(0)) amount = BigInt(0)
    }
    if (amount === null) { out.invalid.push({ row, error: "montant invalide" }); return }
    if (amount === BigInt(0)) { out.invalid.push({ row, error: "montant nul" }); return }
    const label = cell(r, mapping.label).slice(0, 300) || "Opération"
    const reference = cell(r, mapping.reference).slice(0, 100) || null
    const externalId = mapping.bankId !== undefined ? cell(r, mapping.bankId).slice(0, 100) || null : null
    if (externalId) {
      if (seenExternal.has(externalId)) { out.invalid.push({ row, error: `identifiant bancaire en double dans le fichier (${externalId})` }); return }
      seenExternal.add(externalId)
      out.lines.push({ date, label, amountCents: amount, reference, externalId, occurrence: 1, identityAmbiguous: false, fingerprint: bankExternalFingerprint(companyId, externalId), row })
      return
    }
    const key = bankFingerprint(companyId, date, amount, label, reference)
    const occurrence = (tupleCount.get(key) ?? 0) + 1
    tupleCount.set(key, occurrence)
    out.lines.push({ date, label, amountCents: amount, reference, externalId: null, occurrence, identityAmbiguous: false, fingerprint: bankFingerprint(companyId, date, amount, label, reference, occurrence), row })
  })
  // Tuple répété dans le fichier sans identifiant bancaire ⇒ identité ambiguë pour TOUTES ses occurrences (y compris la première).
  for (const l of out.lines) {
    if (l.externalId) continue
    const key = bankFingerprint(companyId, l.date, l.amountCents, l.label, l.reference)
    if ((tupleCount.get(key) ?? 0) > 1) l.identityAmbiguous = true
  }
  return out
}

/** Devine un mapping à partir des en-têtes (modifiable par l'utilisateur). */
export function guessBankMapping(header: string[]): BankColumnMapping {
  const n = header.map((h) => h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))
  const find = (...keys: string[]) => n.findIndex((h) => keys.some((k) => h.includes(k)))
  const debit = find("debit"), credit = find("credit")
  const amount = find("montant", "amount")
  // Identifiant bancaire : correspondance exacte d'en-têtes connus (jamais par sous-chaîne : « liquidité » ne contient pas un identifiant).
  const BANK_ID_HEADERS = new Set(["fitid", "id", "uid", "identifiant", "identifiant operation", "identifiant transaction", "id operation", "id transaction", "transaction id", "operation id", "bank id", "id banque"])
  const bankId = n.findIndex((h) => BANK_ID_HEADERS.has(h.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim()))
  const reference = (() => { const i = n.findIndex((h, idx) => idx !== bankId && ["reference", "ref", "piece"].some((k) => h.includes(k))); return i >= 0 ? i : undefined })()
  return { date: Math.max(0, find("date")), label: Math.max(0, find("libelle", "label", "description", "intitule")), amount: amount >= 0 && !(debit >= 0 && credit >= 0) ? amount : undefined, debit: debit >= 0 ? debit : undefined, credit: credit >= 0 ? credit : undefined, reference, ...(bankId >= 0 ? { bankId } : {}), headerRows: 1 }
}
