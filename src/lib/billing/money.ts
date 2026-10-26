// ═══════════════════════════════════════════════════════════════════════════
// Facturation complète (Lot C) — monnaie exacte en centimes (BigInt), conversions Decimal ↔ centimes.
// Règle d'arrondi (ADR-PLAN-003 §2) : « demi supérieur » appliqué à la valeur absolue, ligne par ligne, puis
// totaux = sommes. Aucun nombre flottant dans un calcul. Les colonnes Decimal(10,2) de production restent le
// stockage ; ce module est le SEUL point de conversion.
// ═══════════════════════════════════════════════════════════════════════════
import { Prisma } from "@prisma/client"
import { MoneyError, parseAmountToCents, roundHalfUp, vatCents } from "@/lib/accounting/engine/money"

export { MoneyError, roundHalfUp, vatCents }

/** Plafond des colonnes Decimal(10,2) : 99 999 999,99 €. */
export const MAX_DECIMAL_10_2_CENTS = BigInt("9999999999")

/** Taux de TVA autorisés (points de base) : 0 ; 2,1 ; 5,5 ; 10 ; 20 %. */
export const VAT_RATES_BP: readonly number[] = [0, 210, 550, 1000, 2000]

export function isAllowedVatRateBp(bp: number): boolean {
  return VAT_RATES_BP.includes(bp)
}

/** « 20 » | « 5.5 » | « 5,5 » | « 2.10 » → points de base (2000, 550, 210). Refuse tout taux hors liste. */
export function parseVatRateToBp(input: string | number): number {
  const s = String(input).trim().replace(",", ".")
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new MoneyError("VAT_RATE_INVALID")
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"))
  if (!isAllowedVatRateBp(bp)) throw new MoneyError("VAT_RATE_INVALID")
  return bp
}

/** Points de base → « 20 » / « 5.5 » / « 2.1 » (chaîne décimale, sans flottant). */
export function bpToPercentString(bp: number): string {
  const units = Math.trunc(bp / 100)
  const dec = bp % 100
  if (dec === 0) return String(units)
  return `${units}.${String(dec).padStart(2, "0").replace(/0$/, "")}`
}

/** Pourcentage saisi (« 2,5 », « 10 ») → points de base, borné [0, 100 %]. */
export function parsePercentToBp(input: string | number): number {
  const s = String(input).trim().replace(/[\s  ]/g, "").replace(",", ".")
  if (s === "") return 0
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new MoneyError("PERCENT_INVALID")
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"))
  if (bp > 10000) throw new MoneyError("PERCENT_INVALID")
  return bp
}

/** Quantité saisie (« 2 », « 1,5 », « 0.25 ») → centièmes (entier), 2 décimales max, ≥ 0, ≤ 99 999 999,99. */
export function parseQuantityToHundredths(input: string | number): bigint {
  const s = String(input).trim().replace(/[\s  ]/g, "").replace(",", ".")
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new MoneyError("QUANTITY_INVALID")
  return BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? "").padEnd(2, "0") || "0")
}

/** Montant saisi en euros (« 1 234,56 », « 1234.5 », « » ⇒ 0) → centimes. Refuse signe et plus de 2 décimales. */
export function parseEuroInputToCents(input: string | number): bigint {
  const s = String(input).replace(/[\s  ]/g, "").replace(",", ".")
  if (s === "") return BigInt(0)
  const cents = parseAmountToCents(s)
  if (cents > MAX_DECIMAL_10_2_CENTS) throw new MoneyError("AMOUNT_TOO_LARGE")
  return cents
}

/** Prisma.Decimal (2 décimales) → centimes. Toute valeur non représentable en centimes est refusée. */
export function decimalToCents(value: Prisma.Decimal | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return BigInt(0)
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value)
  if (!d.isFinite()) throw new MoneyError("DECIMAL_NOT_FINITE")
  const fixed = d.toFixed(2)
  if (!d.equals(new Prisma.Decimal(fixed))) throw new MoneyError("DECIMAL_NOT_CENTS")
  const neg = fixed.startsWith("-")
  const [units, dec] = (neg ? fixed.slice(1) : fixed).split(".")
  const cents = BigInt(units) * BigInt(100) + BigInt(dec)
  return neg ? -cents : cents
}

/** Centimes → chaîne décimale « 1234.56 » / « -0.05 » acceptée par Prisma pour une colonne Decimal. */
export function centsToDecimalString(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  return `${neg ? "-" : ""}${(abs / BigInt(100)).toString()}.${(abs % BigInt(100)).toString().padStart(2, "0")}`
}

/** Centimes → Prisma.Decimal exact. */
export function centsToDecimal(cents: bigint): Prisma.Decimal {
  if (cents > MAX_DECIMAL_10_2_CENTS || -cents > MAX_DECIMAL_10_2_CENTS) throw new MoneyError("AMOUNT_TOO_LARGE")
  return new Prisma.Decimal(centsToDecimalString(cents))
}

/** Quantité en centièmes → chaîne décimale « 1.50 » pour Decimal(10,2). */
export function hundredthsToDecimalString(h: bigint): string {
  return centsToDecimalString(h)
}

/** Affichage fr-FR « 1 234,56 € » (exact, sans flottant). */
export function formatEuro(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  const units = (abs / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  const dec = (abs % BigInt(100)).toString().padStart(2, "0")
  return `${neg ? "−" : ""}${units},${dec} €`
}

/** Centimes → nombre JS pour l'AFFICHAGE uniquement (graphiques) ; jamais pour un calcul. */
export function centsToDisplayNumber(cents: bigint): number {
  return Number(cents) / 100
}

// ─── Lignes et totaux de document (devis, facture, avoir) ───────────────────

export interface DocumentLineInput {
  quantityHundredths: bigint
  unitPriceCents: bigint        // peut être négatif (lignes de déduction d'acompte, C3)
  discountBp: number            // remise de ligne 0..10000
  vatRateBp: number             // saisie : 0 | 210 | 550 | 1000 | 2000 ; données anciennes : tout entier 0..10000
  /** Lignes de déduction d'acompte (C3) : hors remise globale. */
  excludeGlobalDiscount?: boolean
}

export interface ComputedLine {
  /** HT brut = qté × PU (arrondi au centime). */
  grossCents: bigint
  /** HT après remise de ligne (stocké dans lineHT). */
  lineHTCents: bigint
  /** HT après remise de ligne ET remise globale (base de TVA). */
  netCents: bigint
  vatCents: bigint
  vatRateBp: number
}

export interface VatSummaryRow { vatRateBp: number; baseCents: bigint; vatCents: bigint }

export interface DocumentTotals {
  lines: ComputedLine[]
  /** Somme des lineHT (après remises de ligne, avant remise globale). */
  subtotalCents: bigint
  globalDiscountCents: bigint
  totalHTCents: bigint
  totalVATCents: bigint
  totalTTCCents: bigint
  vatSummary: VatSummaryRow[]
}

export interface DocumentTotalsOptions {
  globalDiscountBp: number
  /** Autoliquidation : TVA nulle sur toutes les lignes (taux conservés pour l'affichage). */
  vatReverseCharge: boolean
}

export function computeLine(l: DocumentLineInput, globalDiscountBp: number, vatReverseCharge: boolean): ComputedLine {
  if (!Number.isInteger(l.discountBp) || l.discountBp < 0 || l.discountBp > 10000) throw new MoneyError("PERCENT_INVALID")
  if (!Number.isInteger(globalDiscountBp) || globalDiscountBp < 0 || globalDiscountBp > 10000) throw new MoneyError("PERCENT_INVALID")
  // Taux : tout entier 0..10000 en calcul (les documents anciens peuvent porter un taux hors liste, ex. 8,5 % DOM) ;
  // la liste fermée est imposée à la saisie par parseVatRateToBp.
  if (!Number.isInteger(l.vatRateBp) || l.vatRateBp < 0 || l.vatRateBp > 10000) throw new MoneyError("VAT_RATE_INVALID")
  if (l.quantityHundredths < BigInt(0)) throw new MoneyError("QUANTITY_INVALID")
  const grossCents = roundHalfUp(l.quantityHundredths * l.unitPriceCents, BigInt(100))
  const lineDiscount = roundHalfUp(grossCents * BigInt(l.discountBp), BigInt(10000))
  const lineHTCents = grossCents - lineDiscount
  const globalDiscount = l.excludeGlobalDiscount ? BigInt(0) : roundHalfUp(lineHTCents * BigInt(globalDiscountBp), BigInt(10000))
  const netCents = lineHTCents - globalDiscount
  const vat = vatReverseCharge ? BigInt(0) : vatCents(netCents, l.vatRateBp)
  return { grossCents, lineHTCents, netCents, vatCents: vat, vatRateBp: l.vatRateBp }
}

export function computeDocumentTotals(lines: readonly DocumentLineInput[], opts: DocumentTotalsOptions): DocumentTotals {
  const computed = lines.map((l) => computeLine(l, opts.globalDiscountBp, opts.vatReverseCharge))
  let subtotal = BigInt(0), totalHT = BigInt(0), totalVAT = BigInt(0)
  const byRate = new Map<number, VatSummaryRow>()
  for (const c of computed) {
    subtotal += c.lineHTCents
    totalHT += c.netCents
    totalVAT += c.vatCents
    const row = byRate.get(c.vatRateBp) ?? { vatRateBp: c.vatRateBp, baseCents: BigInt(0), vatCents: BigInt(0) }
    row.baseCents += c.netCents
    row.vatCents += c.vatCents
    byRate.set(c.vatRateBp, row)
  }
  const vatSummary = [...byRate.values()].sort((a, b) => a.vatRateBp - b.vatRateBp)
  const totals: DocumentTotals = {
    lines: computed, subtotalCents: subtotal, globalDiscountCents: subtotal - totalHT,
    totalHTCents: totalHT, totalVATCents: totalVAT, totalTTCCents: totalHT + totalVAT, vatSummary,
  }
  for (const v of [totals.totalHTCents, totals.totalVATCents, totals.totalTTCCents]) {
    if (v > MAX_DECIMAL_10_2_CENTS || -v > MAX_DECIMAL_10_2_CENTS) throw new MoneyError("AMOUNT_TOO_LARGE")
  }
  return totals
}

/** Ligne persistée (Decimal) → entrée de calcul. */
export function storedLineToInput(l: { quantity: Prisma.Decimal | string; unitPrice: Prisma.Decimal | string; vatRate: Prisma.Decimal | string; discountBp: number }): DocumentLineInput {
  return {
    quantityHundredths: decimalToCents(l.quantity),
    unitPriceCents: decimalToCents(l.unitPrice),
    discountBp: l.discountBp,
    vatRateBp: parseVatRateToBp(l.vatRate instanceof Prisma.Decimal ? l.vatRate.toFixed(2) : String(l.vatRate)),
  }
}

/** Taux stocké (Decimal, ex. 20.00) → points de base. Les taux hors liste (données anciennes) sont acceptés en lecture, bornés 0..100 %. */
export function storedVatRateToBp(rate: Prisma.Decimal | string | number): number {
  const d = rate instanceof Prisma.Decimal ? rate : new Prisma.Decimal(rate)
  const bp = Number(decimalToCents(d))
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new MoneyError("VAT_RATE_INVALID")
  return bp
}
