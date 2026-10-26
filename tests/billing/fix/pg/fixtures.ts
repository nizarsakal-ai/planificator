// Parcours synthétiques réutilisés par les tests des correctifs : devis → acceptation → acomptes → facture de solde → émission.
import type { PrismaClient } from "@prisma/client"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, convertQuote, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice } from "@/lib/billing/invoices/invoice.service"
import { createDepositInvoice } from "@/lib/billing/invoices/deposit.service"
import type { DepositRequest } from "@/lib/billing/invoices/deposit.core"
import { NOW } from "./helpers"

type Ctx = { companyId: string; userId: string }
export type QuoteLineForm = { designation: string; quantity: string; unitPrice: string; vatRate: string; discount?: string; unit?: string }

export async function acceptedQuote(db: PrismaClient, ctx: Ctx, worksiteId: string, lines: QuoteLineForm[], opts: { globalDiscount?: string; vatReverseCharge?: boolean; validUntil?: string; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? NOW
  const p = parseQuoteForm({ worksiteId, issueDate: now.toISOString().slice(0, 10), validUntil: opts.validUntil ?? "2026-12-31", lines, globalDiscount: opts.globalDiscount ?? "", vatReverseCharge: opts.vatReverseCharge ?? false })
  if (!p.ok) throw new Error(p.error)
  const q = await createQuote(db, ctx, p.value); if (!q.ok) throw new Error(q.error)
  const s = await sendQuote(db, ctx, q.value.id, now); if (!s.ok) throw new Error(s.error)
  const a = await acceptQuoteManually(db, ctx, q.value.id, now); if (!a.ok) throw new Error(a.error)
  return q.value.id
}

export async function issuedDeposit(db: PrismaClient, ctx: Ctx, quoteId: string, request: DepositRequest, now: Date = NOW): Promise<string> {
  const d = await createDepositInvoice(db, ctx, quoteId, request, now); if (!d.ok) throw new Error(d.error)
  const r = await issueInvoice(db, ctx, d.value.id, now); if (!r.ok) throw new Error(r.error)
  return d.value.id
}

/** Facture de solde (brouillon) issue de la conversion, déductions des acomptes émis appliquées. */
export async function finalDraft(db: PrismaClient, ctx: Ctx, quoteId: string, now: Date = NOW): Promise<string> {
  const c = await convertQuote(db, ctx, quoteId, now); if (!c.ok) throw new Error(c.error)
  return c.value.invoiceId
}

export async function issuedInvoice(db: PrismaClient, ctx: Ctx, worksiteId: string, lines: QuoteLineForm[], opts: { globalDiscount?: string; vatReverseCharge?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? NOW
  const p = parseInvoiceForm({ worksiteId, lines, globalDiscount: opts.globalDiscount ?? "", vatReverseCharge: opts.vatReverseCharge ?? false }); if (!p.ok) throw new Error(p.error)
  const d = await createDraftInvoice(db, ctx, p.value, now); if (!d.ok) throw new Error(d.error)
  const r = await issueInvoice(db, ctx, d.value.id, now); if (!r.ok) throw new Error(r.error)
  return d.value.id
}

export async function issue(db: PrismaClient, ctx: Ctx, invoiceId: string, now: Date = NOW): Promise<void> {
  const r = await issueInvoice(db, ctx, invoiceId, now); if (!r.ok) throw new Error(r.error)
}
