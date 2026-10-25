// Liste des factures — facturation complète (Lot C2). Rendue par src/app/(dashboard)/factures/page.tsx quand le drapeau est actif.
import Link from "next/link"
import { FileText, Plus, Settings } from "lucide-react"
import { prisma } from "@/lib/prisma"
import type { BillingContext } from "@/lib/billing/access"
import { invoiceSummary, listInvoices } from "@/lib/billing/invoices/invoice-queries"
import { invoiceFiltersFromParams } from "@/lib/billing/invoices/invoice-filters"
import { formatEuro } from "@/lib/billing/money"
import { PAYMENT_METHOD_LABEL } from "@/lib/billing/invoices/invoice-schemas"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { InvoiceStatusBadge } from "@/components/factures/InvoiceStatusBadge"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
const STATUSES = [["", "Tous les statuts"], ["DRAFT", "Brouillon"], ["SENT", "Émise"], ["PARTIAL", "Partiellement payée"], ["PAID", "Payée"], ["CANCELLED", "Annulée"]]

export async function InvoicesPageC2({ ctx, searchParams }: { ctx: BillingContext; searchParams: Record<string, string | string[] | undefined> }) {
  const f = invoiceFiltersFromParams(searchParams)
  const [list, summary, clients] = await Promise.all([
    listInvoices(prisma, ctx.companyId, f), invoiceSummary(prisma, ctx.companyId),
    prisma.client.findMany({ where: { companyId: ctx.companyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])
  const query = new URLSearchParams(Object.entries(f.raw).filter(([k, v]) => v && k !== "page")).toString()
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><FileText className="h-6 w-6 text-[#0f3460]" /> Factures</h1><p className="mt-1 text-sm text-slate-500">{list.total} document{list.total > 1 ? "s" : ""}</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/factures/parametres"><Settings className="h-4 w-4" /> Paramètres</Link></Button>
          <Button variant="outline" asChild><Link href="/devis">Devis</Link></Button>
          <Button asChild><Link href="/factures/nouvelle"><Plus className="h-4 w-4" /> Nouvelle facture</Link></Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Total encaissé</p><p className="mt-1 text-2xl font-semibold text-green-700 tabular-nums">{formatEuro(summary.collectedCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Total dû</p><p className="mt-1 text-2xl font-semibold text-blue-700 tabular-nums">{formatEuro(summary.dueCents)}</p><p className="text-xs text-slate-500">{summary.openCount} facture{summary.openCount > 1 ? "s" : ""} en attente</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">En retard</p><p className="mt-1 text-2xl font-semibold text-red-700 tabular-nums">{formatEuro(summary.overdueCents)}</p><p className="text-xs text-slate-500">{summary.overdueCount} facture{summary.overdueCount > 1 ? "s" : ""}</p></CardContent></Card>
      </div>
      <Card><CardContent className="p-4">
        <form method="get" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <Input name="q" placeholder="N° ou client" defaultValue={f.raw.q} className="lg:col-span-2" aria-label="Recherche" />
          <select name="statut" defaultValue={f.raw.statut} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Statut">{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select name="client" defaultValue={f.raw.client} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Client"><option value="">Tous les clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <Input name="du" type="date" defaultValue={f.raw.du} aria-label="Du" /><Input name="au" type="date" defaultValue={f.raw.au} aria-label="Au" />
          <div className="flex items-center gap-2"><label className="flex items-center gap-1 text-sm"><input type="checkbox" name="retard" value="1" defaultChecked={f.raw.retard === "1"} /> En retard</label><Button type="submit" variant="secondary">Filtrer</Button></div>
        </form>
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Date</th><th className="hidden px-3 py-2 md:table-cell">Échéance</th><th className="px-3 py-2 text-right">Montant TTC</th><th className="hidden px-3 py-2 text-right md:table-cell">Payé</th><th className="px-3 py-2 text-right">Reste à payer</th><th className="hidden px-3 py-2 lg:table-cell">Paiement</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {list.rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Aucune facture.</td></tr>}
            {list.rows.map((i) => (
              <tr key={i.id} className={`border-t hover:bg-slate-50 ${i.overdue ? "bg-red-50/40" : ""}`}>
                <td className="px-3 py-2 font-medium"><Link href={`/factures/${i.id}`} className="text-[#0f3460] hover:underline">{i.number}</Link>{i.quoteNumber && <div className="text-xs text-slate-400">devis {i.quoteNumber}</div>}</td>
                <td className="px-3 py-2">{i.clientName}<div className="text-xs text-slate-400">{i.worksiteName}</div></td>
                <td className="px-3 py-2">{i.status === "DRAFT" ? "—" : dateFr.format(i.issueDate)}</td>
                <td className="hidden px-3 py-2 md:table-cell">{i.dueDate && i.kind !== "CREDIT_NOTE" ? dateFr.format(i.dueDate) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{i.kind === "CREDIT_NOTE" ? "−" : ""}{formatEuro(i.totalTTCCents)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{i.kind === "CREDIT_NOTE" ? "—" : formatEuro(i.paidCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{i.kind === "CREDIT_NOTE" || i.status === "DRAFT" || i.status === "CANCELLED" ? "—" : formatEuro(i.remainingCents)}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{i.lastPaymentMethod ? PAYMENT_METHOD_LABEL[i.lastPaymentMethod] ?? i.lastPaymentMethod : "—"}</td>
                <td className="px-3 py-2"><InvoiceStatusBadge status={i.status} kind={i.kind} overdue={i.overdue} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages > 1 && <div className="flex items-center justify-between border-t px-3 py-2 text-sm"><span>Page {list.page} / {pages}</span><div className="flex gap-2">{list.page > 1 && <Link className="underline" href={`/factures?${query}&page=${list.page - 1}`}>Précédente</Link>}{list.page < pages && <Link className="underline" href={`/factures?${query}&page=${list.page + 1}`}>Suivante</Link>}</div></div>}
      </CardContent></Card>
    </div>
  )
}
