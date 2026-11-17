// Lot E Planificator V2 : fiche d'une opportunité (modification, étape, relance, notes, historique append-only).
// Drapeau CRM_OPPORTUNITIES_ENABLED + ADMIN/SUPER_ADMIN ; identifiant d'une autre entreprise ⇒ 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Target } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { crmPageAccess } from "@/lib/crm/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getOpportunity, opportunityFormOptions } from "@/lib/crm/queries"
import { STAGES, STAGE_LABEL, isOpen } from "@/lib/crm/crm.core"
import { addNoteAction, changeStageAction, recordFollowUpAction, updateOpportunityAction } from "@/lib/actions/crm.actions"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtDay, fmtInstant } from "@/components/equipment/labels"
import { OpportunityFields } from "@/components/crm/OpportunityFields"
import { EVENT_LABEL, STAGE_CLASS } from "@/components/crm/labels"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function OpportunityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await crmPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  if (!ID.test(id)) notFound()
  const flash = await searchParams
  const [o, options] = await Promise.all([getOpportunity(prisma, ctx.companyId, id), opportunityFormOptions(prisma, ctx.companyId)])
  if (!o) notFound()
  const open = isOpen(o.stage)
  const hidden = <input type="hidden" name="opportunityId" value={o.id} />

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        {/* Correctif E4 : retour à la liste par navigation native du document (lien ordinaire, mêmes classes). */}
        <a href="/crm/opportunites" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:underline"><ArrowLeft className="h-4 w-4" /> Opportunités</a>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-900"><Target className="h-6 w-6 text-[#0f3460]" /> {o.number} · {o.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CLASS[o.stage] ?? ""}`}>{STAGE_LABEL[o.stage]}</span> · {o.client?.name ?? `${o.prospectName} (prospect)`} · {formatEuro(o.amountCents)} à {o.probabilityBp / 100} %
          {o.quote && <> · devis <Link href={`/devis/${o.quote.id}`} className="text-[#0f3460] hover:underline">{o.quote.number}</Link></>}
          {o.worksite && <> · chantier <Link href={`/chantiers/${o.worksite.id}`} className="text-[#0f3460] hover:underline">{o.worksite.name}</Link></>}
          {o.closedAt && <> · close le {fmtInstant(o.closedAt)}{o.lostReason ? ` (${o.lostReason})` : ""}</>}
        </p>
      </div>
      <MessageRetour><StockFlash params={flash} /></MessageRetour>

      {open && (
        <>
          <Card><CardContent className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Étape</h2>
            <FormulaireRetour action={changeStageAction} className="flex flex-wrap gap-2">{hidden}
              <select name="stage" defaultValue={o.stage} className={SELECT_CLASS} aria-label="Nouvelle étape">{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select>
              <Input name="lostReason" maxLength={500} placeholder="Motif (obligatoire si perdue)" aria-label="Motif de perte" className="w-64" />
              <Button type="submit">Changer d&apos;étape</Button>
            </FormulaireRetour>
          </CardContent></Card>
          <Card><CardContent className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Relance{o.nextFollowUpDate ? ` prévue le ${fmtDay(o.nextFollowUpDate)}` : ""}{o.followUpNote ? ` : ${o.followUpNote}` : ""}</h2>
            <FormulaireRetour action={recordFollowUpAction} className="flex flex-wrap gap-2">{hidden}
              <Input name="note" required minLength={3} maxLength={2000} placeholder="Compte rendu de la relance" aria-label="Compte rendu de la relance" className="w-80" />
              <label className="flex items-center gap-1 text-xs text-slate-500">Suivante <Input name="nextFollowUpDate" type="date" aria-label="Prochaine relance" /></label>
              <Button type="submit" variant="secondary">Relance faite</Button>
            </FormulaireRetour>
          </CardContent></Card>
          <Card><CardContent className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Modifier</h2>
            <FormulaireRetour action={updateOpportunityAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{hidden}
              <OpportunityFields options={options} values={o} />
              <div className="sm:col-span-2 lg:col-span-4"><Button type="submit" variant="secondary">Enregistrer</Button></div>
            </FormulaireRetour>
          </CardContent></Card>
        </>
      )}

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Historique</h2>
        <FormulaireRetour action={addNoteAction} className="flex flex-wrap gap-2">{hidden}
          <Input name="note" required minLength={3} maxLength={2000} placeholder="Ajouter une note" aria-label="Note" className="w-96" />
          <Button type="submit" variant="outline">Ajouter</Button>
        </FormulaireRetour>
        <ol className="space-y-2 text-sm">
          {o.events.map((e) => (
            <li key={e.id} className="rounded-lg border p-2">
              <p className="text-xs text-slate-500">{fmtInstant(e.createdAt)} · {EVENT_LABEL[e.type] ?? e.type}{e.fromStage && e.toStage ? ` : ${STAGE_LABEL[e.fromStage]} → ${STAGE_LABEL[e.toStage]}` : ""}</p>
              {e.note && <p>{e.note}</p>}
            </li>
          ))}
        </ol>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
