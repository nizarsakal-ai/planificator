// Déclarations de TVA (SPEC-BILLING-C5 §3.3) : calcul puis enregistrement figé d'une période ; une déclaration par période.
//
// Correctif R5 (revue Codex R2 du 26/10/2026) :
// - une situation hors contrat fiscal signalée par le calcul (`warnings`, ex. encaissement conservé au-delà de la facture nette après
//   avoir) REFUSE l'enregistrement : aucune déclaration n'est figée tant que le cas n'est pas traité (aucun workflow d'exception dans
//   ce lot : il nécessiterait une décision de Nizar/expert-comptable) ; le refus cite les avertissements ;
// - les avertissements et le résultat du contrôle sont archivés dans `details` de la déclaration enregistrée (`warnings`, toujours
//   vide par construction, et `adjustments`), pour prouver a posteriori ce qui a été vérifié ;
// - contrôle d'unicité/chevauchement, calcul et écriture dans UNE transaction SERIALIZABLE (rejouée sur conflit de sérialisation) :
//   la déclaration figée reflète un instantané cohérent (un paiement committé pendant le calcul ne peut pas produire une déclaration
//   mêlant deux états) et deux déclarations concurrentes qui se chevauchent ne peuvent pas toutes deux être enregistrées (un verrou
//   consultatif pris en première instruction ne suffirait pas : l'instantané serait antérieur au commit concurrent).
import { Prisma, type PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { computeVat } from "./vat"
import { serverNow } from "@/lib/billing/clock"
import { businessDay } from "@/lib/billing/business-day"

type Db = PrismaClient

export const VAT_DECLARATION_ERRORS = {
  alreadyDeclared: "Une déclaration existe déjà pour cette période.",
  overlaps: "La période chevauche une déclaration déjà enregistrée.",
  notEnded: "La période n'est pas terminée : une déclaration ne se fige qu'après son dernier jour.",
  outOfContract: "Déclaration refusée : la période comporte une situation hors contrat fiscal à traiter avant tout enregistrement.",
  basisMismatch: "Régime de TVA unique par société : la base demandée diffère de celle des déclarations déjà enregistrées.",
} as const

export async function declareVat(db: Db, ctx: AccountingContext, periodStart: Date, periodEnd: Date, basis: "DEBITS" | "ENCAISSEMENTS"): Promise<LifecycleResult<{ id: string; dueCents: bigint }>> {
  if (periodEnd < periodStart) return { ok: false, error: "La fin de période précède le début." }
  if ((periodEnd.getTime() - periodStart.getTime()) / 86_400_000 > 370) return { ok: false, error: "Période trop longue (12 mois maximum)." }
  // Même famille (C1 de l'audit R2) : une période non terminée ne se fige pas (montants incomplets) ; « aujourd'hui » = horloge serveur.
  const todayDay = businessDay(serverNow()) // jour civil Europe/Paris (S3)
  if (periodEnd >= todayDay) return { ok: false, error: VAT_DECLARATION_ERRORS.notEnded }
  for (let attempt = 1; ; attempt++) {
  try {
    return await db.$transaction(async (tx): Promise<LifecycleResult<{ id: string; dueCents: bigint }>> => {
      const existing = await tx.vatDeclaration.findFirst({ where: { companyId: ctx.companyId, periodStart, periodEnd }, select: { id: true } })
      if (existing) return { ok: false, error: VAT_DECLARATION_ERRORS.alreadyDeclared }
      // Même famille U1 (cycle R5) : le régime (débits / encaissements) est une option de la société, pas de la période — mélanger les bases
      // d'une déclaration à l'autre déclarerait deux fois (ou jamais) la même TVA ; la base des déclarations existantes fait foi.
      const otherBasis = await tx.vatDeclaration.findFirst({ where: { companyId: ctx.companyId, basis: { not: basis } }, select: { basis: true, periodStart: true, periodEnd: true } })
      if (otherBasis) return { ok: false, error: `${VAT_DECLARATION_ERRORS.basisMismatch} (${otherBasis.basis === "DEBITS" ? "débits" : "encaissements"}, ex. ${otherBasis.periodStart.toISOString().slice(0, 10)} → ${otherBasis.periodEnd.toISOString().slice(0, 10)})` }
      // Chevauchement : [start, end] ∩ [s', e'] ≠ ∅ — la même pièce/le même mouvement ne peut pas être déclaré deux fois.
      const overlap = await tx.vatDeclaration.findFirst({ where: { companyId: ctx.companyId, periodStart: { lte: periodEnd }, periodEnd: { gte: periodStart } }, select: { periodStart: true, periodEnd: true } })
      if (overlap) return { ok: false, error: `${VAT_DECLARATION_ERRORS.overlaps} (${overlap.periodStart.toISOString().slice(0, 10)} → ${overlap.periodEnd.toISOString().slice(0, 10)})` }
      const v = await computeVat(tx, ctx, periodStart, periodEnd, basis)
      if (v.warnings.length > 0) return { ok: false, error: `${VAT_DECLARATION_ERRORS.outOfContract} ${v.warnings.join(" ")}` }
      const row = await tx.vatDeclaration.create({
        data: {
          companyId: ctx.companyId, periodStart, periodEnd, basis, collectedCents: v.collectedCents, deductibleCents: v.deductibleCents, dueCents: v.dueCents,
          details: {
            collected: v.collected.map((r) => ({ vatRateBp: r.vatRateBp, baseCents: r.baseCents.toString(), vatCents: r.vatCents.toString() })),
            documents: v.documents, payments: v.payments, adjustments: v.adjustments, supplierInvoices: v.supplierInvoices,
            warnings: v.warnings, outOfContractChecked: true,
            ...(v.allocationHistory ? { allocationHistory: v.allocationHistory } : {}),
          } as Prisma.InputJsonValue,
          status: "DECLARED", declaredAt: new Date(), createdById: ctx.userId,
        },
        select: { id: true },
      })
      await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "VatDeclaration", entityId: row.id, detail: `Déclaration de TVA ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)} enregistrée (${basis})`, newValue: { collected: v.collectedCents.toString(), deductible: v.deductibleCents.toString(), due: v.dueCents.toString(), warnings: 0 } } })
      return { ok: true, value: { id: row.id, dueCents: v.dueCents } }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 10_000 }) // délais alignés sur runAccountingTransaction : le calcul complet tourne dans la transaction
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "P2002") return { ok: false, error: VAT_DECLARATION_ERRORS.alreadyDeclared }
    if (code === "P2034" && attempt < 5) continue // conflit de sérialisation : rejeu avec un nouvel instantané (le concurrent est alors visible)
    throw e
  }
  }
}

export async function listVatDeclarations(db: Db, ctx: { companyId: string }) {
  return db.vatDeclaration.findMany({ where: { companyId: ctx.companyId }, orderBy: { periodStart: "desc" }, take: 36, select: { id: true, periodStart: true, periodEnd: true, basis: true, collectedCents: true, deductibleCents: true, dueCents: true, status: true, declaredAt: true } })
}
