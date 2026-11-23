/**
 * Lot D Planificator V2 : lecture des faits commerciaux d'une période, bornée par `companyId` (session), en une
 * transaction en lecture répétable (instantané cohérent entre devis, factures et lignes). LECTURE SEULE de la
 * facturation : aucune écriture, aucun service Finance modifié. Émission = `sentAt` renseigné (règle du lot C).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"
import { computeSalesIndicators, decimalToMilli, type Period, type SalesFacts } from "@/lib/sales-dashboard/sales.core"

const DAY = 86_400_000

export async function salesIndicators(db: PrismaClient, companyId: string, period: Period) {
  // Marge d'un jour de chaque côté : le filtrage exact par jour civil de Paris est fait par computeSalesIndicators.
  const range = { gte: new Date(period.from.getTime() - DAY), lt: new Date(period.to.getTime() + DAY) }
  const facts = await db.$transaction(async (tx): Promise<SalesFacts> => {
    const quotes = await tx.quote.findMany({ where: { companyId, issueDate: range, status: { not: "DRAFT" } }, select: { status: true, issueDate: true, totalHT: true } })
    const invoices = await tx.invoice.findMany({
      where: { companyId, issueDate: range, sentAt: { not: null } },
      select: { id: true, kind: true, issueDate: true, totalHT: true, clientId: true, worksiteId: true, client: { select: { name: true } }, worksite: { select: { name: true } } },
    })
    const ids = invoices.map((i) => i.id)
    const lines: SalesFacts["lines"][number][] = []
    for (let k = 0; k < ids.length; k += 500) {
      const part = await tx.invoiceLine.findMany({ where: { invoice: { companyId }, invoiceId: { in: ids.slice(k, k + 500) }, articleId: { not: null } }, select: { invoiceId: true, articleId: true, deductsDepositId: true, designation: true, quantity: true, lineHT: true } })
      for (const l of part) lines.push({ invoiceId: l.invoiceId, articleId: l.articleId, deductsDeposit: l.deductsDepositId !== null, designation: l.designation, quantityMilli: decimalToMilli(l.quantity.toFixed(3)), lineHTCents: decimalToCents(l.lineHT) })
    }
    return {
      quotes: quotes.map((q) => ({ status: q.status, issueDate: q.issueDate, totalHTCents: decimalToCents(q.totalHT) })),
      invoices: invoices.map((i) => ({ id: i.id, kind: i.kind, issued: true, issueDate: i.issueDate, totalHTCents: decimalToCents(i.totalHT), clientId: i.clientId, clientName: i.client.name, worksiteId: i.worksiteId, worksiteName: i.worksite.name })),
      lines,
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 20000 })
  return computeSalesIndicators(facts, period)
}
