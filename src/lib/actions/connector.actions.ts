"use server"
// Lot F Planificator V2 : actions serveur du centre de connecteurs (ADMIN de la société de session, drapeau
// CONNECTOR_CENTER_ENABLED). Deux modes seulement (désactivé, simulation) ; la synchronisation utilise le double fictif
// (aucun appel réseau). Aucune action ne reçoit ni n'enregistre d'identifiant de connexion.
// v3 (recette Chrome F v2) : retour EXPLICITE par état, comme le lot E (useActionState, RetourFormulaire) au lieu de
// revalidatePath + redirect : la réponse de l'action ne porte que son résultat ; après un SUCCÈS, le client rouvre
// « /connecteurs?ok=… » par une navigation NATIVE du document (correctif E4, adresseApresSucces) ; une erreur reste affichée
// sur place. Gardes serveur et messages métier inchangés. Signature compatible avec un envoi sans état préalable.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { ConnectorAccessError, connectorAccessMessage, requireConnectorAdmin, type ConnectorAccessContext } from "@/lib/connectors/access"
import * as svc from "@/lib/connectors/connectors.service"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const str = (f: FormData, k: string, max = 40) => String(f.get(k) ?? "").trim().slice(0, max)
type Outcome = { ok: true; okMessage: string } | { ok: false; error: string }
async function run(fn: (ctx: ConnectorAccessContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireConnectorAdmin())
  } catch (e) {
    if (e instanceof ConnectorAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof ConnectorAccessError) return retour(false, connectorAccessMessage(e.reason))
    console.error("[connecteurs] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage) : retour(false, result.error)
}

export async function setConnectorModeAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const mode = str(form, "mode", 20)
    const r = await svc.setConnectorMode(prisma, ctx, str(form, "connectorKey"), mode)
    return r.ok ? { ok: true, okMessage: mode === "SIMULATION" ? "Simulation activée : données fictives seulement, aucune connexion réelle." : "Connecteur désactivé." } : r
  })
}
export async function syncConnectorAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.runConnectorSync(prisma, ctx, str(form, "connectorKey"))
    return r.ok ? { ok: true, okMessage: `Synchronisation simulée : ${r.value.received} reçu(s), ${r.value.created} nouveau(x), ${r.value.updated} modifié(s), ${r.value.unchanged} inchangé(s).` } : r
  })
}
export async function resetConnectorWatermarkAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de réinitialisation." }
    const r = await svc.resetConnectorWatermark(prisma, ctx, str(form, "connectorKey"))
    return r.ok ? { ok: true, okMessage: "C'est noté : la prochaine synchronisation relira toutes les données depuis le début, sans créer de doublon." } : r
  })
}
