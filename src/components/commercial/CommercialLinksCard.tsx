// 21/11/2026 — encart « Bons de commande / livraison » sur la fiche d'un devis ou d'une facture (composant serveur).
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { CreateClientOrderButton } from "./CommercialDocumentsUi"
import { CLIENT_ORDER_STATUS, DELIVERY_STATUS, StatusPill } from "./status"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export async function CommercialLinksCard({ companyId, source, id, canDeliver, canOrder, defaultAddress }: { companyId: string; source: "QUOTE" | "INVOICE"; id: string; canDeliver: boolean; canOrder: boolean; defaultAddress: string }) {
  const where = source === "QUOTE" ? { companyId, quoteId: id } : { companyId, invoiceId: id }
  const [orders, notes] = await Promise.all([
    source === "QUOTE" ? prisma.clientOrder.findMany({ where: { companyId, quoteId: id }, orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, issueDate: true } }) : Promise.resolve([]),
    prisma.deliveryNote.findMany({ where, orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, deliveryDate: true } }),
  ])
  const hasActiveOrder = orders.some((o) => o.status !== "CANCELLED")
  if (!canDeliver && orders.length === 0 && notes.length === 0) return null
  return (
    <Card><CardContent className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-700">Bons de commande et de livraison</p>
        {canDeliver && <Button variant="outline" size="sm" asChild><Link href={`/bons-de-livraison/nouveau?source=${source}&id=${id}`}>Créer un bon de livraison</Link></Button>}
      </div>
      {source === "QUOTE" && canOrder && !hasActiveOrder && <CreateClientOrderButton quoteId={id} defaultAddress={defaultAddress} />}
      {orders.length + notes.length === 0
        ? <p className="text-slate-400">Aucun document rattaché.</p>
        : <ul className="space-y-1">
          {orders.map((o) => <li key={o.id} className="flex flex-wrap justify-between gap-2"><Link href={`/bons-de-commande/${o.id}`} className="text-[#0f3460] hover:underline">Bon de commande {o.number}</Link><span className="flex items-center gap-2 text-slate-500">{dateFr.format(o.issueDate)} <StatusPill map={CLIENT_ORDER_STATUS} status={o.status} /></span></li>)}
          {notes.map((n) => <li key={n.id} className="flex flex-wrap justify-between gap-2"><Link href={`/bons-de-livraison/${n.id}`} className="text-[#0f3460] hover:underline">Bon de livraison {n.number}</Link><span className="flex items-center gap-2 text-slate-500">{dateFr.format(n.deliveryDate)} <StatusPill map={DELIVERY_STATUS} status={n.status} /></span></li>)}
        </ul>}
    </CardContent></Card>
  )
}
