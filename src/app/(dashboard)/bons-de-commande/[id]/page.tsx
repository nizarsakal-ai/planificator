// 21/11/2026 — détail d'un bon de commande client : lignes, totaux, PDF, annulation, bons de livraison rattachés.
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { FileDown } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { getClientOrder } from "@/lib/billing/commercial/client-order.service"
import { fmtDate, linesAndTotals } from "@/lib/billing/pdf/document-data"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { CancelClientOrderButton } from "@/components/commercial/CommercialDocumentsUi"
import { CLIENT_ORDER_STATUS, DELIVERY_STATUS, StatusPill } from "@/components/commercial/status"

export const metadata: Metadata = { title: "Bon de commande" }

export default async function ClientOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const o = await getClientOrder(prisma, ctx.companyId, id)
  if (!o) notFound()
  const { pdfLines, totals } = linesAndTotals(o.lines, o.globalDiscountBp, o.vatReverseCharge)
  const active = o.status !== "CANCELLED"
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-500"><Link href="/bons-de-commande" className="hover:underline">Bons de commande</Link> / {o.number}</p>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900">{o.number} <StatusPill map={CLIENT_ORDER_STATUS} status={o.status} /></h1>
          {o.subject && <p className="text-slate-600">{o.subject}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild><a href={`/api/pdf/bon-commande/${o.id}`} target="_blank" rel="noopener noreferrer"><FileDown className="h-4 w-4" /> PDF</a></Button>
          {active && <Button variant="outline" size="sm" asChild><Link href={`/bons-de-livraison/nouveau?source=CLIENT_ORDER&id=${o.id}`}>Créer un bon de livraison</Link></Button>}
          {active && <CancelClientOrderButton orderId={o.id} />}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Client</p><p className="font-medium">{o.client.name}</p><p className="text-slate-600">Chantier : {o.worksite.name}</p></CardContent></Card>
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Commande</p>
          <p>Date : {fmtDate(o.issueDate)}</p>
          {o.expectedDeliveryDate && <p>Livraison prévue : {fmtDate(o.expectedDeliveryDate)}</p>}
          <p>Devis : <Link href={`/devis/${o.quote.id}`} className="text-[#0f3460] hover:underline">{o.quote.number}</Link></p>
          {o.clientReference && <p>Réf. client : {o.clientReference}</p>}
          {o.cancelledAt && <p className="text-slate-500">Annulé le {fmtDate(o.cancelledAt)}</p>}
        </CardContent></Card>
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Adresse de livraison</p><p className="whitespace-pre-line">{o.deliveryAddress ?? "—"}</p></CardContent></Card>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2 text-right">Qté</th><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">Remise</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">Total HT</th></tr></thead>
          <tbody>{pdfLines.map((l, i) => <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}{l.description && <div className="text-xs text-slate-500">{l.description}</div>}</td><td className="px-3 py-2">{l.unit}</td><td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td><td className="px-3 py-2 text-right tabular-nums">{l.unitPrice}</td><td className="px-3 py-2 text-right">{l.discount}</td><td className="px-3 py-2 text-right">{l.vatRate}</td><td className="px-3 py-2 text-right tabular-nums">{l.lineHT}</td></tr>)}</tbody>
        </table>
        <div className="flex justify-end border-t p-4">
          <dl className="w-64 space-y-1 text-sm">
            <div className="flex justify-between"><dt>Total HT</dt><dd>{totals.totalHT}</dd></div>
            <div className="flex justify-between"><dt>Total TVA</dt><dd>{totals.totalVAT}</dd></div>
            <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total TTC</dt><dd>{totals.totalTTC}</dd></div>
          </dl>
        </div>
      </CardContent></Card>
      {o.notes && <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Notes</p><p className="whitespace-pre-line">{o.notes}</p></CardContent></Card>}
      <Card><CardContent className="space-y-1 p-4 text-sm">
        <p className="font-medium text-slate-700">Bons de livraison</p>
        {o.deliveryNotes.length === 0 ? <p className="text-slate-400">Aucun bon de livraison.</p> : <ul className="space-y-1">{o.deliveryNotes.map((n) => <li key={n.id} className="flex justify-between gap-2"><Link href={`/bons-de-livraison/${n.id}`} className="text-[#0f3460] hover:underline">{n.number}</Link><span className="flex items-center gap-2 text-slate-500">{fmtDate(n.deliveryDate)} <StatusPill map={DELIVERY_STATUS} status={n.status} /></span></li>)}</ul>}
      </CardContent></Card>
    </div>
  )
}
