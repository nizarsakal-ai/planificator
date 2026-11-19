"use server"
// Lot H Planificator V2 : actions serveur de la pré-paie (ADMIN de la société de session, drapeau
// PAYROLL_PREP_ENABLED). Aucun identifiant d'entreprise lu du formulaire ; aucun calcul de paie ni dépôt.
// Portage sur 90ae644 (19/11/2026) :
// - retour EXPLICITE par état (RetourAction, mécanisme qualifié E4 et employé en G) au lieu de revalidatePath + redirection
//   serveur ; le client (FormulaireRetour) ouvre ensuite par une navigation native la fiche de la période créée (cible
//   calculée ICI à partir de l'identifiant rendu par le service) ou rouvre la page courante ; adresses limitées par la
//   liste blanche de retour-action.ts. Seule redirection serveur conservée : /login si la session est absente ;
// - entrées BORNÉES SANS TRONCATURE : une valeur trop longue est refusée, jamais coupée puis validée.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { PrepayAccessError, prepayAccessMessage, requirePrepayAdmin, type PrepayAccessContext } from "@/lib/payroll-prep/access"
import { PREPAY_ERRORS } from "@/lib/payroll-prep/prepay.core"
import * as svc from "@/lib/payroll-prep/prepay.service"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const BASE = "/pre-paie"
/** Valeur texte du champ, sans espaces de bord ; `null` si elle dépasse `max` (refusée, jamais tronquée). */
function champ(f: FormData, k: string, max: number): string | null {
  const v = f.get(k)
  const s = typeof v === "string" ? v.trim() : ""
  return s.length > max ? null : s
}
/** Identifiant borné ; "" si absent, trop long ou hors alphabet (l'entité est alors introuvable pour le service). */
const reqId = (f: FormData, k: string) => { const v = champ(f, k, 64); return v && ID.test(v) ? v : "" }
type Outcome = { ok: true; okMessage: string; cible?: string } | { ok: false; error: string }
/** Fiche d'une période : cible calculée côté serveur depuis l'identifiant rendu par le service. */
const fichePeriode = (periodId: string) => `${BASE}/${periodId}`

async function run(fn: (ctx: PrepayAccessContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requirePrepayAdmin())
  } catch (e) {
    if (e instanceof PrepayAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof PrepayAccessError) return retour(false, prepayAccessMessage(e.reason))
    console.error("[pre-paie] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage, result.cible) : retour(false, result.error)
}

export async function openPeriodAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const m = /^(\d{4})-(\d{2})$/.exec(champ(form, "month", 7) ?? "")
    if (!m) return { ok: false, error: PREPAY_ERRORS.period }
    const r = await svc.openPeriod(prisma, ctx, Number(m[1]), Number(m[2]))
    return r.ok ? { ok: true, okMessage: "Période ouverte.", cible: fichePeriode(r.value.id) } : r
  })
}
export async function addVariableAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const kind = champ(form, "kind", 10), amount = champ(form, "amount", 30), label = champ(form, "label", 120)
    if (kind === null) return { ok: false, error: PREPAY_ERRORS.kind }
    if (amount === null) return { ok: false, error: PREPAY_ERRORS.amount }
    if (label === null) return { ok: false, error: PREPAY_ERRORS.label }
    const r = await svc.addVariable(prisma, ctx, reqId(form, "periodId"), { employeeId: reqId(form, "employeeId"), kind, amount, label })
    return r.ok ? { ok: true, okMessage: "Variable ajoutée." } : r
  })
}
export async function removeVariableAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.removeVariable(prisma, ctx, reqId(form, "variableId"))
    return r.ok ? { ok: true, okMessage: "Variable supprimée." } : r
  })
}
export async function closePeriodAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (champ(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de clôture." }
    const r = await svc.closePeriod(prisma, ctx, reqId(form, "periodId"))
    return r.ok ? { ok: true, okMessage: "Période clôturée : les variables sont figées." } : r
  })
}
