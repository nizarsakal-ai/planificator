// ═══════════════════════════════════════════════════════════════════════════
// Snapshot documentaire d'une pièce émise (correctif P2-03). À l'émission (facture, acompte, avoir), les données documentaires
// utilisées par le PDF — identité du vendeur, identité de l'acheteur, mentions légales/régime, conditions, pied de page, nom du
// chantier, références (devis, facture d'origine) — sont figées dans `invoice_document_snapshots` (immuable en base).
// Choix : snapshot STRUCTURÉ versionné (schemaVersion) plutôt qu'archivage d'octets PDF : le rendu @react-pdf n'est pas
// déterministe octet à octet (métadonnées de création), alors que le contenu documentaire, lui, est comparable champ à champ.
// Les montants et lignes ne sont PAS dupliqués : ils restent protégés en base (déclencheurs Lot B/C) et recalculés/contrôlés
// (document-integrity.ts). Les indicateurs de suivi (paiements, reste dû) ne sont jamais figés : ils forment une annexe distincte.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"
import { getBillingSettings } from "@/lib/billing/settings"
import { buyerParty, legalMentions, sellerParty, type PdfParty } from "./document-data"

export const DOCUMENT_SNAPSHOT_SCHEMA_VERSION = 1

export interface DocumentSnapshotContent {
  worksiteName: string
  quoteNumber: string | null
  creditedInvoice: { number: string; issueDate: string } | null
  subject: string | null
  notes: string | null
  paymentTerms: string | null
  mentions: string[]
  footer: string | null
  vatReverseCharge: boolean
}

export interface DocumentSnapshot { schemaVersion: number; seller: PdfParty; buyer: PdfParty; document: DocumentSnapshotContent; createdAt: Date }

const invoiceSelect = {
  id: true, number: true, kind: true, status: true, sentAt: true, subject: true, notes: true, paymentTerms: true, vatReverseCharge: true, totalVAT: true,
  company: { select: { name: true, address: true, siret: true, email: true, phone: true } },
  client: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
  worksite: { select: { name: true } }, quote: { select: { number: true } }, creditedInvoice: { select: { number: true, issueDate: true } },
} satisfies Prisma.InvoiceSelect

/**
 * Fige les données documentaires d'une pièce qui vient d'être émise (à appeler DANS la transaction d'émission, après le passage
 * hors brouillon ; le déclencheur SQL refuse tout snapshot d'un brouillon). Idempotent : une pièce déjà figée n'est pas réécrite.
 */
export async function captureDocumentSnapshot(tx: Prisma.TransactionClient, companyId: string, invoiceId: string): Promise<void> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, companyId }, select: invoiceSelect })
  if (!inv) throw new Error("DOCUMENT_SNAPSHOT_INVALID: pièce introuvable")
  if (inv.status === "DRAFT" || !inv.sentAt) throw new Error("DOCUMENT_SNAPSHOT_INVALID: pièce non émise")
  const existing = await tx.invoiceDocumentSnapshot.findFirst({ where: { invoiceId: inv.id, companyId }, select: { id: true } })
  if (existing) return
  const settings = await getBillingSettings(tx, companyId)
  const isCredit = inv.kind === "CREDIT_NOTE"
  const document: DocumentSnapshotContent = {
    worksiteName: inv.worksite.name, quoteNumber: inv.quote?.number ?? null,
    creditedInvoice: inv.creditedInvoice ? { number: inv.creditedInvoice.number, issueDate: inv.creditedInvoice.issueDate.toISOString() } : null,
    subject: inv.subject, notes: inv.notes, paymentTerms: inv.paymentTerms,
    mentions: legalMentions(settings, { vatReverseCharge: inv.vatReverseCharge, paymentTerms: inv.paymentTerms, kind: isCredit ? "credit" : "invoice", vatExempt: !settings.vatNumber && decimalToCents(inv.totalVAT) === BigInt(0) && !inv.vatReverseCharge }),
    footer: settings.invoiceFooter, vatReverseCharge: inv.vatReverseCharge,
  }
  await tx.invoiceDocumentSnapshot.create({
    data: {
      companyId, invoiceId: inv.id, schemaVersion: DOCUMENT_SNAPSHOT_SCHEMA_VERSION,
      seller: sellerParty(inv.company, settings) as unknown as Prisma.InputJsonValue,
      buyer: buyerParty(inv.client) as unknown as Prisma.InputJsonValue,
      document: document as unknown as Prisma.InputJsonValue,
    },
  })
}

export type SnapshotCapture = (tx: Prisma.TransactionClient, companyId: string, invoiceId: string) => Promise<void>

export async function readDocumentSnapshot(db: Prisma.TransactionClient | { invoiceDocumentSnapshot: Prisma.TransactionClient["invoiceDocumentSnapshot"] }, companyId: string, invoiceId: string): Promise<DocumentSnapshot | null> {
  const s = await db.invoiceDocumentSnapshot.findFirst({ where: { invoiceId, companyId }, select: { schemaVersion: true, seller: true, buyer: true, document: true, createdAt: true } })
  if (!s) return null
  return { schemaVersion: s.schemaVersion, seller: s.seller as unknown as PdfParty, buyer: s.buyer as unknown as PdfParty, document: s.document as unknown as DocumentSnapshotContent, createdAt: s.createdAt }
}
