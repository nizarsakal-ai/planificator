// Lectures des factures (C2) — filtrées par la société du contexte ; OVERDUE calculé à la lecture, jamais stocké.
import type { Prisma, PrismaClient } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"

type Db = PrismaClient | Prisma.TransactionClient
const STATUSES = ["DRAFT", "SENT", "PARTIAL", "PAID", "CANCELLED"] as const

export interface InvoiceListFilters { search?: string; status?: string; overdue?: boolean; clientId?: string; from?: string; to?: string; kind?: string; page?: number }
export const INVOICES_PAGE_SIZE = 50

export function todayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function isOverdue(inv: { status: string; dueDate: Date | null; kind: string }, today: Date): boolean {
  return inv.kind !== "CREDIT_NOTE" && (inv.status === "SENT" || inv.status === "PARTIAL") && !!inv.dueDate && inv.dueDate < today
}

export function invoiceWhere(companyId: string, f: InvoiceListFilters, today: Date): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = { companyId }
  if (f.status && (STATUSES as readonly string[]).includes(f.status)) where.status = f.status as (typeof STATUSES)[number]
  if (f.kind === "INVOICE" || f.kind === "CREDIT_NOTE" || f.kind === "DEPOSIT") where.kind = f.kind
  if (f.overdue) { where.status = { in: ["SENT", "PARTIAL"] }; where.dueDate = { lt: today }; where.kind = { not: "CREDIT_NOTE" } }
  if (f.clientId) where.clientId = f.clientId
  if (f.from || f.to) { where.issueDate = {}; if (f.from) where.issueDate.gte = new Date(`${f.from}T00:00:00.000Z`); if (f.to) where.issueDate.lte = new Date(`${f.to}T23:59:59.999Z`) }
  const q = f.search?.trim().slice(0, 100)
  if (q) where.OR = [{ number: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }, { client: { name: { contains: q, mode: "insensitive" } } }, { worksite: { name: { contains: q, mode: "insensitive" } } }]
  return where
}

export interface InvoiceRow {
  id: string; number: string; status: string; kind: string; issueDate: Date; dueDate: Date | null; subject: string | null
  totalHTCents: bigint; totalTTCCents: bigint; paidCents: bigint; creditedPartialCents: bigint; remainingCents: bigint; overdue: boolean
  clientId: string; clientName: string; worksiteName: string; lastPaymentMethod: string | null; quoteNumber: string | null
}

export async function listInvoices(db: Db, companyId: string, f: InvoiceListFilters, now: Date = new Date()) {
  const today = todayUtc(now)
  const where = invoiceWhere(companyId, f, today)
  const page = Math.max(1, Math.min(10_000, Math.trunc(f.page ?? 1)))
  const [total, rows] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], skip: (page - 1) * INVOICES_PAGE_SIZE, take: INVOICES_PAGE_SIZE,
      select: {
        id: true, number: true, status: true, kind: true, issueDate: true, dueDate: true, subject: true, totalHT: true, totalTTC: true,
        client: { select: { id: true, name: true } }, worksite: { select: { name: true } }, quote: { select: { number: true } },
        payments: { select: { amountCents: true, method: true, reversesPaymentId: true, createdAt: true }, orderBy: { createdAt: "desc" } },
        creditNotes: { where: { creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } },
      },
    }),
  ])
  return {
    total, page, pageSize: INVOICES_PAGE_SIZE,
    rows: rows.map((r): InvoiceRow => {
      const paid = r.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
      const ttc = decimalToCents(r.totalTTC)
      const credited = r.creditNotes.reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0))
      const last = r.payments.find((p) => !p.reversesPaymentId)
      // PAID sans paiements enregistrés = réglée hors module (Lot B) : reste 0, « payé » = TTC.
      const settledOutside = r.status === "PAID" && paid + credited < ttc
      return {
        id: r.id, number: r.number, status: r.status, kind: r.kind, issueDate: r.issueDate, dueDate: r.dueDate, subject: r.subject,
        totalHTCents: decimalToCents(r.totalHT), totalTTCCents: ttc, paidCents: settledOutside ? ttc - credited : paid, creditedPartialCents: credited,
        remainingCents: r.kind === "CREDIT_NOTE" || r.status === "CANCELLED" || r.status === "DRAFT" || r.status === "PAID" ? BigInt(0) : ttc - paid - credited,
        overdue: isOverdue(r, today), clientId: r.client.id, clientName: r.client.name, worksiteName: r.worksite.name, lastPaymentMethod: last?.method ?? null, quoteNumber: r.quote?.number ?? null,
      }
    }),
  }
}

/** Cartes : total encaissé (Σ paiements, contre-passations incluses) et total dû (Σ restes des factures SENT/PARTIAL). */
export async function invoiceSummary(db: Db, companyId: string, now: Date = new Date()) {
  const today = todayUtc(now)
  const [paid, open] = await Promise.all([
    db.invoicePayment.aggregate({ where: { companyId }, _sum: { amountCents: true } }),
    db.invoice.findMany({ where: { companyId, status: { in: ["SENT", "PARTIAL"] }, kind: { not: "CREDIT_NOTE" } }, select: { id: true, totalTTC: true, dueDate: true, status: true, kind: true, payments: { select: { amountCents: true } }, creditNotes: { where: { creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } } } }),
  ])
  let due = BigInt(0), overdue = BigInt(0), overdueCount = 0
  for (const i of open) {
    const r = decimalToCents(i.totalTTC) - i.payments.reduce((s, p) => s + p.amountCents, BigInt(0)) - i.creditNotes.reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0))
    due += r
    if (isOverdue(i, today)) { overdue += r; overdueCount++ }
  }
  return { collectedCents: paid._sum.amountCents ?? BigInt(0), dueCents: due, overdueCents: overdue, overdueCount, openCount: open.length }
}

export async function getInvoiceDetail(db: Db, companyId: string, invoiceId: string, now: Date = new Date()) {
  const inv = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: {
      id: true, number: true, status: true, kind: true, issueDate: true, dueDate: true, periodStart: true, periodEnd: true, subject: true, notes: true, paymentTerms: true,
      totalHT: true, totalVAT: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true, sentAt: true, paidAt: true, createdAt: true, creditedInvoiceId: true, quoteId: true,
      reminderDue30SentAt: true, reminderDue45SentAt: true, reminderDue60SentAt: true,
      client: { select: { id: true, name: true, email: true, address: true, siret: true, vatNumber: true } },
      worksite: { select: { id: true, name: true } }, company: { select: { name: true, address: true, siret: true } },
      quote: { select: { id: true, number: true } },
      creditedInvoice: { select: { id: true, number: true } },
      lines: { orderBy: { position: "asc" }, select: { id: true, articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true, position: true, deductsDepositId: true } },
      depositDeductions: { select: { depositInvoiceId: true, amountTTCCents: true, deposit: { select: { number: true, issueDate: true, status: true } } } },
      payments: { orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }], select: { id: true, amountCents: true, method: true, paidAt: true, reference: true, notes: true, reversesPaymentId: true, reversedAt: true, createdAt: true } },
    },
  })
  if (!inv) return null
  const [creditNotes, mails] = await Promise.all([
    db.invoice.findMany({ where: { companyId, creditedInvoiceId: inv.id }, select: { id: true, number: true, status: true, totalTTC: true, issueDate: true, creditScope: true, creditReason: true } }),
    db.billingMailLog.findMany({ where: { companyId, documentType: "Invoice", documentId: inv.id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, kind: true, to: true, status: true, createdAt: true, error: true } }),
  ])
  const ttc = decimalToCents(inv.totalTTC)
  const paid = inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
  const credited = creditNotes.filter((c) => c.creditScope === "PARTIAL" && c.status !== "CANCELLED").reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0))
  const payable = inv.kind !== "CREDIT_NOTE" && (inv.status === "SENT" || inv.status === "PARTIAL") && ttc - credited > BigInt(0)
  const settledOutside = inv.status === "PAID" && paid + credited < ttc
  // Créditable = reste à payer (TTC − avoirs − paiements) : jamais de trop-perçu par avoir ; un acompte ne reçoit qu'un avoir total.
  const creditableCents = settledOutside ? BigInt(0) : ttc - credited - paid
  const creditable = inv.kind === "INVOICE" && ["SENT", "PARTIAL", "PAID"].includes(inv.status) && !creditNotes.some((c) => c.creditScope === "TOTAL") && creditableCents > BigInt(0)
  return { ...inv, creditNotes, mails, totalTTCCents: ttc, paidCents: settledOutside ? ttc - credited : paid, creditedPartialCents: credited, remainingCents: payable ? ttc - paid - credited : BigInt(0), creditableCents, settledOutside, overdue: isOverdue(inv, todayUtc(now)), payable, creditable }
}
