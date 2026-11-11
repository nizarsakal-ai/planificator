// Lot B Planificator V2 : contrats de location et coûts matériel imputés par chantier (réel, engagé, matériel propre).
// Drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN.
import Link from "next/link"
import { FileText, Wrench } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { equipmentPageAccess } from "@/lib/equipment/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { equipmentCostsByWorksite, listRentalContracts } from "@/lib/equipment/queries"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { StockFlash } from "@/components/stock/StockFlash"
import { RENTAL_STATUS_CLASS, RENTAL_STATUS_LABEL, fmtDay } from "@/components/equipment/labels"

export default async function RentalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await equipmentPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const [contracts, costs] = await Promise.all([listRentalContracts(prisma, ctx.companyId), equipmentCostsByWorksite(prisma, ctx.companyId)])
  const active = contracts.filter((c) => c.status === "ACTIVE")

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><FileText className="h-6 w-6 text-[#0f3460]" /> Locations de matériel</h1><p className="mt-1 text-sm text-slate-500">{contracts.length} contrat{contracts.length > 1 ? "s" : ""} · {active.length} en cours · coûts imputés aux chantiers</p></div>
        <Button variant="outline" asChild><Link href="/materiel"><Wrench className="h-4 w-4" /> Parc</Link></Button>
      </div>
      <StockFlash params={params} />

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Équipement</th><th className="hidden px-3 py-2 md:table-cell">Loueur</th><th className="hidden px-3 py-2 md:table-cell">Période</th><th className="hidden px-3 py-2 lg:table-cell">Chantier</th><th className="px-3 py-2 text-right">Coût HT</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {contracts.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Aucun contrat de location.</td></tr>}
            {contracts.map((c) => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{c.number}<div><Link href={`/materiel/locations/${c.id}/contrat`} className="text-xs font-normal text-[#0f3460] hover:underline">Contrat complet</Link></div></td>
                <td className="px-3 py-2"><Link href={`/materiel/${c.equipment.id}`} className="text-[#0f3460] hover:underline">{c.equipment.number}</Link> {c.equipment.name}</td>
                <td className="hidden px-3 py-2 md:table-cell">{c.supplier.name}</td>
                <td className="hidden px-3 py-2 tabular-nums md:table-cell">{fmtDay(c.startDate)} → {fmtDay(c.returnedOn ?? c.endDate)}</td>
                <td className="hidden px-3 py-2 lg:table-cell">{c.worksite?.name ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.status === "CANCELLED" ? "—" : `${formatEuro(c.amountCents)}${c.status === "ACTIVE" ? "*" : ""}`}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RENTAL_STATUS_CLASS[c.status] ?? ""}`}>{RENTAL_STATUS_LABEL[c.status] ?? c.status}</span>{c.supplierInvoice && <div className="mt-1 text-xs text-slate-400">Facture {c.supplierInvoice.number}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      <p className="text-xs text-slate-500">* En cours : coût engagé sur la période prévue ; il est figé sur les jours réels à la clôture.</p>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Coûts matériel par chantier</h2>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Chantier</th><th className="px-3 py-2 text-right">Location réelle</th><th className="px-3 py-2 text-right">Location engagée</th><th className="hidden px-3 py-2 text-right md:table-cell">Matériel propre</th></tr></thead>
          <tbody>
            {costs.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucun coût matériel imputé.</td></tr>}
            {costs.map((w) => (
              <tr key={w.worksiteId} className="border-t">
                <td className="px-3 py-2 font-medium"><Link href={`/chantiers/${w.worksiteId}`} className="text-[#0f3460] hover:underline">{w.name}</Link></td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(w.rentalActualCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(w.rentalCommittedCents)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{formatEuro(w.ownedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-slate-500">Matériel propre : jours entamés entre sortie et retour × coût interne journalier (si renseigné sur l&apos;équipement). Ces montants alimenteront la marge chantier (lot C).</p>
      </CardContent></Card>
    </div>
  )
}
