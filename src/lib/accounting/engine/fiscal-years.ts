// Exercices comptables (SPEC-ACC-A §3 bis « Exercices et clôture »).
// Ouverture et changement d'état passent par ce service : ADMIN revérifié dans la transaction, verrou de la
// ligne d'exercice (le même que celui pris par postEntry ⇒ jamais d'état mixte validation/clôture), audit.
// Les invariants (pas de chevauchement, états sans retour, dates figées, pas de suppression) sont aussi
// garantis en base par le déclencheur fiscal_years_guard.
import type { Prisma } from "@prisma/client"
import { AccountingError, assertStillAccountingAdmin, type AccountingContext } from "./posting"

type Tx = Prisma.TransactionClient
export type FiscalYearStatusValue = "OPEN" | "CLOSING" | "CLOSED"

const NEXT: Readonly<Record<FiscalYearStatusValue, FiscalYearStatusValue | null>> = { OPEN: "CLOSING", CLOSING: "CLOSED", CLOSED: null }

function isUtcMidnight(d: Date): boolean {
  return !Number.isNaN(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
}

/** Ouvre un exercice [startDate, endDate] (dates calendaires UTC, durée ≤ 24 mois). */
export async function openFiscalYear(tx: Tx, ctx: AccountingContext, input: { startDate: Date; endDate: Date }): Promise<{ id: string }> {
  await assertStillAccountingAdmin(tx, ctx)
  const { startDate, endDate } = input
  if (!isUtcMidnight(startDate) || !isUtcMidnight(endDate)) throw new AccountingError("FISCAL_YEAR_INVALID", ["DATE_NOT_CALENDAR_DAY"])
  if (endDate.getTime() <= startDate.getTime()) throw new AccountingError("FISCAL_YEAR_INVALID", ["END_BEFORE_START"])
  const maxEnd = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 24, startDate.getUTCDate()))
  if (endDate.getTime() >= maxEnd.getTime()) throw new AccountingError("FISCAL_YEAR_INVALID", ["LONGER_THAN_24_MONTHS"])
  const fy = await tx.fiscalYear.create({ data: { companyId: ctx.companyId, startDate, endDate }, select: { id: true } })
  await tx.historyLog.create({
    data: {
      companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "FiscalYear", entityId: fy.id,
      detail: `Exercice ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)} ouvert`,
      newValue: { status: "OPEN", startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) },
    },
  })
  return fy
}

/** Fait avancer l'état d'un exercice d'un cran (OPEN → CLOSING → CLOSED), sans retour arrière. */
export async function advanceFiscalYear(tx: Tx, ctx: AccountingContext, fiscalYearId: string, to: FiscalYearStatusValue): Promise<void> {
  await assertStillAccountingAdmin(tx, ctx)
  await tx.$queryRaw`SELECT 1 FROM "fiscal_years" WHERE "id" = ${fiscalYearId} AND "companyId" = ${ctx.companyId} FOR NO KEY UPDATE`
  const fy = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId, companyId: ctx.companyId }, select: { status: true } })
  if (!fy) throw new AccountingError("FISCAL_YEAR_NOT_FOUND")
  const from = fy.status as FiscalYearStatusValue
  if (NEXT[from] !== to) throw new AccountingError("FISCAL_YEAR_TRANSITION_INVALID", [`${from}->${to}`])
  const updated = await tx.fiscalYear.updateMany({ where: { id: fiscalYearId, companyId: ctx.companyId, status: from }, data: { status: to } })
  if (updated.count !== 1) throw new AccountingError("FISCAL_YEAR_CONFLICT")
  await tx.historyLog.create({
    data: {
      companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "FiscalYear", entityId: fiscalYearId,
      detail: `Exercice : ${from} → ${to}`, oldValue: { status: from }, newValue: { status: to },
    },
  })
}
