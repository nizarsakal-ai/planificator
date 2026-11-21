// 20/11/2026 — données d'un document d'EXEMPLE pour l'aperçu d'un design (paramètres, brouillons). Pur : aucun accès base.
// Identité réelle de l'émetteur (logo, coordonnées, pied de page) + client et lignes fictifs, clairement signalés.
import type { DocumentPdfData, PdfParty } from "./document-data"
import { effectiveLayout, type PdfDesign } from "./design"

export interface PreviewIdentity {
  seller: PdfParty
  logoDataUrl: string | null
  legalFooter: string | null
  bank: { iban: string; bic: string | null } | null
}

/** Lignes d'exemple : quantité 1 sans remise (le format « Rapide » est donc applicable et visible dans l'aperçu). */
const QUICK_LINES = [
  { designation: "Prestation électrique — installation scène", description: "Raccordement, tableau provisoire, mise en sécurité", unit: "forfait", quantity: "1", unitPrice: "4 800,00 €", discount: "", vatRate: "20 %", lineHT: "4 800,00 €" },
  { designation: "Éclairage d'ambiance", description: null, unit: "forfait", quantity: "1", unitPrice: "1 950,00 €", discount: "", vatRate: "20 %", lineHT: "1 950,00 €" },
  { designation: "Démontage et évacuation", description: null, unit: "forfait", quantity: "1", unitPrice: "814,67 €", discount: "", vatRate: "20 %", lineHT: "814,67 €" },
]

export function buildDesignPreviewData(design: PdfDesign, identity: PreviewIdentity): DocumentPdfData {
  const layout = effectiveLayout(design, QUICK_LINES)
  return {
    title: "FACTURE", number: "EXEMPLE-0001",
    meta: [{ label: "Date d'émission", value: "20/11/2026" }, { label: "Règlement", value: "à réception" }, { label: "Chantier", value: "Exemple de chantier" }],
    seller: identity.seller,
    buyer: { name: "CLIENT EXEMPLE", lines: ["12 rue de l'Exemple, 75000 Paris", "SIRET 12345678900012", "TVA intracommunautaire FR12123456789"] },
    subject: layout === "QUICK" ? null : "Aperçu du format complet",
    lines: QUICK_LINES,
    totals: { subtotal: "7 564,67 €", globalDiscount: null, globalDiscountLabel: null, totalHT: "7 564,67 €", vat: [{ label: "TVA 20 %", base: "7 564,67 €", amount: "1 512,93 €" }], totalVAT: "1 512,93 €", totalTTC: "9 077,60 €" },
    mentions: [
      "En cas de retard de paiement, pénalités au taux de 3 fois le taux d'intérêt légal et indemnité forfaitaire pour frais de recouvrement de 40 €.",
      ...(identity.bank ? [`Règlement par virement : IBAN ${identity.bank.iban}${identity.bank.bic ? ` — BIC ${identity.bank.bic}` : ""}`] : []),
      "Document d'exemple généré pour l'aperçu du design : client, lignes et montants fictifs.",
    ],
    notes: null, footer: null,
    logoDataUrl: identity.logoDataUrl, legalFooter: identity.legalFooter,
    design, bank: identity.bank,
    deliveryAddress: "Entrepôt — 3 allée des Livraisons, 93100 Montreuil",
    stamp: { label: "Payée", tone: "success" },
  }
}
