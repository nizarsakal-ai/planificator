"use server"
// Lot F Planificator V2 : actions serveur de l'assistant (ADMIN de la société de session, drapeau ASSISTANT_ENABLED).
// « Analyser » ne fait que PROPOSER ; seule l'approbation explicite (case cochée) crée une tâche interne.
// Intégration FGHI v2 (incident Chrome, cinq drapeaux actifs) : retour EXPLICITE par état, sur le modèle exact des
// Connecteurs (v3) et du lot E (useActionState, RetourFormulaire), au lieu de revalidatePath + redirect : la réponse de
// l'action ne porte que son résultat ; après un SUCCÈS, le client rouvre « /assistant?ok=… » par une navigation NATIVE du
// document (correctif E4, adresseApresSucces) ; une erreur reste affichée sur place. Aucune cible explicite. Gardes
// serveur, approbation explicite, sources activées et messages métier inchangés. Signature compatible avec un envoi
// sans état préalable.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { AssistantAccessError, assistantAccessMessage, requireAssistantAdmin, type AssistantAccessContext } from "@/lib/assistant/access"
import * as svc from "@/lib/assistant/assistant.service"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const reqId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : "" }
type Outcome = { ok: true; okMessage: string } | { ok: false; error: string }
async function run(fn: (ctx: AssistantAccessContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireAssistantAdmin())
  } catch (e) {
    if (e instanceof AssistantAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof AssistantAccessError) return retour(false, assistantAccessMessage(e.reason))
    console.error("[assistant] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage) : retour(false, result.error)
}

/** Modules sources activés : pipeline commercial (lot E) et stock (lot A) ; règle réserves reportée avec le lot D.
 *  Même décision à la génération et à l'approbation. */
const enabledSources = (): svc.EnabledSources => ({ crm: isCrmEnabled(), stock: isStockPurchasingEnabled() })

/** Aucun champ lu : l'état précédent et le formulaire (signature useActionState) sont acceptés puis ignorés. */
export async function analyseAction(a?: RetourAction | FormData, b?: FormData) {
  void a
  void b
  return run(async (ctx) => {
    // Sources lues seulement si leur module est activé.
    const r = await svc.generateProposals(prisma, ctx, enabledSources())
    return r.ok ? { ok: true, okMessage: `Analyse terminée : ${r.value.proposed} nouvelle(s) proposition(s), ${r.value.alreadyKnown} déjà connue(s). Rien n'est fait sans votre approbation.` } : r
  })
}
export async function approveProposalAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation d'approbation." }
    // Module source désactivé : refus explicite avant toute lecture de la source, proposition laissée en attente.
    const r = await svc.approveProposal(prisma, ctx, reqId(form, "proposalId"), { title: str(form, "title", 1000), dueDate: str(form, "dueDate", 20), assigneeId: reqId(form, "assigneeId") || null }, undefined, enabledSources())
    if (!r.ok) return r
    return r.value.executed ? { ok: true, okMessage: "Proposition approuvée : tâche créée." } : { ok: false, error: "Les sources ne justifient plus cette proposition : elle est déclarée périmée, aucune tâche n'a été créée." }
  })
}
export async function rejectProposalAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.rejectProposal(prisma, ctx, reqId(form, "proposalId"), str(form, "note", 1000) || null)
    return r.ok ? { ok: true, okMessage: "Proposition refusée : elle ne sera plus proposée." } : r
  })
}
