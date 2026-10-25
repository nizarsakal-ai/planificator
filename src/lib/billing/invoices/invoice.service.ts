// ═══════════════════════════════════════════════════════════════════════════
// Factures — service transactionnel du Lot C2 : création (brouillon provisoire), modification, émission numérotée,
// envoi, paiements, contre-passation, relances. Contexte autorisé (société + utilisateur de session) obligatoire.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { centsToDecimalString, decimalToCents, formatEuro, hundredthsToDecimalString, bpToPercentString } from "@/lib/billing/money"
import { sendBillingMail } from "@/lib/billing/mail/send"
import { invoiceReminderMail, invoiceSentMail } from "@/lib/billing/mail/templates"
import { getBillingSettings } from "@/lib/billing/settings"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { INVOICE_C2_ERRORS, issueInvoiceCore, recordPaymentCore, replaceInvoiceDraftCore, reversePaymentCore, type InvoiceDraftLine, type PaymentStatus } from "./invoice-c2.core"
import { depositIssueChecks } from "./deposit.service"
import type { ParsedInvoice } from "./invoice-schemas"

export interface InvoiceContext { companyId: string; userId: string }
type Db = PrismaClient
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export async function lockInvoiceRow(tx: Prisma.TransactionClient, invoiceId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "invoices" WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} FOR UPDATE`
}
export async function enablePaymentsContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('planificator.billing_payments', 'on', true)`
}

function toLines(parsed: ParsedInvoice): InvoiceDraftLine[] {
  return parsed.lines.map((l, i) => ({
    articleId: l.articleId, designation: l.designation, description: l.description, unit: l.unit,
    quantity: hundredthsToDecimalString(l.quantityHundredths), unitPrice: centsToDecimalString(l.unitPriceCents), vatRate: bpToPercentString(l.vatRateBp),
    lineHT: centsToDecimalString(parsed.totals.lines[i].lineHTCents), discountBp: l.discountBp, position: i,
  }))
}
function toHeader(parsed: ParsedInvoice) {
  return {
    dueDate: parsed.dueDate, subject: parsed.subject, notes: parsed.notes, paymentTerms: parsed.paymentTerms, globalDiscountBp: parsed.globalDiscountBp, vatReverseCharge: parsed.vatReverseCharge,
    totalHT: centsToDecimalString(parsed.totals.totalHTCents), totalVAT: centsToDecimalString(parsed.totals.totalVATCents), totalTTC: centsToDecimalString(parsed.totals.totalTTCCents),
  }
}
async function checkReferences(db: Db, ctx: InvoiceContext, parsed: ParsedInvoice): Promise<LifecycleResult<{ clientId: string; periodStart: Date | null; periodEnd: Date | null }>> {
  const w = await db.worksite.findFirst({ where: { id: parsed.worksiteId, companyId: ctx.companyId }, select: { clientId: true, startDate: true, endDate: true } })
  if (!w) return { ok: false, error: "Chantier introuvable." }
  if (parsed.quoteId) {
    // Devis lié hors conversion : même société ET même chantier, accepté/converti, sans facture (non annulée) déjà liée.
    const q = await db.quote.findFirst({ where: { id: parsed.quoteId, companyId: ctx.companyId }, select: { id: true, worksiteId: true, status: true } })
    if (!q || q.worksiteId !== parsed.worksiteId) return { ok: false, error: "Devis lié introuvable (il doit appartenir au même chantier)." }
    if (q.status !== "ACCEPTED" && q.status !== "CONVERTED") return { ok: false, error: "Seul un devis accepté peut être lié à une facture." }
    const linked = await db.invoice.findFirst({ where: { companyId: ctx.companyId, quoteId: q.id, kind: "INVOICE", status: { not: "CANCELLED" } }, select: { id: true } })
    if (linked && linked.id !== (parsed as { currentInvoiceId?: string }).currentInvoiceId) return { ok: false, error: "Ce devis est déjà lié à une facture." }
  }
  const articleIds = [...new Set(parsed.lines.map((l) => l.articleId).filter((a): a is string => !!a))]
  if (articleIds.length && (await db.article.count({ where: { companyId: ctx.companyId, id: { in: articleIds } } })) !== articleIds.length) return { ok: false, error: "Article introuvable." }
  return { ok: true, value: { clientId: w.clientId, periodStart: w.startDate, periodEnd: w.endDate } }
}

/** Brouillon de facture : numéro PROVISOIRE ; le numéro légal est attribué à l'émission. */
export async function createDraftInvoice(db: Db, ctx: InvoiceContext, parsed: ParsedInvoice, now: Date): Promise<LifecycleResult<{ id: string; number: string }>> {
  const refs = await checkReferences(db, ctx, parsed)
  if (!refs.ok) return refs
  const created = await db.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, ctx.companyId, "INVOICE_DRAFT", now.getUTCFullYear())
    const inv = await tx.invoice.create({
      data: {
        companyId: ctx.companyId, worksiteId: parsed.worksiteId, clientId: refs.value.clientId, quoteId: parsed.quoteId, number, status: "DRAFT", kind: "INVOICE",
        issueDate: now, periodStart: refs.value.periodStart, periodEnd: refs.value.periodEnd, createdById: ctx.userId, ...toHeader(parsed), lines: { create: toLines(parsed) },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: parsed.worksiteId, actorId: ctx.userId, action: "CREATED", entityType: "Invoice", entityId: inv.id, detail: `Facture ${inv.number} créée (brouillon)` } })
    await flushDeferredConstraints(tx)
    return inv
  })
  return { ok: true, value: created }
}

export async function updateDraftInvoice(db: Db, ctx: InvoiceContext, invoiceId: string, parsed: ParsedInvoice): Promise<LifecycleResult> {
  const refs = await checkReferences(db, ctx, { ...parsed, currentInvoiceId: invoiceId } as ParsedInvoice)
  if (!refs.ok) return refs
  return db.$transaction(async (tx) => {
    const r = await replaceInvoiceDraftCore(tx, { companyId: ctx.companyId, invoiceId, actorId: ctx.userId, header: { ...toHeader(parsed), worksiteId: parsed.worksiteId, clientId: refs.value.clientId, quoteId: parsed.quoteId }, lines: toLines(parsed) })
    if (!r.ok) return r
    // Facture de solde : les déductions d'acomptes (lignes retirées par le remplacement) sont régénérées.
    if (parsed.quoteId) {
      const { applyDepositDeductionsCore } = await import("./deposit.service")
      const d = await applyDepositDeductionsCore(tx, ctx, invoiceId)
      if (!d.ok) return d
    }
    await flushDeferredConstraints(tx)
    return r
  })
}

export async function issueInvoice(db: Db, ctx: InvoiceContext, invoiceId: string, now: Date): Promise<LifecycleResult<{ number: string }>> {
  const s = await getBillingSettings(db, ctx.companyId)
  const r = await db.$transaction(async (tx) => {
    const r = await issueInvoiceCore(tx, {
      companyId: ctx.companyId, invoiceId, actorId: ctx.userId, now, paymentTermsDays: s.paymentTermsDays,
      nextLegalNumber: (t, year) => nextDocumentNumber(t, ctx.companyId, "INVOICE", year), lockInvoice: lockInvoiceRow,
      extraChecks: (t, inv) => depositIssueChecks(t, ctx.companyId, inv),
    })
    if (r.ok) await flushDeferredConstraints(tx)
    return r
  })
  return r.ok ? { ok: true, value: { number: r.value.number } } : r
}

/** Envoi par courrier d'une facture émise (journalisé ; sans effet sur le statut). */
export async function sendInvoiceMail(db: Db, ctx: InvoiceContext, invoiceId: string): Promise<LifecycleResult<{ status: string }>> {
  const inv = await db.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    select: { id: true, number: true, status: true, kind: true, dueDate: true, totalTTC: true, client: { select: { name: true, email: true } }, company: { select: { name: true } }, payments: { select: { amountCents: true } } },
  })
  if (!inv) return { ok: false, error: INVOICE_C2_ERRORS.notFound }
  if (inv.kind === "CREDIT_NOTE") return { ok: false, error: "L'envoi d'un avoir par courrier n'est pas encore disponible : transmettez le PDF." }
  if (inv.status === "DRAFT" || inv.status === "CANCELLED") return { ok: false, error: "Seule une facture émise peut être envoyée." }
  const to = inv.client.email?.trim()
  if (!to) return { ok: false, error: "Le client n'a pas d'adresse e-mail." }
  const ttc = decimalToCents(inv.totalTTC)
  const remaining = inv.status === "PAID" ? BigInt(0) : ttc - inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
  const mail = invoiceSentMail({ companyName: inv.company.name, clientName: inv.client.name, invoiceNumber: inv.number, totalTTC: formatEuro(ttc), remaining: formatEuro(remaining), dueDate: inv.dueDate ? dateFr.format(inv.dueDate) : "—" })
  const sent = await sendBillingMail(db, { companyId: ctx.companyId, kind: "INVOICE_SENT", documentType: "Invoice", documentId: inv.id }, { to, ...mail })
  await db.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "Invoice", entityId: inv.id, detail: `Facture ${inv.number} envoyée à ${to} (${sent.status})` } })
  return { ok: true, value: { status: sent.status } }
}

export interface PaymentInput { amountCents: bigint; method: "TRANSFER" | "CHECK" | "CASH" | "CARD" | "DIRECT_DEBIT" | "OTHER"; paidAt: Date; reference: string | null; notes: string | null }

export async function recordPayment(db: Db, ctx: InvoiceContext, invoiceId: string, input: PaymentInput, now: Date): Promise<LifecycleResult<{ paymentId: string; status: PaymentStatus; remainingCents: bigint }>> {
  return db.$transaction(async (tx) => {
    const r = await recordPaymentCore(tx, { companyId: ctx.companyId, invoiceId, actorId: ctx.userId, now, ...input, lockInvoice: lockInvoiceRow, enablePaymentsContext })
    if (r.ok) await flushDeferredConstraints(tx)
    return r
  })
}

export async function reversePayment(db: Db, ctx: InvoiceContext, paymentId: string, reason: string | null, now: Date): Promise<LifecycleResult<{ status: PaymentStatus }>> {
  return db.$transaction(async (tx) => {
    const r = await reversePaymentCore(tx, { companyId: ctx.companyId, paymentId, actorId: ctx.userId, now, reason, lockInvoice: lockInvoiceRow, enablePaymentsContext })
    if (r.ok) await flushDeferredConstraints(tx)
    return r
  })
}

// ─── Relances J+30 / J+45 / J+60 après échéance (job idempotent) ─────────────
const STEPS: readonly { step: 30 | 45 | 60; column: "reminderDue30SentAt" | "reminderDue45SentAt" | "reminderDue60SentAt" }[] = [
  { step: 30, column: "reminderDue30SentAt" }, { step: 45, column: "reminderDue45SentAt" }, { step: 60, column: "reminderDue60SentAt" },
]

export async function runInvoiceReminders(db: Db, now: Date, limit = 200): Promise<{ reminders: { step: number; sent: number }[] }> {
  const report: { step: number; sent: number }[] = []
  for (const { step, column } of STEPS) {
    const threshold = new Date(now.getTime() - step * 86_400_000)
    const due = await db.invoice.findMany({
      where: { status: { in: ["SENT", "PARTIAL"] }, kind: { not: "CREDIT_NOTE" }, totalTTC: { gt: 0 }, dueDate: { lte: threshold }, [column]: null, client: { email: { not: null } } },
      select: { id: true, companyId: true, number: true, dueDate: true, totalTTC: true, client: { select: { name: true, email: true } }, company: { select: { name: true } }, payments: { select: { amountCents: true } } },
      take: limit,
    })
    let sent = 0
    for (const inv of due) {
      const to = inv.client.email?.trim()
      if (!to || !inv.dueDate) continue
      const claimed = await db.invoice.updateMany({ where: { id: inv.id, companyId: inv.companyId, status: { in: ["SENT", "PARTIAL"] }, [column]: null }, data: { [column]: now } })
      if (claimed.count !== 1) continue
      const ttc = decimalToCents(inv.totalTTC)
      const remaining = ttc - inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
      const daysLate = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000)
      const mail = invoiceReminderMail({ step, daysLate, companyName: inv.company.name, clientName: inv.client.name, invoiceNumber: inv.number, totalTTC: formatEuro(ttc), remaining: formatEuro(remaining), dueDate: dateFr.format(inv.dueDate) })
      await sendBillingMail(db, { companyId: inv.companyId, kind: `INVOICE_REMINDER_${step}`, documentType: "Invoice", documentId: inv.id }, { to, ...mail })
      sent++
    }
    report.push({ step, sent })
  }
  return { reminders: report }
}

/** Relance manuelle depuis le détail (hors paliers automatiques), journalisée. */
export async function sendManualReminder(db: Db, ctx: InvoiceContext, invoiceId: string, now: Date): Promise<LifecycleResult<{ status: string }>> {
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, companyId: ctx.companyId, status: { in: ["SENT", "PARTIAL"] }, kind: { not: "CREDIT_NOTE" } }, select: { id: true, number: true, dueDate: true, totalTTC: true, client: { select: { name: true, email: true } }, company: { select: { name: true } }, payments: { select: { amountCents: true } } } })
  if (!inv) return { ok: false, error: "Seule une facture émise non soldée peut être relancée." }
  const to = inv.client.email?.trim()
  if (!to) return { ok: false, error: "Le client n'a pas d'adresse e-mail." }
  const ttc = decimalToCents(inv.totalTTC)
  const remaining = ttc - inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
  const daysLate = inv.dueDate ? Math.max(0, Math.floor((now.getTime() - inv.dueDate.getTime()) / 86_400_000)) : 0
  const mail = invoiceReminderMail({ step: 30, daysLate, companyName: inv.company.name, clientName: inv.client.name, invoiceNumber: inv.number, totalTTC: formatEuro(ttc), remaining: formatEuro(remaining), dueDate: inv.dueDate ? dateFr.format(inv.dueDate) : "—" })
  const sent = await sendBillingMail(db, { companyId: ctx.companyId, kind: "INVOICE_REMINDER_MANUAL", documentType: "Invoice", documentId: inv.id }, { to, ...mail })
  await db.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "Invoice", entityId: inv.id, detail: `Relance manuelle envoyée à ${to} (${sent.status})` } })
  return { ok: true, value: { status: sent.status } }
}
