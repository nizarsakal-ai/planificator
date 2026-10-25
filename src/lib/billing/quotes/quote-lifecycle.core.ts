// ═══════════════════════════════════════════════════════════════════════════
// Devis — automate (SPEC-BILLING-C1 §3) : DRAFT → SENT → ACCEPTED → CONVERTED ; SENT → REFUSED ;
// DRAFT/SENT → EXPIRED. Aucun retour arrière. Chaque transition est conditionnée au statut lu
// (UPDATE … WHERE status = attendu) et tracée dans HistoryLog, dans la même transaction.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma } from "@prisma/client"

export type QuoteStatusValue = "DRAFT" | "SENT" | "ACCEPTED" | "REFUSED" | "EXPIRED" | "CONVERTED"

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatusValue, readonly QuoteStatusValue[]>> = {
  DRAFT: ["SENT", "EXPIRED"],
  SENT: ["ACCEPTED", "REFUSED", "EXPIRED"],
  ACCEPTED: ["CONVERTED"],
  REFUSED: [],
  EXPIRED: [],
  CONVERTED: [],
}

export function canQuoteTransition(from: QuoteStatusValue, to: QuoteStatusValue): boolean {
  return QUOTE_TRANSITIONS[from]?.includes(to) ?? false
}

export const QUOTE_ERRORS = {
  notFound: "Devis introuvable.",
  forbidden: "Changement de statut non autorisé.",
  conflict: "Le devis a été modifié entre-temps. Rechargez la page.",
  notDraft: "Seul un devis brouillon peut être modifié.",
  notAccepted: "Seul un devis accepté peut être converti en facture.",
  noEmail: "Le client n'a pas d'adresse e-mail : renseignez-la avant l'envoi.",
  notSent: "Ce devis n'est pas en attente de signature.",
  tokenInvalid: "Lien de signature invalide ou expiré.",
} as const

export type LifecycleResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

export interface QuoteTransitionInput {
  companyId: string
  quoteId: string
  to: Exclude<QuoteStatusValue, "DRAFT">
  actorId: string
  now: Date
  /** Champs supplémentaires posés avec la transition (sentAt, signerName…), déjà validés par l'appelant. */
  data?: Prisma.QuoteUpdateManyMutationInput
  detail?: string
}

export async function transitionQuoteCore(tx: Prisma.TransactionClient, input: QuoteTransitionInput): Promise<LifecycleResult<{ from: QuoteStatusValue }>> {
  const quote = await tx.quote.findFirst({
    where: { id: input.quoteId, companyId: input.companyId },
    select: { id: true, status: true, number: true, worksiteId: true },
  })
  if (!quote) return { ok: false, error: QUOTE_ERRORS.notFound }
  const from = quote.status as QuoteStatusValue
  if (!canQuoteTransition(from, input.to)) return { ok: false, error: QUOTE_ERRORS.forbidden }

  const stamps: Prisma.QuoteUpdateManyMutationInput =
    input.to === "SENT" ? { sentAt: input.now }
    : input.to === "ACCEPTED" ? { acceptedAt: input.now }
    : input.to === "REFUSED" ? { refusedAt: input.now }
    : input.to === "EXPIRED" ? { expiredAt: input.now }
    : { convertedAt: input.now }
  const updated = await tx.quote.updateMany({
    where: { id: quote.id, companyId: input.companyId, status: from },
    data: { status: input.to, ...stamps, ...(input.data ?? {}) },
  })
  if (updated.count !== 1) return { ok: false, error: QUOTE_ERRORS.conflict }

  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: quote.worksiteId, actorId: input.actorId,
      action: "STATUS_CHANGED", entityType: "Quote", entityId: quote.id,
      detail: input.detail ?? `Devis ${quote.number} : ${from} → ${input.to}`,
      oldValue: { status: from }, newValue: { status: input.to },
    },
  })
  return { ok: true, value: { from } }
}

export interface QuoteDraftLine {
  articleId: string | null
  designation: string
  description: string | null
  unit: string
  quantity: string      // chaîne décimale pour Decimal(10,2)
  unitPrice: string
  vatRate: string
  lineHT: string
  discountBp: number
  position: number
}

export interface QuoteDraftHeader {
  worksiteId?: string
  clientId?: string
  issueDate: Date
  validUntil: Date | null
  subject: string | null
  notes: string | null
  paymentTerms: string | null
  globalDiscountBp: number
  vatReverseCharge: boolean
  totalHT: string
  totalVAT: string
  totalTTC: string
}

export interface ReplaceQuoteDraftInput {
  companyId: string
  quoteId: string
  actorId: string
  header: QuoteDraftHeader
  lines: QuoteDraftLine[]
}

/** Remplace l'en-tête et les lignes d'un brouillon : contrôle DRAFT et mise à jour en une instruction conditionnelle. */
export async function replaceQuoteDraftCore(tx: Prisma.TransactionClient, input: ReplaceQuoteDraftInput): Promise<LifecycleResult> {
  const locked = await tx.quote.updateMany({
    where: { id: input.quoteId, companyId: input.companyId, status: "DRAFT" },
    data: { ...input.header },
  })
  if (locked.count !== 1) {
    const exists = await tx.quote.findFirst({ where: { id: input.quoteId, companyId: input.companyId }, select: { id: true } })
    return { ok: false, error: exists ? QUOTE_ERRORS.notDraft : QUOTE_ERRORS.notFound }
  }
  await tx.quoteLine.deleteMany({ where: { quoteId: input.quoteId } })
  if (input.lines.length > 0) {
    await tx.quoteLine.createMany({ data: input.lines.map((l) => ({ ...l, quoteId: input.quoteId })) })
  }
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, actorId: input.actorId, action: "UPDATED", entityType: "Quote", entityId: input.quoteId,
      detail: `Brouillon de devis modifié (${input.lines.length} ligne${input.lines.length > 1 ? "s" : ""})`,
      newValue: { totalTTC: input.header.totalTTC, lines: input.lines.length },
    },
  })
  return { ok: true, value: undefined }
}

export interface ConvertQuoteInput {
  companyId: string
  quoteId: string
  actorId: string
  now: Date
  /** Échéance de la facture = date du jour + délai (jours). */
  paymentTermsDays: number
  /** Numéro provisoire du brouillon (le numéro légal est attribué à l'émission, C2). */
  nextDraftNumber: (tx: Prisma.TransactionClient) => Promise<string>
  /** Verrou de la ligne devis (FOR UPDATE) : injectable pour les tests sans base. */
  lockQuote: (tx: Prisma.TransactionClient, quoteId: string, companyId: string) => Promise<void>
}

/**
 * Conversion ACCEPTED → CONVERTED : verrou du devis, idempotence (une facture INVOICE liée au devis existe ⇒
 * renvoyée telle quelle), création d'une facture DRAFT copie des lignes, puis transition. Tout ou rien.
 */
export async function convertQuoteCore(tx: Prisma.TransactionClient, input: ConvertQuoteInput): Promise<LifecycleResult<{ invoiceId: string; invoiceNumber: string; existing: boolean }>> {
  await input.lockQuote(tx, input.quoteId, input.companyId)
  const quote = await tx.quote.findFirst({
    where: { id: input.quoteId, companyId: input.companyId },
    select: {
      id: true, status: true, number: true, worksiteId: true, clientId: true, notes: true, paymentTerms: true,
      totalHT: true, totalVAT: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true,
      worksite: { select: { startDate: true, endDate: true } },
      lines: { orderBy: { position: "asc" }, select: { articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true, position: true } },
    },
  })
  if (!quote) return { ok: false, error: QUOTE_ERRORS.notFound }
  const existing = await tx.invoice.findFirst({
    where: { companyId: input.companyId, quoteId: quote.id, kind: "INVOICE", status: { not: "CANCELLED" } },
    select: { id: true, number: true },
  })
  if (quote.status === "CONVERTED" && existing) return { ok: true, value: { invoiceId: existing.id, invoiceNumber: existing.number, existing: true } }
  if (quote.status !== "ACCEPTED") return { ok: false, error: QUOTE_ERRORS.notAccepted }
  if (existing) return { ok: true, value: { invoiceId: existing.id, invoiceNumber: existing.number, existing: true } }

  const number = await input.nextDraftNumber(tx)
  const dueDate = new Date(input.now.getTime() + input.paymentTermsDays * 86_400_000)
  const invoice = await tx.invoice.create({
    data: {
      companyId: input.companyId, worksiteId: quote.worksiteId, clientId: quote.clientId, quoteId: quote.id,
      number, status: "DRAFT", kind: "INVOICE", issueDate: input.now, dueDate,
      periodStart: quote.worksite.startDate, periodEnd: quote.worksite.endDate,
      totalHT: quote.totalHT, totalVAT: quote.totalVAT, totalTTC: quote.totalTTC,
      globalDiscountBp: quote.globalDiscountBp, vatReverseCharge: quote.vatReverseCharge,
      notes: quote.notes, paymentTerms: quote.paymentTerms, createdById: input.actorId,
      lines: { create: quote.lines.map((l) => ({ ...l })) },
    },
    select: { id: true, number: true },
  })
  const t = await transitionQuoteCore(tx, {
    companyId: input.companyId, quoteId: quote.id, to: "CONVERTED", actorId: input.actorId, now: input.now,
    detail: `Devis ${quote.number} converti en facture ${invoice.number}`,
  })
  // La facture a déjà été écrite : un échec ici doit annuler la transaction entière (jamais de facture orpheline).
  if (!t.ok) throw new Error(`QUOTE_CONVERT_CONFLICT: ${t.error}`)
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: quote.worksiteId, actorId: input.actorId, action: "CREATED", entityType: "Invoice", entityId: invoice.id,
      detail: `Facture ${invoice.number} créée (brouillon) depuis le devis ${quote.number}`, newValue: { quoteId: quote.id },
    },
  })
  return { ok: true, value: { invoiceId: invoice.id, invoiceNumber: invoice.number, existing: false } }
}
