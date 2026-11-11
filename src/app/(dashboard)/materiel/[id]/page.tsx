// Lot B Planificator V2 : fiche d'un équipement (réservations, sorties et retours avec état, contrats de location,
// entretien). Drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN ; un identifiant d'une autre entreprise donne 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Wrench } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { equipmentPageAccess } from "@/lib/equipment/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { equipmentFormOptions, getEquipment, rentalInvoicesFor } from "@/lib/equipment/queries"
import { committedRentalCents, formatDay, maintenanceOverdue, parisToday } from "@/lib/equipment/equipment.core"
import { serverNow } from "@/lib/billing/clock"
import { formatEuro } from "@/lib/billing/money"
import {
  cancelBookingAction, cancelRentalContractAction, checkoutBookingAction, closeRentalContractAction, completeMaintenanceAction,
  createBookingAction, createRentalContractAction, linkRentalInvoiceAction, recordMaintenanceAction, returnBookingAction, setEquipmentStatusAction, updateEquipmentAction,
} from "@/lib/actions/equipment.actions"
import { Button } from "@/components/ui/button"
import { WorksitePicker } from "@/components/equipment/WorksitePicker"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import {
  BOOKING_STATUS_CLASS, BOOKING_STATUS_LABEL, CONDITION_LABEL, EQUIPMENT_STATUS_CLASS, EQUIPMENT_STATUS_LABEL, OWNERSHIP_LABEL,
  RENTAL_STATUS_CLASS, RENTAL_STATUS_LABEL, fmtDay, fmtInstant, lastDayOf,
} from "@/components/equipment/labels"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const CONDITIONS = Object.entries(CONDITION_LABEL)
const STATUS_ACTIONS: Record<string, { to: string; label: string }[]> = {
  AVAILABLE: [{ to: "MAINTENANCE", label: "Mettre en entretien" }, { to: "RETIRED", label: "Réformer" }],
  MAINTENANCE: [{ to: "AVAILABLE", label: "Remettre en service" }, { to: "RETIRED", label: "Réformer" }],
}

export default async function EquipmentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await equipmentPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  if (!ID.test(id)) notFound()
  const sp = await searchParams
  const [e, options] = await Promise.all([getEquipment(prisma, ctx.companyId, id), equipmentFormOptions(prisma, ctx.companyId)])
  if (!e) notFound()
  const today = parisToday(serverNow())
  const supplierIds = [...new Set(e.rentals.filter((r) => r.status !== "CANCELLED").map((r) => r.supplierId))]
  const invoices = new Map(await Promise.all(supplierIds.map(async (s) => [s, await rentalInvoicesFor(prisma, ctx.companyId, s)] as const)))
  const hidden = <input type="hidden" name="equipmentId" value={e.id} />
  const worksiteOptions = options.worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)
  const conditionOptions = CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Wrench className="h-6 w-6 text-[#0f3460]" /> {e.number} · {e.name}</h1>
          <p className="mt-1 text-sm text-slate-500">{e.category} · {OWNERSHIP_LABEL[e.ownership]} · {CONDITION_LABEL[e.condition]}{e.warehouse ? ` · dépôt ${e.warehouse.name}` : ""}{e.serialNumber ? ` · n° de série ${e.serialNumber}` : ""}{e.dailyCostCents !== null ? ` · coût interne ${formatEuro(BigInt(e.dailyCostCents))}/jour` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${EQUIPMENT_STATUS_CLASS[e.status] ?? ""}`}>{EQUIPMENT_STATUS_LABEL[e.status] ?? e.status}</span>
          {(STATUS_ACTIONS[e.status] ?? []).map((a) => (
            <form key={a.to} action={setEquipmentStatusAction}>{hidden}<input type="hidden" name="status" value={a.to} /><Button type="submit" variant="outline" size="sm">{a.label}</Button></form>
          ))}
          <Button variant="outline" asChild><Link href="/materiel"><ArrowLeft className="h-4 w-4" /> Parc</Link></Button>
        </div>
      </div>
      <StockFlash params={sp} />
      {e.notes && <Card><CardContent className="p-4 text-sm text-slate-600">{e.notes}</CardContent></Card>}
      {e.status !== "RETIRED" && <Card><CardContent className="p-4">
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Modifier la fiche</summary>
          <form action={updateEquipmentAction} className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{hidden}
            <Input name="name" required maxLength={160} defaultValue={e.name} aria-label="Désignation" />
            <Input name="category" required maxLength={80} defaultValue={e.category} aria-label="Catégorie" />
            <Input name="serialNumber" maxLength={120} defaultValue={e.serialNumber ?? ""} placeholder="N° de série" aria-label="Numéro de série" />
            <select name="warehouseId" defaultValue={e.warehouse?.id ?? ""} className={SELECT_CLASS} aria-label="Dépôt"><option value="">Sans dépôt</option>{options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            <Input name="dailyCost" inputMode="decimal" defaultValue={e.dailyCostCents !== null ? (e.dailyCostCents / 100).toFixed(2).replace(".", ",") : ""} placeholder="Coût interne / jour (€)" aria-label="Coût interne par jour" />
            <Input name="notes" maxLength={2000} defaultValue={e.notes ?? ""} placeholder="Notes" aria-label="Notes" />
            <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" variant="secondary">Enregistrer la fiche</Button></div>
          </form>
        </details>
      </CardContent></Card>}

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Réservations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Période</th><th className="px-3 py-2">Chantier</th><th className="hidden px-3 py-2 md:table-cell">Responsable</th><th className="hidden px-3 py-2 lg:table-cell">Sortie / retour</th><th className="px-3 py-2">Statut</th><th className="px-3 py-2 text-right">Action</th></tr></thead>
            <tbody>
              {e.bookings.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Aucune réservation.</td></tr>}
              {e.bookings.map((b) => (
                <tr key={b.id} className="border-t align-top">
                  <td className="px-3 py-2 tabular-nums">{fmtDay(b.startAt)} → {lastDayOf(b.endAt)}{b.depositCents !== null && <div className="text-xs text-slate-400">Caution {formatEuro(BigInt(b.depositCents))}</div>}</td>
                  <td className="px-3 py-2">{b.worksite ? <Link href={`/chantiers/${b.worksite.id}`} className="text-[#0f3460] hover:underline">{b.worksite.name}</Link> : "—"}</td>
                  <td className="hidden px-3 py-2 md:table-cell">{b.responsible ? `${b.responsible.firstName} ${b.responsible.lastName}` : "—"}</td>
                  <td className="hidden px-3 py-2 text-xs text-slate-500 lg:table-cell">
                    {b.checkedOutAt ? `Sorti le ${fmtInstant(b.checkedOutAt)} (${CONDITION_LABEL[b.checkoutCondition ?? ""] ?? "—"})` : "—"}
                    {b.returnedAt && <div>Rendu le {fmtInstant(b.returnedAt)} ({CONDITION_LABEL[b.returnCondition ?? ""] ?? "—"}){b.returnNotes ? ` : ${b.returnNotes}` : ""}</div>}
                  </td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BOOKING_STATUS_CLASS[b.status] ?? ""}`}>{BOOKING_STATUS_LABEL[b.status] ?? b.status}</span><div><Link href={`/materiel/reservations/${b.id}/contrat`} className="text-xs text-[#0f3460] hover:underline">Contrat de location</Link></div></td>
                  <td className="px-3 py-2 text-right">
                    {b.status === "RESERVED" && <div className="flex flex-wrap justify-end gap-2">
                      <form action={checkoutBookingAction} className="flex gap-2">{hidden}<input type="hidden" name="bookingId" value={b.id} /><select name="condition" required defaultValue={e.condition} className={SELECT_CLASS} aria-label="État à la sortie">{conditionOptions}</select><Button type="submit" size="sm">Sortie</Button></form>
                      <form action={cancelBookingAction}>{hidden}<input type="hidden" name="bookingId" value={b.id} /><Button type="submit" variant="outline" size="sm">Annuler</Button></form>
                    </div>}
                    {b.status === "CHECKED_OUT" && <form action={returnBookingAction} className="flex flex-wrap justify-end gap-2">{hidden}<input type="hidden" name="bookingId" value={b.id} />
                      <select name="condition" required defaultValue={b.checkoutCondition ?? "GOOD"} className={SELECT_CLASS} aria-label="État au retour">{conditionOptions}</select>
                      <select name="warehouseId" defaultValue={e.warehouse?.id ?? ""} className={SELECT_CLASS} aria-label="Dépôt de retour"><option value="">Dépôt inchangé</option>{options.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
                      <Input name="notes" maxLength={1000} placeholder="Observations" aria-label="Observations au retour" className="w-40" />
                      <Button type="submit" size="sm">Retour</Button>
                    </form>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {e.status !== "RETIRED" && <form action={createBookingAction} className="grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-6">{hidden}
          <Input name="firstDay" type="date" required aria-label="Premier jour" />
          <Input name="lastDay" type="date" required aria-label="Dernier jour" />
          <WorksitePicker worksites={options.worksites} />
          <select name="responsibleId" className={SELECT_CLASS} aria-label="Responsable"><option value="">Sans responsable</option>{options.employees.map((p) => <option key={p.id} value={p.id}>{p.lastName} {p.firstName}</option>)}</select>
          <Input name="deposit" inputMode="decimal" placeholder="Caution (€, facultatif)" aria-label="Caution" />
          <Button type="submit">Réserver</Button>
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-6">Le contrat de location est établi automatiquement : indiquez la période, et le chantier pour reprendre le client.</p>
        </form>}
        {e.ownership === "RENTED" && <p className="text-xs text-slate-500">Équipement loué : la période réservée doit être entièrement couverte par un contrat de location en cours.</p>}
      </CardContent></Card>

      {e.ownership === "RENTED" && <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Contrats de location</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">N°</th><th className="px-3 py-2">Loueur</th><th className="px-3 py-2">Période</th><th className="hidden px-3 py-2 md:table-cell">Chantier imputé</th><th className="px-3 py-2 text-right">Coût</th><th className="px-3 py-2">Statut</th><th className="px-3 py-2 text-right">Action</th></tr></thead>
            <tbody>
              {e.rentals.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Aucun contrat.</td></tr>}
              {e.rentals.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-3 py-2 font-medium">{r.number}<div><Link href={`/materiel/locations/${r.id}/contrat`} className="text-xs font-normal text-[#0f3460] hover:underline">Contrat complet</Link></div></td>
                  <td className="px-3 py-2">{r.supplier.name}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtDay(r.startDate)} → {fmtDay(r.endDate)}{r.returnedOn && <div className="text-xs text-slate-400">Rendu le {fmtDay(r.returnedOn)}</div>}</td>
                  <td className="hidden px-3 py-2 md:table-cell">{r.worksite?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.status === "CLOSED" ? formatEuro(r.costCents ?? BigInt("0")) : r.status === "ACTIVE" ? <span title="Engagé sur la période prévue">{formatEuro(committedRentalCents(r))}*</span> : "—"}<div className="text-xs text-slate-400">{formatEuro(BigInt(r.dailyRateCents))}/jour{r.fixedFeesCents ? ` + ${formatEuro(BigInt(r.fixedFeesCents))}` : ""}</div></td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RENTAL_STATUS_CLASS[r.status] ?? ""}`}>{RENTAL_STATUS_LABEL[r.status] ?? r.status}</span>{r.supplierInvoice && <div className="mt-1 text-xs text-slate-400">Facture {r.supplierInvoice.number}{r.status === "CLOSED" && r.costCents !== null && BigInt(r.supplierInvoice.totalHTCents) !== r.costCents && <span className="ml-1 rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-600">Écart {formatEuro(BigInt(r.supplierInvoice.totalHTCents) - r.costCents)}</span>}</div>}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "ACTIVE" && <div className="flex flex-wrap justify-end gap-2">
                      <form action={closeRentalContractAction} className="flex gap-2">{hidden}<input type="hidden" name="contractId" value={r.id} /><Input name="returnedOn" type="date" required defaultValue={formatDay(today)} aria-label="Date de retour au loueur" className="w-40" /><Button type="submit" size="sm">Clôturer</Button></form>
                      <form action={cancelRentalContractAction}>{hidden}<input type="hidden" name="contractId" value={r.id} /><Button type="submit" variant="outline" size="sm">Annuler</Button></form>
                    </div>}
                    {r.status !== "CANCELLED" && <form action={linkRentalInvoiceAction} className="mt-2 flex justify-end gap-2">{hidden}<input type="hidden" name="contractId" value={r.id} />
                      <select name="supplierInvoiceId" defaultValue={r.supplierInvoice?.id ?? ""} className={SELECT_CLASS} aria-label="Facture du loueur"><option value="">Aucune facture</option>{(invoices.get(r.supplierId) ?? []).map((i) => <option key={i.id} value={i.id}>{i.number} · {formatEuro(BigInt(i.totalHTCents))} HT</option>)}</select>
                      <Button type="submit" variant="outline" size="sm">Lier</Button>
                    </form>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">* Contrat en cours : coût engagé sur la période prévue. À la clôture, le coût est figé sur les jours réels (bornes incluses) et imputé au chantier du contrat.</p>
        {e.status !== "RETIRED" && (options.suppliers.length === 0
          ? <p className="text-sm text-slate-500">Il faut au moins un fournisseur actif pour enregistrer un contrat.</p>
          : <form action={createRentalContractAction} className="grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-4">{hidden}
            <select name="supplierId" required className={SELECT_CLASS} aria-label="Loueur">{options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <select name="worksiteId" className={SELECT_CLASS} aria-label="Chantier imputé"><option value="">Sans chantier (frais généraux)</option>{worksiteOptions}</select>
            <Input name="startDate" type="date" required aria-label="Début du contrat" />
            <Input name="endDate" type="date" required aria-label="Fin prévue du contrat" />
            <Input name="dailyRate" required inputMode="decimal" placeholder="Tarif HT / jour (€)" aria-label="Tarif journalier" />
            <Input name="fixedFees" inputMode="decimal" placeholder="Frais fixes HT (€, transport…)" aria-label="Frais fixes" />
            <Input name="notes" maxLength={2000} placeholder="Notes (facultatif)" aria-label="Notes du contrat" className="sm:col-span-2" />
            <div className="sm:col-span-2 lg:col-span-4"><Button type="submit">Enregistrer le contrat</Button></div>
          </form>)}
      </CardContent></Card>}

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Entretien</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Intervention</th><th className="px-3 py-2">Prévu</th><th className="px-3 py-2">Réalisé</th><th className="hidden px-3 py-2 md:table-cell">Prestataire</th><th className="px-3 py-2 text-right">Coût</th><th className="px-3 py-2 text-right">Action</th></tr></thead>
            <tbody>
              {e.maintenances.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Aucun entretien.</td></tr>}
              {e.maintenances.map((m) => {
                const late = maintenanceOverdue(m, today)
                return (
                  <tr key={m.id} className={`border-t align-top ${late ? "bg-red-50/40" : ""}`}>
                    <td className="px-3 py-2">{m.description}{late && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">En retard</span>}</td>
                    <td className="px-3 py-2 tabular-nums">{m.plannedOn ? fmtDay(m.plannedOn) : "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{m.performedOn ? fmtDay(m.performedOn) : "—"}</td>
                    <td className="hidden px-3 py-2 md:table-cell">{m.supplier?.name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.costCents !== null ? formatEuro(BigInt(m.costCents)) : "—"}</td>
                    <td className="px-3 py-2 text-right">{!m.performedOn && <form action={completeMaintenanceAction} className="flex justify-end gap-2">{hidden}<input type="hidden" name="maintenanceId" value={m.id} /><Input name="performedOn" type="date" required defaultValue={formatDay(today)} aria-label="Date de réalisation" className="w-40" /><Input name="cost" inputMode="decimal" placeholder="Coût (€)" aria-label="Coût réel" className="w-28" /><Button type="submit" size="sm" variant="secondary">Réalisé</Button></form>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <form action={recordMaintenanceAction} className="grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-6">{hidden}
          <Input name="description" required maxLength={500} placeholder="Intervention (ex. vidange, contrôle VGP)" aria-label="Intervention" className="lg:col-span-2" />
          <Input name="plannedOn" type="date" aria-label="Date prévue" />
          <Input name="performedOn" type="date" aria-label="Date réalisée" />
          <Input name="cost" inputMode="decimal" placeholder="Coût (€, facultatif)" aria-label="Coût" />
          <select name="supplierId" className={SELECT_CLASS} aria-label="Prestataire"><option value="">En interne</option>{options.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-5">Renseigner une date prévue (planification) ou une date réalisée (intervention déjà faite).</p>
          <Button type="submit" variant="secondary">Enregistrer</Button>
        </form>
      </CardContent></Card>
    </div>
  )
}
