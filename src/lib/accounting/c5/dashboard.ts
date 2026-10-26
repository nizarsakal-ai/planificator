// Tableau de bord comptable (SPEC-BILLING-C5 §3.2) — TOUT est filtré par la société du contexte (défaut n° 1 de PrintManager corrigé).
import type { Prisma, PrismaClient } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"
import { DocumentIntegrityError, recomputeDocumentTotals, storedTotalsMatch } from "@/lib/billing/document-integrity"
import { computeVat } from "./vat"

type Db = PrismaClient | Prisma.TransactionClient

export interface DashboardData {
  revenueMonthHTCents: bigint; revenueYearHTCents: bigint
  unpaid: { count: number; remainingCents: bigint; overdueCount: number }
  vat: { collectedCents: bigint; deductibleCents: bigint; dueCents: bigint; periodStart: Date; periodEnd: Date; basis: "DEBITS" | "ENCAISSEMENTS" }
  revenue12Months: { period: string; htCents: bigint }[]
  supplierByCategory: { category: string; htCents: bigint; count: number }[]
  /** Correctif P1-01 : pièces émises dont les totaux persistés diffèrent du recalcul — signalées, EXCLUES des indicateurs. */
  inconsistentDocuments: string[]
  vatWarnings: string[]
}

export async function accountingDashboard(db: Db, ctx: { companyId: string }, now: Date, vatRegime: "DEBITS" | "ENCAISSEMENTS"): Promise<DashboardData> {
  const companyId = ctx.companyId
  const y = now.getUTCFullYear(), m = now.getUTCMonth()
  const yearStart = new Date(Date.UTC(y, 0, 1)), monthStart = new Date(Date.UTC(y, m, 1))
  const start12 = new Date(Date.UTC(y, m - 11, 1))
  const docs = await db.invoice.findMany({
    where: { companyId, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, sentAt: { not: null }, issueDate: { gte: start12 < yearStart ? start12 : yearStart } },
    select: { number: true, status: true, kind: true, issueDate: true, globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } },
  })
  const inconsistentDocuments: string[] = []
  const buckets = new Map<string, bigint>()
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, m - i, 1)); buckets.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, BigInt(0)) }
  let month = BigInt(0), year = BigInt(0)
  for (const d of docs) {
    const t = recomputeDocumentTotals(d)
    if (!storedTotalsMatch(d, t)) { inconsistentDocuments.push(d.number); continue }
    const ht = (d.kind === "CREDIT_NOTE" ? BigInt(-1) : BigInt(1)) * t.totalHTCents
    if (d.issueDate >= yearStart) year += ht
    if (d.issueDate >= monthStart) month += ht
    const key = `${d.issueDate.getUTCFullYear()}-${String(d.issueDate.getUTCMonth() + 1).padStart(2, "0")}`
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? BigInt(0)) + ht)
  }
  const open = await db.invoice.findMany({ where: { companyId, status: { in: ["SENT", "PARTIAL"] }, kind: { not: "CREDIT_NOTE" } }, select: { totalTTC: true, dueDate: true, payments: { select: { amountCents: true } }, creditNotes: { where: { creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } } } })
  const today = new Date(Date.UTC(y, m, now.getUTCDate()))
  let remaining = BigInt(0), overdueCount = 0
  // Reste dû = TTC − paiements − avoirs partiels (règle C2/C4).
  for (const i of open) { remaining += decimalToCents(i.totalTTC) - i.payments.reduce((s, p) => s + p.amountCents, BigInt(0)) - i.creditNotes.reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0)); if (i.dueDate && i.dueDate < today) overdueCount++ }
  const vatPeriodEnd = new Date(Date.UTC(y, m + 1, 0))
  let vat: Awaited<ReturnType<typeof computeVat>>
  try {
    vat = await computeVat(db, ctx, monthStart, vatPeriodEnd, vatRegime)
  } catch (e) {
    // P1-01 : une pièce incohérente rend la TVA du mois NON calculable ; le tableau de bord le dit au lieu d'afficher un autre montant.
    if (!(e instanceof DocumentIntegrityError)) throw e
    if (!inconsistentDocuments.includes(e.documentNumber)) inconsistentDocuments.push(e.documentNumber)
    vat = { basis: vatRegime, periodStart: monthStart, periodEnd: vatPeriodEnd, collected: [], collectedCents: BigInt(0), deductibleCents: BigInt(0), dueCents: BigInt(0), documents: 0, payments: 0, supplierInvoices: 0, warnings: [`TVA du mois non calculable : pièce ${e.documentNumber} incohérente (totaux enregistrés ≠ recalcul).`] }
  }
  const sup = await db.supplierInvoice.groupBy({ by: ["category"], where: { companyId, status: "VALIDATED", date: { gte: yearStart } }, _sum: { totalHTCents: true }, _count: { _all: true } })
  return {
    revenueMonthHTCents: month, revenueYearHTCents: year,
    unpaid: { count: open.length, remainingCents: remaining, overdueCount },
    vat: { collectedCents: vat.collectedCents, deductibleCents: vat.deductibleCents, dueCents: vat.dueCents, periodStart: vat.periodStart, periodEnd: vat.periodEnd, basis: vat.basis },
    revenue12Months: [...buckets.entries()].map(([period, htCents]) => ({ period, htCents })),
    supplierByCategory: sup.map((s) => ({ category: s.category ?? "autre", htCents: s._sum.totalHTCents ?? BigInt(0), count: s._count._all })).sort((a, b) => (b.htCents > a.htCents ? 1 : -1)),
    inconsistentDocuments, vatWarnings: vat.warnings,
  }
}
