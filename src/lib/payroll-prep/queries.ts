/** Lot H Planificator V2 : lectures de la pré-paie, bornées par `companyId`. */
import type { PrismaClient } from "@prisma/client"
import { readSnapshot } from "@/lib/payroll-prep/prepay.core"
import { computePeriod, snapshotSha256 } from "@/lib/payroll-prep/prepay.service"

type Db = PrismaClient

export async function listPeriods(db: Db, companyId: string) {
  return db.payrollPeriod.findMany({ where: { companyId }, orderBy: [{ year: "desc" }, { month: "desc" }], take: 60, select: { id: true, year: true, month: true, status: true, closedAt: true } })
}

/** Période et ses variables : clôturée ⇒ relue depuis l'instantané (vérifié par son empreinte) ; ouverte ⇒ calculée. */
export async function getPeriodView(db: Db, companyId: string, id: string) {
  const p = await db.payrollPeriod.findFirst({ where: { id, companyId }, select: { id: true, year: true, month: true, status: true, snapshot: true, snapshotSha256: true, closedAt: true } })
  if (!p) return null
  const variables = await db.payrollManualVariable.findMany({
    where: { companyId, periodId: p.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, amountCents: true, label: true, employee: { select: { firstName: true, lastName: true } } },
  })
  if (p.status === "CLOSED") {
    const s = readSnapshot(p.snapshot)
    const intact = !!s && snapshotSha256(s) === p.snapshotSha256
    return { period: p, variables, lines: s?.lines ?? [], anomalies: s?.warnings ?? [], intact, provisional: false }
  }
  const r = await computePeriod(db, companyId, p)
  return { period: p, variables, lines: r.lines, anomalies: r.anomalies, intact: true, provisional: true }
}
