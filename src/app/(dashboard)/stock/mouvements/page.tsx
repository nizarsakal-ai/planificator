// Lot A Planificator V2 : mouvements de stock (entrée hors commande, sortie vers un chantier, transfert, ajustement).
import { ArticleOptions } from "@/components/stock/ArticleOptions"
import Link from "next/link"
import { ArrowLeftRight, Boxes } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { stockPageAccess } from "@/lib/stock/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listMovements, stockFormOptions } from "@/lib/stock/queries"
import { formatMilli } from "@/lib/stock/quantity"
import { recordMovementAction } from "@/lib/actions/stock.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { MOVEMENT_LABEL, SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })

export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await stockPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const [movements, options] = await Promise.all([listMovements(prisma, ctx.companyId, { take: 100 }), stockFormOptions(prisma, ctx.companyId)])
  const warehouseOptions = options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><ArrowLeftRight className="h-6 w-6 text-[#0f3460]" /> Mouvements de stock</h1><p className="mt-1 text-sm text-slate-500">100 derniers mouvements · chaque mouvement est tracé dans l&apos;historique</p></div>
        <Button variant="outline" asChild><Link href="/stock"><Boxes className="h-4 w-4" /> Stock</Link></Button>
      </div>
      <StockFlash params={params} />

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouveau mouvement</h2>
        <form action={recordMovementAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select name="type" required className={SELECT_CLASS} aria-label="Type de mouvement">
            <option value="ISSUE">Sortie (vers un chantier ou consommation)</option>
            <option value="RECEIPT">Entrée hors commande</option>
            <option value="TRANSFER">Transfert entre dépôts</option>
            <option value="ADJUSTMENT">Ajustement motivé</option>
          </select>
          <select name="articleId" required className={SELECT_CLASS} aria-label="Article"><ArticleOptions articles={options.articles} /></select>
          <Input name="quantity" required inputMode="decimal" placeholder="Quantité" aria-label="Quantité" />
          <select name="worksiteId" className={SELECT_CLASS} aria-label="Chantier"><option value="">Sans chantier</option>{options.worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <select name="fromWarehouseId" className={SELECT_CLASS} aria-label="Dépôt de départ"><option value="">Dépôt de départ (sortie, transfert ; ajustement en moins)</option>{warehouseOptions}</select>
          <select name="toWarehouseId" className={SELECT_CLASS} aria-label="Dépôt d'arrivée"><option value="">Dépôt d&apos;arrivée (entrée, transfert ; ajustement en plus)</option>{warehouseOptions}</select>
          <Input name="reason" maxLength={500} placeholder="Motif (obligatoire pour un ajustement)" aria-label="Motif" className="sm:col-span-2" />
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-4">Ajustement : renseigner un seul dépôt, le dépôt de départ pour retirer, le dépôt d&apos;arrivée pour ajouter.</p>
          <div className="sm:col-span-2 lg:col-span-4"><Button type="submit">Enregistrer le mouvement</Button></div>
        </form>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Article</th><th className="px-3 py-2 text-right">Quantité</th><th className="hidden px-3 py-2 md:table-cell">Départ → arrivée</th><th className="hidden px-3 py-2 lg:table-cell">Chantier</th><th className="hidden px-3 py-2 lg:table-cell">Motif</th></tr></thead>
          <tbody>
            {movements.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Aucun mouvement.</td></tr>}
            {movements.map((m) => (
              <tr key={m.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 tabular-nums">{dateFr.format(m.createdAt)}</td>
                <td className="px-3 py-2">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                <td className="px-3 py-2 font-medium">{m.article.designation}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.fromWarehouse && !m.toWarehouse ? "−" : ""}{formatMilli(m.quantityMilli)} {m.article.unit}</td>
                <td className="hidden px-3 py-2 md:table-cell">{m.fromWarehouse?.name ?? "—"} → {m.toWarehouse?.name ?? "—"}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{m.worksite ? <Link href={`/chantiers/${m.worksite.id}`} className="text-[#0f3460] hover:underline">{m.worksite.name}</Link> : "—"}</td>
                <td className="hidden px-3 py-2 text-slate-500 lg:table-cell">{m.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
  )
}
