// Filtres de la liste des factures (pur).
import { searchParam } from "@/lib/accounting/ui/labels"
import { isCalendarDay } from "@/lib/accounting/ui/forms"
import type { InvoiceListFilters } from "./invoice-queries"

export function invoiceFiltersFromParams(sp: Record<string, string | string[] | undefined>): InvoiceListFilters & { raw: Record<string, string> } {
  const raw = { q: searchParam(sp.q) ?? "", statut: searchParam(sp.statut) ?? "", client: searchParam(sp.client) ?? "", du: searchParam(sp.du) ?? "", au: searchParam(sp.au) ?? "", retard: searchParam(sp.retard) ?? "", page: searchParam(sp.page) ?? "1" }
  return { raw, search: raw.q || undefined, status: raw.statut || undefined, clientId: raw.client || undefined, overdue: raw.retard === "1", from: isCalendarDay(raw.du) ? raw.du : undefined, to: isCalendarDay(raw.au) ? raw.au : undefined, page: Number(raw.page) || 1 }
}
