import type { Prisma, PrismaClient } from "@prisma/client"
import { decimalToCents, formatEuro } from "@/lib/billing/money"
import { getBillingSettings } from "@/lib/billing/settings"
import { buyerParty, fmtDate, legalMentions, linesAndTotals, sellerParty, type DocumentPdfData } from "./document-data"

type Db = PrismaClient | Prisma.TransactionClient
const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

export async function buildInvoicePdfData(db: Db, companyId: string, invoiceId: string): Promise<DocumentPdfData | null> {
  const inv = await db.invoice.findFirst({
    where: { id: invoiceId, companyId },
    select: {
      number: true, status: true, kind: true, issueDate: true, dueDate: true, periodStart: true, periodEnd: true, subject: true, notes: true, paymentTerms: true, globalDiscountBp: true, vatReverseCharge: true, totalTTC: true,
      company: { select: { name: true, address: true, siret: true, email: true, phone: true } },
      client: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
      worksite: { select: { name: true } }, quote: { select: { number: true } }, creditedInvoice: { select: { number: true, issueDate: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
      payments: { where: { reversesPaymentId: null, reversedAt: null }, orderBy: { paidAt: "asc" }, select: { amountCents: true, method: true, paidAt: true } },
    },
  })
  if (!inv) return null
  const settings = await getBillingSettings(db, companyId)
  const { pdfLines, totals, raw } = linesAndTotals(inv.lines, inv.globalDiscountBp, inv.vatReverseCharge)
  const isCredit = inv.kind === "CREDIT_NOTE"
  const isDeposit = inv.kind === "DEPOSIT"
  const draft = inv.status === "DRAFT"
  const title = isCredit ? "AVOIR" : isDeposit ? "FACTURE D'ACOMPTE" : "FACTURE"
  const meta = [
    { label: "Date d'émission", value: draft ? "non émise" : fmtDate(inv.issueDate) },
    ...(isCredit ? [] : [{ label: "Échéance", value: fmtDate(inv.dueDate) }]),
    { label: "Chantier", value: inv.worksite.name },
    ...(inv.quote ? [{ label: "Devis", value: inv.quote.number }] : []),
    ...(inv.creditedInvoice ? [{ label: "Facture d'origine", value: `${inv.creditedInvoice.number} du ${fmtDate(inv.creditedInvoice.issueDate)}` }] : []),
    ...(inv.periodStart || inv.periodEnd ? [{ label: "Période", value: `${fmtDate(inv.periodStart)} → ${fmtDate(inv.periodEnd)}` }] : []),
  ]
  const extraBlocks: DocumentPdfData["extraBlocks"] = []
  if (!isCredit && !draft && inv.status !== "CANCELLED") {
    const ttc = decimalToCents(inv.totalTTC)
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, BigInt(0))
    const rows = inv.payments.map((p) => `${dateFr.format(p.paidAt)} — ${formatEuro(p.amountCents)} (${{ TRANSFER: "virement", CHECK: "chèque", CASH: "espèces", CARD: "carte", DIRECT_DEBIT: "prélèvement", OTHER: "autre" }[p.method] ?? p.method})`)
    if (inv.status === "PAID") rows.push(paid < ttc ? "Facture acquittée (règlement constaté)." : "Facture acquittée.")
    else rows.push(`Reste à payer : ${formatEuro(ttc - paid)}`)
    extraBlocks.push({ title: inv.payments.length ? "Règlements reçus" : "Règlement", rows })
  }
  if (isCredit && inv.creditedInvoice) extraBlocks.push({ title: "Avoir", rows: [`Avoir sur la facture ${inv.creditedInvoice.number} du ${fmtDate(inv.creditedInvoice.issueDate)}.`, "Montant à déduire de la prochaine facture ou à rembourser."] })
  return {
    title: draft ? `${title} (brouillon — non émise)` : title, number: inv.number, meta,
    seller: sellerParty(inv.company, settings), buyer: buyerParty(inv.client), subject: inv.subject, lines: pdfLines, totals,
    mentions: legalMentions(settings, { vatReverseCharge: inv.vatReverseCharge, paymentTerms: inv.paymentTerms, kind: isCredit ? "credit" : "invoice", vatExempt: !settings.vatNumber && raw.totalVATCents === BigInt(0) && !inv.vatReverseCharge }),
    notes: inv.notes, footer: settings.invoiceFooter, extraBlocks,
  }
}
