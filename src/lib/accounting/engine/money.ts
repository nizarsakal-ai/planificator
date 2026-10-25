// Montants comptables exacts : centimes en BigInt (ADR-PLAN-003 §2, SPEC-ACC-A §3 bis).
// Aucun nombre flottant : entrées en chaînes décimales strictes, sorties en chaînes.

export const MAX_LINE_CENTS = BigInt(1000000000000000) // 10^15 centimes

const AMOUNT = /^(\d{1,13})(?:\.(\d{1,2}))?$/

/** "1234.5" → BigInt(123450). Refuse signe, espaces, séparateurs, exposants, plus de 2 décimales. */
export function parseAmountToCents(input: string): bigint {
  if (typeof input !== "string") throw new MoneyError("AMOUNT_NOT_STRING")
  const m = AMOUNT.exec(input)
  if (!m) throw new MoneyError("AMOUNT_INVALID")
  const cents = BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? "").padEnd(2, "0") || "0")
  if (cents > MAX_LINE_CENTS) throw new MoneyError("AMOUNT_TOO_LARGE")
  return cents
}

/** BigInt(123450) → "1234.50" ; négatif → "-1234.50". */
export function formatCents(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  const units = abs / BigInt(100)
  const dec = (abs % BigInt(100)).toString().padStart(2, "0")
  return `${neg ? "-" : ""}${units}.${dec}`
}

/**
 * Arrondi « demi supérieur » appliqué à la valeur absolue, signe réappliqué.
 * value / divisor en entiers (ex. HT × taux_bp / 10000).
 */
export function roundHalfUp(value: bigint, divisor: bigint): bigint {
  if (divisor <= BigInt(0)) throw new MoneyError("DIVISOR_INVALID")
  const neg = value < BigInt(0)
  const abs = neg ? -value : value
  const q = abs / divisor
  const r = abs % divisor
  const rounded = r * BigInt(2) >= divisor ? q + BigInt(1) : q
  return neg ? -rounded : rounded
}

/** TVA d'un montant HT en centimes au taux en points de base (2000 = 20 %), arrondie au centime. */
export function vatCents(netCents: bigint, rateBp: number): bigint {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new MoneyError("VAT_RATE_INVALID")
  return roundHalfUp(netCents * BigInt(rateBp), BigInt(10000))
}

export class MoneyError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "MoneyError"
  }
}
