import type { Prisma, PrismaClient } from "@prisma/client"
import { getBillingSettings } from "@/lib/billing/settings"
import { buyerParty, fmtDate, legalMentions, linesAndTotals, sellerParty, type DocumentPdfData } from "./document-data"

type Db = PrismaClient | Prisma.TransactionClient

export async function buildQuotePdfData(db: Db, companyId: string, quoteId: string): Promise<DocumentPdfData | null> {
  const q = await db.quote.findFirst({
    where: { id: quoteId, companyId },
    select: {
      number: true, status: true, issueDate: true, validUntil: true, subject: true, notes: true, paymentTerms: true, globalDiscountBp: true, vatReverseCharge: true, signerName: true, signedAt: true,
      company: { select: { name: true, address: true, siret: true, email: true, phone: true } },
      client: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
      worksite: { select: { name: true, address: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
    },
  })
  if (!q) return null
  const settings = await getBillingSettings(db, companyId)
  const { pdfLines, totals } = linesAndTotals(q.lines, q.globalDiscountBp, q.vatReverseCharge)
  return {
    title: q.status === "DRAFT" ? "DEVIS (brouillon)" : "DEVIS",
    number: q.number,
    meta: [{ label: "Date", value: fmtDate(q.issueDate) }, { label: "Valable jusqu'au", value: fmtDate(q.validUntil) }, { label: "Chantier", value: q.worksite.name }],
    seller: sellerParty(q.company, settings), buyer: buyerParty(q.client),
    subject: q.subject, lines: pdfLines, totals,
    mentions: legalMentions(settings, { vatReverseCharge: q.vatReverseCharge, paymentTerms: q.paymentTerms, kind: "quote" }),
    notes: q.notes, footer: settings.quoteFooter,
    signature: q.signerName && q.signedAt ? { name: q.signerName, date: fmtDate(q.signedAt) } : null,
  }
}
