// Lot E Planificator V2 : automatisations (règles en brouillon, approbation explicite, désactivation immédiate,
// journal des exécutions). Actions internes seulement (tâche, notification dans l'application), jamais d'envoi externe.
// Drapeau AUTOMATIONS_ENABLED + ADMIN/SUPER_ADMIN.
import { Workflow } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { automationPageAccess } from "@/lib/automation/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listRules, listRuns } from "@/lib/automation/queries"
import { ACTIONS, ACTION_LABEL, ACTIVATION_SCOPE, TEMPLATE_FIELDS, TRIGGER_LABEL, availableTriggers, isTriggerAvailable } from "@/lib/automation/automation.core"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { STAGES, STAGE_LABEL } from "@/lib/crm/crm.core"
import { approveRuleAction, createRuleAction, disableRuleAction, runNowAction } from "@/lib/actions/automation.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

const STATUS_LABEL: Record<string, string> = { DRAFT: "Brouillon (inactive)", ACTIVE: "Active", DISABLED: "Désactivée" }
const STATUS_CLASS: Record<string, string> = { DRAFT: "bg-slate-100 text-slate-700", ACTIVE: "bg-green-50 text-green-700", DISABLED: "bg-red-50 text-red-600" }

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await automationPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  // Pipeline commercial désactivé : déclencheurs d'opportunité ni proposés ni exécutés (règles existantes en attente).
  const crmEnabled = isCrmEnabled()
  const triggers = availableTriggers(crmEnabled)
  const [rules, runs, employees] = await Promise.all([
    listRules(prisma, ctx.companyId), listRuns(prisma, ctx.companyId),
    prisma.employee.findMany({ where: { companyId: ctx.companyId, active: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 500, select: { id: true, firstName: true, lastName: true } }),
  ])

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Workflow className="h-6 w-6 text-[#0f3460]" /> Automatisations</h1>
          <p className="mt-1 text-sm text-slate-500">Déclencheurs internes · actions internes seulement (tâche, notification dans l&apos;application) · aucun envoi externe</p>
        </div>
        <FormulaireRetour action={runNowAction}><Button type="submit" variant="outline">Exécuter maintenant</Button></FormulaireRetour>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Règles d&apos;automatisation</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Règle</th><th scope="col" className="px-3 py-2">État</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400">Aucune règle.</td></tr>}
            {rules.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-slate-500">Quand : {TRIGGER_LABEL[r.trigger]}{r.stageFilter ? ` (vers « ${STAGE_LABEL[r.stageFilter]} »)` : ""} · Alors : {ACTION_LABEL[r.action]}</p>
                  <p className="text-xs text-slate-500">{r.action === "CREATE_TASK" ? `Tâche « ${r.taskTitle} »${r.taskAssignee ? ` pour ${r.taskAssignee.firstName} ${r.taskAssignee.lastName}` : ""}${r.taskDueInDays !== null ? `, échéance J+${r.taskDueInDays}` : ""}` : `Message « ${r.message} »`} · {r._count.runs} exécution(s)</p>
                </td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status]}</span>{r.activatedAt && r.status === "ACTIVE" && <div className="text-xs text-slate-500">depuis le {fmtInstant(r.activatedAt)}</div>}{!isTriggerAvailable(r.trigger, crmEnabled) && <div className="text-xs text-amber-700">En attente : pipeline commercial désactivé</div>}</td>
                <td className="px-3 py-2">
                  {r.status === "ACTIVE" ? (
                    <FormulaireRetour action={disableRuleAction}><input type="hidden" name="ruleId" value={r.id} /><Button type="submit" variant="outline" size="sm">Désactiver</Button></FormulaireRetour>
                  ) : !isTriggerAvailable(r.trigger, crmEnabled) ? (
                    <span className="text-xs text-slate-500">Approbation possible quand le pipeline commercial est actif</span>
                  ) : (
                    <FormulaireRetour action={approveRuleAction} className="flex items-center gap-2"><input type="hidden" name="ruleId" value={r.id} />
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="oui" required /> J&apos;approuve cette règle</label>
                      <Button type="submit" size="sm">Approuver et activer</Button>
                    </FormulaireRetour>
                  )}
                  {isTriggerAvailable(r.trigger, crmEnabled) && (
                    <p className="mt-1 max-w-xs text-xs text-slate-500">{ACTIVATION_SCOPE[r.trigger]}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvelle règle (créée en brouillon)</h2>
        <FormulaireRetour action={createRuleAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Input name="name" required minLength={3} maxLength={120} placeholder="Nom de la règle" aria-label="Nom de la règle" />
          <select name="trigger" required defaultValue="" className={SELECT_CLASS} aria-label="Déclencheur"><option value="" disabled>Quand…</option>{triggers.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}</select>
          {crmEnabled && <select name="stageFilter" defaultValue="" className={SELECT_CLASS} aria-label="Filtre d'étape"><option value="">Toute étape (changement d&apos;étape)</option>{STAGES.map((s) => <option key={s} value={s}>Vers « {STAGE_LABEL[s]} »</option>)}</select>}
          <select name="action" required defaultValue="" className={SELECT_CLASS} aria-label="Action"><option value="" disabled>Alors…</option>{ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select>
          <Input name="taskTitle" maxLength={200} placeholder="Intitulé de tâche (tâche)" aria-label="Intitulé de tâche" />
          <select name="taskAssigneeId" defaultValue="" className={SELECT_CLASS} aria-label="Responsable de la tâche"><option value="">Sans responsable (tâche)</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select>
          <Input name="taskDueInDays" inputMode="numeric" placeholder="Échéance en jours (tâche)" aria-label="Échéance en jours" />
          <Input name="message" maxLength={500} placeholder="Message (notification)" aria-label="Message de notification" className="sm:col-span-2" />
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-3">Champs utilisables dans l&apos;intitulé ou le message : {TEMPLATE_FIELDS.map((f) => `{${f}}`).join(" ")}. Une règle ne peut plus être modifiée : pour la changer, désactivez-la et créez-en une autre.</p>
          <div className="sm:col-span-2 lg:col-span-3"><Button type="submit">Créer en brouillon</Button></div>
        </FormulaireRetour>
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Journal des exécutions</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Date</th><th scope="col" className="px-3 py-2">Règle</th><th scope="col" className="px-3 py-2">Résultat</th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Aucune exécution.</td></tr>}
            {runs.map((r) => <tr key={r.id} className="border-t"><td className="px-3 py-2 tabular-nums">{fmtInstant(r.createdAt)}</td><td className="px-3 py-2">{r.rule.name}</td><td className="px-3 py-2">{r.status === "DONE" ? "Fait" : "Ignoré"} · {r.detail}</td></tr>)}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
