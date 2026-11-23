"use server"
// Lot D Planificator V2 : actions serveur des réserves et des procès-verbaux (ADMIN de la société de session, drapeau
// WORKSITE_RESERVES_ENABLED). Formulaires HTML simples : chaque action redirige vers la page avec un message
// (`?ok=` ou `?erreur=`). Le companyId vient toujours de la session ; aucun identifiant d'entreprise n'est lu du client.
// Correctif « retour d'état » (réserve : création, levée, annulation) : avec JavaScript, l'action RENVOIE le message au
// formulaire (sans redirection vers la même page) ; sans JavaScript (champ `_retour` absent), redirection inchangée.
// Autorisation, service, transaction, messages et revalidation identiques dans les deux cas (execute()).
// Extension PV : le procès-verbal suit le même retour d'état (createReceptionReportFormAction) ; service, contrôle de la
// signature et message inchangés ; sans JavaScript, redirection inchangée.
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { ReserveAccessError, requireReserveAdmin, reserveAccessMessage, type ReserveContext } from "@/lib/reserves/access"
import { parseDay } from "@/lib/equipment/equipment.core"
import { MAX_FILES_PER_ACTION, RESERVE_ERRORS } from "@/lib/reserves/reserves.core"
import * as svc from "@/lib/reserves/reserves.service"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_TOTAL_UPLOAD = 15_000_000 // sous la limite serveur des actions (20 Mo)
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const reqId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : "" }

type Outcome = { ok: true; okMessage: string } | { ok: false; error: string }
/** État renvoyé aux formulaires de réserve (même texte que les paramètres `?ok=` / `?erreur=`). */
export type ReserveFormState = { ok: string } | { erreur: string } | null
type Work = { path: string; fn: (ctx: ReserveContext) => Promise<Outcome> }
function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString()
  redirect(`${path}${q ? `?${q}` : ""}`)
}
/** Exécution commune : autorisation, travail métier, messages et revalidation (inchangés) ; seule la sortie diffère. */
async function execute(fn: Work["fn"]): Promise<{ ok: string } | { erreur: string }> {
  let result: Outcome
  try {
    const ctx = await requireReserveAdmin()
    result = await fn(ctx)
  } catch (e) {
    if (e instanceof ReserveAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof ReserveAccessError) return { erreur: reserveAccessMessage(e.reason) }
    console.error("[reserves] action en échec", e instanceof Error ? e.name : "erreur")
    return { erreur: "Opération impossible pour le moment." }
  }
  if (!result.ok) return { erreur: result.error }
  revalidatePath("/reserves", "layout")
  return { ok: result.okMessage }
}
async function run(path: string, fn: Work["fn"]): Promise<never> {
  back(path, await execute(fn))
}
/** Avec JavaScript (champ `_retour` posé après hydratation) : état renvoyé ; sinon : redirection comme `run`. */
async function respond(form: FormData, w: Work): Promise<ReserveFormState> {
  const state = await execute(w.fn)
  if (form.get("_retour") !== "etat") back(w.path, state)
  return state
}
const pathOf = (worksiteId: string) => (worksiteId ? `/reserves/${worksiteId}` : "/reserves")

/** Fichiers joints (champ « files ») : vides ignorés ; nombre et volume total bornés avant toute lecture du contenu. */
async function readFiles(form: FormData): Promise<svc.UploadedFile[] | "trop"> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length > MAX_FILES_PER_ACTION || files.reduce((t, f) => t + f.size, 0) > MAX_TOTAL_UPLOAD) return "trop"
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
}

function createReserveWork(form: FormData): Work {
  const worksiteId = reqId(form, "worksiteId")
  return { path: pathOf(worksiteId), fn: async (ctx) => {
    const files = await readFiles(form)
    if (files === "trop") return { ok: false, error: RESERVE_ERRORS.tooManyFiles }
    const dueRaw = str(form, "dueDate", 10)
    const dueDate = dueRaw ? parseDay(dueRaw) : null
    if (dueRaw && !dueDate) return { ok: false, error: RESERVE_ERRORS.dueDate }
    const r = await svc.createReserve(prisma, ctx, {
      worksiteId, title: str(form, "title", 1000), location: str(form, "location", 1000), description: str(form, "description", 10000) || null,
      severity: str(form, "severity", 20), dueDate, assigneeLabel: str(form, "assigneeLabel", 1000) || null,
    }, files)
    return r.ok ? { ok: true, okMessage: `Réserve ${r.value.number} enregistrée.` } : r
  } }
}
export async function createReserveAction(form: FormData) { const w = createReserveWork(form); return run(w.path, w.fn) }
export async function createReserveFormAction(_previous: ReserveFormState, form: FormData) { return respond(form, createReserveWork(form)) }

function liftReserveWork(form: FormData): Work {
  const worksiteId = reqId(form, "worksiteId")
  return { path: pathOf(worksiteId), fn: async (ctx) => {
    const files = await readFiles(form)
    if (files === "trop") return { ok: false, error: RESERVE_ERRORS.tooManyFiles }
    const r = await svc.liftReserve(prisma, ctx, reqId(form, "reserveId"), str(form, "note", 5000), files)
    return r.ok ? { ok: true, okMessage: "Réserve levée." } : r
  } }
}
export async function liftReserveAction(form: FormData) { const w = liftReserveWork(form); return run(w.path, w.fn) }
export async function liftReserveFormAction(_previous: ReserveFormState, form: FormData) { return respond(form, liftReserveWork(form)) }

function cancelReserveWork(form: FormData): Work {
  const worksiteId = reqId(form, "worksiteId")
  return { path: pathOf(worksiteId), fn: async (ctx) => {
    const r = await svc.cancelReserve(prisma, ctx, reqId(form, "reserveId"), str(form, "reason", 2000))
    return r.ok ? { ok: true, okMessage: "Réserve annulée (conservée dans l'historique)." } : r
  } }
}
export async function cancelReserveAction(form: FormData) { const w = cancelReserveWork(form); return run(w.path, w.fn) }
export async function cancelReserveFormAction(_previous: ReserveFormState, form: FormData) { return respond(form, cancelReserveWork(form)) }

function createReceptionReportWork(form: FormData): Work {
  const worksiteId = reqId(form, "worksiteId")
  return { path: pathOf(worksiteId), fn: async (ctx) => {
    const day = str(form, "receptionDate", 10)
    const r = await svc.createReceptionReport(prisma, ctx, {
      worksiteId, decision: str(form, "decision", 30), receptionDate: day ? parseDay(day) : null,
      clientSignerName: str(form, "clientSignerName", 1000), companySignerName: str(form, "companySignerName", 1000),
      attendees: str(form, "attendees", 5000) || null, remarks: str(form, "remarks", 10000) || null,
      signatureDataUrl: str(form, "signature", 450_000),
    })
    return r.ok ? { ok: true, okMessage: `Procès-verbal ${r.value.number} signé et figé.` } : r
  } }
}
export async function createReceptionReportAction(form: FormData) { const w = createReceptionReportWork(form); return run(w.path, w.fn) }
export async function createReceptionReportFormAction(_previous: ReserveFormState, form: FormData) { return respond(form, createReceptionReportWork(form)) }
