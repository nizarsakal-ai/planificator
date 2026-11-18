// Lot E Planificator V2 : opportunités commerciales (pipeline par étape, relances dues, création).
// Drapeau CRM_OPPORTUNITIES_ENABLED + ADMIN/SUPER_ADMIN.
import { Target } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { crmPageAccess } from "@/lib/crm/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listOpportunities, opportunityFormOptions } from "@/lib/crm/queries"
import { DEFAULT_PROBABILITY_BP, OPEN_STAGES, STAGES, STAGE_LABEL, isOpen } from "@/lib/crm/crm.core"
import { createOpportunityAction } from "@/lib/actions/crm.actions"
import { parisToday } from "@/lib/equipment/equipment.core"
import { serverNow } from "@/lib/billing/clock"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtDay } from "@/components/equipment/labels"
import { OpportunityFields } from "@/components/crm/OpportunityFields"
import { STAGE_CLASS } from "@/components/crm/labels"

// Correctif E4 : les liens vers une fiche sont des liens ordinaires (navigation native du document, mêmes classes).
export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await crmPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const today = parisToday(serverNow())
  const [{ items, pipeline, truncated }, options] = await Promise.all([listOpportunities(prisma, ctx.companyId, today), opportunityFormOptions(prisma, ctx.companyId)])
  const due = items.filter((o) => isOpen(o.stage) && o.nextFollowUpDate && o.nextFollowUpDate.getTime() <= today.getTime())
  const tile = (label: string, value: string, sub: string) => <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p><p className="text-xs text-slate-500">{sub}</p></CardContent></Card>

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Target className="h-6 w-6 text-[#0f3460]" /> Opportunités</h1>
        <p className="mt-1 text-sm text-slate-500">{pipeline.openCount} ouverte{pipeline.openCount > 1 ? "s" : ""} · montants HT estimés</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      {truncated && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">Affichage et synthèse limités aux 1 000 opportunités les plus récemment modifiées.</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {tile("Pipeline ouvert", formatEuro(pipeline.openAmountCents), `${pipeline.openCount} opportunité(s)`)}
        {tile("Pipeline pondéré", formatEuro(pipeline.openWeightedCents), "montant × probabilité, étapes ouvertes")}
        {tile("Relances dues", String(pipeline.followUpsDue), "date de relance atteinte")}
      </div>

      {due.length > 0 && (
        <Card><CardContent className="space-y-2 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Relances dues</h2>
          <ul className="space-y-1 text-sm">{due.map((o) => <li key={o.id}><a href={`/crm/opportunites/${o.id}`} className="text-[#0f3460] hover:underline">{o.number} · {o.title}</a> <span className="text-xs text-slate-500">· {o.client?.name ?? o.prospectName} · relance du {fmtDay(o.nextFollowUpDate!)}</span></li>)}</ul>
        </CardContent></Card>
      )}

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Pipeline par étape</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Étape</th><th scope="col" className="px-3 py-2 text-right">Nombre</th><th scope="col" className="px-3 py-2 text-right">Montant</th><th scope="col" className="px-3 py-2 text-right">Pondéré</th></tr></thead>
          <tbody>{pipeline.rows.map((r) => <tr key={r.stage} className="border-t"><th scope="row" className="px-3 py-2 text-left font-normal"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CLASS[r.stage] ?? ""}`}>{STAGE_LABEL[r.stage]}</span></th><td className="px-3 py-2 text-right tabular-nums">{r.count}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.amountCents)}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.weightedCents)}</td></tr>)}</tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Opportunités</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Opportunité</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Client</th><th scope="col" className="px-3 py-2 text-right">Montant</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Signature prévue</th><th scope="col" className="px-3 py-2">Étape</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Aucune opportunité.</td></tr>}
            {items.map((o) => (
              <tr key={o.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2"><a href={`/crm/opportunites/${o.id}`} className="font-medium text-[#0f3460] hover:underline">{o.number} · {o.title}</a>{o.owner && <div className="text-xs text-slate-500">{o.owner.firstName} {o.owner.lastName}</div>}</td>
                <td className="hidden px-3 py-2 md:table-cell">{o.client?.name ?? <span className="text-slate-500">{o.prospectName} (prospect)</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(o.amountCents)}<div className="text-xs text-slate-500">{o.probabilityBp / 100} %</div></td>
                <td className="hidden px-3 py-2 tabular-nums md:table-cell">{o.expectedCloseDate ? fmtDay(o.expectedCloseDate) : "—"}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CLASS[o.stage] ?? ""}`}>{STAGE_LABEL[o.stage]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvelle opportunité</h2>
        <FormulaireRetour action={createOpportunityAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select name="stage" defaultValue="LEAD" className={SELECT_CLASS} aria-label="Étape">{OPEN_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select>
          <OpportunityFields options={options} />
          <div className="sm:col-span-2 lg:col-span-4"><Button type="submit">Créer l&apos;opportunité</Button></div>
        </FormulaireRetour>
      </CardContent></Card>
      <p className="text-xs text-slate-500">Probabilités par défaut : {STAGES.map((s) => `${STAGE_LABEL[s]} ${DEFAULT_PROBABILITY_BP[s] / 100} %`).join(" · ")}. Une opportunité gagnée ou perdue est figée.</p>
    </div>
    </ZoneRetour>
  )
}
