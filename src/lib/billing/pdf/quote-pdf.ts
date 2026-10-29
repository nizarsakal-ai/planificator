import type { Prisma, PrismaClient } from "@prisma/client"
import { getBillingSettings } from "@/lib/billing/settings"
import { assessIssuerIdentity, issuerLegalFooter } from "@/lib/billing/company-identity"
import { logoForPdf } from "@/lib/company-logo"
import { buyerIsBusiness, buyerParty, fmtDate, legalMentions, linesAndTotals, sellerParty, type DocumentPdfData } from "./document-data"

type Db = PrismaClient | Prisma.TransactionClient

/**
 * 29/10/2026 — le PDF (aperçu et export) utilise le logo géré et les coordonnées de l'entreprise de session.
 * Brouillon : conditions complètes (validité, paiement, retard B2B) et signalement des données juridiques
 * manquantes ; devis déjà émis : mentions historiques reproduites à l'identique (`legacy`), aucune réécriture.
 * La TVA n'est jamais exonérée automatiquement : `vatReverseCharge` est un choix explicite du devis.
 */
export async function buildQuotePdfData(db: Db, companyId: string, quoteId: string): Promise<DocumentPdfData | null> {
  const q = await db.quote.findFirst({
    where: { id: quoteId, companyId },
    select: {
      number: true, status: true, issueDate: true, validUntil: true, subject: true, notes: true, paymentTerms: true, globalDiscountBp: true, vatReverseCharge: true, signerName: true, signedAt: true,
      company: { select: { name: true, address: true, siret: true, email: true, phone: true, logoUrl: true } },
      client: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
      worksite: { select: { name: true, address: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
    },
  })
  if (!q) return null
  const settings = await getBillingSettings(db, companyId)
  const { pdfLines, totals, raw } = linesAndTotals(q.lines, q.globalDiscountBp, q.vatReverseCharge)
  const draft = q.status === "DRAFT"
  const identity = { name: q.company.name, address: q.company.address, siret: q.company.siret, email: q.company.email, phone: q.company.phone, settings }
  const vatExempt = !settings.vatNumber && raw.totalVATCents === BigInt(0) && !q.vatReverseCharge
  return {
    title: draft ? "DEVIS (brouillon)" : "DEVIS",
    number: q.number,
    meta: [{ label: "Date", value: fmtDate(q.issueDate) }, { label: "Valable jusqu'au", value: fmtDate(q.validUntil) }, { label: "Chantier", value: q.worksite.name }],
    seller: sellerParty(q.company, settings), buyer: buyerParty(q.client),
    subject: q.subject, lines: pdfLines, totals,
    mentions: legalMentions(settings, {
      vatReverseCharge: q.vatReverseCharge, paymentTerms: q.paymentTerms, kind: "quote",
      ...(draft ? { vatExempt, buyerIsBusiness: buyerIsBusiness(q.client), validUntil: q.validUntil ? fmtDate(q.validUntil) : null } : { legacy: true }),
    }),
    notes: q.notes, footer: settings.quoteFooter,
    signature: q.signerName && q.signedAt ? { name: q.signerName, date: fmtDate(q.signedAt) } : null,
    logoDataUrl: logoForPdf(q.company.logoUrl),
    legalFooter: issuerLegalFooter(identity),
    draftWarnings: draft ? assessIssuerIdentity(identity).blocking.map((label) => `Donnée d'identité manquante ou invalide : ${label} (Paramètres de l'entreprise / de facturation).`) : undefined,
  }
}
