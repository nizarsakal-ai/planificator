"use server"
// Server Actions des factures (Lot C2) — distinctes de invoice.actions.ts (Lot B, inchangé) : drapeau + garde de session,
// zod strict, companyId de session, service transactionnel, erreurs traduites.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"
import { parseInvoiceForm, parsePaymentForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment, reversePayment, sendInvoiceMail, sendManualReminder, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)

function integrityMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ""
  const code = /\b(INVOICE_[A-Z_]+|CREDIT_NOTE_INVALID|PAYMENT_[A-Z_]+)\b/.exec(message)?.[1]
  if (!code) return null
  if (code === "INVOICE_CONFLICT") return "La facture a été modifiée entre-temps. Rechargez la page."
  if (code === "PAYMENT_EXCEEDS_TOTAL") return "Paiement refusé : le total des paiements dépasserait le montant de la facture."
  if (code.startsWith("PAYMENT_")) return "Paiement refusé par les contrôles d'intégrité."
  return "Opération refusée : une facture émise n'est plus modifiable."
}

async function run<T>(fn: (ctx: { companyId: string; userId: string }) => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Result<{ value: T }>> {
  try {
    const c = await requireBillingAdmin()
    const r = await fn({ companyId: c.companyId, userId: c.userId })
    if (!r.ok) return { ok: false, error: r.error }
    revalidatePath("/factures", "layout"); revalidatePath("/devis", "layout"); revalidatePath("/comptabilite", "layout")
    return { ok: true, value: r.value }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    const mapped = integrityMessage(error)
    if (mapped) return { ok: false, error: mapped }
    console.error("[factures] action en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

export async function createInvoiceC2Action(raw: unknown): Promise<Result<{ id: string; number: string }>> {
  const p = parseInvoiceForm(raw)
  if (!p.ok) return { ok: false, error: p.error }
  const r = await run((ctx) => createDraftInvoice(prisma, ctx, p.value, new Date()))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function updateInvoiceC2Action(invoiceId: unknown, raw: unknown): Promise<Result> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const p = parseInvoiceForm(raw)
  if (!p.ok) return { ok: false, error: p.error }
  const r = await run((ctx) => updateDraftInvoice(prisma, ctx, id.data, p.value))
  return r.ok ? { ok: true } : r
}

export async function issueInvoiceAction(invoiceId: unknown): Promise<Result<{ number: string }>> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const r = await run((ctx) => issueInvoice(prisma, ctx, id.data, new Date()))
  return r.ok ? { ok: true, number: r.value.number } : r
}

export async function sendInvoiceAction(invoiceId: unknown): Promise<Result<{ status: string }>> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const r = await run((ctx) => sendInvoiceMail(prisma, ctx, id.data))
  return r.ok ? { ok: true, status: r.value.status } : r
}

export async function recordPaymentAction(invoiceId: unknown, raw: unknown): Promise<Result<{ status: string; remaining: string }>> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const p = parsePaymentForm(raw)
  if (!p.ok) return { ok: false, error: p.error }
  const r = await run((ctx) => recordPayment(prisma, ctx, id.data, p.value, new Date()))
  return r.ok ? { ok: true, status: r.value.status, remaining: r.value.remainingCents.toString() } : r
}

export async function reversePaymentAction(paymentId: unknown, reason: unknown): Promise<Result<{ status: string }>> {
  const id = idSchema.safeParse(paymentId)
  if (!id.success) return { ok: false, error: "Paiement introuvable." }
  const motive = typeof reason === "string" ? reason.trim().slice(0, 500) : ""
  const r = await run((ctx) => reversePayment(prisma, ctx, id.data, motive || null, new Date()))
  return r.ok ? { ok: true, status: r.value.status } : r
}

export async function sendInvoiceReminderAction(invoiceId: unknown): Promise<Result<{ status: string }>> {
  const id = idSchema.safeParse(invoiceId)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  const r = await run((ctx) => sendManualReminder(prisma, ctx, id.data, new Date()))
  return r.ok ? { ok: true, status: r.value.status } : r
}
