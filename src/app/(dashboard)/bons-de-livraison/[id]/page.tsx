// 21/11/2026 — détail d'un bon de livraison : lignes commandées / livrées, PDF, réception signée, annulation.
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { FileDown } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { formatQuantityFr as qty, getDeliveryNote } from "@/lib/billing/commercial/delivery-note.service"
import { fmtDate } from "@/lib/billing/pdf/document-data"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DeliveryNoteActions } from "@/components/commercial/CommercialDocumentsUi"
import { DELIVERY_STATUS, StatusPill } from "@/components/commercial/status"

export const metadata: Metadata = { title: "Bon de livraison" }

export default async function DeliveryNotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const n = await getDeliveryNote(prisma, ctx.companyId, id)
  if (!n) notFound()
  const origin = n.quote ? { href: `/devis/${n.quote.id}`, label: `Devis ${n.quote.number}` } : n.invoice ? { href: `/factures/${n.invoice.id}`, label: `Facture ${n.invoice.number}` } : n.clientOrder ? { href: `/bons-de-commande/${n.clientOrder.id}`, label: `Bon de commande ${n.clientOrder.number}` } : null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-500"><Link href="/bons-de-livraison" className="hover:underline">Bons de livraison</Link> / {n.number}</p>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900">{n.number} <StatusPill map={DELIVERY_STATUS} status={n.status} /></h1>
        </div>
        <Button variant="outline" size="sm" asChild><a href={`/api/pdf/bon-livraison/${n.id}`} target="_blank" rel="noopener noreferrer"><FileDown className="h-4 w-4" /> PDF</a></Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Client</p><p className="font-medium">{n.client.name}</p><p className="text-slate-600">Chantier : {n.worksite.name}</p></CardContent></Card>
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Livraison</p>
          <p>Date : {fmtDate(n.deliveryDate)}</p>
          {origin && <p>Origine : <Link href={origin.href} className="text-[#0f3460] hover:underline">{origin.label}</Link></p>}
          {n.receivedByName && n.receivedAt && <p className="text-emerald-700">Reçu par {n.receivedByName} le {fmtDate(n.receivedAt)}</p>}
          {n.cancelledAt && <p className="text-slate-500">Annulé le {fmtDate(n.cancelledAt)}</p>}
        </CardContent></Card>
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Adresse de livraison</p><p className="whitespace-pre-line">{n.deliveryAddress ?? "—"}</p></CardContent></Card>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2 text-right">Qté commandée</th><th className="px-3 py-2 text-right">Qté livrée</th></tr></thead>
          <tbody>{n.lines.map((l, i) => <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}{l.description && <div className="text-xs text-slate-500">{l.description}</div>}</td><td className="px-3 py-2">{l.unit}</td><td className="px-3 py-2 text-right tabular-nums">{qty(l.quantityOrdered)}</td><td className="px-3 py-2 text-right tabular-nums">{qty(l.quantityDelivered)}</td></tr>)}</tbody>
        </table>
      </CardContent></Card>
      {n.notes && <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Notes</p><p className="whitespace-pre-line">{n.notes}</p></CardContent></Card>}
      {n.status === "ISSUED" && <DeliveryNoteActions noteId={n.id} />}
    </div>
  )
}
