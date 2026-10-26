// ═══════════════════════════════════════════════════════════════════════════
// Intégrité d'une pièce émise (correctif P1-01) : les totaux PERSISTÉS d'une pièce émise doivent être égaux au RECALCUL depuis
// ses lignes (même moteur monétaire, même sémantique des déductions). Tout consommateur qui produit un montant à partir d'une
// pièce (PDF, TVA, écritures comptables, indicateurs) vérifie cette égalité et REFUSE explicitement la pièce en cas de
// divergence : jamais un PDF, une déclaration ou une écriture d'un autre montant que la pièce.
// Les brouillons ne sont pas contrôlés (totaux provisoires) ; les pièces anciennes ne sont pas réécrites.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma } from "@prisma/client"
import { computeDocumentTotals, decimalToCents, storedVatRateToBp, type DocumentTotals } from "@/lib/billing/money"

export class DocumentIntegrityError extends Error {
  constructor(readonly code: "TOTALS_MISMATCH", readonly documentNumber: string, readonly detail: { stored: { ht: bigint; vat: bigint; ttc: bigint }; computed: { ht: bigint; vat: bigint; ttc: bigint } }) {
    super(`DOCUMENT_INTEGRITY:${code}: pièce ${documentNumber} — totaux stockés (${detail.stored.ht}/${detail.stored.vat}/${detail.stored.ttc} c) ≠ recalcul (${detail.computed.ht}/${detail.computed.vat}/${detail.computed.ttc} c)`)
    this.name = "DocumentIntegrityError"
  }
}

export interface StoredDocumentForIntegrity {
  number: string
  status: string
  globalDiscountBp: number
  vatReverseCharge: boolean
  totalHT: Prisma.Decimal | string
  totalVAT: Prisma.Decimal | string
  totalTTC: Prisma.Decimal | string
  lines: { quantity: Prisma.Decimal | string; unitPrice: Prisma.Decimal | string; vatRate: Prisma.Decimal | string; discountBp: number; deductsDepositId: string | null }[]
}

/** Recalcul des totaux d'une pièce depuis ses lignes persistées (sémantique figée : déduction d'acompte hors remise globale). */
export function recomputeDocumentTotals(doc: Omit<StoredDocumentForIntegrity, "number" | "status" | "totalHT" | "totalVAT" | "totalTTC">): DocumentTotals {
  return computeDocumentTotals(
    doc.lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), excludeGlobalDiscount: !!l.deductsDepositId })),
    { globalDiscountBp: doc.globalDiscountBp, vatReverseCharge: doc.vatReverseCharge },
  )
}

export function storedTotalsMatch(doc: StoredDocumentForIntegrity, totals: DocumentTotals): boolean {
  return decimalToCents(doc.totalHT) === totals.totalHTCents && decimalToCents(doc.totalVAT) === totals.totalVATCents && decimalToCents(doc.totalTTC) === totals.totalTTCCents
}

/**
 * Vérifie une pièce ÉMISE (hors brouillon) : lève DocumentIntegrityError si les totaux stockés diffèrent du recalcul.
 * Renvoie les totaux recalculés (à utiliser par l'appelant) ; un brouillon est renvoyé sans contrôle.
 */
export function assertStoredTotalsMatch(doc: StoredDocumentForIntegrity, totals: DocumentTotals = recomputeDocumentTotals(doc)): DocumentTotals {
  if (doc.status === "DRAFT") return totals
  if (!storedTotalsMatch(doc, totals)) {
    throw new DocumentIntegrityError("TOTALS_MISMATCH", doc.number, {
      stored: { ht: decimalToCents(doc.totalHT), vat: decimalToCents(doc.totalVAT), ttc: decimalToCents(doc.totalTTC) },
      computed: { ht: totals.totalHTCents, vat: totals.totalVATCents, ttc: totals.totalTTCCents },
    })
  }
  return totals
}
