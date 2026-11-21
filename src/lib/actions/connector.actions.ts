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
import { isConnectorLiveEnabled } from "@/lib/connectors/connector-feature-flag"
import { isLiveConnectorKey } from "@/lib/connectors/connectors.core"
import { configureLiveConnector, loadLiveStatus, revokeLiveConnector } from "@/lib/integration/connectors/live/live-connection.service"
import { LIVE_FIELDS } from "@/lib/integration/connectors/live/live-catalog"
import { runLiveConnectorSync } from "@/lib/integration/connectors/live/live-sync.service"
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
    const key = str(form, "connectorKey")
    // LOT-8B : la connexion réelle exige le drapeau ET des identifiants vérifiés (la base revérifie la connexion liée).
    const liveAllowed = mode === "LIVE" && isConnectorLiveEnabled() && isLiveConnectorKey(key) && (await loadLiveStatus(prisma, ctx.companyId))[key].usable
    const r = await svc.setConnectorMode(prisma, ctx, key, mode, undefined, { liveAllowed })
    const okMessage = mode === "SIMULATION" ? "Simulation activée : données fictives seulement, aucune connexion réelle." : mode === "LIVE" ? "Connexion réelle activée : lecture seule, les données reçues sont mises de côté sans toucher à vos données." : "Connecteur désactivé."
    return r.ok ? { ok: true, okMessage } : r
  })
}
export async function syncConnectorAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const key = str(form, "connectorKey")
    const live = isLiveConnectorKey(key) && (await svc.readConnectorSetting(prisma, ctx, key))?.mode === "LIVE"
    if (live && !isConnectorLiveEnabled()) return { ok: false, error: "Connexion réelle désactivée sur ce serveur." }
    const r = live ? await runLiveConnectorSync(prisma, ctx, key) : await svc.runConnectorSync(prisma, ctx, key)
    return r.ok ? { ok: true, okMessage: `Synchronisation ${live ? "réelle" : "simulée"} : ${r.value.received} reçu(s), ${r.value.created} nouveau(x), ${r.value.updated} modifié(s), ${r.value.unchanged} inchangé(s).` } : r
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

// LOT-8B : identifiants des connexions réelles. Le secret transite seulement de ce formulaire vers le coffre chiffré ;
// il n'est jamais renvoyé ni réaffiché (seul l'indice de 4 caractères l'est).
export async function configureLiveConnectorAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (!isConnectorLiveEnabled()) return { ok: false, error: "Connexion réelle désactivée sur ce serveur." }
    const key = str(form, "connectorKey")
    if (!isLiveConnectorKey(key)) return { ok: false, error: "Connecteur inconnu." }
    const fields: Record<string, string> = {}
    for (const f of LIVE_FIELDS[key]) fields[f.name] = str(form, f.name, 300)
    const r = await configureLiveConnector(prisma, ctx, key, fields)
    return r.ok ? { ok: true, okMessage: `Identifiants vérifiés et enregistrés chiffrés (se terminant par ${r.value.hint ?? "····"}). Vous pouvez activer la connexion réelle.` } : r
  })
}
export async function revokeLiveConnectorAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de révocation." }
    const r = await revokeLiveConnector(prisma, ctx, str(form, "connectorKey"))
    return r.ok ? { ok: true, okMessage: "Identifiants révoqués : le connecteur ne contacte plus le service." } : r
  })
}
