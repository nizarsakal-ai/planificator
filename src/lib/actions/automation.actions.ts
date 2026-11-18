"use server"
// Lot E Planificator V2 : actions serveur des automatisations (ADMIN de la société de session, drapeau
// AUTOMATIONS_ENABLED). « Exécuter maintenant » ne traite que les règles ACTIVES de l'entreprise de session.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { AutomationAccessError, automationAccessMessage, requireAutomationAdmin, type AutomationContext } from "@/lib/automation/access"
import { AUTOMATION_ERRORS } from "@/lib/automation/automation.core"
import * as svc from "@/lib/automation/automation.service"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const reqId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : "" }
type Outcome = { ok: true; okMessage: string } | { ok: false; error: string }
// v7 (preuves e3r/e3s) : retour EXPLICITE par état (useActionState, RetourFormulaire) au lieu d'une redirection serveur vers
// « ?ok= » : sans redirection ni revalidation, la réponse de l'action ne porte que ce résultat, rendu par le formulaire sans
// dépendre d'une transition du routeur ; l'actualisation des données est demandée ensuite par le client (router.refresh) et
// signalée tant qu'elle n'est pas appliquée. Signature compatible avec un envoi sans état préalable (formulaire seul).
async function run(fn: (ctx: AutomationContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireAutomationAdmin())
  } catch (e) {
    if (e instanceof AutomationAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof AutomationAccessError) return retour(false, automationAccessMessage(e.reason))
    console.error("[automatisations] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage) : retour(false, result.error)
}

export async function createRuleAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const daysRaw = str(form, "taskDueInDays", 5)
    const days = daysRaw === "" ? null : /^\d{1,3}$/.test(daysRaw) ? Number(daysRaw) : -1
    if (days === -1) return { ok: false, error: AUTOMATION_ERRORS.dueInDays }
    const r = await svc.createRule(prisma, ctx, {
      name: str(form, "name", 1000), trigger: str(form, "trigger", 40), action: str(form, "action", 20), stageFilter: str(form, "stageFilter", 20) || null,
      taskTitle: str(form, "taskTitle", 1000) || null, taskAssigneeId: reqId(form, "taskAssigneeId") || null, taskDueInDays: days, message: str(form, "message", 2000) || null,
    })
    return r.ok ? { ok: true, okMessage: "Règle créée en brouillon : elle n'agira qu'après approbation." } : r
  })
}
export async function approveRuleAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation d'approbation." }
    const r = await svc.approveAndActivate(prisma, ctx, reqId(form, "ruleId"))
    return r.ok ? { ok: true, okMessage: "Règle approuvée et active. Sa portée à l'activation est indiquée sur sa ligne." } : r
  })
}
export async function disableRuleAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.disableRule(prisma, ctx, reqId(form, "ruleId"))
    return r.ok ? { ok: true, okMessage: "Règle désactivée immédiatement." } : r
  })
}
export async function runNowAction() {
  return run(async (ctx) => {
    const s = await svc.runAutomations(prisma, { companyId: ctx.companyId })
    return { ok: true, okMessage: `Passe terminée : ${s.done} action(s), ${s.skipped} ignorée(s), ${s.errors} erreur(s) reprise(s) au prochain passage, ${s.rules} règle(s) active(s).` }
  })
}
