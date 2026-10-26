"use server"
// Server Actions des acomptes (Lot C3) : drapeau + garde de session, zod strict, société de session.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"
import { MoneyError, parseEuroInputToCents, parsePercentToBp } from "@/lib/billing/money"
import { applyDepositDeductions, createDepositInvoice } from "@/lib/billing/invoices/deposit.service"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)

async function run<T>(fn: (ctx: { companyId: string; userId: string }) => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Result<{ value: T }>> {
  try {
    const c = await requireBillingAdmin()
    const r = await fn({ companyId: c.companyId, userId: c.userId })
    if (!r.ok) return { ok: false, error: r.error }
    revalidatePath("/factures", "layout"); revalidatePath("/devis", "layout")
    return { ok: true, value: r.value }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    const message = error instanceof Error ? error.message : ""
    if (/INVOICE_CONFLICT/.test(message)) return { ok: false, error: "La facture a été modifiée entre-temps. Rechargez la page." }
    if (/\b(DEPOSIT_[A-Z_]+)\b/.test(message)) return { ok: false, error: "Opération refusée par les contrôles d'intégrité (plafond des acomptes ou cohérence des déductions)." }
    if (/\b(INVOICE_[A-Z_]+|PAYMENT_[A-Z_]+)\b/.test(message)) return { ok: false, error: "Opération refusée par les contrôles d'intégrité de facturation." }
    console.error("[acomptes] action en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

export async function createDepositAction(quoteId: unknown, raw: unknown): Promise<Result<{ id: string; number: string }>> {
  const id = idSchema.safeParse(quoteId)
  const p = z.object({ mode: z.enum(["PERCENT", "AMOUNT_TTC"]), value: z.string().trim().min(1).max(24) }).strict().safeParse(raw)
  if (!id.success || !p.success) return { ok: false, error: "Demande invalide." }
  let request: { kind: "PERCENT"; bp: number } | { kind: "AMOUNT_TTC"; cents: bigint }
  try {
    request = p.data.mode === "PERCENT" ? { kind: "PERCENT", bp: parsePercentToBp(p.data.value) } : { kind: "AMOUNT_TTC", cents: parseEuroInputToCents(p.data.value) }
  } catch (e) { if (e instanceof MoneyError) return { ok: false, error: "Pourcentage ou montant invalide." }; throw e }
  if (request.kind === "PERCENT" && request.bp === 0) return { ok: false, error: "Le pourcentage doit être supérieur à zéro." }
  const r = await run((ctx) => createDepositInvoice(prisma, ctx, id.data, request, new Date()))
  return r.ok ? { ok: true, id: r.value.id, number: r.value.number } : r
}

export async function applyDepositDeductionsAction(invoiceId: unknown): Promise<Result<{ deposits: number }>> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const r = await run((ctx) => applyDepositDeductions(prisma, ctx, id.data))
  return r.ok ? { ok: true, deposits: r.value.deposits } : r
}
