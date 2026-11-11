// Lot A Planificator V2 : commandes d'achat (liste et création). Drapeau STOCK_PURCHASING_ENABLED + ADMIN.
import Link from "next/link"
import { Boxes, ShoppingCart } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { stockPageAccess } from "@/lib/stock/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listPurchaseOrders, stockFormOptions } from "@/lib/stock/queries"
import { formatEuro } from "@/lib/billing/money"
import { createPurchaseOrderAction } from "@/lib/actions/stock.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ORDER_STATUS_CLASS, ORDER_STATUS_LABEL, SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
const LINE_ROWS = 5

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await stockPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const [orders, options] = await Promise.all([listPurchaseOrders(prisma, ctx.companyId), stockFormOptions(prisma, ctx.companyId)])
  const open = orders.filter((o) => o.status === "ORDERED" || o.status === "PARTIALLY_RECEIVED")

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><ShoppingCart className="h-6 w-6 text-[#0f3460]" /> Achats</h1><p className="mt-1 text-sm text-slate-500">{orders.length} commande{orders.length > 1 ? "s" : ""} · {open.length} en attente de réception</p></div>
        <Button variant="outline" asChild><Link href="/stock"><Boxes className="h-4 w-4" /> Stock</Link></Button>
      </div>
      <StockFlash params={params} />

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Fournisseur</th><th className="hidden px-3 py-2 md:table-cell">Dépôt</th><th className="hidden px-3 py-2 lg:table-cell">Chantier</th><th className="hidden px-3 py-2 md:table-cell">Livraison prévue</th><th className="px-3 py-2 text-right">Total HT</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Aucune commande d&apos;achat.</td></tr>}
            {orders.map((o) => (
              <tr key={o.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium"><Link href={`/achats/${o.id}`} className="text-[#0f3460] hover:underline">{o.number}</Link></td>
                <td className="px-3 py-2">{o.supplier.name}</td>
                <td className="hidden px-3 py-2 md:table-cell">{o.warehouse.name}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{o.worksite?.name ?? "—"}</td>
                <td className="hidden px-3 py-2 md:table-cell">{o.expectedAt ? dateFr.format(o.expectedAt) : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(o.totalHTCents)}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_CLASS[o.status] ?? ""}`}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvelle commande d&apos;achat</h2>
        {options.suppliers.length === 0 || options.warehouses.length === 0
          ? <p className="text-sm text-slate-500">Il faut au moins un fournisseur actif et un dépôt actif pour créer une commande.</p>
          : <form action={createPurchaseOrderAction} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <select name="supplierId" required className={SELECT_CLASS} aria-label="Fournisseur">{options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <select name="warehouseId" required className={SELECT_CLASS} aria-label="Dépôt de livraison">{options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              <select name="worksiteId" className={SELECT_CLASS} aria-label="Chantier"><option value="">Sans chantier</option>{options.worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              <Input name="expectedAt" type="date" aria-label="Livraison prévue" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: LINE_ROWS }, (_, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <select name={`line${i}_article`} className={SELECT_CLASS} aria-label={`Article, ligne ${i + 1}`}><option value="">Article (facultatif)</option>{options.articles.map((a) => <option key={a.id} value={a.id}>{a.reference ? `${a.reference} · ` : ""}{a.designation} ({a.unit})</option>)}</select>
                  <Input name={`line${i}_designation`} maxLength={500} placeholder="Désignation (si pas d'article)" aria-label={`Désignation, ligne ${i + 1}`} />
                  <Input name={`line${i}_quantity`} inputMode="decimal" placeholder="Quantité" aria-label={`Quantité, ligne ${i + 1}`} />
                  <Input name={`line${i}_price`} inputMode="decimal" placeholder="Prix HT (€), vide = prix de l'article" aria-label={`Prix unitaire, ligne ${i + 1}`} />
                </div>
              ))}
            </div>
            <Input name="notes" maxLength={2000} placeholder="Notes (facultatif)" aria-label="Notes" />
            <Button type="submit">Créer la commande (brouillon)</Button>
          </form>}
      </CardContent></Card>
    </div>
  )
}
