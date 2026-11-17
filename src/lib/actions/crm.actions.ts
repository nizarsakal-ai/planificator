"use server"
// Lot E Planificator V2 : actions serveur des opportunités (ADMIN de la société de session, drapeau
// CRM_OPPORTUNITIES_ENABLED). Le companyId vient toujours de la session ; aucun identifiant d'entreprise n'est lu du client.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { parseEuroInputToCents } from "@/lib/billing/money"
import { parseDay } from "@/lib/equipment/equipment.core"
import { CrmAccessError, crmAccessMessage, requireCrmAdmin, type CrmContext } from "@/lib/crm/access"
import { CRM_ERRORS } from "@/lib/crm/crm.core"
import * as svc from "@/lib/crm/crm.service"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const optId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : null }
const reqId = (f: FormData, k: string) => optId(f, k) ?? ""
type Outcome = { ok: true; okMessage: string; redirectTo?: string } | { ok: false; error: string }
// v7 (preuves e3r/e3s) : retour EXPLICITE par état (useActionState, RetourFormulaire) au lieu d'une redirection serveur vers
// « ?ok= » : sans redirection ni revalidation, la réponse de l'action ne porte que ce résultat, rendu par le formulaire sans
// dépendre d'une transition du routeur. Le client demande ensuite l'actualisation (router.refresh) ou ouvre la fiche créée
// (router.push), et signale tant que la page n'est pas rendue après l'action. Signature compatible avec un envoi direct.
async function run(fn: (ctx: CrmContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireCrmAdmin())
  } catch (e) {
    if (e instanceof CrmAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof CrmAccessError) return retour(false, crmAccessMessage(e.reason))
    console.error("[opportunites] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage, result.redirectTo) : retour(false, result.error)
}
/** Jour saisi ; "" → null ; date inexistante → "invalide". */
const day = (raw: string): Date | null | "invalide" => (raw === "" ? null : parseDay(raw) ?? "invalide")
function euros(raw: string): bigint | "invalide" {
  try { const c = parseEuroInputToCents(raw); return c >= BigInt(0) ? c : "invalide" } catch { return "invalide" }
}
/** Probabilité saisie en pour cent (0 à 100, deux décimales au plus) → points de base ; "" → défaut de l'étape. */
function percent(raw: string): number | null | "invalide" {
  if (raw === "") return null
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(raw)
  if (!m) return "invalide"
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"))
  return bp <= 10000 ? bp : "invalide"
}
function readFields(form: FormData) {
  const amount = euros(str(form, "amount", 30)), probability = percent(str(form, "probability", 10))
  const expected = day(str(form, "expectedCloseDate", 10)), followUp = day(str(form, "nextFollowUpDate", 10))
  if (amount === "invalide") return { ok: false as const, error: CRM_ERRORS.amount }
  if (probability === "invalide") return { ok: false as const, error: CRM_ERRORS.probability }
  if (expected === "invalide" || followUp === "invalide") return { ok: false as const, error: CRM_ERRORS.date }
  return {
    ok: true as const,
    value: {
      title: str(form, "title", 1000), clientId: optId(form, "clientId"), prospectName: str(form, "prospectName", 1000) || null, amountCents: amount,
      probabilityBp: probability, expectedCloseDate: expected, nextFollowUpDate: followUp, followUpNote: str(form, "followUpNote", 5000) || null,
      worksiteId: optId(form, "worksiteId"), quoteId: optId(form, "quoteId"), consultationDraftId: optId(form, "consultationDraftId"), ownerEmployeeId: optId(form, "ownerId"),
    },
  }
}
const detail = (id: string) => (id ? `/crm/opportunites/${id}` : "/crm/opportunites")

export async function createOpportunityAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const f = readFields(form)
    if (!f.ok) return f
    const r = await svc.createOpportunity(prisma, ctx, { ...f.value, stage: str(form, "stage", 20) })
    return r.ok ? { ok: true, okMessage: `Opportunité ${r.value.number} créée.`, redirectTo: detail(r.value.id) } : r
  })
}
export async function updateOpportunityAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const id = reqId(form, "opportunityId")   // lu APRÈS le contrôle d'accès (revue Codex v7)
    const f = readFields(form)
    if (!f.ok) return f
    const r = await svc.updateOpportunity(prisma, ctx, id, f.value)
    return r.ok ? { ok: true, okMessage: "Opportunité enregistrée." } : r
  })
}
export async function changeStageAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const id = reqId(form, "opportunityId")   // lu APRÈS le contrôle d'accès (revue Codex v7)
    const r = await svc.changeStage(prisma, ctx, id, str(form, "stage", 20), str(form, "lostReason", 2000) || null)
    return r.ok ? { ok: true, okMessage: "Étape mise à jour." } : r
  })
}
export async function recordFollowUpAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const id = reqId(form, "opportunityId")   // lu APRÈS le contrôle d'accès (revue Codex v7)
    const next = day(str(form, "nextFollowUpDate", 10))
    if (next === "invalide") return { ok: false, error: CRM_ERRORS.date }
    const r = await svc.recordFollowUp(prisma, ctx, id, str(form, "note", 5000), next)
    return r.ok ? { ok: true, okMessage: "Relance enregistrée." } : r
  })
}
export async function addNoteAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const id = reqId(form, "opportunityId")   // lu APRÈS le contrôle d'accès (revue Codex v7)
    const r = await svc.addNote(prisma, ctx, id, str(form, "note", 5000))
    return r.ok ? { ok: true, okMessage: "Note ajoutée." } : r
  })
}
