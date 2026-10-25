import type { Metadata } from "next"
import Link from "next/link"
import { FileText, Plus, Settings } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { listQuotes, quoteFormOptions } from "@/lib/billing/quotes/quote-queries"
import { filtersFromParams } from "@/lib/billing/quotes/quote-filters"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { QuoteStatusBadge } from "@/components/devis/QuoteStatusBadge"
import { QuoteImportDialog } from "@/components/devis/QuoteImportDialog"

export const metadata: Metadata = { title: "Devis" }
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
const STATUSES = [["", "Tous les statuts"], ["DRAFT", "Brouillon"], ["SENT", "Envoyé"], ["ACCEPTED", "Accepté"], ["REFUSED", "Refusé"], ["EXPIRED", "Expiré"], ["CONVERTED", "Converti"]]

export default async function DevisPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireBillingPage()
  const f = filtersFromParams(await searchParams)
  const [list, options] = await Promise.all([listQuotes(prisma, ctx.companyId, f), quoteFormOptions(prisma, ctx.companyId)])
  const query = new URLSearchParams(Object.entries(f.raw).filter(([k, v]) => v && k !== "page")).toString()
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><FileText className="h-6 w-6 text-[#0f3460]" /> Devis</h1>
          <p className="mt-1 text-sm text-slate-500">{list.total} devis</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/factures/parametres"><Settings className="h-4 w-4" /> Paramètres</Link></Button>
          <Button variant="outline" asChild><a href={`/devis/export${query ? `?${query}` : ""}`}>Exporter</a></Button>
          <QuoteImportDialog />
          <Button asChild><Link href="/devis/nouveau"><Plus className="h-4 w-4" /> Nouveau devis</Link></Button>
        </div>
      </div>

      <Card><CardContent className="p-4">
        <form method="get" className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Input name="q" placeholder="N° ou client" defaultValue={f.raw.q} className="sm:col-span-2" aria-label="Recherche" />
          <select name="statut" defaultValue={f.raw.statut} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Statut">{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select name="client" defaultValue={f.raw.client} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Client"><option value="">Tous les clients</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <Input name="du" type="date" defaultValue={f.raw.du} aria-label="Du" />
          <Input name="au" type="date" defaultValue={f.raw.au} aria-label="Au" />
          <Input name="min" inputMode="decimal" placeholder="TTC min" defaultValue={f.raw.min} aria-label="Montant TTC minimum" />
          <div className="flex gap-2"><Input name="max" inputMode="decimal" placeholder="TTC max" defaultValue={f.raw.max} aria-label="Montant TTC maximum" /><Button type="submit" variant="secondary">Filtrer</Button></div>
        </form>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th className="px-3 py-2">N°</th><th className="px-3 py-2">Client</th><th className="hidden px-3 py-2 md:table-cell">Chantier</th><th className="px-3 py-2">Date</th><th className="hidden px-3 py-2 md:table-cell">Validité</th><th className="px-3 py-2 text-right">Total TTC</th><th className="px-3 py-2">Statut</th><th className="hidden px-3 py-2 lg:table-cell">Facture</th>
          </tr></thead>
          <tbody>
            {list.rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Aucun devis.</td></tr>}
            {list.rows.map((q) => (
              <tr key={q.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium"><Link href={`/devis/${q.id}`} className="text-[#0f3460] hover:underline">{q.number}</Link>{q.subject && <div className="text-xs text-slate-400">{q.subject}</div>}</td>
                <td className="px-3 py-2">{q.clientName}</td>
                <td className="hidden px-3 py-2 md:table-cell">{q.worksiteName}</td>
                <td className="px-3 py-2">{dateFr.format(q.issueDate)}</td>
                <td className="hidden px-3 py-2 md:table-cell">{q.validUntil ? dateFr.format(q.validUntil) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(q.totalTTCCents)}</td>
                <td className="px-3 py-2"><QuoteStatusBadge status={q.status} /></td>
                <td className="hidden px-3 py-2 lg:table-cell">{q.invoice ? <Link href={`/factures/${q.invoice.id}`} className="hover:underline">{q.invoice.number}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm">
            <span>Page {list.page} / {pages}</span>
            <div className="flex gap-2">
              {list.page > 1 && <Link className="underline" href={`/devis?${query}&page=${list.page - 1}`}>Précédente</Link>}
              {list.page < pages && <Link className="underline" href={`/devis?${query}&page=${list.page + 1}`}>Suivante</Link>}
            </div>
          </div>
        )}
      </CardContent></Card>
    </div>
  )
}
