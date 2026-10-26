// ═══════════════════════════════════════════════════════════════════════════
// Avoirs partiels — Lot C4 (SPEC-BILLING-C4) : calcul pur des lignes d'un avoir partiel (par lignes/quantités ou
// par montant HT ventilé par taux) et plafonnement. Centimes BigInt.
// ═══════════════════════════════════════════════════════════════════════════
import { MoneyError, computeDocumentTotals, roundHalfUp, type DocumentLineInput, type DocumentTotals } from "@/lib/billing/money"

export interface OriginLine { id: string; designation: string; description: string | null; unit: string; quantityHundredths: bigint; unitPriceCents: bigint; discountBp: number; vatRateBp: number; deductsDepositId: string | null }

export type CreditRequest =
  | { kind: "LINES"; items: { lineId: string; quantityHundredths: bigint }[] }
  | { kind: "AMOUNT_HT"; cents: bigint }

export interface CreditLineSpec { articleId?: null; designation: string; description: string | null; unit: string; quantityHundredths: bigint; unitPriceCents: bigint; discountBp: number; vatRateBp: number }

/**
 * Lignes d'un avoir partiel.
 * - LINES : mêmes PU/remise/taux que l'origine, quantité ≤ quantité d'origine (> 0), désignation préfixée « Avoir — » ;
 *   les lignes de déduction d'acompte (négatives) ne sont pas créditables.
 * - AMOUNT_HT : montant HT ventilé par taux au prorata des bases HT nettes de l'origine ; une ligne par taux, remise 0.
 */
export function computeCreditLines(origin: { lines: OriginLine[]; globalDiscountBp: number; vatReverseCharge: boolean }, request: CreditRequest): { lines: CreditLineSpec[]; totals: DocumentTotals } {
  let lines: CreditLineSpec[]
  if (request.kind === "LINES") {
    if (request.items.length === 0) throw new MoneyError("CREDIT_NO_LINES")
    lines = request.items.map((it) => {
      const o = origin.lines.find((l) => l.id === it.lineId)
      if (!o) throw new MoneyError("CREDIT_LINE_UNKNOWN")
      if (o.deductsDepositId || o.unitPriceCents < BigInt(0)) throw new MoneyError("CREDIT_LINE_NOT_CREDITABLE")
      if (it.quantityHundredths <= BigInt(0) || it.quantityHundredths > o.quantityHundredths) throw new MoneyError("CREDIT_QUANTITY_INVALID")
      return { designation: `Avoir — ${o.designation}`, description: o.description, unit: o.unit, quantityHundredths: it.quantityHundredths, unitPriceCents: o.unitPriceCents, discountBp: o.discountBp, vatRateBp: o.vatRateBp }
    })
  } else {
    if (request.cents <= BigInt(0)) throw new MoneyError("AMOUNT_INVALID")
    const base = computeDocumentTotals(origin.lines.filter((l) => !l.deductsDepositId && l.unitPriceCents > BigInt(0)).map((l): DocumentLineInput => ({ quantityHundredths: l.quantityHundredths, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp })), { globalDiscountBp: origin.globalDiscountBp, vatReverseCharge: origin.vatReverseCharge })
    const rows = base.vatSummary.filter((r) => r.baseCents > BigInt(0))
    if (rows.length === 0) throw new MoneyError("CREDIT_NO_LINES")
    if (request.cents > base.totalHTCents) throw new MoneyError("CREDIT_EXCEEDS")
    let allocated = BigInt(0)
    lines = rows.map((r, i) => {
      const share = i === rows.length - 1 ? request.cents - allocated : roundHalfUp(request.cents * r.baseCents, base.totalHTCents)
      allocated += share
      const pct = (bp: number) => { const u = Math.trunc(bp / 100), d = bp % 100; return d === 0 ? String(u) : `${u},${String(d).padStart(2, "0").replace(/0$/, "")}` }
      return { designation: `Avoir — remise sur prestations (base TVA ${pct(r.vatRateBp)} %)`, description: null, unit: "forfait", quantityHundredths: BigInt(100), unitPriceCents: share, discountBp: 0, vatRateBp: r.vatRateBp }
    })
    if (lines.some((l) => l.unitPriceCents < BigInt(0)) || lines.reduce((s, l) => s + l.unitPriceCents, BigInt(0)) !== request.cents) throw new MoneyError("CREDIT_ROUNDING")
    lines = lines.filter((l) => l.unitPriceCents > BigInt(0))
  }
  // Un avoir partiel ne porte pas la remise globale de l'origine en mode LINES ? Si : mêmes conditions commerciales
  // (PU, remise de ligne ET remise globale) pour rester une annulation partielle fidèle de la facture.
  const totals = computeDocumentTotals(lines, { globalDiscountBp: request.kind === "LINES" ? origin.globalDiscountBp : 0, vatReverseCharge: origin.vatReverseCharge })
  if (totals.totalTTCCents <= BigInt(0)) throw new MoneyError("CREDIT_EMPTY")
  return { lines, totals }
}
