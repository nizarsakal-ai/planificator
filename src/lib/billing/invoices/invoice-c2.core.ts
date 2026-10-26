// ═══════════════════════════════════════════════════════════════════════════
// Factures — Lot C2 (SPEC-BILLING-C2) : émission avec numérotation légale, paiements partiels plafonnés sous
// verrou, contre-passation, statuts PARTIAL/PAID, remplacement d'un brouillon. Complète le Lot B
// (invoice-lifecycle.core.ts), jamais contourné : toute écriture est conditionnée au statut lu et tracée.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma } from "@prisma/client"
import { MoneyError, centsToDecimalString, computeDocumentTotals, decimalToCents, storedVatRateToBp } from "@/lib/billing/money"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { captureDocumentSnapshot, type SnapshotCapture } from "@/lib/billing/pdf/document-snapshot"
import { decisionClock } from "@/lib/billing/clock"
import { addBusinessDays, businessDay } from "@/lib/billing/business-day"

export const INVOICE_C2_ERRORS = {
  notFound: "Facture introuvable.",
  notDraft: "Seule une facture brouillon peut être émise ou modifiée.",
  quoteLocked: "Cette facture de solde déduit des acomptes émis de son devis : le devis lié ne peut être ni retiré ni changé. Abandonnez ce brouillon (les acomptes redeviennent déductibles) et créez une nouvelle facture.",
  notInvoice: "Seule une facture (pas un avoir) peut être émise.",
  noLines: "Une facture doit comporter au moins une ligne.",
  conflict: "La facture a été modifiée entre-temps. Rechargez la page.",
  notPayable: "Seule une facture émise non soldée peut recevoir un paiement.",
  alreadyPaid: "Cette facture est déjà soldée.",
  exceeds: "Le montant dépasse le reste à payer.",
  paymentNotFound: "Paiement introuvable.",
  alreadyReversed: "Ce paiement a déjà été annulé.",
  isReversal: "Une contre-passation ne s'annule pas.",
} as const

export const LEGAL_NUMBER = /^FAC-\d{4}-\d{4,}$/

export interface IssueBlocker { code: string; message: string }

/** Contrôles de mentions avant émission (bloquants). Les avertissements (adresse client…) sont affichés, non bloquants. */
export function issueBlockers(input: { company: { name: string; address: string | null; siret: string | null }; client: { name: string; address: string | null }; lineCount: number }): IssueBlocker[] {
  const b: IssueBlocker[] = []
  if (!input.company.name.trim()) b.push({ code: "SELLER_NAME", message: "Nom de la société manquant." })
  if (!input.company.address?.trim()) b.push({ code: "SELLER_ADDRESS", message: "Adresse de la société manquante (Paramètres de l'entreprise)." })
  if (!/^\d{14}$/.test((input.company.siret ?? "").replace(/\s/g, ""))) b.push({ code: "SELLER_SIRET", message: "SIRET de la société manquant ou invalide (14 chiffres)." })
  if (!input.client.name.trim()) b.push({ code: "CLIENT_NAME", message: "Nom du client manquant." })
  if (!input.client.address?.trim()) b.push({ code: "CLIENT_ADDRESS", message: "Adresse du client manquante (fiche client)." })
  if (input.lineCount < 1) b.push({ code: "NO_LINES", message: INVOICE_C2_ERRORS.noLines })
  return b
}

export interface IssueInvoiceInput {
  companyId: string
  invoiceId: string
  actorId: string
  now: Date
  paymentTermsDays: number
  nextLegalNumber: (tx: Prisma.TransactionClient, year: number) => Promise<string>
  lockInvoice: (tx: Prisma.TransactionClient, invoiceId: string, companyId: string) => Promise<void>
  /**
   * Correctif S2 : ordre global des verrous DEVIS → FACTURE → ACOMPTES. Si fourni, le devis lié (lu avant tout verrou) est verrouillé
   * AVANT la facture ; la facture est relue sous verrou et un changement de devis entre-temps est un conflit (aucune écriture).
   */
  lockQuote?: (tx: Prisma.TransactionClient, quoteId: string, companyId: string) => Promise<void>
  /** Correctif S3 : horloge serveur relue après les verrous (défaut : horloge réelle / de test) pour la date d'émission et la série. */
  clock?: () => Date
  /** Contrôles supplémentaires sous verrou (C3 : acomptes) ; message d'erreur ou null. */
  extraChecks?: (tx: Prisma.TransactionClient, invoice: { id: string; kind: string; quoteId: string | null; totalTTCCents: bigint; vatReverseCharge: boolean }) => Promise<string | null>
  /** Correctif P2-03 : figement documentaire à l'émission (injectable pour les tests sans base ; défaut = snapshot réel). */
  captureSnapshot?: SnapshotCapture
}

/**
 * Émission DRAFT → SENT : verrou, contrôles, totaux recalculés depuis les lignes, numéro légal attribué dans la
 * même transaction (sauf brouillon déjà numéroté FAC-… par le chemin Lot B), date d'émission = aujourd'hui,
 * échéance = émission + délai si absente. Conditionnel sur status = DRAFT.
 */
export async function issueInvoiceCore(tx: Prisma.TransactionClient, input: IssueInvoiceInput): Promise<LifecycleResult<{ number: string; issueDate: Date; dueDate: Date }>> {
  const decide = decisionClock(input.now, input.clock) // S3 : créée AVANT les verrous, relue après
  // S2 : devis d'abord (lecture non verrouillée du lien, puis verrou du devis), facture ensuite, acomptes enfin (depositIssueChecks).
  let lockedQuoteId: string | null = null
  if (input.lockQuote) {
    const pre = await tx.invoice.findFirst({ where: { id: input.invoiceId, companyId: input.companyId }, select: { quoteId: true } })
    if (pre?.quoteId) { await input.lockQuote(tx, pre.quoteId, input.companyId); lockedQuoteId = pre.quoteId }
  }
  await input.lockInvoice(tx, input.invoiceId, input.companyId)
  // Même famille (audit R3, #7) : les fiches client et société sont lues sous verrou partagé — les contrôles d'émission et le snapshot
  // figent la même version (une modification concurrente de la fiche attend la fin de l'émission).
  await tx.$queryRaw`SELECT 1 FROM "clients" c JOIN "invoices" i ON i."clientId" = c."id" WHERE i."id" = ${input.invoiceId} FOR SHARE OF c`
  await tx.$queryRaw`SELECT 1 FROM "companies" WHERE "id" = ${input.companyId} FOR SHARE`
  const inv = await tx.invoice.findFirst({
    where: { id: input.invoiceId, companyId: input.companyId },
    select: {
      id: true, status: true, kind: true, number: true, dueDate: true, worksiteId: true, globalDiscountBp: true, vatReverseCharge: true, quoteId: true, totalTTC: true,
      company: { select: { name: true, address: true, siret: true } }, client: { select: { name: true, address: true } },
      lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } },
    },
  })
  if (!inv) return { ok: false, error: INVOICE_C2_ERRORS.notFound }
  if (inv.kind === "CREDIT_NOTE") return { ok: false, error: INVOICE_C2_ERRORS.notInvoice }
  if (inv.status !== "DRAFT") return { ok: false, error: INVOICE_C2_ERRORS.notDraft }
  // Le devis lié a changé entre la lecture non verrouillée et le verrou : l'ordre des verrous n'est plus garanti ⇒ conflit (aucune écriture).
  if (input.lockQuote && (inv.quoteId ?? null) !== lockedQuoteId) return { ok: false, error: INVOICE_C2_ERRORS.conflict }
  const blockers = issueBlockers({ company: inv.company, client: inv.client, lineCount: inv.lines.length })
  if (blockers.length) return { ok: false, error: `Émission impossible : ${blockers.map((b) => b.message).join(" ")}` }

  let totals
  try {
    totals = computeDocumentTotals(
      inv.lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), excludeGlobalDiscount: !!l.deductsDepositId })),
      { globalDiscountBp: inv.globalDiscountBp, vatReverseCharge: inv.vatReverseCharge },
    )
  } catch (e) {
    if (e instanceof MoneyError) return { ok: false, error: `Émission impossible : lignes invalides (${e.code}).` }
    throw e
  }
  if (totals.totalTTCCents < BigInt(0)) return { ok: false, error: "Émission impossible : total TTC négatif." }
  if (input.extraChecks) {
    const err = await input.extraChecks(tx, { id: inv.id, kind: inv.kind, quoteId: inv.quoteId, totalTTCCents: totals.totalTTCCents, vatReverseCharge: inv.vatReverseCharge })
    if (err) return { ok: false, error: err }
  }
  // Correctif S3 : instant de décision relu APRÈS les verrous ; date d'émission = jour civil Europe/Paris de cet instant ; série = son année.
  const at = decide()
  const issueDate = businessDay(at)
  const year = issueDate.getUTCFullYear()
  const dueDate = inv.dueDate && inv.dueDate >= issueDate ? inv.dueDate : addBusinessDays(issueDate, input.paymentTermsDays)
  // Brouillon hérité du Lot B déjà numéroté FAC-AAAA-… : numéro conservé seulement si son année est celle de l'émission
  // (sinon nouveau numéro de l'année courante ; l'ancien reste un trou documenté de la série du Lot B).
  const legacyYear = /^FAC-(\d{4})-/.exec(inv.number)?.[1]
  const number = LEGAL_NUMBER.test(inv.number) && legacyYear === String(year) ? inv.number : await input.nextLegalNumber(tx, year)
  const updated = await tx.invoice.updateMany({
    where: { id: inv.id, companyId: input.companyId, status: "DRAFT" },
    data: {
      status: "SENT", sentAt: at, issueDate, dueDate, number,
      totalHT: centsToDecimalString(totals.totalHTCents), totalVAT: centsToDecimalString(totals.totalVATCents), totalTTC: centsToDecimalString(totals.totalTTCCents),
    },
  })
  // Le compteur légal a déjà été consommé : un conflit ici doit annuler toute la transaction (jamais de trou).
  if (updated.count !== 1) throw new Error(`INVOICE_CONFLICT: ${INVOICE_C2_ERRORS.conflict}`)
  // Solde nul (acomptes = 100 %) : rien à encaisser ⇒ soldée dans la même transaction (aucune relance).
  if (totals.totalTTCCents === BigInt(0)) {
    const paid = await tx.invoice.updateMany({ where: { id: inv.id, companyId: input.companyId, status: "SENT" }, data: { status: "PAID", paidAt: at } })
    if (paid.count !== 1) throw new Error(`INVOICE_CONFLICT: ${INVOICE_C2_ERRORS.conflict}`)
  }
  // Correctif P2-03 : identités vendeur/acheteur, mentions, conditions, pied de page et références figés avec la pièce émise.
  await (input.captureSnapshot ?? captureDocumentSnapshot)(tx, input.companyId, inv.id)
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: inv.worksiteId, actorId: input.actorId, action: "STATUS_CHANGED", entityType: "Invoice", entityId: inv.id,
      detail: `Facture ${number} émise`, oldValue: { status: "DRAFT", number: inv.number }, newValue: { status: "SENT", number, totalTTC: centsToDecimalString(totals.totalTTCCents) },
    },
  })
  return { ok: true, value: { number, issueDate, dueDate } }
}

/** Somme des paiements (contre-passations incluses) d'une facture, en centimes. */
export async function sumPayments(tx: Prisma.TransactionClient, companyId: string, invoiceId: string): Promise<bigint> {
  const agg = await tx.invoicePayment.aggregate({ where: { companyId, invoiceId }, _sum: { amountCents: true } })
  return agg._sum.amountCents ?? BigInt(0)
}

/** Σ TTC des avoirs PARTIELS émis sur une facture (Lot C4), en centimes. */
export async function sumPartialCredits(tx: Prisma.TransactionClient, companyId: string, invoiceId: string): Promise<bigint> {
  const rows = await tx.invoice.findMany({ where: { companyId, creditedInvoiceId: invoiceId, kind: "CREDIT_NOTE", creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } })
  return rows.reduce((s, r) => s + decimalToCents(r.totalTTC), BigInt(0))
}

export type PaymentStatus = "SENT" | "PARTIAL" | "PAID"
/** Statut selon paiements (+ avoirs partiels) : PAID quand paiements + avoirs = TTC ; SENT sans paiement. */
export function statusForPaid(paidCents: bigint, totalCents: bigint, creditedCents: bigint = BigInt(0)): PaymentStatus {
  if (paidCents <= BigInt(0)) return "SENT"
  return paidCents + creditedCents >= totalCents ? "PAID" : "PARTIAL"
}

export interface RecordPaymentInput {
  companyId: string
  invoiceId: string
  actorId: string
  now: Date
  amountCents: bigint
  method: "TRANSFER" | "CHECK" | "CASH" | "CARD" | "DIRECT_DEBIT" | "OTHER"
  paidAt: Date
  reference: string | null
  notes: string | null
  /** Correctif P1-03 : opération bancaire à l'origine du paiement (clé UNIQUE en base ⇒ un seul paiement par opération). */
  bankTransactionId?: string | null
  lockInvoice: (tx: Prisma.TransactionClient, invoiceId: string, companyId: string) => Promise<void>
  /** Pose l'indicateur transactionnel autorisant les changements de statut liés aux paiements. */
  enablePaymentsContext: (tx: Prisma.TransactionClient) => Promise<void>
}

export async function recordPaymentCore(tx: Prisma.TransactionClient, input: RecordPaymentInput): Promise<LifecycleResult<{ paymentId: string; status: PaymentStatus; remainingCents: bigint }>> {
  if (input.amountCents <= BigInt(0)) return { ok: false, error: "Le montant doit être supérieur à zéro." }
  if (input.paidAt.getTime() > input.now.getTime() + 86_400_000) return { ok: false, error: "La date de paiement ne peut pas être dans le futur." }
  await input.enablePaymentsContext(tx)
  await input.lockInvoice(tx, input.invoiceId, input.companyId)
  const inv = await tx.invoice.findFirst({ where: { id: input.invoiceId, companyId: input.companyId }, select: { id: true, status: true, kind: true, number: true, worksiteId: true, totalTTC: true } })
  if (!inv) return { ok: false, error: INVOICE_C2_ERRORS.notFound }
  if (inv.kind === "CREDIT_NOTE" || !["SENT", "PARTIAL", "PAID"].includes(inv.status)) return { ok: false, error: INVOICE_C2_ERRORS.notPayable }
  if (inv.status === "PAID") return { ok: false, error: INVOICE_C2_ERRORS.alreadyPaid }
  const total = decimalToCents(inv.totalTTC)
  const paid = await sumPayments(tx, input.companyId, inv.id)
  const credited = await sumPartialCredits(tx, input.companyId, inv.id)
  const remaining = total - paid - credited
  if (input.amountCents > remaining) return { ok: false, error: `${INVOICE_C2_ERRORS.exceeds} (reste : ${centsToDecimalString(remaining)} €)` }
  const payment = await tx.invoicePayment.create({
    data: { companyId: input.companyId, invoiceId: inv.id, amountCents: input.amountCents, method: input.method, paidAt: input.paidAt, reference: input.reference, notes: input.notes, recordedById: input.actorId, bankTransactionId: input.bankTransactionId ?? null },
    select: { id: true },
  })
  const newPaid = paid + input.amountCents
  const status = statusForPaid(newPaid, total, credited)
  const from = inv.status as PaymentStatus
  if (status !== from) {
    const u = await tx.invoice.updateMany({ where: { id: inv.id, companyId: input.companyId, status: from }, data: { status, ...(status === "PAID" ? { paidAt: input.now } : {}) } })
    // Paiement déjà inséré : un conflit doit annuler la transaction entière.
    if (u.count !== 1) throw new Error(`INVOICE_CONFLICT: ${INVOICE_C2_ERRORS.conflict}`)
  }
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: inv.worksiteId, actorId: input.actorId, action: status !== from ? "STATUS_CHANGED" : "UPDATED", entityType: "Invoice", entityId: inv.id,
      detail: `Paiement de ${centsToDecimalString(input.amountCents)} € enregistré sur ${inv.number} (${input.method})${status !== from ? ` : ${from} → ${status}` : ""}`,
      oldValue: { status: from, paid: centsToDecimalString(paid) }, newValue: { status, paid: centsToDecimalString(newPaid), paymentId: payment.id },
    },
  })
  return { ok: true, value: { paymentId: payment.id, status, remainingCents: total - newPaid - credited } }
}

export interface ReversePaymentInput {
  companyId: string
  paymentId: string
  actorId: string
  now: Date
  reason: string | null
  lockInvoice: (tx: Prisma.TransactionClient, invoiceId: string, companyId: string) => Promise<void>
  enablePaymentsContext: (tx: Prisma.TransactionClient) => Promise<void>
}

/** Contre-passation d'un paiement : ligne opposée (append-only), statut recalculé, paidAt effacé si PAID quitté. */
export async function reversePaymentCore(tx: Prisma.TransactionClient, input: ReversePaymentInput): Promise<LifecycleResult<{ status: PaymentStatus }>> {
  const decide = decisionClock(input.now) // S3 : créée avant les verrous
  await input.enablePaymentsContext(tx)
  const p = await tx.invoicePayment.findFirst({ where: { id: input.paymentId, companyId: input.companyId }, select: { id: true, invoiceId: true, amountCents: true, method: true, reversesPaymentId: true, reversedAt: true } })
  if (!p) return { ok: false, error: INVOICE_C2_ERRORS.paymentNotFound }
  if (p.reversesPaymentId) return { ok: false, error: INVOICE_C2_ERRORS.isReversal }
  if (p.reversedAt) return { ok: false, error: INVOICE_C2_ERRORS.alreadyReversed }
  await input.lockInvoice(tx, p.invoiceId, input.companyId)
  const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId, companyId: input.companyId }, select: { id: true, status: true, number: true, worksiteId: true, totalTTC: true } })
  if (!inv) return { ok: false, error: INVOICE_C2_ERRORS.notFound }
  if (inv.status === "CANCELLED") return { ok: false, error: "Facture annulée par avoir : le remboursement des paiements reçus se traite depuis l'avoir." }
  const at = decide()
  const marked = await tx.invoicePayment.updateMany({ where: { id: p.id, companyId: input.companyId, reversedAt: null }, data: { reversedAt: at } })
  if (marked.count !== 1) return { ok: false, error: INVOICE_C2_ERRORS.alreadyReversed }
  await tx.invoicePayment.create({
    data: { companyId: input.companyId, invoiceId: p.invoiceId, amountCents: -p.amountCents, method: p.method, paidAt: businessDay(at), reference: null, notes: input.reason, recordedById: input.actorId, reversesPaymentId: p.id }, // S3 (même famille) : jour civil Europe/Paris à l'instant de décision
  })
  const paid = await sumPayments(tx, input.companyId, inv.id)
  const status = statusForPaid(paid, decimalToCents(inv.totalTTC), await sumPartialCredits(tx, input.companyId, inv.id))
  const from = inv.status as PaymentStatus
  if (status !== from) {
    const u = await tx.invoice.updateMany({ where: { id: inv.id, companyId: input.companyId, status: from }, data: { status, ...(from === "PAID" ? { paidAt: null } : {}) } })
    if (u.count !== 1) throw new Error(`INVOICE_CONFLICT: ${INVOICE_C2_ERRORS.conflict}`)
  }
  await tx.historyLog.create({
    data: {
      companyId: input.companyId, worksiteId: inv.worksiteId, actorId: input.actorId, action: status !== from ? "STATUS_CHANGED" : "UPDATED", entityType: "Invoice", entityId: inv.id,
      detail: `Paiement de ${centsToDecimalString(p.amountCents)} € annulé sur ${inv.number}${input.reason ? ` — ${input.reason}` : ""}${status !== from ? ` : ${from} → ${status}` : ""}`,
      oldValue: { status: from }, newValue: { status, reversedPaymentId: p.id },
    },
  })
  return { ok: true, value: { status } }
}

export interface InvoiceDraftHeader {
  worksiteId?: string
  clientId?: string
  quoteId?: string | null
  dueDate: Date | null
  subject: string | null
  notes: string | null
  paymentTerms: string | null
  globalDiscountBp: number
  vatReverseCharge: boolean
  totalHT: string
  totalVAT: string
  totalTTC: string
}
export interface InvoiceDraftLine { articleId: string | null; designation: string; description: string | null; unit: string; quantity: string; unitPrice: string; vatRate: string; lineHT: string; discountBp: number; position: number }

/** Remplace en-tête et lignes d'un brouillon de facture (kind INVOICE) : une instruction conditionnelle (verrou de ligne jusqu'au COMMIT). */
export async function replaceInvoiceDraftCore(tx: Prisma.TransactionClient, input: { companyId: string; invoiceId: string; actorId: string; header: InvoiceDraftHeader; lines: InvoiceDraftLine[] }): Promise<LifecycleResult> {
  const locked = await tx.invoice.updateMany({ where: { id: input.invoiceId, companyId: input.companyId, status: "DRAFT", kind: "INVOICE" }, data: { ...input.header } })
  if (locked.count !== 1) {
    const exists = await tx.invoice.findFirst({ where: { id: input.invoiceId, companyId: input.companyId }, select: { id: true } })
    return { ok: false, error: exists ? INVOICE_C2_ERRORS.notDraft : INVOICE_C2_ERRORS.notFound }
  }
  await tx.invoiceLine.deleteMany({ where: { invoiceId: input.invoiceId } })
  if (input.lines.length > 0) await tx.invoiceLine.createMany({ data: input.lines.map((l) => ({ ...l, invoiceId: input.invoiceId })) })
  await tx.historyLog.create({
    data: { companyId: input.companyId, actorId: input.actorId, action: "UPDATED", entityType: "Invoice", entityId: input.invoiceId, detail: `Brouillon de facture modifié (${input.lines.length} ligne${input.lines.length > 1 ? "s" : ""})`, newValue: { totalTTC: input.header.totalTTC, lines: input.lines.length } },
  })
  return { ok: true, value: undefined }
}
