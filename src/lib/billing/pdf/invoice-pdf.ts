import type { Prisma, PrismaClient } from "@prisma/client"
import { decimalToCents, formatEuro } from "@/lib/billing/money"
import { getBillingSettings } from "@/lib/billing/settings"
import { assertStoredTotalsMatch } from "@/lib/billing/document-integrity"
import { buyerParty, fmtDate, legalMentions, linesAndTotals, sellerParty, type DocumentPdfData } from "./document-data"
import { readDocumentSnapshot } from "./document-snapshot"

type Db = PrismaClient | Prisma.TransactionClient
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export const NO_SNAPSHOT_MENTION = "Réédition : identités et mentions issues des fiches actuelles — snapshot historique indisponible pour cette pièce (émise avant la mise en place du figement documentaire). Ce document n'est pas une reconstitution certifiée de l'original."

/**
 * Données du PDF d'une pièce. Correctifs : P1-01 (une pièce émise dont les totaux stockés diffèrent du recalcul lève
 * DocumentIntegrityError — aucun PDF d'un autre montant) ; P2-03 (pièce émise = contenu documentaire FIGÉ au snapshot
 * d'émission ; brouillon = données courantes ; pièce émise sans snapshot = données courantes explicitement signalées).
 * Le suivi des règlements est une annexe distincte (`settlement`), datée du jour de réédition.
 */
export async function buildInvoicePdfData(db: Db, companyId: string, invoiceId: string, now: Date = new Date()): Promise<DocumentPdfData | null> {
  const inv = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: {
      number: true, status: true, kind: true, issueDate: true, dueDate: true, periodStart: true, periodEnd: true, subject: true, notes: true, paymentTerms: true, globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, creditReason: true, depositBp: true,
      depositDeductions: { select: { amountTTCCents: true, deposit: { select: { number: true, issueDate: true } } } },
      creditNotes: { where: { creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { number: true, totalTTC: true } },
      company: { select: { name: true, address: true, siret: true, email: true, phone: true } },
      client: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
      worksite: { select: { name: true } }, quote: { select: { number: true } }, creditedInvoice: { select: { number: true, issueDate: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true, deductsDepositId: true } },
      payments: { where: { reversesPaymentId: null, reversedAt: null }, orderBy: { paidAt: "asc" }, select: { amountCents: true, method: true, paidAt: true } },
    },
  })
  if (!inv) return null
  const draft = inv.status === "DRAFT"
  const { pdfLines, totals, raw } = linesAndTotals(inv.lines, inv.globalDiscountBp, inv.vatReverseCharge)
  // P1-01 : pièce émise ⇒ totaux stockés = recalcul, sinon refus explicite (exception typée).
  assertStoredTotalsMatch({ number: inv.number, status: inv.status, globalDiscountBp: inv.globalDiscountBp, vatReverseCharge: inv.vatReverseCharge, totalHT: inv.totalHT, totalVAT: inv.totalVAT, totalTTC: inv.totalTTC, lines: inv.lines }, raw)
  const snapshot = draft ? null : await readDocumentSnapshot(db, companyId, invoiceId)
  const isCredit = inv.kind === "CREDIT_NOTE"
  const isDeposit = inv.kind === "DEPOSIT"
  const title = isCredit ? "AVOIR" : isDeposit ? "FACTURE D'ACOMPTE" : "FACTURE"
  const worksiteName = snapshot?.document.worksiteName ?? inv.worksite.name
  const quoteNumber = snapshot ? snapshot.document.quoteNumber : inv.quote?.number ?? null
  const credited = snapshot ? snapshot.document.creditedInvoice : inv.creditedInvoice ? { number: inv.creditedInvoice.number, issueDate: inv.creditedInvoice.issueDate.toISOString() } : null
  const meta = [
    { label: "Date d'émission", value: draft ? "non émise" : fmtDate(inv.issueDate) },
    ...(isCredit ? [] : [{ label: "Échéance", value: fmtDate(inv.dueDate) }]),
    { label: "Chantier", value: worksiteName },
    ...(quoteNumber ? [{ label: "Devis", value: quoteNumber }] : []),
    ...(credited ? [{ label: "Facture d'origine", value: `${credited.number} du ${fmtDate(new Date(credited.issueDate))}` }] : []),
    ...(inv.periodStart || inv.periodEnd ? [{ label: "Période", value: `${fmtDate(inv.periodStart)} → ${fmtDate(inv.periodEnd)}` }] : []),
  ]
  const extraBlocks: DocumentPdfData["extraBlocks"] = []
  let settlement: DocumentPdfData["settlement"] = null
  if (!isCredit && !draft && inv.status !== "CANCELLED") {
    const ttc = decimalToCents(inv.totalTTC)
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
    const creditedCents = inv.creditNotes.reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0))
    const rows = inv.payments.map((p) => `${dateFr.format(p.paidAt)} — ${formatEuro(p.amountCents)} (${{ TRANSFER: "virement", CHECK: "chèque", CASH: "espèces", CARD: "carte", DIRECT_DEBIT: "prélèvement", OTHER: "autre" }[p.method] ?? p.method})`)
    for (const c of inv.creditNotes) rows.push(`Avoir ${c.number} : −${formatEuro(decimalToCents(c.totalTTC))}`)
    if (inv.status === "PAID") rows.push(paid + creditedCents >= ttc ? (creditedCents > BigInt(0) && paid < ttc ? "Facture soldée (paiements et avoir)." : "Facture acquittée.") : "Facture acquittée (règlement constaté).")
    else rows.push(`Reste à payer : ${formatEuro(ttc - paid - creditedCents)}`)
    settlement = { title: `Situation des règlements au ${dateFr.format(now)} (annexe informative, distincte de la pièce émise)`, rows }
  }
  if (isCredit && credited) extraBlocks.push({ title: "Avoir", rows: [`Avoir sur la facture ${credited.number} du ${fmtDate(new Date(credited.issueDate))}.`, ...(inv.creditReason ? [`Motif : ${inv.creditReason}`] : []), "Montant à déduire de la prochaine facture ou à rembourser."] })
  if (inv.depositDeductions.length > 0) extraBlocks.push({ title: "Acomptes déduits", rows: inv.depositDeductions.map((d) => `Facture d'acompte ${d.deposit.number} du ${fmtDate(d.deposit.issueDate)} : ${formatEuro(d.amountTTCCents)} TTC`) })
  if (isDeposit && quoteNumber) extraBlocks.push({ title: "Acompte", rows: [`${inv.depositBp ? `Acompte de ${inv.depositBp / 100} %` : "Acompte"} sur le devis ${quoteNumber}. Le solde sera facturé à l'issue des prestations, déduction faite du présent acompte.`] })
  let seller: DocumentPdfData["seller"], buyer: DocumentPdfData["buyer"], mentions: string[], footer: string | null
  if (snapshot) {
    seller = snapshot.seller; buyer = snapshot.buyer; mentions = [...snapshot.document.mentions]; footer = snapshot.document.footer
  } else {
    const settings = await getBillingSettings(db, companyId)
    seller = sellerParty(inv.company, settings); buyer = buyerParty(inv.client); footer = settings.invoiceFooter
    mentions = legalMentions(settings, { vatReverseCharge: inv.vatReverseCharge, paymentTerms: inv.paymentTerms, kind: isCredit ? "credit" : "invoice", vatExempt: !settings.vatNumber && raw.totalVATCents === BigInt(0) && !inv.vatReverseCharge })
    if (!draft) mentions.push(NO_SNAPSHOT_MENTION)
  }
  return {
    title: draft ? `${title} (brouillon — non émise)` : title, number: inv.number, meta,
    seller, buyer, subject: snapshot ? snapshot.document.subject : inv.subject, lines: pdfLines, totals,
    mentions, notes: snapshot ? snapshot.document.notes : inv.notes, footer, extraBlocks,
    reissue: { source: draft ? "DRAFT" : snapshot ? "SNAPSHOT" : "CURRENT_NO_SNAPSHOT", capturedAt: snapshot?.createdAt.toISOString() ?? null },
    settlement,
  }
}
