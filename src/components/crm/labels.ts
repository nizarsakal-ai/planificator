// Lot E : pastilles des étapes (classes de couleur déjà présentes dans l'application).
export const STAGE_CLASS: Record<string, string> = {
  LEAD: "bg-slate-100 text-slate-700", QUALIFIED: "bg-blue-50 text-blue-700", PROPOSAL: "bg-blue-50 text-blue-700",
  NEGOTIATION: "bg-amber-50 text-amber-700", WON: "bg-green-50 text-green-700", LOST: "bg-red-50 text-red-600",
}
export const EVENT_LABEL: Record<string, string> = { CREATED: "Création", STAGE_CHANGED: "Changement d'étape", UPDATED: "Modification", FOLLOW_UP_DONE: "Relance faite", NOTE: "Note" }
/** Montant en centimes vers la saisie française (« 1234,50 ») ; vide pour zéro. Repris du lot C, absent de main, pour ne pas en dépendre. */
export function centsToInput(cents: bigint): string {
  if (cents === BigInt(0)) return ""
  const signe = cents < BigInt(0) ? "-" : "", v = cents < BigInt(0) ? -cents : cents
  return `${signe}${v / BigInt(100)},${String(v % BigInt(100)).padStart(2, "0")}`
}
