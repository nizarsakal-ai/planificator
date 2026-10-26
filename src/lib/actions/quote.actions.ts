"use server"
// Server Actions des devis (SPEC-BILLING-C1) : minces — drapeau + garde de session, zod strict, companyId de session,
// service transactionnel, erreurs traduites. Jamais de companyId reçu du client.
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, requireBillingAdmin } from "@/lib/billing/access"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { hashIp } from "@/lib/billing/quotes/quote-signature"
import {
  acceptQuoteManually, convertQuote, createQuote, deleteDraftQuote, duplicateQuote, expireQuote, importQuotes,
  refuseQuote, refuseQuoteByToken, sendQuote, signQuoteByToken, updateQuote, type ImportReport,
} from "@/lib/billing/quotes/quote.service"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)

/** Invariant PostgreSQL de facturation refusé ⇒ message lisible (jamais d'erreur brute). */
function integrityMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ""
  return /\b(INVOICE_[A-Z_]+|CREDIT_NOTE_INVALID)\b/.test(message) ? "Opération refusée par les contrôles d'intégrité de facturation." : null
}

async function run<T>(fn: (ctx: { companyId: string; userId: string }) => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Result<{ value: T }>> {
  try {
    const c = await requireBillingAdmin()
    const r = await fn({ companyId: c.companyId, userId: c.userId })
    if (!r.ok) return { ok: false, error: r.error }
    revalidatePath("/devis", "layout")
    revalidatePath("/factures", "layout")
    return { ok: true, value: r.value }
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    const mapped = integrityMessage(error)
    if (mapped) return { ok: false, error: mapped }
    console.error("[devis] action en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

export async function createQuoteAction(raw: unknown): Promise<Result<{ id: string; number: string }>> {
  const p = parseQuoteForm(raw)
  if (!p.ok) return { ok: false, error: p.error }
  const r = await run((ctx) => createQuote(prisma, ctx, p.value))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function updateQuoteAction(quoteId: unknown, raw: unknown): Promise<Result> {
  const id = idSchema.safeParse(quoteId)
  if (!id.success) return { ok: false, error: "Devis introuvable." }
  const p = parseQuoteForm(raw)
  if (!p.ok) return { ok: false, error: p.error }
  const r = await run((ctx) => updateQuote(prisma, ctx, id.data, p.value))
  return r.ok ? { ok: true } : r
}

export async function deleteDraftQuoteAction(quoteId: unknown): Promise<Result> {
  const id = idSchema.safeParse(quoteId)
  if (!id.success) return { ok: false, error: "Devis introuvable." }
  const r = await run((ctx) => deleteDraftQuote(prisma, ctx, id.data))
  return r.ok ? { ok: true } : r
}

export async function duplicateQuoteAction(quoteId: unknown): Promise<Result<{ id: string; number: string }>> {
  const id = idSchema.safeParse(quoteId)
  if (!id.success) return { ok: false, error: "Devis introuvable." }
  const r = await run((ctx) => duplicateQuote(prisma, ctx, id.data, new Date()))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function sendQuoteAction(quoteId: unknown): Promise<Result<{ status: string }>> {
  const id = idSchema.safeParse(quoteId)
  if (!id.success) return { ok: false, error: "Devis introuvable." }
  const r = await run((ctx) => sendQuote(prisma, ctx, id.data, new Date()))
  return r.ok ? { ok: true, status: r.value.status } : r
}

export async function quoteStatusAction(quoteId: unknown, to: unknown, reason?: unknown): Promise<Result> {
  const id = idSchema.safeParse(quoteId)
  const t = z.enum(["ACCEPTED", "REFUSED", "EXPIRED"]).safeParse(to)
  if (!id.success || !t.success) return { ok: false, error: "Demande invalide." }
  const motive = typeof reason === "string" ? reason.trim().slice(0, 500) : ""
  const now = new Date()
  const r = await run((ctx) =>
    t.data === "ACCEPTED" ? acceptQuoteManually(prisma, ctx, id.data, now)
    : t.data === "REFUSED" ? refuseQuote(prisma, ctx, id.data, motive || null, now)
    : expireQuote(prisma, ctx, id.data, now))
  return r.ok ? { ok: true } : r
}

export async function convertQuoteAction(quoteId: unknown): Promise<Result<{ invoiceId: string; invoiceNumber: string; existing: boolean }>> {
  const id = idSchema.safeParse(quoteId)
  if (!id.success) return { ok: false, error: "Devis introuvable." }
  const r = await run((ctx) => convertQuote(prisma, ctx, id.data, new Date()))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function importQuotesAction(text: unknown): Promise<Result<{ report: ImportReport }>> {
  const t = z.string().max(1_100_000).safeParse(text)
  if (!t.success) return { ok: false, error: "Fichier invalide." }
  const r = await run(async (ctx) => ({ ok: true as const, value: await importQuotes(prisma, ctx, t.data, new Date()) }))
  return r.ok ? { ok: true, report: r.value } : r
}

// ─── Actions publiques de signature (aucune session ; le jeton est la seule autorité) ───

async function clientIpHash(): Promise<string | null> {
  try {
    const h = await headers()
    const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")
    return hashIp(fwd)
  } catch { return null }
}

export async function signQuoteAction(token: unknown, raw: unknown): Promise<Result> {
  if (!isBillingCompleteEnabled()) return { ok: false, error: "Fonctionnalité indisponible." }
  const p = z.object({ signerName: z.string().trim().min(2).max(120), approved: z.literal(true) }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Indiquez votre nom et cochez la case d'approbation." }
  try {
    const r = await signQuoteByToken(prisma, token, { signerName: p.data.signerName, ipHash: await clientIpHash(), now: new Date() })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  } catch (error) {
    console.error("[devis] signature en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

export async function refuseQuotePublicAction(token: unknown, raw: unknown): Promise<Result> {
  if (!isBillingCompleteEnabled()) return { ok: false, error: "Fonctionnalité indisponible." }
  const p = z.object({ reason: z.string().trim().max(500).optional() }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  try {
    const r = await refuseQuoteByToken(prisma, token, { reason: p.data.reason ?? null, now: new Date() })
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  } catch (error) {
    console.error("[devis] refus en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}
