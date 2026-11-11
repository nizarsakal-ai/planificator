// Lot A Planificator V2 : stocks multi-dépôts (dépôts, niveaux par article, seuils d'alerte, inventaire).
// Drapeau STOCK_PURCHASING_ENABLED + ADMIN/SUPER_ADMIN de la société de session (stockPageAccess) ; sinon 404, /login ou refus rendu sur place.
import Link from "next/link"
import { ArrowLeftRight, Boxes, ShoppingCart } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { stockPageAccess } from "@/lib/stock/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listStockLevels, listWarehouses, stockFormOptions } from "@/lib/stock/queries"
import { formatMilli } from "@/lib/stock/quantity"
import { createWarehouseAction, importEventCatalogAction, syncEquipmentStockAction, inventoryCountAction, setThresholdAction, setWarehouseActiveAction } from "@/lib/actions/stock.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { ArticleOptions } from "@/components/stock/ArticleOptions"
import { EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"

export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await stockPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const depot = typeof params.depot === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(params.depot) ? params.depot : null
  const [warehouses, levels, options] = await Promise.all([
    listWarehouses(prisma, ctx.companyId), listStockLevels(prisma, ctx.companyId, depot), stockFormOptions(prisma, ctx.companyId),
  ])
  const alerts = levels.filter((l) => l.alert).length
  const articleOptions = <ArticleOptions articles={options.articles} />
  const warehouseOptions = options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Boxes className="h-6 w-6 text-[#0f3460]" /> Stock</h1><p className="mt-1 text-sm text-slate-500">{warehouses.filter((w) => w.active).length} dépôt{warehouses.filter((w) => w.active).length > 1 ? "s" : ""} actif{warehouses.filter((w) => w.active).length > 1 ? "s" : ""} · niveaux par article et seuils d&apos;alerte</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/stock/mouvements"><ArrowLeftRight className="h-4 w-4" /> Mouvements</Link></Button>
          <Button asChild><Link href="/achats"><ShoppingCart className="h-4 w-4" /> Achats</Link></Button>
        </div>
      </div>
      <StockFlash params={params} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Dépôts</p><p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{warehouses.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Lignes de stock</p><p className="mt-1 text-2xl font-semibold text-blue-700 tabular-nums">{levels.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Sous le seuil</p><p className="mt-1 text-2xl font-semibold text-red-700 tabular-nums">{alerts}</p></CardContent></Card>
      </div>

      <Card><CardContent className="p-4">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <select name="depot" defaultValue={depot ?? ""} className={SELECT_CLASS} aria-label="Dépôt"><option value="">Tous les dépôts</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.active ? "" : " (désactivé)"}</option>)}</select>
          <Button type="submit" variant="secondary">Filtrer</Button>
        </form>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Article</th><th className="px-3 py-2">Dépôt</th><th className="px-3 py-2 text-right">Quantité</th><th className="hidden px-3 py-2 text-right md:table-cell">Seuil</th><th className="px-3 py-2">État</th></tr></thead>
          <tbody>
            {levels.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Aucun stock enregistré.</td></tr>}
            {levels.map((l) => (
              <tr key={l.id} className={`border-t hover:bg-slate-50 ${l.alert ? "bg-red-50/40" : ""}`}>
                <td className="px-3 py-2 font-medium">{l.article.designation}{l.article.reference && <div className="text-xs text-slate-400">{l.article.reference}</div>}</td>
                <td className="px-3 py-2">{l.warehouse.name}{!l.warehouse.active && <span className="ml-1 text-xs text-slate-400">(désactivé)</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMilli(l.quantityMilli)} {l.article.unit}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{l.minQuantityMilli === null ? "—" : `${formatMilli(l.minQuantityMilli)} ${l.article.unit}`}</td>
                <td className="px-3 py-2">{l.alert ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">Sous le seuil</span> : <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Disponible</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><h2 className="text-sm font-semibold text-slate-900">Catalogue événementiel</h2><p className="text-xs text-slate-500">Les menus Stock, Inventaire et Mouvements proposent les {EVENT_STOCK_ARTICLES.length} articles du matériel événementiel (même liste que Matériel). Chaque article est créé automatiquement à son premier mouvement. Matériel suivi à l&apos;unité (tentes, photobooth, sono…) : le stock suit les fiches Matériel (création, sortie, retour, réforme) et une réception d&apos;achat crée les fiches. Matériel en quantité (chaises, tables, textile, moquette…) : stock seul.</p></div>
        <div className="flex flex-wrap gap-2"><form action={importEventCatalogAction}>{depot && <input type="hidden" name="depot" value={depot} />}<Button type="submit" variant="secondary">Tout créer maintenant</Button></form><form action={syncEquipmentStockAction}>{depot && <input type="hidden" name="depot" value={depot} />}<Button type="submit" variant="outline">Aligner sur le Matériel</Button></form></div>
      </CardContent></Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Nouveau dépôt</h2>
          <form action={createWarehouseAction} className="space-y-2">{depot && <input type="hidden" name="depot" value={depot} />}
            <Input name="name" required maxLength={120} placeholder="Nom du dépôt" aria-label="Nom du dépôt" />
            <Input name="address" maxLength={500} placeholder="Adresse (facultatif)" aria-label="Adresse" />
            <Button type="submit">Créer le dépôt</Button>
          </form>
        </CardContent></Card>
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Seuil d&apos;alerte</h2>
          <form action={setThresholdAction} className="space-y-2">{depot && <input type="hidden" name="depot" value={depot} />}
            <select name="warehouseId" required className={`${SELECT_CLASS} w-full`} aria-label="Dépôt">{warehouseOptions}</select>
            <select name="articleId" required className={`${SELECT_CLASS} w-full`} aria-label="Article">{articleOptions}</select>
            <Input name="min" inputMode="decimal" placeholder="Seuil (vide = aucun)" aria-label="Seuil" />
            <Button type="submit" variant="secondary">Enregistrer le seuil</Button>
          </form>
        </CardContent></Card>
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Inventaire</h2>
          <form action={inventoryCountAction} className="space-y-2">{depot && <input type="hidden" name="depot" value={depot} />}
            <select name="warehouseId" required className={`${SELECT_CLASS} w-full`} aria-label="Dépôt">{warehouseOptions}</select>
            <select name="articleId" required className={`${SELECT_CLASS} w-full`} aria-label="Article">{articleOptions}</select>
            <Input name="counted" required inputMode="decimal" placeholder="Quantité comptée" aria-label="Quantité comptée" />
            <Input name="reason" maxLength={200} placeholder="Motif (ex. inventaire annuel)" aria-label="Motif" />
            <Button type="submit" variant="secondary">Enregistrer le comptage</Button>
          </form>
        </CardContent></Card>
      </div>

      {warehouses.length > 0 && <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Dépôt</th><th className="hidden px-3 py-2 md:table-cell">Adresse</th><th className="px-3 py-2 text-right">Action</th></tr></thead>
          <tbody>{warehouses.map((w) => (
            <tr key={w.id} className="border-t">
              <td className="px-3 py-2 font-medium">{w.name}{!w.active && <span className="ml-1 text-xs text-slate-400">(désactivé)</span>}</td>
              <td className="hidden px-3 py-2 text-slate-500 md:table-cell">{w.address ?? "—"}</td>
              <td className="px-3 py-2 text-right"><form action={setWarehouseActiveAction}><input type="hidden" name="warehouseId" value={w.id} />{depot && <input type="hidden" name="depot" value={depot} />}<input type="hidden" name="active" value={w.active ? "false" : "true"} /><Button type="submit" variant="outline" size="sm">{w.active ? "Désactiver" : "Réactiver"}</Button></form></td>
            </tr>
          ))}</tbody>
        </table>
      </CardContent></Card>}
    </div>
  )
}
