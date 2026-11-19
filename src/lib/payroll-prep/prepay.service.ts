/**
 * Lot H Planificator V2 : service de pré-paie. Toute lecture et écriture est bornée par `ctx.companyId` (session) ;
 * chaque écriture est auditée (HistoryLog) dans sa transaction. Aucun calcul de salaire ni de cotisation.
 *
 * - Ouverture d'une période (un mois, au plus le mois en cours ; unique par entreprise).
 * - Variables saisies (primes, frais) : seulement sur période ouverte, période verrouillée (`FOR UPDATE`).
 * - Calcul : lecture des salariés, pointages, absences et variables du mois, puis règles pures (prepay.core.ts).
 * - Clôture : période verrouillée, recalcul, refus s'il reste un contrôle bloquant, instantané figé et empreint ; la
 *   période devient immuable (garanti en base). L'export d'une période clôturée est relu depuis l'instantané.
 *
 * Portage sur 90ae644 (19/11/2026) :
 * - empreinte par la forme canonique LOCALE au lot H (`./canonical`, sémantique archivée), sans dépendance au lot D ;
 * - cohérence de la clôture : transaction en lecture répétable (REPEATABLE READ) ; pointages, absences, salariés et
 *   variables sont lus dans UN MÊME instantané de base. Chaque saisie ou suppression de variable « touche » la période
 *   (`updatedAt`) sous son verrou : une clôture qui attendait ce verrou échoue alors en conflit de sérialisation au lieu
 *   de figer un instantané antérieur à la saisie validée. Elle est relancée une fois sur un instantané neuf ; si le
 *   conflit persiste, un message métier invite à relancer la clôture (jamais de variable perdue en silence).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { canonicalJson, sha256Hex } from "@/lib/payroll-prep/canonical"
import {
  PREPAY_ERRORS, blockingCount, computePrepay, monthBounds, parseAmount, periodLabel, validateLabel, validatePeriod,
  type AbsenceKind, type PeriodSnapshot, type PrepayResult, type VariableKind,
} from "@/lib/payroll-prep/prepay.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
type Reader = Pick<Tx, "employee" | "timeclock" | "absence" | "payrollManualVariable">
export interface PrepayContext { companyId: string; userId: string }
export type PrepayResultT<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class PrepayFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "PrepayFailure" }
}
const fail = (m: string): never => { throw new PrepayFailure(m) }
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<PrepayResultT<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof PrepayFailure) return { ok: false, error: e.userMessage }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: PREPAY_ERRORS.exists }
    throw e
  }
}
/** Conflit de sérialisation (SQLSTATE 40001) ou interblocage (40P01), tel que Prisma le rapporte. */
export function isSerializationConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (e.code === "P2034") return true
  const code = (e.meta as { code?: unknown } | undefined)?.code
  return code === "40001" || code === "40P01"
}
/** Saisie ou suppression de variable : la période est « touchée » sous son verrou exclusif (voir l'en-tête). */
async function touchPeriod(tx: Tx, ctx: PrepayContext, periodId: string) {
  const n = await tx.$executeRaw`UPDATE "payroll_periods" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${periodId} AND "companyId" = ${ctx.companyId} AND "status" = 'OPEN'`
  if (n !== 1) fail(PREPAY_ERRORS.closed)
}
async function audit(tx: Tx, ctx: PrepayContext, action: "CREATED" | "UPDATED" | "STATUS_CHANGED" | "DELETED", entityId: string, detail: string) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action, entityType: "PayrollPeriod", entityId, detail } })
}
export const snapshotSha256 = (s: PeriodSnapshot) => sha256Hex(canonicalJson(s))
/** Détails génériques du journal pour la saisie et la suppression d'une variable (aucune donnée salarié ni montant). */
export const AUDIT_VARIABLE_ADDED = "Variable de pré-paie ajoutée."
export const AUDIT_VARIABLE_REMOVED = "Variable de pré-paie supprimée."

export async function openPeriod(db: Db, ctx: PrepayContext, year: number, month: number, now: Date = serverNow()): Promise<PrepayResultT<{ id: string }>> {
  const v = validatePeriod(year, month, parisToday(now))
  if (!v.ok) return v
  return inTx(db, async (tx) => {
    const p = await tx.payrollPeriod.create({ data: { companyId: ctx.companyId, year, month, createdById: ctx.userId }, select: { id: true } })
    await audit(tx, ctx, "CREATED", p.id, `Période de pré-paie ${periodLabel(year, month)} ouverte`)
    return { id: p.id }
  })
}

async function lockOpen(tx: Tx, ctx: PrepayContext, periodId: string) {
  const rows = await tx.$queryRaw<{ id: string; year: number; month: number; status: string }[]>`
    SELECT "id", "year", "month", "status"::text AS "status" FROM "payroll_periods" WHERE "id" = ${periodId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  const p = rows[0] ?? fail(PREPAY_ERRORS.notFound)
  if (p.status !== "OPEN") fail(PREPAY_ERRORS.closed)
  return p
}

export async function addVariable(db: Db, ctx: PrepayContext, periodId: string, input: { employeeId: string; kind: string; amount: string; label: string }): Promise<PrepayResultT<{ id: string }>> {
  if (input.kind !== "BONUS" && input.kind !== "EXPENSE") return { ok: false, error: PREPAY_ERRORS.kind }
  const kind: VariableKind = input.kind
  const amount = parseAmount(input.amount)
  if (!amount.ok) return amount
  const label = validateLabel(input.label)
  if (!label.ok) return label
  return inTx(db, async (tx) => {
    const p = await lockOpen(tx, ctx, periodId)
    const e = (await tx.employee.findFirst({ where: { id: input.employeeId, companyId: ctx.companyId, active: true }, select: { id: true } })) ?? fail(PREPAY_ERRORS.employee)
    const v = await tx.payrollManualVariable.create({ data: { companyId: ctx.companyId, periodId: p.id, employeeId: e.id, kind, amountCents: amount.value, label: label.value, createdById: ctx.userId }, select: { id: true } })
    await touchPeriod(tx, ctx, p.id)
    // Portage v2 : journal minimal (société, auteur, période, type d'action) ; ni salarié, ni libellé, ni montant.
    await audit(tx, ctx, "UPDATED", p.id, AUDIT_VARIABLE_ADDED)
    return { id: v.id }
  })
}

export async function removeVariable(db: Db, ctx: PrepayContext, variableId: string): Promise<PrepayResultT> {
  return inTx(db, async (tx) => {
    const v = (await tx.payrollManualVariable.findFirst({ where: { id: variableId, companyId: ctx.companyId }, select: { id: true, periodId: true } })) ?? fail(PREPAY_ERRORS.notFound)
    const p = await lockOpen(tx, ctx, v.periodId)
    const d = await tx.payrollManualVariable.deleteMany({ where: { id: v.id, companyId: ctx.companyId } })
    if (d.count !== 1) fail(PREPAY_ERRORS.notFound)
    await touchPeriod(tx, ctx, p.id)
    await audit(tx, ctx, "UPDATED", p.id, AUDIT_VARIABLE_REMOVED)
    return undefined
  })
}

/** Calcul du mois depuis les données vivantes (salariés actifs, ou inactifs ayant des données dans le mois). */
export async function computePeriod(db: Reader, companyId: string, period: { id: string; year: number; month: number }): Promise<PrepayResult> {
  const { start, end } = monthBounds(period.year, period.month)
  const timeclocks = await db.timeclock.findMany({ where: { companyId, date: { gte: start, lt: end } }, orderBy: [{ date: "asc" }, { id: "asc" }], select: { employeeId: true, date: true, checkInAt: true, checkOutAt: true } })
  const absences = await db.absence.findMany({ where: { companyId, startDate: { lt: end }, endDate: { gte: start } }, orderBy: [{ startDate: "asc" }, { id: "asc" }], select: { id: true, employeeId: true, type: true, status: true, startDate: true, endDate: true } })
  const variables = await db.payrollManualVariable.findMany({ where: { companyId, periodId: period.id }, select: { employeeId: true, kind: true, amountCents: true } })
  const withData = [...new Set([...timeclocks.map((t) => t.employeeId), ...absences.map((a) => a.employeeId), ...variables.map((v) => v.employeeId)])]
  const employees = await db.employee.findMany({ where: { companyId, OR: [{ active: true }, { id: { in: withData } }] }, select: { id: true, firstName: true, lastName: true, active: true } })
  return computePrepay(period.year, period.month, {
    employees, timeclocks, variables,
    absences: absences.map((a) => ({ ...a, type: a.type as AbsenceKind })),
  })
}

export async function closePeriod(db: Db, ctx: PrepayContext, periodId: string, now: Date = serverNow()): Promise<PrepayResultT<{ sha256: string }>> {
  // Une relance au plus, sur un instantané neuf (saisie concurrente validée entre-temps : elle sera incluse).
  for (let tentative = 1; ; tentative++) {
    try {
      return await closeOnce(db, ctx, periodId, now)
    } catch (e) {
      if (!isSerializationConflict(e)) throw e
      if (tentative >= 2) return { ok: false, error: PREPAY_ERRORS.concurrent }
    }
  }
}

async function closeOnce(db: Db, ctx: PrepayContext, periodId: string, now: Date): Promise<PrepayResultT<{ sha256: string }>> {
  try {
    return { ok: true, value: await db.$transaction((tx) => closeInTx(tx, ctx, periodId, now), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }) }
  } catch (e) {
    if (e instanceof PrepayFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}

async function closeInTx(tx: Tx, ctx: PrepayContext, periodId: string, now: Date): Promise<{ sha256: string }> {
  // REPEATABLE READ : le verrou de la période puis toutes les lectures du calcul voient le même instantané de base.
  const p = await lockOpen(tx, ctx, periodId)
  const r = await computePeriod(tx, ctx.companyId, p)
  const n = blockingCount(r)
  if (n > 0) fail(PREPAY_ERRORS.blocking(n))
  const snapshot: PeriodSnapshot = { year: p.year, month: p.month, closedOn: formatDay(parisToday(now)), lines: r.lines, warnings: r.anomalies }
  const sha = snapshotSha256(snapshot)
  await tx.payrollPeriod.update({ where: { id: p.id }, data: { status: "CLOSED", snapshot: snapshot as unknown as Prisma.InputJsonObject, snapshotSha256: sha, closedById: ctx.userId, closedAt: now } })
  await audit(tx, ctx, "STATUS_CHANGED", p.id, `Période de pré-paie ${periodLabel(p.year, p.month)} clôturée (${r.lines.length} salarié(s), empreinte ${sha.slice(0, 12)})`)
  return { sha256: sha }
}
