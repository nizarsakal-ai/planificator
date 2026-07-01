// ═══════════════════════════════════════════════════════════════════════════
// Facturation — Calcul des totaux (HT / TVA / TTC)
// Arrondi à 2 décimales pour chaque montant. Les lignes portent leur propre TVA.
// ═══════════════════════════════════════════════════════════════════════════

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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Calcule le HT d'une ligne (quantité × prix unitaire), arrondi 2 décimales. */
export function computeLineHT(line: LineInput): number {
  return round2(line.quantity * line.unitPrice)
}

/** Agrège les totaux d'un ensemble de lignes (TVA par ligne). */
export function computeTotals(lines: LineInput[]): Totals {
  let totalHT = 0
  let totalVAT = 0
  for (const line of lines) {
    const ht = computeLineHT(line)
    totalHT += ht
    totalVAT += round2(ht * (line.vatRate / 100))
  }
  totalHT = round2(totalHT)
  totalVAT = round2(totalVAT)
  return { totalHT, totalVAT, totalTTC: round2(totalHT + totalVAT) }
}
