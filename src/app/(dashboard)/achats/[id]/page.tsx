// Lot A Planificator V2 : détail d'une commande d'achat (passer, annuler, réceptionner, rapprocher facture fournisseur).
import Link from "next/link"
import { notFound } from "next/navigation"
import { PackageCheck, ShoppingCart } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { stockPageAccess } from "@/lib/stock/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getPurchaseOrder, listWarehouses, supplierInvoicesFor } from "@/lib/stock/queries"
import { orderMatch } from "@/lib/stock/stock.service"
import { formatMilli, lineAmountCents } from "@/lib/stock/quantity"
import { formatEuro } from "@/lib/billing/money"
import { cancelOrderAction, linkSupplierInvoiceAction, markOrderedAction, receiveGoodsAction } from "@/lib/actions/stock.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { MATCH_LABEL, ORDER_STATUS_CLASS, ORDER_STATUS_LABEL, SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await stockPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const order = await getPurchaseOrder(prisma, ctx.companyId, id)
  if (!order) notFound()
  const [match, invoices, warehouses] = await Promise.all([
    orderMatch(prisma, ctx, order.id), supplierInvoicesFor(prisma, ctx.companyId, order.supplierId), listWarehouses(prisma, ctx.companyId),
  ])
  const receivable = order.status === "ORDERED" || order.status === "PARTIALLY_RECEIVED"
  const orderWarehouseActive = warehouses.some((w) => w.id === order.warehouse.id && w.active)
  const sp = await searchParams

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><ShoppingCart className="h-6 w-6 text-[#0f3460]" /> Commande {order.number}</h1>
          <p className="mt-1 text-sm text-slate-500">{order.supplier.name} · dépôt {order.warehouse.name}{order.worksite ? ` · chantier ${order.worksite.name}` : ""}{order.expectedAt ? ` · livraison prévue le ${dateFr.format(order.expectedAt)}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_CLASS[order.status] ?? ""}`}>{ORDER_STATUS_LABEL[order.status] ?? order.status}</span>
          {order.status === "DRAFT" && <form action={markOrderedAction}><input type="hidden" name="orderId" value={order.id} /><Button type="submit">Passer la commande</Button></form>}
          {(order.status === "DRAFT" || order.status === "ORDERED") && <form action={cancelOrderAction}><input type="hidden" name="orderId" value={order.id} /><Button type="submit" variant="outline">Annuler</Button></form>}
          <Button variant="outline" asChild><Link href="/achats">Toutes les commandes</Link></Button>
        </div>
      </div>
      <StockFlash params={sp} />

      {match && <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Commandé HT</p><p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{formatEuro(match.orderedCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Reçu HT</p><p className="mt-1 text-2xl font-semibold text-blue-700 tabular-nums">{formatEuro(match.receivedCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Facturé HT</p><p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{formatEuro(match.invoicedCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Rapprochement</p><p className="mt-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_LABEL[match.status].className}`}>{MATCH_LABEL[match.status].label}</span></p></CardContent></Card>
      </div>}

      <Card><CardContent className="p-0">
        <form action={receiveGoodsAction}>
          <input type="hidden" name="orderId" value={order.id} />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Commandé</th><th className="px-3 py-2 text-right">Reçu</th><th className="hidden px-3 py-2 text-right md:table-cell">Prix unitaire HT</th><th className="hidden px-3 py-2 text-right md:table-cell">Total HT</th>{receivable && <th className="px-3 py-2 text-right">À réceptionner</th>}</tr></thead>
            <tbody>{order.lines.map((l) => {
              const unit = l.article?.unit ?? ""
              const remaining = l.quantityMilli - l.receivedMilli
              return (
                <tr key={l.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{l.designation}{l.article?.reference && <div className="text-xs text-slate-400">{l.article.reference}</div>}{!l.article && <div className="text-xs text-slate-400">hors stock (sans article)</div>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMilli(l.quantityMilli)} {unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMilli(l.receivedMilli)} {unit}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatEuro(BigInt(l.unitPriceCents))}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatEuro(lineAmountCents(l.quantityMilli, l.unitPriceCents))}</td>
                  {receivable && <td className="px-3 py-2 text-right">{remaining > 0 ? <Input name={`recv_${l.id}`} inputMode="decimal" placeholder={formatMilli(remaining)} className="ml-auto w-28 text-right" aria-label={`Quantité reçue : ${l.designation}`} /> : <span className="text-xs text-slate-400">soldée</span>}</td>}
                </tr>
              )
            })}</tbody>
          </table>
          {receivable && !orderWarehouseActive && <p role="alert" className="border-t px-3 pt-3 text-sm text-amber-700">Le dépôt de la commande ({order.warehouse.name}) est désactivé : choisissez le dépôt de réception.</p>}
          {receivable && <div className="flex flex-wrap items-center gap-2 border-t p-3">
            <select name="warehouseId" defaultValue={orderWarehouseActive ? order.warehouse.id : ""} required className={SELECT_CLASS} aria-label="Dépôt de réception">{!orderWarehouseActive && <option value="" disabled>Choisir un dépôt</option>}{warehouses.filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            <select name="supplierInvoiceId" className={SELECT_CLASS} aria-label="Facture fournisseur"><option value="">Sans facture pour l&apos;instant</option>{invoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {dateFr.format(i.date)} · {formatEuro(BigInt(i.totalHTCents))} HT</option>)}</select>
            <Input name="notes" maxLength={2000} placeholder="Notes de réception" className="max-w-xs" aria-label="Notes de réception" />
            <Button type="submit"><PackageCheck className="h-4 w-4" /> Enregistrer la réception</Button>
          </div>}
        </form>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Réception</th><th className="px-3 py-2">Date</th><th className="hidden px-3 py-2 md:table-cell">Dépôt</th><th className="hidden px-3 py-2 lg:table-cell">Lignes</th><th className="px-3 py-2">Facture fournisseur</th></tr></thead>
          <tbody>
            {order.receipts.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Aucune réception.</td></tr>}
            {order.receipts.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-medium">{r.number}</td>
                <td className="px-3 py-2">{dateFr.format(r.receivedAt)}</td>
                <td className="hidden px-3 py-2 md:table-cell">{r.warehouse.name}</td>
                <td className="hidden px-3 py-2 text-slate-500 lg:table-cell">{r.lines.map((x) => `${x.orderLine.designation} : ${formatMilli(x.quantityMilli)}`).join(" · ")}</td>
                <td className="px-3 py-2">
                  <form action={linkSupplierInvoiceAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="orderId" value={order.id} /><input type="hidden" name="receiptId" value={r.id} />
                    <select name="supplierInvoiceId" defaultValue={r.supplierInvoice?.id ?? ""} className={SELECT_CLASS} aria-label={`Facture de la réception ${r.number}`}><option value="">Aucune</option>{invoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {formatEuro(BigInt(i.totalHTCents))} HT</option>)}</select>
                    <Button type="submit" variant="outline" size="sm">Lier</Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {order.notes && <p className="text-sm text-slate-500">Notes : {order.notes}</p>}
    </div>
  )
}
