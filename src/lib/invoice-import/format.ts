// Utilitaires d'affichage sans dépendance serveur (utilisables dans les composants client).
import type { ImportRowKind, ImportStatus } from "./types"

export const KIND_LABEL: Record<ImportRowKind, string> = { INVOICE: "Facture client", CREDIT_NOTE: "Avoir client", SUPPLIER: "Facture fournisseur" }
export const STATUS_LABEL: Record<ImportStatus, string> = { ISSUED: "Émise", PARTIALLY_PAID: "Partiellement payée", PAID: "Payée", OVERDUE: "En retard", CANCELLED: "Annulée", UNKNOWN: "Non précisé" }

/** « 1 234,56 » → "123456" (centimes, chaîne) ; vide ⇒ null ; illisible ⇒ undefined. */
export function eurosToCents(input: string): string | null | undefined {
  const s = input.replace(/[\s  €]/g, "").replace(",", ".")
  if (s === "") return null
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return undefined
  const [units, dec = ""] = s.split(".")
  return (BigInt(units) * BigInt(100) + BigInt(dec.padEnd(2, "0"))).toString()
}
export function centsToEuros(cents: string | null): string {
  if (cents === null) return ""
  const c = cents.padStart(3, "0")
  return `${c.slice(0, -2)},${c.slice(-2)}`
}
