// Quantités du module stocks : entiers en millièmes d'unité (3 décimales au plus), jamais de flottant.
export const QUANTITY_MAX_MILLI = 1_000_000_000 // 1 000 000 unités, borne de saisie et de cumul raisonnable

/** "12", "12,5", "0.125" → millièmes ; refuse négatif, zéro (si exigé), plus de 3 décimales, notation exponentielle. */
export function parseQuantityToMilli(input: string, opts: { allowZero?: boolean } = {}): number | null {
  const s = String(input ?? "").trim().replace(",", ".")
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(s)) return null
  const [int, dec = ""] = s.split(".")
  const milli = Number(int) * 1000 + Number(dec.padEnd(3, "0"))
  if (!Number.isSafeInteger(milli) || milli > QUANTITY_MAX_MILLI) return null
  if (milli === 0 && !opts.allowZero) return null
  return milli
}

/** 12500 → "12,5" ; 125 → "0,125" ; jamais d'arrondi caché. */
export function formatMilli(milli: number): string {
  const sign = milli < 0 ? "-" : ""
  const abs = Math.abs(milli)
  const int = Math.trunc(abs / 1000)
  const dec = String(abs % 1000).padStart(3, "0").replace(/0+$/, "")
  return `${sign}${int.toLocaleString("fr-FR")}${dec ? `,${dec}` : ""}`
}

/** Montant d'une ligne en centimes (BigInt, sans perte) : quantité (millièmes) × prix unitaire (centimes), arrondi
 * au centime le plus proche (demi vers le haut ; les deux opérandes sont positifs ou nuls). */
export function lineAmountCents(quantityMilli: number, unitPriceCents: number): bigint {
  if (!Number.isSafeInteger(quantityMilli) || !Number.isSafeInteger(unitPriceCents) || quantityMilli < 0 || unitPriceCents < 0) {
    throw new RangeError("LINE_AMOUNT_INVALID")
  }
  return (BigInt(quantityMilli) * BigInt(unitPriceCents) + BigInt("500")) / BigInt("1000")
}
