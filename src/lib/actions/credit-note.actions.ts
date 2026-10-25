"use server"
// Server Actions des avoirs partiels (Lot C4) : drapeau + garde de session, zod strict, société de session.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"
import { MoneyError, parseEuroInputToCents, parseQuantityToHundredths } from "@/lib/billing/money"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import type { CreditRequest } from "@/lib/billing/invoices/credit-note.core"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)
const schema = z.object({
  mode: z.enum(["LINES", "AMOUNT_HT"]),
  reason: z.string().trim().min(3, "Motif obligatoire (3 caractères minimum)").max(500),
  amount: z.string().trim().max(24).optional(),
  items: z.array(z.object({ lineId: idSchema, quantity: z.string().trim().max(20) }).strict()).max(200).optional(),
}).strict()

export async function createPartialCreditNoteAction(invoiceId: unknown, raw: unknown): Promise<Result<{ id: string; number: string; originStatus: string }>> {
  const id = idSchema.safeParse(invoiceId)
  const p = schema.safeParse(raw)
  if (!id.success) return { ok: false, error: "Facture introuvable." }
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Demande invalide." }
  let request: CreditRequest
  try {
    if (p.data.mode === "AMOUNT_HT") request = { kind: "AMOUNT_HT", cents: parseEuroInputToCents(p.data.amount ?? "") }
    else request = { kind: "LINES", items: (p.data.items ?? []).filter((i) => i.quantity.trim() !== "" && i.quantity.trim() !== "0").map((i) => ({ lineId: i.lineId, quantityHundredths: parseQuantityToHundredths(i.quantity) })) }
  } catch (e) { if (e instanceof MoneyError) return { ok: false, error: "Montant ou quantité invalide." }; throw e }
  try {
    const c = await requireBillingAdmin()
    const r = await createPartialCreditNote(prisma, { companyId: c.companyId, userId: c.userId }, id.data, request, p.data.reason, new Date())
    if (!r.ok) return { ok: false, error: r.error }
    revalidatePath("/factures", "layout"); revalidatePath("/comptabilite", "layout")
    return { ok: true, id: r.value.id, number: r.value.number, originStatus: r.value.originStatus }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    const message = error instanceof Error ? error.message : ""
    if (/PARTIAL_CREDIT_EXCEEDS/.test(message)) return { ok: false, error: "L'avoir dépasse le montant restant créditable." }
    if (/\b(PARTIAL_CREDIT_[A-Z_]+|CREDIT_NOTE_[A-Z_]+|INVOICE_[A-Z_]+|PAYMENT_[A-Z_]+)\b/.test(message)) return { ok: false, error: "Avoir refusé par les contrôles d'intégrité." }
    console.error("[avoirs] action en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}
