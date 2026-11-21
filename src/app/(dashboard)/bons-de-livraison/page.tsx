// 21/11/2026 — liste des bons de livraison (depuis un devis accepté, une facture émise ou un bon de commande client).
import type { Metadata } from "next"
import Link from "next/link"
import { Truck } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { listDeliveryNotes } from "@/lib/billing/commercial/delivery-note.service"
import { Card, CardContent } from "@/components/ui/card"
import { DELIVERY_SOURCE_LABEL, DELIVERY_STATUS, StatusPill } from "@/components/commercial/status"

export const metadata: Metadata = { title: "Bons de livraison" }
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export default async function DeliveryNotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireBillingPage()
  const sp = await searchParams
  const page = Math.max(1, Math.min(10_000, Number.parseInt(String(sp.page ?? "1"), 10) || 1))
  const { total, rows, pageSize } = await listDeliveryNotes(prisma, ctx.companyId, page)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Truck className="h-6 w-6 text-[#0f3460]" /> Bons de livraison</h1>
        <p className="mt-1 text-sm text-slate-500">{total} bon{total > 1 ? "s" : ""} · créés depuis la fiche d&apos;un devis accepté, d&apos;une facture émise ou d&apos;un bon de commande client.</p>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Livraison</th><th className="px-3 py-2">Client</th><th className="hidden px-3 py-2 md:table-cell">Chantier</th><th className="hidden px-3 py-2 md:table-cell">Origine</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Aucun bon de livraison.</td></tr>}
            {rows.map((n) => (
              <tr key={n.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium"><Link href={`/bons-de-livraison/${n.id}`} className="text-[#0f3460] hover:underline">{n.number}</Link></td>
                <td className="px-3 py-2">{dateFr.format(n.deliveryDate)}</td>
                <td className="px-3 py-2">{n.client.name}</td>
                <td className="hidden px-3 py-2 md:table-cell">{n.worksite.name}</td>
                <td className="hidden px-3 py-2 md:table-cell">{DELIVERY_SOURCE_LABEL[n.sourceType]} {n.quote?.number ?? n.invoice?.number ?? n.clientOrder?.number ?? ""}</td>
                <td className="px-3 py-2"><StatusPill map={DELIVERY_STATUS} status={n.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {pages > 1 && <div className="flex justify-between text-sm">{page > 1 ? <Link href={`?page=${page - 1}`} className="underline">Précédent</Link> : <span />}<span>Page {page} / {pages}</span>{page < pages ? <Link href={`?page=${page + 1}`} className="underline">Suivant</Link> : <span />}</div>}
    </div>
  )
}
