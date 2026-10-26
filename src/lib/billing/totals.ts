// ═══════════════════════════════════════════════════════════════════════════
// Facturation — Calcul des totaux (HT / TVA / TTC) du chemin Lot B (drapeau OFF).
// Correctif P1-01 (revue indépendante du 26/10/2026) : ce module délègue désormais au moteur monétaire en centimes
// (`money.ts`, arrondi demi-supérieur ligne par ligne) : les totaux enregistrés par l'ancien chemin sont ainsi identiques au
// recalcul effectué par le contrôle d'intégrité (PDF, TVA, écritures). L'ancien arrondi flottant divergeait d'un centime sur
// certaines quantités fractionnaires (ex. 0,15 × 13,70 € : 2,05 au lieu de 2,06).
// ═══════════════════════════════════════════════════════════════════════════
import { computeDocumentTotals, computeLine } from "./money"

export interface LineInput {
  quantity: number
  unitPrice: number
  vatRate: number
}

export interface ComputedLine extends LineInput {
  lineHT: number
}

export interface Totals {
  totalHT: number
  totalVAT: number
  totalTTC: number
}

/** Nombre à 2 décimales (colonnes Decimal(10,2)) → centièmes entiers, sans flottant résiduel. */
function toHundredths(n: number): bigint {
  if (!Number.isFinite(n)) throw new Error("TOTALS_INVALID_NUMBER")
  return BigInt(Math.round(n * 100))
}
const toInput = (line: LineInput) => ({ quantityHundredths: toHundredths(line.quantity), unitPriceCents: toHundredths(line.unitPrice), discountBp: 0, vatRateBp: Number(toHundredths(line.vatRate)) })
const fromCents = (c: bigint) => Number(c) / 100

/** Calcule le HT d'une ligne (quantité × prix unitaire), arrondi demi-supérieur au centime (moteur centimes). */
export function computeLineHT(line: LineInput): number {
  return fromCents(computeLine(toInput(line), 0, false).lineHTCents)
}

/** Agrège les totaux d'un ensemble de lignes (TVA par ligne) — même moteur que l'émission C2 et le contrôle d'intégrité. */
export function computeTotals(lines: LineInput[]): Totals {
  const t = computeDocumentTotals(lines.map(toInput), { globalDiscountBp: 0, vatReverseCharge: false })
  return { totalHT: fromCents(t.totalHTCents), totalVAT: fromCents(t.totalVATCents), totalTTC: fromCents(t.totalTTCCents) }
}
