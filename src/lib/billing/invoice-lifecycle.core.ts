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
// - Chaque opération de cycle (émission, paiement, abandon, avoir, remplacement des lignes) écrit une
//   trace HistoryLog dans la même transaction (création : voir createInvoice).
// La base impose de son côté : création en brouillon, contenu figé hors brouillon, lignes verrouillées
// avec leur facture, et (au COMMIT) aucune facture émise annulée sans son avoir total émis.
// ═══════════════════════════════════════════════════════════════════════════

import type { Prisma } from "@prisma/client"
import { captureDocumentSnapshot, type SnapshotCapture } from "@/lib/billing/pdf/document-snapshot"
import { centsToDecimalString, computeDocumentTotals, decimalToCents, storedVatRateToBp } from "@/lib/billing/money"
import { decisionClock } from "@/lib/billing/clock"
import { businessDay } from "@/lib/billing/business-day"

// Lot C2 : PARTIAL (partiellement payée) — aucune transition manuelle depuis ce statut ; l'avoir total reste possible.
export type InvoiceStatusValue = "DRAFT" | "SENT" | "PAID" | "CANCELLED" | "PARTIAL"
export type RequestedInvoiceStatus = "SENT" | "PAID" | "CANCELLED"

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatusValue, readonly InvoiceStatusValue[]>> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["PAID"],
  PAID: [],
  CANCELLED: [],
  PARTIAL: [],
}

export type LifecycleResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

const STATUSES: readonly string[] = ["DRAFT", "SENT", "PAID", "CANCELLED", "PARTIAL"]

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
  provisionalNumber: "Cette facture porte un numéro provisoire : émettez-la depuis sa fiche (numéro légal attribué à l'émission).",
  quoteHasDeposits: "Ce devis porte des acomptes : la facture de solde s'émet depuis la facturation complète (déduction des acomptes), pas par ce chemin.",
  hasDeductions: "Cette facture de solde déduit des acomptes : modifiez-la depuis la facturation complète (les déductions sont recalculées), pas par ce chemin.",
  yearMismatch: "Le numéro de cette facture appartient à une année antérieure : émission refusée (la pièce doit porter un numéro de la série de l'année d'émission).",
} as const

/** Lot C : brouillon à numéro provisoire (créé par la facturation complète) — jamais émis par ce chemin. */
export const PROVISIONAL_NUMBER_PREFIX = "PROV-"

/** Verrou de la ligne de facture (même protocole que le Lot C : `lockInvoiceRow`), injectable pour les tests sans base. */
export type InvoiceLock = (tx: Prisma.TransactionClient, invoiceId: string, companyId: string) => Promise<void>
export const lockInvoiceForUpdate: InvoiceLock = async (tx, invoiceId, companyId) => {
  await tx.$queryRaw`SELECT 1 FROM "invoices" WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} FOR UPDATE`
}

export interface TransitionInput {
  companyId: string
  invoiceId: string
  to: RequestedInvoiceStatus
  actorId: string
  now: Date
  /** Correctif P2-03 : figement documentaire à l'émission (injectable pour les tests sans base ; défaut = snapshot réel). */
  captureSnapshot?: SnapshotCapture
  /** Correctif R2 : verrou du parent AVANT la lecture qui nourrit le recalcul (défaut = FOR UPDATE réel). */
  lockInvoice?: InvoiceLock
  /**
   * S3 : si l'année civile Europe/Paris de l'émission diffère de celle du numéro FAC-AAAA déjà attribué (brouillon Lot B d'une année
   * antérieure), la pièce est RENUMÉROTÉE dans la série de l'année d'émission par ce fournisseur (comme issueInvoiceCore) ; l'ancien numéro
   * reste un trou documenté. Sans fournisseur, l'émission est refusée (jamais une pièce FAC-2026 datée 2027).
   */
  nextNumber?: (tx: Prisma.TransactionClient, year: number) => Promise<string>
}

export async function transitionInvoiceCore(
  tx: Prisma.TransactionClient,
  input: TransitionInput
): Promise<LifecycleResult> {
  // Correctif R2 (revue Codex R2 du 26/10/2026) : le parent est verrouillé AVANT toute lecture — même protocole que la modification
  // des lignes (UPDATE conditionnel) et que l'émission Lot C (lockInvoiceRow). Une modification concurrente du brouillon attend ou a
  // déjà commité : les lignes et l'en-tête lus ici sont la version finale, le recalcul écrit à l'émission ne peut plus être périmé.
  const decide = decisionClock(input.now) // S3 : créée avant le verrou
  // S2 (ordre global DEVIS → FACTURE) : si la facture est liée à un devis, le devis est verrouillé AVANT la facture (lecture non verrouillée
  // du lien, relu ensuite). Même famille (audit R3, #2) : une facture liée à un devis porteur d'acomptes ne s'émet pas par ce chemin
  // (aucune déduction possible ici ⇒ double facturation) ; sans acompte, le chemin reste disponible.
  let lockedQuoteId: string | null = null
  if (input.to === "SENT") {
    const pre = await tx.invoice.findFirst({ where: { id: input.invoiceId, companyId: input.companyId }, select: { quoteId: true } })
    if (pre?.quoteId) { await tx.$queryRaw`SELECT 1 FROM "quotes" WHERE "id" = ${pre.quoteId} AND "companyId" = ${input.companyId} FOR NO KEY UPDATE`; lockedQuoteId = pre.quoteId }
  }
  await (input.lockInvoice ?? lockInvoiceForUpdate)(tx, input.invoiceId, input.companyId)
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    select: { id: true, status: true, kind: true, number: true, worksiteId: true, quoteId: true, globalDiscountBp: true, vatReverseCharge: true, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } },
  })
  if (!invoice || !isStatus(invoice.status)) return { ok: false, error: LIFECYCLE_ERRORS.notFound }
  if (input.to === "SENT" && (invoice.quoteId ?? null) !== lockedQuoteId) return { ok: false, error: LIFECYCLE_ERRORS.conflict }
  if (input.to === "SENT" && invoice.kind === "INVOICE" && invoice.quoteId) {
    const deposits = await tx.invoice.count({ where: { companyId: input.companyId, quoteId: invoice.quoteId, kind: "DEPOSIT", status: { not: "CANCELLED" } } })
    if (deposits > 0) return { ok: false, error: LIFECYCLE_ERRORS.quoteHasDeposits }
  }
  // Correctif P1-01 (chemin Lot B) : à l'émission, les totaux sont RECALCULÉS depuis les lignes avec le moteur centimes et écrits
  // dans la même instruction que la transition — les totaux persistés d'une pièce émise sont toujours égaux au recalcul.
  let issuedTotals: { totalHT: string; totalVAT: string; totalTTC: string } | null = null
  if (input.to === "SENT") {
    const lines = (invoice as { lines?: { quantity: unknown; unitPrice: unknown; vatRate: unknown; discountBp?: number | null; deductsDepositId?: string | null }[] }).lines ?? []
    const t = computeDocumentTotals(
      lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity as never), unitPriceCents: decimalToCents(l.unitPrice as never), discountBp: l.discountBp ?? 0, vatRateBp: storedVatRateToBp(l.vatRate as never), excludeGlobalDiscount: !!l.deductsDepositId })),
      { globalDiscountBp: (invoice as { globalDiscountBp?: number }).globalDiscountBp ?? 0, vatReverseCharge: (invoice as { vatReverseCharge?: boolean }).vatReverseCharge ?? false },
    )
    issuedTotals = { totalHT: centsToDecimalString(t.totalHTCents), totalVAT: centsToDecimalString(t.totalVATCents), totalTTC: centsToDecimalString(t.totalTTCCents) }
  }
  // Lot C3 : un acompte (DEPOSIT) suit le même automate ; un avoir reste immuable.
  if (invoice.kind === "CREDIT_NOTE") return { ok: false, error: LIFECYCLE_ERRORS.creditNoteImmutable }
  const from = invoice.status
  if (input.to === "CANCELLED" && from !== "DRAFT") return { ok: false, error: LIFECYCLE_ERRORS.cancelIssued }
  if (!canTransition(from, input.to)) return { ok: false, error: LIFECYCLE_ERRORS.forbidden }
  if (input.to === "SENT" && invoice.number.startsWith(PROVISIONAL_NUMBER_PREFIX)) return { ok: false, error: LIFECYCLE_ERRORS.provisionalNumber }

  // La transition conditionnelle est la PREMIÈRE écriture : un conflit ici n'a rien modifié (correctif P1-06, même règle partout :
  // aucune réponse d'échec après une mutation).
  // Correctif S3 : instant de décision relu après le verrou ; date d'émission = jour civil Paris ; série = année de ce jour.
  const at = decide()
  let number = invoice.number
  if (input.to === "SENT") {
    const year = businessDay(at).getUTCFullYear()
    const legacyYear = /^FAC-(\d{4})-/.exec(invoice.number)?.[1]
    if (legacyYear && legacyYear !== String(year)) {
      if (!input.nextNumber) return { ok: false, error: LIFECYCLE_ERRORS.yearMismatch }
      number = await input.nextNumber(tx, year)
    }
  }
  const updated = await tx.invoice.updateMany({
    where: { id: invoice.id, companyId: input.companyId, status: from, kind: invoice.kind },
    data: {
      status: input.to,
      ...(input.to === "SENT" ? { sentAt: at, issueDate: businessDay(at), number, ...issuedTotals } : {}),
      ...(input.to === "PAID" ? { paidAt: at } : {}),
    },
  })
  // Même famille (audit R4, T1 #7) : si un numéro légal vient d'être consommé (renumérotation), un conflit doit annuler la transaction
  // entière (jamais de trou dans la série) ; sans numéro consommé, le conflit reste un simple résultat (aucune écriture).
  if (updated.count !== 1) { if (number !== invoice.number) throw new Error(`INVOICE_CONFLICT: ${LIFECYCLE_ERRORS.conflict}`); return { ok: false, error: LIFECYCLE_ERRORS.conflict } }
  // Lot C3 : l'abandon d'un brouillon de facture de solde libère ses déductions d'acomptes (les acomptes redeviennent déductibles).
  if (input.to === "CANCELLED" && invoice.kind === "INVOICE") {
    await tx.invoiceDepositDeduction.deleteMany({ where: { companyId: input.companyId, finalInvoiceId: invoice.id } })
  }
  // Correctif P2-03 : les données documentaires de la pièce émise sont figées dans la même transaction.
  if (input.to === "SENT") await (input.captureSnapshot ?? captureDocumentSnapshot)(tx, input.companyId, invoice.id)

  await tx.historyLog.create({
    data: {
      companyId: input.companyId,
      worksiteId: invoice.worksiteId,
      actorId: input.actorId,
      action: "STATUS_CHANGED",
      entityType: "Invoice",
      entityId: invoice.id,
      detail: `Facture ${number} : ${from} → ${input.to}${number !== invoice.number ? ` (renumérotée depuis ${invoice.number} : série de l'année d'émission)` : ""}`,
      oldValue: { status: from, number: invoice.number },
      newValue: { status: input.to, number },
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
  actorId: string
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
  // Même famille S1 (audit R3, #5) : un brouillon de solde qui déduit des acomptes ne se modifie pas par ce chemin (les lignes de
  // déduction seraient effacées, la liaison conservée) — refus AVANT toute écriture, sous verrou de la facture (pas de lecture non protégée).
  await lockInvoiceForUpdate(tx, input.invoiceId, input.companyId)
  const deductions = await tx.invoiceDepositDeduction.count({ where: { companyId: input.companyId, finalInvoiceId: input.invoiceId } })
  if (deductions > 0) return { ok: false, error: LIFECYCLE_ERRORS.hasDeductions }
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
  await tx.historyLog.create({
    data: {
      companyId: input.companyId,
      actorId: input.actorId,
      action: "UPDATED",
      entityType: "Invoice",
      entityId: input.invoiceId,
      detail: `Lignes du brouillon remplacées (${input.lines.length})`,
      newValue: { totalTTC: String(input.totals.totalTTC), lines: input.lines.length },
    },
  })
  return { ok: true, value: undefined }
}

export interface CreditNoteInput {
  companyId: string
  invoiceId: string
  actorId: string
  reason: string | null
  now: Date
  /** Numéro AV ; `at` = instant de décision relu après le verrou (série annuelle = année civile Europe/Paris de cet instant, S3). */
  nextNumber: (tx: Prisma.TransactionClient, at: Date) => Promise<string>
  /** Correctif P2-03 : figement documentaire de l'avoir émis (injectable pour les tests sans base ; défaut = snapshot réel). */
  captureSnapshot?: SnapshotCapture
  /** Correctif R2 (même famille) : verrou de l'origine avant la lecture copiée dans l'avoir (défaut = FOR UPDATE réel). */
  lockInvoice?: InvoiceLock
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
  // R2 (même famille) : l'origine est verrouillée avant la lecture dont l'avoir est la copie exacte (sérialisation avec paiements,
  // avoirs partiels et émission concurrents ; le contenu d'une pièce émise est figé en base, le statut est relu sous verrou).
  const decide = decisionClock(input.now) // S3 : créée avant le verrou
  await (input.lockInvoice ?? lockInvoiceForUpdate)(tx, input.invoiceId, input.companyId)
  const original = await tx.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    select: {
      id: true, status: true, kind: true, number: true, worksiteId: true, clientId: true, quoteId: true,
      periodStart: true, periodEnd: true, totalHT: true, totalVAT: true, totalTTC: true, paymentTerms: true,
      globalDiscountBp: true, vatReverseCharge: true,
      lines: {
        orderBy: { position: "asc" },
        // Lot C1 : description et remise de ligne font partie de la copie exacte.
        // Correctif P1-01 : le marqueur de déduction d'acompte (deductsDepositId) aussi — il détermine le calcul (ligne hors
        // remise globale) ; sans lui, l'avoir total d'un solde remisé recalculerait un autre montant que la pièce annulée.
        select: { articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, position: true, discountBp: true, deductsDepositId: true },
      },
    },
  })
  if (!original || !isStatus(original.status)) return { ok: false, error: LIFECYCLE_ERRORS.notFound }
  if ((original.kind !== "INVOICE" && original.kind !== "DEPOSIT") || !["SENT", "PAID", "PARTIAL"].includes(original.status)) {
    return { ok: false, error: LIFECYCLE_ERRORS.notCreditable }
  }
  const existing = await tx.invoice.findFirst({
    where: { creditedInvoiceId: original.id, companyId: input.companyId },
    select: { id: true, creditScope: true },
  })
  if (existing) return { ok: false, error: existing.creditScope === "PARTIAL" ? "Des avoirs partiels existent sur cette facture : utilisez un avoir partiel du reste créditable." : LIFECYCLE_ERRORS.alreadyCredited }
  const DEPOSIT_DEDUCTED = "Cet acompte est déduit sur une facture de solde émise : établissez l'avoir sur la facture de solde."
  const DEPOSIT_DEDUCTED_DRAFT = "Cet acompte est affecté à un brouillon de facture de solde : abandonnez ce brouillon (ou retirez-y l'acompte) avant d'établir l'avoir."
  // T1 (cycle R4) : seule une affectation ACTIVE (releasedAt NULL) bloque l'avoir sur l'acompte — vers un solde émis (avoir à établir sur le
  // solde) ou vers un brouillon (à abandonner d'abord : une seule affectation active, jamais d'avoir sur un acompte encore affecté) ; la trace
  // libérée d'un solde annulé par avoir total ne bloque plus rien (l'acompte redevient affectable une fois, ou créditable).
  const activeAllocation = () => tx.invoiceDepositDeduction.findFirst({ where: { companyId: input.companyId, depositInvoiceId: original.id, releasedAt: null }, select: { id: true, finalInvoice: { select: { status: true } } } })
  const deductedOnIssuedFinal = async () => { const a = await activeAllocation(); return a ? (a.finalInvoice.status === "DRAFT" ? "DRAFT" : "ISSUED") : null }
  if (original.kind === "DEPOSIT") { const a = await deductedOnIssuedFinal(); if (a) return { ok: false, error: a === "DRAFT" ? DEPOSIT_DEDUCTED_DRAFT : DEPOSIT_DEDUCTED } }

  const at = decide()
  const cancelled = await tx.invoice.updateMany({
    where: { id: original.id, companyId: input.companyId, status: original.status, kind: original.kind },
    data: { status: "CANCELLED" },
  })
  if (cancelled.count !== 1) return { ok: false, error: LIFECYCLE_ERRORS.conflict }
  // Lot C3 : relecture sous verrou (l'UPDATE ci-dessus verrouille l'acompte) — une émission concurrente du solde,
  // qui verrouille les acomptes déduits, est ainsi sérialisée ; un conflit détecté après écriture annule la transaction.
  if (original.kind === "DEPOSIT" && (await deductedOnIssuedFinal())) throw new Error(`INVOICE_DEPOSIT_DEDUCTED: ${DEPOSIT_DEDUCTED}`)
  // (une reconversion concurrente verrouille les acomptes du devis en partage avant de poser ses affectations : elle attend cet avoir et
  // relit l'annulation ; en défense, la contrainte différée refuse au COMMIT toute affectation active vers un acompte non émis/annulé)
  // T1 : l'annulation intégrale d'une facture de solde LIBÈRE ses affectations d'acomptes (trace conservée, datée) : chaque acompte non
  // annulé redevient affectable une seule fois à un nouveau solde du même devis (sans nouvel encaissement) ou créditable.
  if (original.kind === "INVOICE") {
    const released = await tx.invoiceDepositDeduction.updateMany({ where: { companyId: input.companyId, finalInvoiceId: original.id, releasedAt: null }, data: { releasedAt: at } })
    if (released.count > 0) await tx.historyLog.create({ data: { companyId: input.companyId, worksiteId: original.worksiteId, actorId: input.actorId, action: "UPDATED", entityType: "Invoice", entityId: original.id, detail: `Annulation du solde ${original.number} : ${released.count} affectation(s) d'acompte libérée(s) (trace conservée)`, newValue: { releasedDeductions: released.count } } })
  }

  const number = await input.nextNumber(tx, at)
  // Créé en brouillon (lignes autorisées par la base), puis émis dans la même transaction.
  const note = await tx.invoice.create({
    data: {
      companyId: input.companyId,
      worksiteId: original.worksiteId,
      clientId: original.clientId,
      quoteId: original.quoteId,
      number,
      kind: "CREDIT_NOTE",
      creditScope: "TOTAL",
      creditedInvoiceId: original.id,
      status: "DRAFT",
      issueDate: businessDay(at), // S3 : date d'émission de l'avoir = jour civil Europe/Paris de l'instant de décision (relu après verrou)
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      totalHT: original.totalHT,
      totalVAT: original.totalVAT,
      totalTTC: original.totalTTC,
      globalDiscountBp: original.globalDiscountBp ?? 0,
      vatReverseCharge: original.vatReverseCharge ?? false,
      paymentTerms: original.paymentTerms,
      notes: `Avoir total sur la facture ${original.number}${input.reason ? ` — ${input.reason}` : ""}`,
      createdById: input.actorId,
      lines: { create: original.lines.map((l) => ({ ...l })) },
    },
    select: { id: true, number: true },
  })
  const issued = await tx.invoice.updateMany({
    where: { id: note.id, companyId: input.companyId, status: "DRAFT", kind: "CREDIT_NOTE" },
    data: { status: "SENT", sentAt: at },
  })
  if (issued.count !== 1) throw new Error("CREDIT_NOTE_ISSUE_FAILED")
  // Correctif P2-03 : l'avoir est une nouvelle pièce avec sa propre identité d'émission figée.
  await (input.captureSnapshot ?? captureDocumentSnapshot)(tx, input.companyId, note.id)

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
