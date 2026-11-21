// 21/11/2026 — PDF d'un bon de commande FOURNISSEUR (module Achats) aux couleurs du design de la société.
// Lecture seule ; bornée à la société de session. Montants hors taxes (la TVA s'applique à la facture du fournisseur).
import type { Prisma, PrismaClient } from "@prisma/client"
import { formatEuro } from "@/lib/billing/money"
import { getBillingSettings } from "@/lib/billing/settings"
import { issuerLegalFooter } from "@/lib/billing/company-identity"
import { logoForPdf } from "@/lib/company-logo"
import { formatMilli, lineAmountCents } from "@/lib/stock/quantity"
import { fmtDate, sellerParty, type DocumentPdfData } from "./document-data"

type Db = PrismaClient | Prisma.TransactionClient

const EMPTY_TOTALS = { subtotal: "", globalDiscount: null, globalDiscountLabel: null, totalHT: "", vat: [], totalVAT: "", totalTTC: "" }

/** Lignes d'identité d'un fournisseur (adresse, SIRET, TVA, e-mail présents uniquement). */
export function supplierLines(s: { address: string | null; siret: string | null; vatNumber: string | null; email: string | null }): string[] {
  return [s.address, s.siret ? `SIRET ${s.siret}` : null, s.vatNumber ? `TVA intracommunautaire ${s.vatNumber}` : null, s.email].filter((l): l is string => !!l)
}

export async function buildPurchaseOrderPdfData(db: Db, companyId: string, orderId: string): Promise<DocumentPdfData | null> {
  const [order, company, settings] = await Promise.all([
    db.purchaseOrder.findFirst({
      where: { id: orderId, companyId },
      select: {
        number: true, status: true, orderedAt: true, expectedAt: true, notes: true,
        supplier: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
        warehouse: { select: { name: true, address: true } }, worksite: { select: { name: true } },
        lines: { orderBy: { position: "asc" }, select: { designation: true, quantityMilli: true, unitPriceCents: true, article: { select: { unit: true, reference: true } } } },
      },
    }),
    db.company.findUnique({ where: { id: companyId }, select: { name: true, address: true, siret: true, email: true, phone: true, logoUrl: true } }),
    getBillingSettings(db, companyId),
  ])
  if (!order || !company) return null
  let total = BigInt(0)
  const rows = order.lines.map((l) => {
    const amount = lineAmountCents(l.quantityMilli, l.unitPriceCents)
    total += amount
    return {
      cells: { designation: l.designation, unit: l.article?.unit ?? "u", quantity: formatMilli(l.quantityMilli), unitPrice: formatEuro(BigInt(l.unitPriceCents)), lineHT: formatEuro(amount) },
      description: l.article?.reference ? `Réf. ${l.article.reference}` : null,
    }
  })
  const draft = order.status === "DRAFT"
  return {
    title: "BON DE COMMANDE", number: order.number,
    subtitle: draft ? "Brouillon — commande non passée" : null,
    meta: [
      { label: "Date", value: order.orderedAt ? fmtDate(order.orderedAt) : "non émise" },
      ...(order.expectedAt ? [{ label: "Livraison prévue", value: fmtDate(order.expectedAt) }] : []),
      ...(order.worksite ? [{ label: "Chantier", value: order.worksite.name }] : []),
    ],
    seller: sellerParty(company, settings),
    buyer: { name: order.supplier.name, lines: supplierLines(order.supplier) },
    partyLabels: { seller: "Émetteur", buyer: "Fournisseur" },
    deliveryAddress: [order.warehouse.name, order.warehouse.address].filter(Boolean).join("\n") || null,
    subject: null, lines: [], totals: EMPTY_TOTALS, hideTotals: true,
    table: {
      columns: [
        { key: "designation", label: "Désignation", width: 46 }, { key: "unit", label: "Unité", width: 9 }, { key: "quantity", label: "Qté", width: 12, numeric: true },
        { key: "unitPrice", label: "PU HT", width: 15, numeric: true }, { key: "lineHT", label: "Total HT", width: 18, numeric: true },
      ],
      rows,
    },
    extraBlocks: [{ title: "Total de la commande", rows: [`Total HT : ${formatEuro(total)}`, "Montants hors taxes ; la TVA s'applique à la facture du fournisseur."] }],
    mentions: ["Merci de rappeler le numéro de commande sur le bon de livraison et sur la facture."],
    notes: order.notes, footer: null,
    logoDataUrl: logoForPdf(company.logoUrl),
    legalFooter: issuerLegalFooter({ name: company.name, address: company.address, siret: company.siret, email: company.email, phone: company.phone, settings }),
    // Le design de la société s'applique ; l'adresse de livraison (dépôt) est toujours utile sur une commande.
    design: { ...settings.pdfDesign, showDeliveryAddress: true },
    stamp: order.status === "CANCELLED" ? { label: "Annulée", tone: "danger" } : null,
  }
}
