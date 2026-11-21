"use server"
// 21/11/2026 — actions des documents commerciaux (bons de commande clients, bons de livraison). Enveloppes fines :
// drapeau + garde facturation (ADMIN/SUPER_ADMIN, société de session), zod strict ; la logique est dans les services.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin, type BillingContext } from "@/lib/billing/access"
import { cancelClientOrder, createClientOrderFromQuote } from "@/lib/billing/commercial/client-order.service"
import { cancelDeliveryNote, createDeliveryNote, recordDeliveryReceipt } from "@/lib/billing/commercial/delivery-note.service"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const id = z.string().trim().min(1).max(64)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), "Date invalide")
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)
const optText = (max: number) => z.string().max(max).optional().transform((v) => (v && v.trim() ? v.trim() : null))

async function run<T>(fn: (ctx: BillingContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn(await requireBillingAdmin())
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    console.error("[documents commerciaux] action échouée", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Une erreur est survenue. Réessayez." }
  }
}

const orderSchema = z.object({ quoteId: id, issueDate: day, expectedDeliveryDate: z.union([day, z.literal("")]).optional(), deliveryAddress: optText(500), notes: optText(2000) }).strict()
export async function createClientOrderAction(raw: unknown): Promise<Result<{ id: string; number: string }>> {
  const p = orderSchema.safeParse(raw)
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Saisie invalide." }
  return run(async (ctx) => {
    const r = await createClientOrderFromQuote(prisma, ctx, p.data.quoteId, {
      issueDate: toDate(p.data.issueDate), expectedDeliveryDate: p.data.expectedDeliveryDate ? toDate(p.data.expectedDeliveryDate) : null, deliveryAddress: p.data.deliveryAddress, notes: p.data.notes,
    })
    if (!r.ok) return r
    revalidatePath(`/devis/${p.data.quoteId}`); revalidatePath("/bons-de-commande")
    return { ok: true, ...r.value }
  })
}

export async function cancelClientOrderAction(orderId: unknown): Promise<Result> {
  const p = id.safeParse(orderId)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await cancelClientOrder(prisma, ctx, p.data, new Date())
    if (!r.ok) return r
    revalidatePath(`/bons-de-commande/${p.data}`); revalidatePath("/bons-de-commande")
    return { ok: true }
  })
}

const deliverySchema = z.object({
  sourceType: z.enum(["QUOTE", "INVOICE", "CLIENT_ORDER"]), sourceId: id, deliveryDate: day, deliveryAddress: optText(500), notes: optText(2000),
  delivered: z.array(z.string().max(20)).min(1).max(200),
}).strict()
export async function createDeliveryNoteAction(raw: unknown): Promise<Result<{ id: string; number: string }>> {
  const p = deliverySchema.safeParse(raw)
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Saisie invalide." }
  return run(async (ctx) => {
    const r = await createDeliveryNote(prisma, ctx, p.data.sourceType, p.data.sourceId, { deliveryDate: toDate(p.data.deliveryDate), deliveryAddress: p.data.deliveryAddress, notes: p.data.notes, delivered: p.data.delivered })
    if (!r.ok) return r
    revalidatePath("/bons-de-livraison")
    return { ok: true, ...r.value }
  })
}

const receiptSchema = z.object({ noteId: id, receivedByName: z.string().trim().min(1, "Nom du destinataire obligatoire.").max(120), receivedAt: day }).strict()
export async function recordDeliveryReceiptAction(raw: unknown): Promise<Result> {
  const p = receiptSchema.safeParse(raw)
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Saisie invalide." }
  return run(async (ctx) => {
    const r = await recordDeliveryReceipt(prisma, ctx, p.data.noteId, p.data.receivedByName, toDate(p.data.receivedAt))
    if (!r.ok) return r
    revalidatePath(`/bons-de-livraison/${p.data.noteId}`); revalidatePath("/bons-de-livraison")
    return { ok: true }
  })
}

export async function cancelDeliveryNoteAction(noteId: unknown): Promise<Result> {
  const p = id.safeParse(noteId)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await cancelDeliveryNote(prisma, ctx, p.data, new Date())
    if (!r.ok) return r
    revalidatePath(`/bons-de-livraison/${p.data}`); revalidatePath("/bons-de-livraison")
    return { ok: true }
  })
}
