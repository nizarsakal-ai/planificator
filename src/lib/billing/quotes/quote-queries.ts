// Lectures des devis — toujours filtrées par la société du contexte (jamais d'entrée client pour companyId).
import type { Prisma, PrismaClient } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"

type Db = PrismaClient | Prisma.TransactionClient

export interface QuoteListFilters {
  search?: string
  status?: string
  clientId?: string
  from?: string   // AAAA-MM-JJ
  to?: string
  minTTC?: bigint
  maxTTC?: bigint
  page?: number
}
export const QUOTES_PAGE_SIZE = 50
const STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REFUSED", "EXPIRED", "CONVERTED"] as const

export function quoteWhere(companyId: string, f: QuoteListFilters): Prisma.QuoteWhereInput {
  const where: Prisma.QuoteWhereInput = { companyId }
  if (f.status && (STATUSES as readonly string[]).includes(f.status)) where.status = f.status as (typeof STATUSES)[number]
  if (f.clientId) where.clientId = f.clientId
  if (f.from || f.to) {
    where.issueDate = {}
    if (f.from) where.issueDate.gte = new Date(`${f.from}T00:00:00.000Z`)
    if (f.to) where.issueDate.lte = new Date(`${f.to}T23:59:59.999Z`)
  }
  if (f.minTTC !== undefined || f.maxTTC !== undefined) {
    where.totalTTC = {}
    if (f.minTTC !== undefined) where.totalTTC.gte = (Number(f.minTTC) / 100).toFixed(2)
    if (f.maxTTC !== undefined) where.totalTTC.lte = (Number(f.maxTTC) / 100).toFixed(2)
  }
  const q = f.search?.trim().slice(0, 100)
  if (q) {
    where.OR = [
      { number: { contains: q, mode: "insensitive" } },
      { subject: { contains: q, mode: "insensitive" } },
      { client: { name: { contains: q, mode: "insensitive" } } },
      { worksite: { name: { contains: q, mode: "insensitive" } } },
    ]
  }
  return where
}

export async function listQuotes(db: Db, companyId: string, f: QuoteListFilters) {
  const where = quoteWhere(companyId, f)
  const page = Math.max(1, Math.min(10_000, Math.trunc(f.page ?? 1)))
  const [total, rows] = await Promise.all([
    db.quote.count({ where }),
    db.quote.findMany({
      where, orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }], skip: (page - 1) * QUOTES_PAGE_SIZE, take: QUOTES_PAGE_SIZE,
      select: {
        id: true, number: true, status: true, issueDate: true, validUntil: true, totalHT: true, totalTTC: true, subject: true, sentAt: true,
        client: { select: { id: true, name: true } }, worksite: { select: { id: true, name: true } },
        invoices: { where: { kind: "INVOICE", status: { not: "CANCELLED" } }, select: { id: true, number: true }, take: 1 },
      },
    }),
  ])
  return {
    total, page, pageSize: QUOTES_PAGE_SIZE,
    rows: rows.map((r) => ({
      id: r.id, number: r.number, status: r.status, issueDate: r.issueDate, validUntil: r.validUntil, subject: r.subject, sentAt: r.sentAt,
      totalHTCents: decimalToCents(r.totalHT), totalTTCCents: decimalToCents(r.totalTTC),
      clientId: r.client.id, clientName: r.client.name, worksiteName: r.worksite.name,
      invoice: r.invoices[0] ?? null,
    })),
  }
}

export async function getQuoteDetail(db: Db, companyId: string, quoteId: string) {
  const q = await db.quote.findFirst({
    where: { id: quoteId, companyId },
    select: {
      id: true, number: true, status: true, issueDate: true, validUntil: true, subject: true, notes: true, paymentTerms: true,
      totalHT: true, totalVAT: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true,
      sentAt: true, acceptedAt: true, refusedAt: true, refusalReason: true, expiredAt: true, convertedAt: true,
      signerName: true, signedAt: true, signatureTokenExpiresAt: true, reminderJ3SentAt: true, reminderJ7SentAt: true, reminderJ15SentAt: true,
      createdAt: true, importRef: true,
      client: { select: { id: true, name: true, email: true, address: true, siret: true, vatNumber: true, phone: true } },
      worksite: { select: { id: true, name: true, address: true } },
      lines: { orderBy: { position: "asc" }, select: { id: true, articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true, position: true } },
      invoices: { where: { status: { not: "CANCELLED" } }, select: { id: true, number: true, kind: true, status: true }, orderBy: { createdAt: "asc" } },
    },
  })
  if (!q) return null
  const mails = await db.billingMailLog.findMany({
    where: { companyId, documentType: "Quote", documentId: q.id }, orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, kind: true, to: true, status: true, createdAt: true, error: true },
  })
  return { ...q, mails }
}

/** Options de formulaire : chantiers actifs (avec client), articles actifs, clients (filtre liste). */
export async function quoteFormOptions(db: Db, companyId: string) {
  const [worksites, articles, clients] = await Promise.all([
    db.worksite.findMany({ where: { companyId, archivedAt: null }, orderBy: { startDate: "desc" }, select: { id: true, name: true, client: { select: { id: true, name: true, email: true } } } }),
    db.article.findMany({ where: { companyId, active: true }, orderBy: { designation: "asc" }, select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true } }),
    db.client.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])
  return {
    worksites: worksites.map((w) => ({ id: w.id, name: w.name, clientId: w.client.id, clientName: w.client.name, clientEmail: w.client.email })),
    articles: articles.map((a) => ({ id: a.id, designation: a.designation, unit: a.unit, unitPrice: a.unitPrice.toFixed(2), vatRate: a.vatRate.toFixed(2).replace(/\.?0+$/, "") })),
    clients,
  }
}
