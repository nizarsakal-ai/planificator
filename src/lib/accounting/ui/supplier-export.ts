// Export comptable des factures fournisseurs : une ligne par facture, au format CSV des autres exports comptables
// (séparateur « ; », décimales à la virgule, BOM UTF-8). Fonctions pures, sans accès base.
import { buildCsv, type CsvCell } from "@/lib/accounting/ui/csv"

export interface SupplierExportRow {
  supplierName: string
  siret: string | null
  number: string
  date: Date
  dueDate: Date | null
  totalHTCents: bigint
  vatCents: bigint
  totalTTCCents: bigint
  vatRateBp: number | null
  status: string
  category: string | null
  validatedAt: Date | null
  paidAt: Date | null
  expenseAccount: { number: string; label: string } | null
  supplier: { name: string } | null
}

export const SUPPLIER_EXPORT_HEADER = ["Date", "Fournisseur", "SIRET", "N° facture", "Échéance", "Montant HT", "TVA", "Montant TTC", "Taux TVA (%)", "Compte de charge", "Libellé du compte", "Statut", "Validée le", "Payée le"] as const

const STATUS_LABEL: Record<string, string> = { PENDING: "À valider", VALIDATED: "Validée", REJECTED: "Rejetée" }
const dayFr = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })
const dayFrParis = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric" })

/** Taux en points de base → « 20 », « 5,5 », « 2,1 ». */
function vatRate(bp: number): string {
  return (bp / 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",")
}

export function buildSupplierExportCsv(rows: readonly SupplierExportRow[], categoryLabel: Record<string, string>): string {
  return buildCsv(
    SUPPLIER_EXPORT_HEADER,
    rows.map((r): CsvCell[] => [
      { text: dayFr.format(r.date) },
      { text: r.supplier?.name ?? r.supplierName },
      { text: r.siret ?? "" },
      { text: r.number },
      { text: r.dueDate ? dayFr.format(r.dueDate) : "" },
      { amount: r.totalHTCents },
      { amount: r.vatCents },
      { amount: r.totalTTCCents },
      { text: r.vatRateBp === null ? "" : vatRate(r.vatRateBp) },
      { text: r.expenseAccount?.number ?? "" },
      { text: r.expenseAccount?.label ?? (r.category ? (categoryLabel[r.category] ?? r.category) : "") },
      { text: STATUS_LABEL[r.status] ?? r.status },
      { text: r.validatedAt ? dayFrParis.format(r.validatedAt) : "" },
      { text: r.paidAt ? dayFr.format(r.paidAt) : "" },
    ]),
  )
}

/** Lien de téléchargement reprenant les filtres actifs de la liste. */
export function supplierExportHref(filters: { q?: string; status?: string }): string {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  if (filters.status) params.set("statut", filters.status)
  const qs = params.toString()
  return `/comptabilite/fournisseurs/export${qs ? `?${qs}` : ""}`
}
