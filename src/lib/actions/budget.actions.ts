"use server"
// Lot C Planificator V2 : actions serveur des budgets chantier et des imputations de factures fournisseurs (ADMIN de
// la société de session, drapeau WORKSITE_BUDGET_ENABLED). Formulaires HTML simples : chaque action redirige vers la
// page avec un message (`?ok=` ou `?erreur=`). Le companyId vient toujours de la session ; aucun identifiant
// d'entreprise n'est lu du client.
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { parseEuroInputToCents } from "@/lib/billing/money"
import { BudgetAccessError, budgetAccessMessage, requireBudgetAdmin, type BudgetContext } from "@/lib/budget/access"
import { COST_NATURES, type BudgetLineInput } from "@/lib/budget/budget.core"
import * as svc from "@/lib/budget/budget.service"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const reqId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : "" }

/** Montant en euros saisi → centimes ; "" → 0 ; invalide ou négatif → "invalide". */
function euros(raw: string): bigint | "invalide" {
  try {
    const c = parseEuroInputToCents(raw)
    return c >= BigInt(0) ? c : "invalide"
  } catch { return "invalide" }
}

type Outcome = { ok: true; okMessage: string } | { ok: false; error: string }

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString()
  redirect(`${path}${q ? `?${q}` : ""}`)
}

/** Exécute une action protégée ; convertit refus d'accès et erreurs métier en message, jamais de détail technique. */
async function run(path: string, fn: (ctx: BudgetContext) => Promise<Outcome>): Promise<never> {
  let result: Outcome
  try {
    const ctx = await requireBudgetAdmin()
    result = await fn(ctx)
  } catch (e) {
    if (e instanceof BudgetAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof BudgetAccessError) back(path, { erreur: budgetAccessMessage(e.reason) })
    console.error("[budgets] action en échec", e instanceof Error ? e.name : "erreur")
    back(path, { erreur: "Opération impossible pour le moment." })
  }
  if (!result.ok) back(path, { erreur: result.error })
  revalidatePath("/budgets", "layout")
  back(path, { ok: result.okMessage })
}
const pathOf = (worksiteId: string) => (worksiteId ? `/budgets/${worksiteId}` : "/budgets")

/** Lit la recette prévue et un montant (et un libellé facultatif) par nature ; toute saisie invalide est refusée. */
function readVersion(form: FormData): { ok: true; plannedRevenueCents: bigint; lines: BudgetLineInput[] } | { ok: false; error: string } {
  const revenue = euros(str(form, "plannedRevenue", 30))
  if (revenue === "invalide") return { ok: false, error: "Recette prévue invalide." }
  const lines: BudgetLineInput[] = []
  for (const nature of COST_NATURES) {
    const amount = euros(str(form, `amount_${nature}`, 30))
    if (amount === "invalide") return { ok: false, error: "Montant de budget invalide." }
    lines.push({ nature, amountCents: amount, label: str(form, `label_${nature}`, 1000) || null })
  }
  return { ok: true, plannedRevenueCents: revenue, lines }
}

export async function createBudgetAction(form: FormData) {
  const worksiteId = reqId(form, "worksiteId")
  return run(pathOf(worksiteId), async (ctx) => {
    const v = readVersion(form)
    if (!v.ok) return v
    const r = await svc.createBudget(prisma, ctx, { worksiteId, plannedRevenueCents: v.plannedRevenueCents, lines: v.lines })
    return r.ok ? { ok: true, okMessage: "Budget initial enregistré (version 1)." } : r
  })
}

export async function reviseBudgetAction(form: FormData) {
  const worksiteId = reqId(form, "worksiteId")
  return run(pathOf(worksiteId), async (ctx) => {
    const v = readVersion(form)
    if (!v.ok) return v
    const expected = Number.parseInt(str(form, "expectedRevision", 10), 10)
    const r = await svc.reviseBudget(prisma, ctx, { worksiteId, plannedRevenueCents: v.plannedRevenueCents, lines: v.lines, expectedRevision: Number.isSafeInteger(expected) ? expected : -1, reason: str(form, "reason", 2000) })
    return r.ok ? { ok: true, okMessage: `Révision ${r.value.revision} enregistrée ; les versions précédentes sont conservées.` } : r
  })
}

export async function allocateSupplierInvoiceAction(form: FormData) {
  const worksiteId = reqId(form, "worksiteId")
  return run(pathOf(worksiteId), async (ctx) => {
    const amount = euros(str(form, "amount", 30))
    if (amount === "invalide" || amount === BigInt(0)) return { ok: false, error: "Montant HT à imputer invalide." }
    const r = await svc.allocateSupplierInvoice(prisma, ctx, { supplierInvoiceId: reqId(form, "supplierInvoiceId"), worksiteId, nature: str(form, "nature", 20), amountHTCents: amount, label: str(form, "label", 1000) || null })
    return r.ok ? { ok: true, okMessage: "Facture fournisseur imputée au chantier." } : r
  })
}

export async function cancelAllocationAction(form: FormData) {
  const worksiteId = reqId(form, "worksiteId")
  return run(pathOf(worksiteId), async (ctx) => {
    const r = await svc.cancelAllocation(prisma, ctx, reqId(form, "allocationId"), worksiteId)
    return r.ok ? { ok: true, okMessage: "Imputation annulée (conservée dans l'historique)." } : r
  })
}
