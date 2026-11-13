import type { Metadata } from "next"
import Link from "next/link"
import { FileText, Upload } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireInvoiceImportPage } from "@/lib/invoice-import/access"
import { listImportedInvoices } from "@/lib/invoice-import/import.service"
import { STATUS_LABEL } from "@/lib/invoice-import/format"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

export const metadata: Metadata = { title: "Factures importées" }
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "")

export default async function FacturesImporteesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireInvoiceImportPage()
  const sp = await searchParams
  const clientParam = one(sp.client).slice(0, 64), q = one(sp.q).slice(0, 80)
  const clients = await prisma.client.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } })
  // Le filtre client n'est appliqué que si l'identifiant appartient à la société de session.
  const clientId = clients.some((c) => c.id === clientParam) ? clientParam : undefined
  const list = await listImportedInvoices(prisma, ctx.companyId, { clientId, q, page: Number(one(sp.page)) || 1 })
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize))
  const query = new URLSearchParams({ ...(clientId ? { client: clientId } : {}), ...(q ? { q } : {}) }).toString()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><FileText className="h-6 w-6 text-[#0f3460]" /> Factures importées</h1><p className="mt-1 text-sm text-slate-500">{list.total} pièce{list.total > 1 ? "s" : ""} émise{list.total > 1 ? "s" : ""} dans un autre logiciel — numérotation et statut d’origine conservés, hors relances, règlements et comptabilité de Planificator.</p></div>
        <div className="flex gap-2"><Button variant="outline" asChild><Link href="/factures">Factures</Link></Button><Button asChild><Link href="/factures/import"><Upload className="h-4 w-4" /> Importer des factures</Link></Button></div>
      </div>
      <Card><CardContent className="p-4">
        <form method="get" className="grid gap-2 sm:grid-cols-4">
          <Input name="q" placeholder="N° ou client" defaultValue={q} className="sm:col-span-2" aria-label="Recherche" />
          <select name="client" defaultValue={clientId ?? ""} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Client"><option value="">Tous les clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <Button type="submit" variant="secondary">Filtrer</Button>
        </form>
      </CardContent></Card>
      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Date</th><th className="hidden px-3 py-2 md:table-cell">Échéance</th><th className="hidden px-3 py-2 text-right md:table-cell">HT</th><th className="hidden px-3 py-2 text-right md:table-cell">TVA</th><th className="px-3 py-2 text-right">TTC</th><th className="px-3 py-2">Statut</th><th className="hidden px-3 py-2 lg:table-cell">Origine</th><th className="px-3 py-2">PDF</th></tr></thead>
          <tbody>
            {list.rows.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Aucune facture importée.</td></tr>}
            {list.rows.map((i) => (
              <tr key={i.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{i.number}{i.kind === "CREDIT_NOTE" && <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">Avoir</span>}
                  {i.kind === "CREDIT_NOTE" && (i.credited ? <div className="text-xs text-slate-400">sur {i.credited.href ? <Link className="underline" href={i.credited.href}>{i.credited.number}</Link> : i.credited.number}</div> : i.creditedNumber ? <div className="text-xs text-slate-400">sur {i.creditedNumber} (non liée)</div> : null)}</td>
                <td className="px-3 py-2">{i.clientName}{i.worksiteName && <div className="text-xs text-slate-400">{i.worksiteName}</div>}</td>
                <td className="px-3 py-2">{dateFr.format(i.issueDate)}</td>
                <td className="hidden px-3 py-2 md:table-cell">{i.dueDate ? dateFr.format(i.dueDate) : "—"}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatEuro(i.totalHTCents)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatEuro(i.vatCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{i.kind === "CREDIT_NOTE" ? "−" : ""}{formatEuro(i.totalTTCCents)}</td>
                <td className="px-3 py-2">{STATUS_LABEL[i.status]}{i.sourceStatus && <div className="text-xs text-slate-400">source : {i.sourceStatus}</div>}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{i.sourceSystem}{i.sourceReference && <div className="text-xs text-slate-400">réf. {i.sourceReference}</div>}</td>
                <td className="px-3 py-2">{i.hasFile ? <a className="underline" href={`/factures/importees/${i.id}/pdf`} target="_blank" rel="noopener noreferrer">Ouvrir</a> : <span className="text-slate-400">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages > 1 && <div className="flex items-center justify-between border-t px-3 py-2 text-sm"><span>Page {list.page} / {pages}</span><div className="flex gap-2">{list.page > 1 && <Link className="underline" href={`/factures/importees?${query}&page=${list.page - 1}`}>Précédente</Link>}{list.page < pages && <Link className="underline" href={`/factures/importees?${query}&page=${list.page + 1}`}>Suivante</Link>}</div></div>}
      </CardContent></Card>
    </div>
  )
}
