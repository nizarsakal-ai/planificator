"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createInvoiceSchema, invoiceLineSchema, type InvoiceLineInput } from "@/lib/validations/invoice"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { computeLineHT, computeTotals } from "@/lib/billing/totals"
import {
  createCreditNoteCore,
  parseRequestedStatus,
  replaceDraftLinesCore,
  transitionInvoiceCore,
} from "@/lib/billing/invoice-lifecycle.core"

// Facturation réservée aux administrateurs (pas TEAM_LEADER).
/**
 * Invariant PostgreSQL de facturation (déclencheurs Lot B) refusé dans la transaction : message lisible
 * au lieu d'une erreur serveur brute. Les autres erreurs sont relancées telles quelles.
 */
function billingIntegrityError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ""
  const code = /\b(INVOICE_[A-Z_]+|CREDIT_NOTE_INVALID|PAYMENT_[A-Z_]+|DOCUMENT_SNAPSHOT_[A-Z_]+|DEPOSIT_DEDUCTION_[A-Z_]+)\b/.exec(message)?.[1]
  if (!code) return null
  // Lot C2 : une facture avec paiements enregistrés ne se solde plus manuellement (enregistrez le paiement restant).
  if (code.startsWith("PAYMENT_")) return "Opération refusée : des paiements sont enregistrés sur cette facture (utilisez la fiche facture)."
  if (code === "CREDIT_NOTE_INVALID") return "Avoir refusé : il doit reprendre exactement la facture d'origine."
  if (code === "INVOICE_CANCEL_WITHOUT_CREDIT_NOTE") return "Une facture émise ne s'annule que par un avoir."
  return "Opération refusée : une facture émise n'est plus modifiable."
}

async function requireBillingAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

function mapLines(lines: InvoiceLineInput[]) {
  return lines.map((l, i) => ({
    articleId:   l.articleId || null,
    designation: l.designation,
    unit:        l.unit,
    quantity:    l.quantity,
    unitPrice:   l.unitPrice,
    vatRate:     l.vatRate,
    lineHT:      computeLineHT(l),
    position:    i,
  }))
}

/**
 * Crée une facture (brouillon) pour un chantier. La période facturée est calée
 * sur les dates de début/fin du chantier. Numéro séquentiel généré de façon
 * atomique. L'IA (étape C) réutilisera cette action.
 */
export async function createInvoice(input: unknown) {
  const user = await requireBillingAdmin()

  const parsed = createInvoiceSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.errors[0].message }
  const data = parsed.data

  // Le chantier doit appartenir à l'entreprise de l'admin (isolation multi-tenant).
  const worksite = await prisma.worksite.findFirst({
    where:  { id: data.worksiteId, companyId: user.companyId! },
    select: { id: true, clientId: true, startDate: true, endDate: true },
  })
  if (!worksite) return { error: "Chantier introuvable." }

  // Si un devis est lié, vérifier qu'il appartient bien à l'entreprise.
  if (data.quoteId) {
    const quote = await prisma.quote.findFirst({
      where:  { id: data.quoteId, companyId: user.companyId! },
      select: { id: true },
    })
    if (!quote) return { error: "Devis lié introuvable." }
  }

  const lines = mapLines(data.lines)
  const totals = computeTotals(data.lines)

  const invoice = await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, user.companyId!, "INVOICE")
    const created = await tx.invoice.create({
      data: {
        companyId:   user.companyId!,
        worksiteId:  worksite.id,
        clientId:    worksite.clientId,
        quoteId:     data.quoteId || null,
        number,
        status:      "DRAFT",
        dueDate:     data.dueDate ? new Date(data.dueDate) : null,
        periodStart: worksite.startDate,
        periodEnd:   worksite.endDate,
        notes:       data.notes || null,
        createdById: user.id,
        totalHT:     totals.totalHT,
        totalVAT:    totals.totalVAT,
        totalTTC:    totals.totalTTC,
        lines:       { create: lines },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({
      data: {
        companyId:  user.companyId!,
        worksiteId: worksite.id,
        actorId:    user.id,
        action:     "CREATED",
        entityType: "Invoice",
        entityId:   created.id,
        detail:     `Facture ${created.number} créée (brouillon)`,
      },
    })
    await flushDeferredConstraints(tx)
    return created
  })

  revalidatePath("/factures")
  return { success: true, id: invoice.id, number: invoice.number }
}

/**
 * Remplace intégralement les lignes d'une facture brouillon et recalcule les totaux.
 * Lot B : contrôle DRAFT et remplacement dans UNE transaction conditionnelle (pas de course avec l'émission).
 */
export async function setInvoiceLines(invoiceId: string, rawLines: unknown) {
  const user = await requireBillingAdmin()
  if (typeof invoiceId !== "string" || !invoiceId) return { error: "Facture introuvable." }

  const parsed = z.array(invoiceLineSchema).safeParse(rawLines)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const lines = mapLines(parsed.data)
  const totals = computeTotals(parsed.data)

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const r = await replaceDraftLinesCore(tx, { companyId: user.companyId!, invoiceId, actorId: user.id, lines, totals })
      if (r.ok) await flushDeferredConstraints(tx)
      return r
    })
  } catch (error) {
    const mapped = billingIntegrityError(error)
    if (mapped) return { error: mapped }
    throw error
  }
  if (!result.ok) return { error: result.error }

  revalidatePath("/factures")
  return { success: true }
}

/**
 * Fait évoluer le statut d'une facture. Lot B : statut validé à l'exécution, automate sans retour
 * arrière, mise à jour conditionnelle et trace d'audit. Une facture émise s'annule par avoir.
 */
export async function updateInvoiceStatus(invoiceId: string, status: unknown) {
  const user = await requireBillingAdmin()
  const to = parseRequestedStatus(status)
  if (!to) return { error: "Statut invalide." }
  if (typeof invoiceId !== "string" || !invoiceId) return { error: "Facture introuvable." }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const r = await transitionInvoiceCore(tx, { companyId: user.companyId!, invoiceId, to, actorId: user.id, now: new Date() })
      if (r.ok) await flushDeferredConstraints(tx)
      return r
    })
  } catch (error) {
    const mapped = billingIntegrityError(error)
    if (mapped) return { error: mapped }
    throw error
  }
  if (!result.ok) return { error: result.error }

  revalidatePath("/factures")
  return { success: true }
}

/** Émet un avoir total sur une facture envoyée ou payée, qui passe à « annulée ». */
export async function createCreditNote(invoiceId: string, reason?: unknown) {
  const user = await requireBillingAdmin()
  if (typeof invoiceId !== "string" || !invoiceId) return { error: "Facture introuvable." }
  const motive = typeof reason === "string" ? reason.trim().slice(0, 500) : ""

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const r = await createCreditNoteCore(tx, {
        companyId: user.companyId!,
        invoiceId,
        actorId: user.id,
        reason: motive || null,
        now: new Date(),
        nextNumber: (t) => nextDocumentNumber(t, user.companyId!, "CREDIT_NOTE"),
      })
      // Prisma avale les erreurs levées au COMMIT : les invariants différés (avoir = copie exacte,
      // annulation par avoir uniquement) sont évalués ici, avant le COMMIT.
      if (r.ok) await flushDeferredConstraints(tx)
      return r
    })
  } catch (error) {
    const mapped = billingIntegrityError(error)
    if (mapped) return { error: mapped }
    throw error
  }
  if (!result.ok) return { error: result.error }
  // Lot C5 : écriture de l'avoir (si l'auto-génération comptable est activée ; jamais bloquant).
  const { autoPostIfEnabled } = await import("@/lib/accounting/c5/auto-post")
  await autoPostIfEnabled(prisma, { companyId: user.companyId!, userId: user.id }, "INVOICE", result.value.id)

  revalidatePath("/factures")
  return { success: true, id: result.value.id, number: result.value.number }
}
