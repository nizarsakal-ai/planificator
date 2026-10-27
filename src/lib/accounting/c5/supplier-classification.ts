// Référentiel partagé navigateur/serveur : suggestions modifiables, jamais une validation comptable.
export const SUPPLIER_CATEGORIES = ["marchandises", "services", "location", "deplacement", "honoraires", "entretien", "autre"] as const
export type SupplierCategory = typeof SUPPLIER_CATEGORIES[number]
export const CATEGORY_ACCOUNT: Record<string, string> = { marchandises: "607000", services: "604000", location: "613000", deplacement: "625000", honoraires: "622000", entretien: "615000", autre: "606000" }

/** Tolère les libellés français usuels ; aucune catégorie devinée à partir d'un texte inconnu. */
export function normalizeSupplierCategory(value: unknown): SupplierCategory | null {
  if (typeof value !== "string") return null
  const key = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ")
  const aliases: Record<string, SupplierCategory> = {
    marchandise: "marchandises", achats: "marchandises", service: "services", prestations: "services", "prestations de services": "services",
    locations: "location", deplacements: "deplacement", "frais de deplacement": "deplacement",
    honoraire: "honoraires", "entretien et reparations": "entretien", reparation: "entretien", reparations: "entretien", autres: "autre",
  }
  return (SUPPLIER_CATEGORIES as readonly string[]).includes(key) ? key as SupplierCategory : aliases[key] ?? null
}

/** Ne retourne qu'un compte proposé par le serveur pour cette société (actif, classe 6). */
export function suggestedExpenseAccountId(category: unknown, accounts: readonly { id: string; number: string }[]): string {
  const normalized = normalizeSupplierCategory(category)
  return normalized ? accounts.find((a) => a.number === CATEGORY_ACCOUNT[normalized])?.id ?? "" : ""
}
