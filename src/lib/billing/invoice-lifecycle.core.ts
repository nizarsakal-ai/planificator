// ═══════════════════════════════════════════════════════════════════════════
// Facturation — Lot B minimal (ADR-PLAN-003) : cycle de vie irréversible.
//
// Règles :
// - DRAFT → SENT (émission) ; SENT → PAID ; DRAFT → CANCELLED (brouillon abandonné).
// - Aucun retour à DRAFT. Une facture émise (SENT/PAID) ne s'annule QUE par un avoir
//   total référencé (createCreditNoteCore), qui la passe à CANCELLED dans la même transaction.
// - Chaque changement est conditionné au statut lu (UPDATE … WHERE status = attendu) :
//   une modification concurrente fait échouer l'opération au lieu de l'écraser.
// - Un avoir est immuable dès sa création (créé brouillon puis émis dans la même transaction).
// - Toute opération écrit une trace HistoryLog dans la même transaction.
// La base applique les mêmes interdits (déclencheurs de la migration billing_lot_b_minimal).
// ═══════════════════════════════════════════════════════════════════════════

import type { Prisma } from "@prisma/client"

export type InvoiceStatusValue = "DRAFT" | "SENT" | "PAID" | "CANCELLED"
export type RequestedInvoiceStatus = "SENT" | "PAID" | "CANCELLED"

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatusValue, readonly InvoiceStatusValue[]>> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["PAID"],
  PAID: [],
  CANCELLED: [],
}

export type LifecycleResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

const STATUSES: readonly string[] = ["DRAFT", "SENT", "PAID", "CANCELLED"]

/** Validation d'exécution : une Server Action reçoit des données non fiables. */
export function parseRequestedStatus(value: unknown): RequestedInvoiceStatus | null {
  return value === "SENT" || value === "PAID" || value === "CANCELLED" ? value : null
}

export function canTransition(from: InvoiceStatusValue, to: InvoiceStatusValue): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false
}

function isStatus(value: unknown): value is InvoiceStatusValue {
  return typeof value === "string" && STATUSES.includes(value)
}

export const LIFECYCLE_ERRORS = {
  notFound: "Facture introuvable.",
  creditNoteImmutable: "Un avoir émis ne peut pas être modifié.",
  cancelIssued: "Une facture émise ne s'annule pas : créez un avoir.",
  forbidden: "Changement de statut non autorisé.",
  conflict: "La facture a été modifiée entre-temps. Rechargez la page.",
  notDraft: "Seule une facture brouillon peut être modifiée.",
  notCreditable: "Seule une facture émise (envoyée ou payée) peut faire l'objet d'un avoir.",
  alreadyCredited: "Cette facture a déjà un avoir.",
} as const

export interface TransitionInput {
  companyId: string
  invoiceId: string
  to: RequestedInvoiceStatus
  actorId: string
  now: Date
}

export async function transitionInvoiceCore(
  tx: Prisma.TransactionClient,
  input: TransitionInput
): Promise<LifecycleResult> {
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    select: { id: true, status: true, kind: true, number: true, worksiteId: true },
  })
  if (!invoice || !isStatus(invoice.status)) return { ok: false, error: LIFECYCLE_ERRORS.notFound }
  if (invoice.kind !== "INVOICE") return { ok: false, error: LIFECYCLE_ERRORS.creditNoteImmutable }
  const from = invoice.status
  if (input.to === "CANCELLED" && from !== "DRAFT") return { ok: false, error: LIFECYCLE_ERRORS.cancelIssued }
  if (!canTransition(from, input.to)) return { ok: false, error: LIFECYCLE_ERRORS.forbidden }

  const updated = await tx.invoice.updateMany({
    where: { id: invoice.id, companyId: input.companyId, status: from, kind: "INVOICE" },
    data: {
      status: input.to,
      ...(input.to === "SENT" ? { sentAt: input.now } : {}),
      ...(input.to === "PAID" ? { paidAt: input.now } : {}),
    },
  })
  if (updated.count !== 1) return { ok: false, error: LIFECYCLE_ERRORS.conflict }

  await tx.historyLog.create({
    data: {
      companyId: input.companyId,
      worksiteId: invoice.worksiteId,
      actorId: input.actorId,
      action: "STATUS_CHANGED",
      entityType: "Invoice",
      entityId: invoice.id,
      detail: `Facture ${invoice.number} : ${from} → ${input.to}`,
      oldValue: { status: from },
      newValue: { status: input.to },
    },
  })
  return { ok: true, value: undefined }
}

export interface DraftLine {
  articleId: string | null
  designation: string
  unit: string
  quantity: number
  unitPrice: number
  vatRate: number
  lineHT: number
  position: number
}

export interface ReplaceLinesInput {
  companyId: string
  invoiceId: string
  lines: DraftLine[]
  totals: { totalHT: number; totalVAT: number; totalTTC: number }
}

/**
 * Remplace les lignes d'un brouillon. Le contrôle DRAFT et la mise à jour sont une seule instruction
 * conditionnelle : la ligne de facture est verrouillée jusqu'à la fin de la transaction, donc une
 * émission concurrente attend puis porte sur les lignes finales, ou bien cette modification échoue.
 */
export async function replaceDraftLinesCore(
  tx: Prisma.TransactionClient,
  input: ReplaceLinesInput
): Promise<LifecycleResult> {
  const locked = await tx.invoice.updateMany({
    where: { id: input.invoiceId, companyId: input.companyId, status: "DRAFT", kind: "INVOICE" },
    data: { totalHT: input.totals.totalHT, totalVAT: input.totals.totalVAT, totalTTC: input.totals.totalTTC },
  })
  if (locked.count !== 1) {
    const exists = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId: input.companyId },
      select: { id: true },
    })
    return { ok: false, error: exists ? LIFECYCLE_ERRORS.notDraft : LIFECYCLE_ERRORS.notFound }
  }
  await tx.invoiceLine.deleteMany({ where: { invoiceId: input.invoiceId } })
  if (input.lines.length > 0) {
    await tx.invoiceLine.createMany({ data: input.lines.map((l) => ({ ...l, invoiceId: input.invoiceId })) })
  }
  return { ok: true, value: undefined }
}

export interface CreditNoteInput {
  companyId: string
  invoiceId: string
  actorId: string
  reason: string | null
  now: Date
  nextNumber: (tx: Prisma.TransactionClient) => Promise<string>
}

/**
 * Avoir TOTAL : copie exacte des lignes et montants de la facture d'origine (montants positifs,
 * kind = CREDIT_NOTE), émis immédiatement ; la facture d'origine passe à CANCELLED. Tout ou rien.
 * Avoirs partiels : hors Lot B minimal.
 */
export async function createCreditNoteCore(
  tx: Prisma.TransactionClient,
  input: CreditNoteInput
): Promise<LifecycleResult<{ id: string; number: string }>> {
  const original = await tx.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    select: {
      id: true, status: true, kind: true, number: true, worksiteId: true, clientId: true, quoteId: true,
      periodStart: true, periodEnd: true, totalHT: true, totalVAT: true, totalTTC: true, paymentTerms: true,
      lines: {
        orderBy: { position: "asc" },
        select: { articleId: true, designation: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, position: true },
      },
    },
  })
  if (!original || !isStatus(original.status)) return { ok: false, error: LIFECYCLE_ERRORS.notFound }
  if (original.kind !== "INVOICE" || (original.status !== "SENT" && original.status !== "PAID")) {
    return { ok: false, error: LIFECYCLE_ERRORS.notCreditable }
  }
  const existing = await tx.invoice.findFirst({
    where: { creditedInvoiceId: original.id, companyId: input.companyId },
    select: { id: true },
  })
  if (existing) return { ok: false, error: LIFECYCLE_ERRORS.alreadyCredited }

  const cancelled = await tx.invoice.updateMany({
    where: { id: original.id, companyId: input.companyId, status: original.status, kind: "INVOICE" },
    data: { status: "CANCELLED" },
  })
  if (cancelled.count !== 1) return { ok: false, error: LIFECYCLE_ERRORS.conflict }

  const number = await input.nextNumber(tx)
  // Créé en brouillon (lignes autorisées par la base), puis émis dans la même transaction.
  const note = await tx.invoice.create({
    data: {
      companyId: input.companyId,
      worksiteId: original.worksiteId,
      clientId: original.clientId,
      quoteId: original.quoteId,
      number,
      kind: "CREDIT_NOTE",
      creditedInvoiceId: original.id,
      status: "DRAFT",
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      totalHT: original.totalHT,
      totalVAT: original.totalVAT,
      totalTTC: original.totalTTC,
      paymentTerms: original.paymentTerms,
      notes: `Avoir total sur la facture ${original.number}${input.reason ? ` — ${input.reason}` : ""}`,
      createdById: input.actorId,
      lines: { create: original.lines.map((l) => ({ ...l })) },
    },
    select: { id: true, number: true },
  })
  const issued = await tx.invoice.updateMany({
    where: { id: note.id, companyId: input.companyId, status: "DRAFT", kind: "CREDIT_NOTE" },
    data: { status: "SENT", sentAt: input.now },
  })
  if (issued.count !== 1) throw new Error("CREDIT_NOTE_ISSUE_FAILED")

  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: original.worksiteId, actorId: input.actorId,
      action: "STATUS_CHANGED", entityType: "Invoice", entityId: original.id,
      detail: `Facture ${original.number} annulée par l'avoir ${note.number}`,
      oldValue: { status: original.status }, newValue: { status: "CANCELLED", creditNoteId: note.id },
    },
  })
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: original.worksiteId, actorId: input.actorId,
      action: "CREATED", entityType: "CreditNote", entityId: note.id,
      detail: `Avoir ${note.number} émis sur la facture ${original.number}`,
      newValue: { creditedInvoiceId: original.id, totalTTC: String(original.totalTTC) },
    },
  })
  return { ok: true, value: note }
}
