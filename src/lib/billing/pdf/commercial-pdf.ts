// 21/11/2026 — PDF des documents commerciaux : bon de commande client et bon de livraison (design de la société).
import type { Prisma, PrismaClient } from "@prisma/client"
import { getBillingSettings } from "@/lib/billing/settings"
import { issuerLegalFooter } from "@/lib/billing/company-identity"
import { logoForPdf } from "@/lib/company-logo"
import { buyerParty, fmtDate, linesAndTotals, sellerParty, type DocumentPdfData } from "./document-data"
import { formatQuantityFr } from "@/lib/billing/commercial/delivery-note.service"

type Db = PrismaClient | Prisma.TransactionClient
const EMPTY_TOTALS = { subtotal: "", globalDiscount: null, globalDiscountLabel: null, totalHT: "", vat: [], totalVAT: "", totalTTC: "" }
const qty = (d: Prisma.Decimal) => formatQuantityFr(d)

const companySelect = { name: true, address: true, siret: true, email: true, phone: true, logoUrl: true } as const
const clientSelect = { name: true, address: true, siret: true, vatNumber: true, email: true } as const

async function issuer(db: Db, companyId: string) {
  const [company, settings] = await Promise.all([db.company.findUnique({ where: { id: companyId }, select: companySelect }), getBillingSettings(db, companyId)])
  if (!company) return null
  return {
    settings, seller: sellerParty(company, settings), logoDataUrl: logoForPdf(company.logoUrl),
    legalFooter: issuerLegalFooter({ name: company.name, address: company.address, siret: company.siret, email: company.email, phone: company.phone, settings }),
  }
}

export async function buildClientOrderPdfData(db: Db, companyId: string, orderId: string): Promise<DocumentPdfData | null> {
  const [o, iss] = await Promise.all([
    db.clientOrder.findFirst({
      where: { id: orderId, companyId },
      select: {
        number: true, status: true, issueDate: true, expectedDeliveryDate: true, clientReference: true, deliveryAddress: true, subject: true, notes: true, globalDiscountBp: true, vatReverseCharge: true,
        client: { select: clientSelect }, worksite: { select: { name: true } }, quote: { select: { number: true } },
        lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
      },
    }),
    issuer(db, companyId),
  ])
  if (!o || !iss) return null
  const { pdfLines, totals } = linesAndTotals(o.lines, o.globalDiscountBp, o.vatReverseCharge)
  return {
    title: "BON DE COMMANDE CLIENT", number: o.number,
    meta: [
      { label: "Date", value: fmtDate(o.issueDate) },
      { label: "Devis", value: o.quote.number },
      ...(o.clientReference ? [{ label: "Bon de commande client", value: o.clientReference }] : []),
      ...(o.expectedDeliveryDate ? [{ label: "Livraison prévue", value: fmtDate(o.expectedDeliveryDate) }] : []),
      { label: "Chantier", value: o.worksite.name },
    ],
    seller: iss.seller, buyer: buyerParty(o.client), deliveryAddress: o.deliveryAddress,
    subject: o.subject, lines: pdfLines, totals,
    mentions: ["Confirmation de commande établie d'après le devis accepté ; la facture sera émise selon les conditions de ce devis."],
    notes: o.notes, footer: iss.settings.quoteFooter, logoDataUrl: iss.logoDataUrl, legalFooter: iss.legalFooter,
    design: iss.settings.pdfDesign,
    stamp: o.status === "CANCELLED" ? { label: "Annulée", tone: "danger" } : null,
  }
}

export async function buildDeliveryNotePdfData(db: Db, companyId: string, noteId: string): Promise<DocumentPdfData | null> {
  const [n, iss] = await Promise.all([
    db.deliveryNote.findFirst({
      where: { id: noteId, companyId },
      select: {
        number: true, status: true, deliveryDate: true, deliveryAddress: true, notes: true, receivedByName: true, receivedAt: true,
        client: { select: clientSelect }, worksite: { select: { name: true } }, quote: { select: { number: true } }, invoice: { select: { number: true } }, clientOrder: { select: { number: true, clientReference: true } },
        lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantityOrdered: true, quantityDelivered: true } },
      },
    }),
    issuer(db, companyId),
  ])
  if (!n || !iss) return null
  return {
    title: "BON DE LIVRAISON", number: n.number,
    meta: [
      { label: "Date de livraison", value: fmtDate(n.deliveryDate) },
      ...(n.clientOrder ? [{ label: "Bon de commande client", value: n.clientOrder.clientReference ? `${n.clientOrder.number} (réf. ${n.clientOrder.clientReference})` : n.clientOrder.number }] : []),
      ...(n.quote ? [{ label: "Devis", value: n.quote.number }] : []),
      ...(n.invoice ? [{ label: "Facture", value: n.invoice.number }] : []),
      { label: "Chantier", value: n.worksite.name },
    ],
    seller: iss.seller, buyer: buyerParty(n.client), deliveryAddress: n.deliveryAddress,
    subject: null, lines: [], totals: EMPTY_TOTALS, hideTotals: true,
    table: {
      columns: [{ key: "designation", label: "Désignation", width: 56 }, { key: "unit", label: "Unité", width: 12 }, { key: "ordered", label: "Qté commandée", width: 16, numeric: true }, { key: "delivered", label: "Qté livrée", width: 16, numeric: true }],
      rows: n.lines.map((l) => ({ cells: { designation: l.designation, unit: l.unit, ordered: qty(l.quantityOrdered), delivered: qty(l.quantityDelivered) }, description: l.description })),
    },
    mentions: ["Toute réserve sur l'état ou les quantités livrées doit être indiquée sur ce bon à la réception."],
    notes: n.notes, footer: null, logoDataUrl: iss.logoDataUrl, legalFooter: iss.legalFooter,
    signatureKind: "delivery",
    signature: n.receivedByName && n.receivedAt ? { name: n.receivedByName, date: fmtDate(n.receivedAt) } : null,
    // L'adresse de livraison est l'information centrale d'un bon de livraison : toujours affichée.
    design: { ...iss.settings.pdfDesign, showDeliveryAddress: true },
    stamp: n.status === "DELIVERED" ? { label: "Livré", tone: "success" } : n.status === "CANCELLED" ? { label: "Annulé", tone: "danger" } : null,
  }
}
