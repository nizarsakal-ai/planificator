// Déclarations de TVA (SPEC-BILLING-C5 §3.3) : calcul puis enregistrement figé d'une période ; une déclaration par période.
import type { Prisma, PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { computeVat } from "./vat"

type Db = PrismaClient

export async function declareVat(db: Db, ctx: AccountingContext, periodStart: Date, periodEnd: Date, basis: "DEBITS" | "ENCAISSEMENTS"): Promise<LifecycleResult<{ id: string; dueCents: bigint }>> {
  if (periodEnd < periodStart) return { ok: false, error: "La fin de période précède le début." }
  if ((periodEnd.getTime() - periodStart.getTime()) / 86_400_000 > 370) return { ok: false, error: "Période trop longue (12 mois maximum)." }
  const existing = await db.vatDeclaration.findFirst({ where: { companyId: ctx.companyId, periodStart, periodEnd }, select: { id: true } })
  if (existing) return { ok: false, error: "Une déclaration existe déjà pour cette période." }
  const v = await computeVat(db, ctx, periodStart, periodEnd, basis)
  try {
    const d = await db.$transaction(async (tx) => {
      const row = await tx.vatDeclaration.create({
        data: {
          companyId: ctx.companyId, periodStart, periodEnd, basis, collectedCents: v.collectedCents, deductibleCents: v.deductibleCents, dueCents: v.dueCents,
          details: { collected: v.collected.map((r) => ({ vatRateBp: r.vatRateBp, baseCents: r.baseCents.toString(), vatCents: r.vatCents.toString() })), documents: v.documents, payments: v.payments, supplierInvoices: v.supplierInvoices } as Prisma.InputJsonValue,
          status: "DECLARED", declaredAt: new Date(), createdById: ctx.userId,
        },
        select: { id: true },
      })
      await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "VatDeclaration", entityId: row.id, detail: `Déclaration de TVA ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)} enregistrée (${basis})`, newValue: { collected: v.collectedCents.toString(), deductible: v.deductibleCents.toString(), due: v.dueCents.toString() } } })
      return row
    })
    return { ok: true, value: { id: d.id, dueCents: v.dueCents } }
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, error: "Une déclaration existe déjà pour cette période." }
    throw e
  }
}

export async function listVatDeclarations(db: Db, ctx: { companyId: string }) {
  return db.vatDeclaration.findMany({ where: { companyId: ctx.companyId }, orderBy: { periodStart: "desc" }, take: 36, select: { id: true, periodStart: true, periodEnd: true, basis: true, collectedCents: true, deductibleCents: true, dueCents: true, status: true, declaredAt: true } })
}
