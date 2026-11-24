// Lot F Planificator V2 : assistant. Propositions issues de règles locales (aucun fournisseur d'IA externe pour ces propositions), chacune
// avec ses sources ; aucune action sans approbation explicite d'un administrateur ; journal des actions.
// Drapeau ASSISTANT_ENABLED + ADMIN/SUPER_ADMIN.
// Intégration FGHI v2 (incident Chrome) : retour explicite par le mécanisme qualifié E4, comme les Connecteurs : écran
// enveloppé par ZoneRetour, message par MessageRetour, les trois formulaires par FormulaireRetour ; refus d'accès rendu
// avant la zone et avant toute lecture ; liens des sources inchangés (navigation native du document).
import { Sparkles } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { assistantPageAccess } from "@/lib/assistant/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { RULE_LABEL, readPayload, readSources, type AssistantRule } from "@/lib/assistant/assistant.core"
import { PROVIDERS } from "@/lib/assistant/providers"
import { loadAssistantPage } from "@/lib/assistant/queries"
import { analyseAction, approveProposalAction, rejectProposalAction } from "@/lib/actions/assistant.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

const STATUS_LABEL: Record<string, string> = { EXECUTED: "Approuvée, tâche créée", REJECTED: "Refusée", OBSOLETE: "Périmée (sources changées)" }
const EVENT_LABEL: Record<string, string> = { GENERATED: "Proposée", EXECUTED: "Exécutée", REJECTED: "Refusée", OBSOLETE: "Périmée" }
const ruleLabel = (r: string) => RULE_LABEL[r as AssistantRule] ?? r

export default async function AssistantPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await assistantPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A, B et E).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const { pending, decided, logs, employees } = await loadAssistantPage(prisma, ctx.companyId)

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Sparkles className="h-6 w-6 text-[#0f3460]" /> Propositions</h1>
          <p className="mt-1 text-sm text-slate-500">Propositions avec leurs sources · rien n&apos;est fait sans votre approbation · journal des actions</p>
        </div>
        <FormulaireRetour action={analyseAction}><Button type="submit">Analyser maintenant</Button></FormulaireRetour>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      <ul className="flex flex-wrap gap-2 text-xs">
        {PROVIDERS.map((p) => <li key={p.id} className={`rounded-full px-2 py-0.5 ${p.usable ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}`}>{p.label} : {p.note}</li>)}
      </ul>

      <h2 className="text-sm font-semibold text-slate-900">En attente de décision ({pending.length})</h2>
      {pending.length === 0 && <p className="text-sm text-slate-400">Aucune proposition en attente.</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {pending.map((p) => {
          const payload = readPayload(p.payload)
          const sources = readSources(p.sources)
          return (
            <Card key={p.id} id={`proposition-${p.id}`} className="scroll-mt-24"><CardContent className="space-y-2 p-4">
              <p className="text-xs uppercase text-slate-500">{ruleLabel(p.rule)} · {fmtInstant(p.createdAt)}</p>
              <p className="font-medium text-slate-900">{p.title}</p>
              <p className="text-sm text-slate-600">{p.rationale}</p>
              <div className="text-xs text-slate-600">Sources :
                {/* Lien ordinaire (navigation native du document), comme les liens vers les fiches du pipeline commercial du
                    correctif E4 ; adresse interne seulement (readSources refuse tout lien externe). */}
                <ul className="ml-4 list-disc">{sources.map((s) => <li key={`${s.type}:${s.id}`}><a href={s.href} className="text-[#0f3460] underline">{s.label}</a> — {s.fact}</li>)}</ul>
              </div>
              {payload && (
                <FormulaireRetour action={approveProposalAction} className="grid gap-2 sm:grid-cols-2">
                  <input type="hidden" name="proposalId" value={p.id} />
                  <Input name="title" defaultValue={payload.title} required minLength={3} maxLength={200} aria-label="Intitulé de la tâche" className="sm:col-span-2" />
                  <Input name="dueDate" type="date" defaultValue={payload.dueDate} aria-label="Échéance" />
                  <select name="assigneeId" defaultValue="" className={SELECT_CLASS} aria-label="Responsable"><option value="">Sans responsable</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select>
                  <label className="flex items-center gap-1 text-xs sm:col-span-2"><input type="checkbox" name="confirm" value="oui" required /> J&apos;approuve : créer cette tâche interne</label>
                  <div><Button type="submit" size="sm">Approuver</Button></div>
                </FormulaireRetour>
              )}
              <FormulaireRetour action={rejectProposalAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="proposalId" value={p.id} />
                <Input name="note" maxLength={500} placeholder="Motif (facultatif)" aria-label="Motif du refus" className="h-8 max-w-xs" />
                <Button type="submit" size="sm" variant="outline">Refuser</Button>
              </FormulaireRetour>
            </CardContent></Card>
          )
        })}
      </div>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Décisions récentes</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Date</th><th scope="col" className="px-3 py-2">Proposition</th><th scope="col" className="px-3 py-2">Décision</th></tr></thead>
          <tbody>
            {decided.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Aucune décision.</td></tr>}
            {decided.map((d) => <tr key={d.id} className="border-t"><td className="px-3 py-2 tabular-nums">{d.decidedAt ? fmtInstant(d.decidedAt) : "—"}</td><td className="px-3 py-2">{d.title} <span className="text-xs text-slate-500">({ruleLabel(d.rule)})</span></td><td className="px-3 py-2">{STATUS_LABEL[d.status] ?? d.status}{d.decisionNote ? ` · ${d.decisionNote}` : ""}</td></tr>)}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Journal des actions</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Date</th><th scope="col" className="px-3 py-2">Événement</th><th scope="col" className="px-3 py-2">Détail</th></tr></thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Journal vide.</td></tr>}
            {logs.map((l) => <tr key={l.id} className="border-t"><td className="px-3 py-2 tabular-nums">{fmtInstant(l.createdAt)}</td><td className="px-3 py-2">{EVENT_LABEL[l.event] ?? l.event}</td><td className="px-3 py-2">{l.detail}</td></tr>)}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
