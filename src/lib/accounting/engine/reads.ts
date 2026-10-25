// Lectures comptables (A1-d) : uniquement les écritures VALIDÉES de la société du contexte.
import type { Prisma } from "@prisma/client"
import type { AccountingContext } from "./posting"

type Tx = Prisma.TransactionClient | Prisma.DefaultPrismaClient

export interface BalanceRow { accountId: string; number: string; label: string; debitCents: bigint; creditCents: bigint; balanceCents: bigint }

export async function trialBalance(db: Tx, ctx: AccountingContext, fiscalYearId: string): Promise<BalanceRow[]> {
  const rows = await db.$queryRaw<{ accountId: string; number: string; label: string; debit: bigint; credit: bigint }[]>`
    SELECT a."id" AS "accountId", a."number", a."label",
           coalesce(sum(l."debitCents"), 0)::bigint AS debit, coalesce(sum(l."creditCents"), 0)::bigint AS credit
    FROM "journal_entry_lines" l
    JOIN "journal_entries" e ON e."id" = l."entryId" AND e."companyId" = ${ctx.companyId}
    JOIN "accounting_accounts" a ON a."id" = l."accountId" AND a."companyId" = ${ctx.companyId}
    WHERE l."companyId" = ${ctx.companyId} AND e."status" = 'VALIDATED' AND e."fiscalYearId" = ${fiscalYearId}
    GROUP BY a."id", a."number", a."label"
    ORDER BY a."number"`
  return rows.map((r) => ({ accountId: r.accountId, number: r.number, label: r.label, debitCents: BigInt(r.debit), creditCents: BigInt(r.credit), balanceCents: BigInt(r.debit) - BigInt(r.credit) }))
}

export interface LedgerRow { entryId: string; number: number; entryDate: Date; label: string; debitCents: bigint; creditCents: bigint }

export async function generalLedger(db: Tx, ctx: AccountingContext, fiscalYearId: string, accountId: string): Promise<LedgerRow[]> {
  const rows = await db.$queryRaw<{ entryId: string; number: number; entryDate: Date; label: string; debit: bigint; credit: bigint }[]>`
    SELECT e."id" AS "entryId", e."number", e."entryDate", coalesce(l."label", e."label") AS label, l."debitCents" AS debit, l."creditCents" AS credit
    FROM "journal_entry_lines" l
    JOIN "journal_entries" e ON e."id" = l."entryId" AND e."companyId" = ${ctx.companyId}
    WHERE l."companyId" = ${ctx.companyId} AND l."accountId" = ${accountId} AND e."status" = 'VALIDATED' AND e."fiscalYearId" = ${fiscalYearId}
    ORDER BY e."entryDate", e."number", l."position"`
  return rows.map((r) => ({ entryId: r.entryId, number: Number(r.number), entryDate: r.entryDate, label: r.label, debitCents: BigInt(r.debit), creditCents: BigInt(r.credit) }))
}
