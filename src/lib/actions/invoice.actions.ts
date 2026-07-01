"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createInvoiceSchema, invoiceLineSchema, type InvoiceLineInput } from "@/lib/validations/invoice"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { computeLineHT, computeTotals } from "@/lib/billing/totals"

// Facturation réservée aux administrateurs (pas TEAM_LEADER).
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
    return tx.invoice.create({
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
  })

  revalidatePath("/factures")
  return { success: true, id: invoice.id, number: invoice.number }
}

/** Remplace intégralement les lignes d'une facture brouillon et recalcule les totaux. */
export async function setInvoiceLines(invoiceId: string, rawLines: unknown) {
  const user = await requireBillingAdmin()

  const existing = await prisma.invoice.findFirst({
    where:  { id: invoiceId, companyId: user.companyId! },
    select: { id: true, status: true },
  })
  if (!existing) return { error: "Facture introuvable." }
  if (existing.status !== "DRAFT") return { error: "Seule une facture brouillon peut être modifiée." }

  const parsed = z.array(invoiceLineSchema).safeParse(rawLines)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const lines = mapLines(parsed.data)
  const totals = computeTotals(parsed.data)

  await prisma.$transaction([
    prisma.invoiceLine.deleteMany({ where: { invoiceId } }),
    prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        totalHT:  totals.totalHT,
        totalVAT: totals.totalVAT,
        totalTTC: totals.totalTTC,
        lines:    { create: lines },
      },
    }),
  ])

  revalidatePath("/factures")
  return { success: true }
}

/** Fait évoluer le statut d'une facture (envoyée / payée / annulée). */
export async function updateInvoiceStatus(
  invoiceId: string,
  status: "SENT" | "PAID" | "CANCELLED"
) {
  const user = await requireBillingAdmin()

  const existing = await prisma.invoice.findFirst({
    where:  { id: invoiceId, companyId: user.companyId! },
    select: { id: true },
  })
  if (!existing) return { error: "Facture introuvable." }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status,
      ...(status === "SENT" ? { sentAt: new Date() } : {}),
      ...(status === "PAID" ? { paidAt: new Date() } : {}),
    },
  })

  revalidatePath("/factures")
  return { success: true }
}
