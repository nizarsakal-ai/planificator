// Lectures pour les écrans (SPEC-ACC-A2). Toujours filtrées par la société du contexte autorisé.
import type { Prisma } from "@prisma/client"
import type { AccountingContext } from "./posting"

type Db = Prisma.TransactionClient | Prisma.DefaultPrismaClient

export async function listFiscalYears(db: Db, ctx: AccountingContext) {
  return db.fiscalYear.findMany({ where: { companyId: ctx.companyId }, orderBy: { startDate: "desc" }, select: { id: true, startDate: true, endDate: true, status: true } })
}

export async function listJournals(db: Db, ctx: AccountingContext) {
  return db.accountingJournal.findMany({ where: { companyId: ctx.companyId }, orderBy: { code: "asc" }, select: { id: true, code: true, label: true, kind: true } })
}

export async function listAccounts(db: Db, ctx: AccountingContext) {
  const [accounts, used] = await Promise.all([
    db.accountingAccount.findMany({ where: { companyId: ctx.companyId }, orderBy: { number: "asc" }, select: { id: true, number: true, label: true, active: true } }),
    db.journalEntryLine.groupBy({ by: ["accountId"], where: { companyId: ctx.companyId }, _count: { _all: true } }),
  ])
  const usage = new Map(used.map((u) => [u.accountId, u._count._all]))
  return accounts.map((a) => ({ ...a, lineCount: usage.get(a.id) ?? 0 }))
}

export interface EntryFilters { fiscalYearId?: string; journalId?: string; status?: "DRAFT" | "VALIDATED"; page?: number }
export const ENTRIES_PAGE_SIZE = 50

export async function listEntries(db: Db, ctx: AccountingContext, filters: EntryFilters) {
  const where: Prisma.JournalEntryWhereInput = { companyId: ctx.companyId }
  if (filters.fiscalYearId) where.fiscalYearId = filters.fiscalYearId
  if (filters.journalId) where.journalId = filters.journalId
  if (filters.status) where.status = filters.status
  const page = Math.max(1, Math.min(10_000, Math.trunc(filters.page ?? 1)))
  const [total, rows] = await Promise.all([
    db.journalEntry.count({ where }),
    db.journalEntry.findMany({
      where, orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * ENTRIES_PAGE_SIZE, take: ENTRIES_PAGE_SIZE,
      select: {
        id: true, status: true, number: true, entryDate: true, label: true, documentRef: true, reversalOfId: true,
        journal: { select: { code: true } }, lines: { select: { debitCents: true } },
      },
    }),
  ])
  return {
    total, page, pageSize: ENTRIES_PAGE_SIZE,
    rows: rows.map((r) => ({
      id: r.id, status: r.status, number: r.number, entryDate: r.entryDate, label: r.label, documentRef: r.documentRef,
      journalCode: r.journal.code, isReversal: r.reversalOfId !== null,
      totalCents: r.lines.reduce((s, l) => s + l.debitCents, BigInt(0)),
    })),
  }
}

export async function getEntryDetail(db: Db, ctx: AccountingContext, entryId: string) {
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    select: {
      id: true, status: true, number: true, entryDate: true, documentDate: true, documentRef: true, label: true, closingEntry: true,
      validatedAt: true, hash: true, reversalOfId: true, fiscalYearId: true,
      journal: { select: { code: true, label: true } },
      fiscalYear: { select: { startDate: true, endDate: true, status: true } },
      lines: { orderBy: { position: "asc" }, select: { position: true, label: true, debitCents: true, creditCents: true, vatRateBp: true, account: { select: { number: true, label: true } } } },
    },
  })
  if (!entry) return null
  const reversedBy = await db.journalEntry.findFirst({ where: { companyId: ctx.companyId, reversalOfId: entry.id }, select: { id: true, number: true, status: true } })
  const reversalOf = entry.reversalOfId
    ? await db.journalEntry.findFirst({ where: { companyId: ctx.companyId, id: entry.reversalOfId }, select: { id: true, number: true } })
    : null
  return { ...entry, reversedBy, reversalOf }
}

export async function accountingSummary(db: Db, ctx: AccountingContext) {
  const [accounts, journals, years, drafts, validated] = await Promise.all([
    db.accountingAccount.count({ where: { companyId: ctx.companyId } }),
    db.accountingJournal.count({ where: { companyId: ctx.companyId } }),
    listFiscalYears(db, ctx),
    db.journalEntry.count({ where: { companyId: ctx.companyId, status: "DRAFT" } }),
    db.journalEntry.count({ where: { companyId: ctx.companyId, status: "VALIDATED" } }),
  ])
  return { initialized: accounts > 0 && journals > 0, accounts, journals, years, openYear: years.find((y) => y.status === "OPEN") ?? null, drafts, validated }
}
