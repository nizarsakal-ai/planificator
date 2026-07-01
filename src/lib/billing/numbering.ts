// ═══════════════════════════════════════════════════════════════════════════
// Facturation — Numérotation séquentielle légale (sans trou)
//
// Génère un numéro DEV-YYYY-NNNN (devis) ou FAC-YYYY-NNNN (facture), unique par
// entreprise et par année, via un compteur incrémenté ATOMIQUEMENT en base pour
// éviter les doublons en cas d'appels concurrents.
// ═══════════════════════════════════════════════════════════════════════════

import type { Prisma } from "@prisma/client"

export type DocumentType = "QUOTE" | "INVOICE"

const PREFIX: Record<DocumentType, string> = {
  QUOTE:   "DEV",
  INVOICE: "FAC",
}

/**
 * Réserve le prochain numéro séquentiel pour un type de document.
 * DOIT être appelé à l'intérieur d'une transaction Prisma (`tx`) afin que la
 * réservation du numéro et la création du document soient atomiques.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  type: DocumentType,
  year = new Date().getFullYear()
): Promise<string> {
  const counter = await tx.documentCounter.upsert({
    where:  { companyId_type_year: { companyId, type, year } },
    create: { companyId, type, year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })

  const seq = String(counter.lastValue).padStart(4, "0")
  return `${PREFIX[type]}-${year}-${seq}`
}
