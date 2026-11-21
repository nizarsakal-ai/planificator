// Lot C : formats d'affichage des budgets et marges (montants en centimes, taux en points de base).
import { formatEuro } from "@/lib/billing/money"

/** Taux en points de base → « 12,5 % » ; null → « — ». */
export function fmtBp(bp: number | null): string {
  if (bp === null) return "—"
  const neg = bp < 0
  const abs = Math.abs(bp)
  return `${neg ? "−" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} %`
}
/** Montant signé, en rouge s'il est négatif (marge négative, dépassement). Classe -700 lisible en clair et en sombre. */
export const signedClass = (cents: bigint) => (cents < BigInt(0) ? "text-red-700" : "text-slate-900")
/** Centimes → valeur d'un champ de saisie en euros (« 1234,50 »), vide si nul. */
export function centsToInput(cents: bigint): string {
  if (cents === BigInt(0)) return ""
  return `${cents / BigInt(100)},${String(cents % BigInt(100)).padStart(2, "0")}`
}
export { formatEuro }
