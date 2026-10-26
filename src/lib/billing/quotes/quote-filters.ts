// Filtres de la liste des devis à partir des paramètres d'URL (pur ; les ids sont ensuite filtrés par société).
import { parseEuroInputToCents } from "@/lib/billing/money"
import { searchParam } from "@/lib/accounting/ui/labels"
import { isCalendarDay } from "@/lib/accounting/ui/forms"
import type { QuoteListFilters } from "./quote-queries"

export function filtersFromParams(sp: Record<string, string | string[] | undefined>): QuoteListFilters & { raw: Record<string, string> } {
  const raw = { q: searchParam(sp.q) ?? "", statut: searchParam(sp.statut) ?? "", client: searchParam(sp.client) ?? "", du: searchParam(sp.du) ?? "", au: searchParam(sp.au) ?? "", min: searchParam(sp.min) ?? "", max: searchParam(sp.max) ?? "", page: searchParam(sp.page) ?? "1" }
  const cents = (v: string) => { try { return v ? parseEuroInputToCents(v) : undefined } catch { return undefined } }
  return {
    raw, search: raw.q || undefined, status: raw.statut || undefined, clientId: raw.client || undefined,
    from: isCalendarDay(raw.du) ? raw.du : undefined, to: isCalendarDay(raw.au) ? raw.au : undefined,
    minTTC: cents(raw.min), maxTTC: cents(raw.max), page: Number(raw.page) || 1,
  }
}

