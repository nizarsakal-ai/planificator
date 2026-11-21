// ═══════════════════════════════════════════════════════════════════════════
// Langue des PDF (21/11/2026) — traduction des libellés, titres et mentions STANDARD générés par Planificator.
// Pur, sans dépendance. Les textes saisis par l'utilisateur (désignations, noms, adresses, notes, conditions libres, pied de
// page) ne passent jamais par ici : seul le texte produit par l'application est traduit. Texte inconnu ⇒ inchangé.
// En anglais, une mention précise que la version française fait foi (sécurité juridique : facture française).
// ═══════════════════════════════════════════════════════════════════════════
import type { PdfLanguage } from "./design"

const EXACT: Readonly<Record<string, string>> = {
  // Titres
  "FACTURE": "INVOICE", "FACTURE D'ACOMPTE": "DEPOSIT INVOICE", "AVOIR": "CREDIT NOTE", "DEVIS": "QUOTE", "DEVIS (brouillon)": "QUOTE (draft)",
  "BON DE COMMANDE": "PURCHASE ORDER", "BON DE COMMANDE CLIENT": "SALES ORDER", "BON DE LIVRAISON": "DELIVERY NOTE",
  // Parties et blocs
  "Émetteur": "From", "Client": "Bill to", "Fournisseur": "Supplier", "Adresse de livraison": "Delivery address", "Livrer à": "Deliver to",
  "Objet": "Subject", "N°": "No.", "Notes": "Notes", "Conditions et mentions": "Terms and legal notices", "Coordonnées bancaires": "Bank details", "Titulaire": "Account holder",
  "Bon pour accord": "Approved", "Date, nom et signature du client": "Date, name and signature of the client",
  "Réception de la livraison": "Delivery received", "Date, nom et signature du destinataire": "Date, name and signature of the recipient",
  "Brouillon — à compléter avant émission": "Draft — to be completed before issue",
  // Colonnes
  "Désignation": "Description", "Unité": "Unit", "Qté": "Qty", "PU HT": "Unit price excl. VAT", "Remise": "Discount", "TVA": "VAT",
  "Total HT": "Total excl. VAT", "Montant HT": "Amount excl. VAT", "Qté commandée": "Qty ordered", "Qté livrée": "Qty delivered",
  // Totaux
  "Sous-total HT": "Subtotal excl. VAT", "Total TVA": "Total VAT", "Total TTC": "Total incl. VAT",
  // Métadonnées
  "Date d'émission": "Issue date", "Échéance": "Due date", "Chantier": "Project site", "Devis": "Quote", "Bon de commande client": "Client PO number",
  "Facture d'origine": "Original invoice", "Période": "Period", "Date": "Date", "Valable jusqu'au": "Valid until", "non émise": "not issued",
  "Règlement": "Payment", "à réception": "on receipt", "Date de livraison": "Delivery date", "Livraison prévue": "Expected delivery", "Facture": "Invoice",
  // Tampons et suivi
  "Payée": "Paid", "Annulée": "Cancelled", "Livré": "Delivered", "Facture acquittée.": "Invoice paid.", "Facture acquittée (règlement constaté).": "Invoice paid (payment recorded).",
  "Facture soldée (paiements et avoir).": "Invoice settled (payments and credit note).", "Avoir": "Credit note", "Acomptes déduits": "Deposits deducted", "Acompte": "Deposit",
  // Mentions légales standard (document-data.ts, settings.ts)
  "En cas de retard de paiement, pénalités de retard au taux de 3 fois le taux d'intérêt légal, exigibles sans rappel, et indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 et D441-5 du Code de commerce). Pas d'escompte pour paiement anticipé.":
    "Late payment: penalties at three times the French statutory interest rate, payable without reminder, plus a fixed recovery fee of €40 (art. L441-10 and D441-5 of the French Commercial Code). No discount for early payment.",
  "Autoliquidation — TVA due par le preneur (art. 283-2 nonies du CGI).": "Reverse charge — VAT payable by the customer (art. 283-2 nonies of the French General Tax Code).",
  "TVA non applicable, art. 293 B du CGI.": "VAT not applicable, art. 293 B of the French General Tax Code.",
  "Devis gratuit. Pour accord, retourner ce devis daté et signé avec la mention « Bon pour accord », ou signer en ligne via le lien reçu.":
    "Free quote. To accept, return this quote dated and signed with the words \"Approved\", or sign online using the link you received.",
  "Montant à déduire de la prochaine facture ou à rembourser.": "Amount to be deducted from the next invoice or refunded.",
}

const PATTERNS: readonly [RegExp, (m: RegExpMatchArray, lang: PdfLanguage) => string][] = [
  [/^(.+) \(brouillon — non émise\)$/, (m, l) => `${translate(m[1], l)} (draft — not issued)`],
  [/^TVA (\d+(?:[.,]\d+)?) %$/, (m) => `VAT ${m[1]} %`],
  [/^Remise globale (\d+(?:[.,]\d+)?) %$/, (m) => `Global discount ${m[1]} %`],
  [/^Paiement à (\d+) jours\.$/, (m) => `Payment within ${m[1]} days.`],
  [/^Conditions de paiement : ([\s\S]*)$/, (m) => `Payment terms: ${m[1]}`],
  [/^Règlement par virement : IBAN ([\s\S]*)$/, (m) => `Payment by bank transfer: IBAN ${m[1]}`],
  [/^Entre professionnels : ([\s\S]*)$/, (m, l) => `Between professionals: ${translate(m[1], l)}`],
  [/^Validité de l'offre : jusqu'au (.+)\. Au-delà, les prix et disponibilités sont à reconfirmer\.$/, (m) => `Offer valid until ${m[1]}. After that date, prices and availability must be reconfirmed.`],
  [/^Reste à payer : (.*)$/, (m) => `Balance due: ${m[1]}`],
  [/^Situation des règlements au (.+) \(annexe informative, distincte de la pièce émise\)$/, (m) => `Payment status as of ${m[1]} (informative appendix, separate from the issued document)`],
  [/^Signé en ligne par (.+) le (.+)$/, (m) => `Signed online by ${m[1]} on ${m[2]}`],
  [/^Reçu par (.+) le (.+)$/, (m) => `Received by ${m[1]} on ${m[2]}`],
]

/** Mention ajoutée en fin de document traduit. */
export const FRENCH_PREVAILS_EN = "This document is a translation provided for convenience; the French version prevails."

/** Traduit un texte produit par l'application ; inconnu ⇒ inchangé. FR ⇒ toujours inchangé. */
export function translate(text: string, lang: PdfLanguage): string {
  if (lang === "FR" || !text) return text
  const exact = EXACT[text]
  if (exact !== undefined) return exact
  for (const [re, fn] of PATTERNS) {
    const m = text.match(re)
    if (m) return fn(m, lang)
  }
  return text
}
