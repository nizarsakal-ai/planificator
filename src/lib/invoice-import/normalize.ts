// SPEC-INVOICE-IMPORT-001 — normalisation pure (numéros, noms, dates, montants, natures, statuts). Aucune E/S.
import { createHash } from "node:crypto"
import { parseBankAmount, parseBankDate } from "@/lib/accounting/c5/bank-import"
import type { ImportRowKind, ImportStatus } from "./types"

const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "")

/** Clé d'identité d'un numéro de pièce : majuscules, sans espaces ni ponctuation (« FA 2024-001 » ≡ « fa2024/001 »). */
export function numberKey(raw: string): string {
  return stripAccents(raw).toUpperCase().replace(/[^A-Z0-9]/g, "")
}

const LEGAL_FORMS = /\b(sarl|sas|sasu|sa|eurl|sci|scop|snc|ei|eirl|selarl|association|ste|societe)\b/g
/** Clé de rapprochement d'un nom de tiers : sans accents, casse, ponctuation ni forme juridique. */
export function nameKey(raw: string): string {
  return stripAccents(raw).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(LEGAL_FORMS, " ").replace(/\s+/g, " ").trim()
}

/** Date en AAAA-MM-JJ depuis JJ/MM/AAAA, AAAA-MM-JJ, JJ/MM/AA, un objet Date ou un numéro de série Excel. */
export function parseImportDate(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10)
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 20000 && raw < 80000) {
    // Numéro de série Excel (système 1900) : jour 25569 = 1970-01-01.
    return new Date(Math.round((raw - 25569) * 86400000)).toISOString().slice(0, 10)
  }
  const s = String(raw ?? "").trim()
  if (!s) return null
  const short = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(s)
  const d = parseBankDate(short ? `${short[1]}/${short[2]}/20${short[3]}` : s)
  if (!d) return null
  const y = d.getUTCFullYear()
  return y >= 1990 && y <= 2100 ? d.toISOString().slice(0, 10) : null
}

/** Montant en centimes (signé) depuis « 1 234,56 € », « -12.5 », un nombre… ; null si vide ou illisible. */
export function parseImportAmount(raw: unknown): bigint | null {
  if (typeof raw === "number") return Number.isFinite(raw) && Math.abs(raw) < 1e11 ? BigInt(Math.round(raw * 100)) : null
  const s = String(raw ?? "").trim()
  if (!s) return null
  return parseBankAmount(s)
}

export function detectKind(rawKind: string, number: string, signedTtc: bigint | null): ImportRowKind {
  const k = stripAccents(rawKind).toLowerCase()
  if (/fournisseur|achat|depense|supplier|purchase|bill\b/.test(k)) return "SUPPLIER"
  if (/avoir|credit|refund|remboursement/.test(k)) return "CREDIT_NOTE"
  if (/facture|invoice|acompte|vente|sale/.test(k)) return "INVOICE"
  if (/^(AV|AVO|AVOIR|CN|CRE)[-_ ]?\d/i.test(number.trim())) return "CREDIT_NOTE"
  if (signedTtc !== null && signedTtc < BigInt(0)) return "CREDIT_NOTE"
  return "INVOICE"
}

/** Statut normalisé ; le libellé source est toujours conservé à côté. */
export function mapStatus(raw: string | null): ImportStatus {
  const s = stripAccents(raw ?? "").toLowerCase().trim()
  if (!s) return "UNKNOWN"
  if (/annul|cancel|void/.test(s)) return "CANCELLED"
  if (/partiel|partial/.test(s)) return "PARTIALLY_PAID"
  if (/impay|unpaid|non pay|non regl|a payer|a encaisser|en attente|pending|due\b/.test(s)) return /retard|overdue|late/.test(s) ? "OVERDUE" : "ISSUED"
  if (/retard|overdue|late|echu/.test(s)) return "OVERDUE"
  if (/pay|regl|encaiss|paid|sold/.test(s)) return "PAID"
  if (/emis|envoy|sent|issued|valid|finalis|final/.test(s)) return "ISSUED"
  return "UNKNOWN"
}

export interface AmountTriple { ht: bigint | null; vat: bigint | null; ttc: bigint | null }
/** Valeurs absolues ; complète le troisième montant si deux sont connus (TTC seul ⇒ rien d'inventé). */
export function completeAmounts(a: AmountTriple): AmountTriple {
  const abs = (v: bigint | null) => (v === null ? null : v < BigInt(0) ? -v : v)
  let ht = abs(a.ht), vat = abs(a.vat), ttc = abs(a.ttc)
  if (ht !== null && vat !== null && ttc === null) ttc = ht + vat
  else if (ht !== null && ttc !== null && vat === null && ttc >= ht) vat = ttc - ht
  else if (vat !== null && ttc !== null && ht === null && ttc >= vat) ht = ttc - vat
  return { ht, vat, ttc }
}

export interface HashableDocument { kind: string; numberKey: string; clientId: string; issueDate: string; dueDate: string | null; htCents: string; vatCents: string; ttcCents: string; status: string; creditedNumberKey: string | null }
/** Empreinte du contenu métier (hors PDF : un réimport sans PDF n'est pas un conflit) : identique ⇒ réimport ignoré ; différente pour la même identité ⇒ conflit. */
export function contentHash(d: HashableDocument): string {
  return createHash("sha256").update([d.kind, d.numberKey, d.clientId, d.issueDate, d.dueDate ?? "", d.htCents, d.vatCents, d.ttcCents, d.status, d.creditedNumberKey ?? ""].join("|")).digest("hex")
}
