// Lot B Planificator V2 : parc matériel (équipements en propriété ou loués, état, dépôt, prochaine réservation).
// Drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN de la société de session (equipmentPageAccess) ; sinon 404, /login ou refus rendu sur place.
import Link from "next/link"
import { FileText, Wrench } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { equipmentPageAccess } from "@/lib/equipment/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { equipmentFormOptions, isStatusFilter, listEquipment } from "@/lib/equipment/queries"
import { parisToday } from "@/lib/equipment/equipment.core"
import { serverNow } from "@/lib/billing/clock"
import { createEquipmentAction } from "@/lib/actions/equipment.actions"
import { Button } from "@/components/ui/button"
import { CatalogFields } from "@/components/equipment/CatalogFields"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { CONDITION_LABEL, EQUIPMENT_STATUS_CLASS, EQUIPMENT_STATUS_LABEL, OWNERSHIP_LABEL, fmtDay, lastDayOf } from "@/components/equipment/labels"

export default async function EquipmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await equipmentPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const status = isStatusFilter(params.etat) ? params.etat : null
  const today = parisToday(serverNow())
  const [all, options] = await Promise.all([listEquipment(prisma, ctx.companyId, today), equipmentFormOptions(prisma, ctx.companyId)])
  // Indicateurs sur tout le parc ; le filtre ne restreint que la liste.
  const items = status ? all.filter((i) => i.status === status) : all
  const count = (s: string) => all.filter((i) => i.status === s).length
  const overdue = all.reduce((n, i) => n + i.overdue, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Wrench className="h-6 w-6 text-[#0f3460]" /> Matériel</h1><p className="mt-1 text-sm text-slate-500">{items.length} équipement{items.length > 1 ? "s" : ""}{status ? ` · filtre : ${EQUIPMENT_STATUS_LABEL[status]}` : ""} · réservations, sorties, retours et entretien</p></div>
        <Button variant="outline" asChild><Link href="/materiel/locations"><FileText className="h-4 w-4" /> Locations</Link></Button>
      </div>
      <StockFlash params={params} />
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Disponibles</p><p className="mt-1 text-2xl font-semibold text-green-700 tabular-nums">{count("AVAILABLE")}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Sortis</p><p className="mt-1 text-2xl font-semibold text-blue-700 tabular-nums">{count("OUT")}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">En entretien</p><p className="mt-1 text-2xl font-semibold text-amber-700 tabular-nums">{count("MAINTENANCE")}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Entretiens en retard</p><p className="mt-1 text-2xl font-semibold text-red-700 tabular-nums">{overdue}</p></CardContent></Card>
      </div>

      <Card><CardContent className="p-4">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <select name="etat" defaultValue={status ?? ""} className={SELECT_CLASS} aria-label="État"><option value="">Tous les états</option>{Object.entries(EQUIPMENT_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <Button type="submit" variant="secondary">Filtrer</Button>
        </form>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Équipement</th><th className="hidden px-3 py-2 md:table-cell">Catégorie</th><th className="hidden px-3 py-2 lg:table-cell">Dépôt</th><th className="hidden px-3 py-2 lg:table-cell">Prochaine réservation</th><th className="px-3 py-2">État</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Aucun équipement.</td></tr>}
            {items.map((e) => (
              <tr key={e.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium"><Link href={`/materiel/${e.id}`} className="text-[#0f3460] hover:underline">{e.number}</Link></td>
                <td className="px-3 py-2">{e.name}<div className="text-xs text-slate-400">{OWNERSHIP_LABEL[e.ownership]} · {CONDITION_LABEL[e.condition]}{e.overdue > 0 ? ` · ${e.overdue} entretien${e.overdue > 1 ? "s" : ""} en retard` : ""}</div></td>
                <td className="hidden px-3 py-2 md:table-cell">{e.category}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{e.warehouse?.name ?? "—"}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{e.next ? `${fmtDay(e.next.startAt)} → ${lastDayOf(e.next.endAt)}${e.next.worksite ? ` · ${e.next.worksite.name}` : ""}` : "—"}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${EQUIPMENT_STATUS_CLASS[e.status] ?? ""}`}>{EQUIPMENT_STATUS_LABEL[e.status] ?? e.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvel équipement</h2>
        <form action={createEquipmentAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <CatalogFields />
          <Input name="number" required maxLength={40} placeholder="N° interne (ex. TENTE-01)" aria-label="Numéro interne" />
          <Input name="serialNumber" maxLength={120} placeholder="N° de série (facultatif)" aria-label="Numéro de série" />
          <select name="ownership" className={SELECT_CLASS} aria-label="Propriété"><option value="OWNED">En propriété</option><option value="RENTED">Loué (contrat fournisseur)</option></select>
          <select name="warehouseId" className={SELECT_CLASS} aria-label="Dépôt"><option value="">Sans dépôt</option>{options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <Input name="dailyCost" inputMode="decimal" placeholder="Coût interne / jour (€, facultatif)" aria-label="Coût interne par jour" />
          <Input name="notes" maxLength={2000} placeholder="Notes (facultatif)" aria-label="Notes" />
          <div className="sm:col-span-2 lg:col-span-4"><Button type="submit">Créer l&apos;équipement</Button></div>
        </form>
      </CardContent></Card>
    </div>
  )
}
