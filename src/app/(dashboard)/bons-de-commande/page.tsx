// 21/11/2026 — liste des bons de commande clients (créés depuis un devis accepté).
import type { Metadata } from "next"
import Link from "next/link"
import { ClipboardList } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { listClientOrders } from "@/lib/billing/commercial/client-order.service"
import { decimalToCents, formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { CLIENT_ORDER_STATUS, StatusPill } from "@/components/commercial/status"

export const metadata: Metadata = { title: "Bons de commande" }
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export default async function ClientOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireBillingPage()
  const sp = await searchParams
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(sp.page ?? "1"), 10) || 1))
  const { total, rows, pageSize } = await listClientOrders(prisma, ctx.companyId, page)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><ClipboardList className="h-6 w-6 text-[#0f3460]" /> Bons de commande clients</h1>
        <p className="mt-1 text-sm text-slate-500">{total} bon{total > 1 ? "s" : ""} · créés depuis la fiche d&apos;un <Link href="/devis" className="underline">devis accepté</Link>. Les bons de commande fournisseurs sont dans <Link href="/achats" className="underline">Achats</Link>.</p>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Client</th><th className="hidden px-3 py-2 md:table-cell">Chantier</th><th className="hidden px-3 py-2 md:table-cell">Devis</th><th className="px-3 py-2 text-right">Total TTC</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Aucun bon de commande client.</td></tr>}
            {rows.map((o) => (
              <tr key={o.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium"><Link href={`/bons-de-commande/${o.id}`} className="text-[#0f3460] hover:underline">{o.number}</Link></td>
                <td className="px-3 py-2">{dateFr.format(o.issueDate)}</td>
                <td className="px-3 py-2">{o.client.name}</td>
                <td className="hidden px-3 py-2 md:table-cell">{o.worksite.name}</td>
                <td className="hidden px-3 py-2 md:table-cell"><Link href={`/devis/${o.quote.id}`} className="hover:underline">{o.quote.number}</Link></td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(decimalToCents(o.totalTTC))}</td>
                <td className="px-3 py-2"><StatusPill map={CLIENT_ORDER_STATUS} status={o.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {pages > 1 && <div className="flex justify-between text-sm">{page > 1 ? <Link href={`?page=${page - 1}`} className="underline">Précédent</Link> : <span />}<span>Page {page} / {pages}</span>{page < pages ? <Link href={`?page=${page + 1}`} className="underline">Suivant</Link> : <span />}</div>}
    </div>
  )
}
