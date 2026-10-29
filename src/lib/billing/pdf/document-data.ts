// Données d'un document PDF (devis, facture, acompte, avoir) : tout est calculé en centimes puis formaté en chaînes.
import type { Prisma } from "@prisma/client"
import { bpToPercentString, computeDocumentTotals, decimalToCents, formatEuro, storedVatRateToBp, type DocumentTotals } from "@/lib/billing/money"
import { DEFAULT_LATE_PENALTY_TEXT, sirenFromSiret, type BillingSettingsView } from "@/lib/billing/settings"
import { isPlausibleVatNumber } from "@/lib/billing/company-identity"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
export const fmtDate = (d: Date | null | undefined) => (d ? dateFr.format(d) : "—")

export interface PdfParty { name: string; lines: string[] }
export interface PdfLine { designation: string; description: string | null; unit: string; quantity: string; unitPrice: string; discount: string; vatRate: string; lineHT: string }
export interface PdfTotals { subtotal: string; globalDiscount: string | null; globalDiscountLabel: string | null; totalHT: string; vat: { label: string; base: string; amount: string }[]; totalVAT: string; totalTTC: string }

export interface DocumentPdfData {
  title: string            // DEVIS / FACTURE / FACTURE D'ACOMPTE / AVOIR
  number: string
  meta: { label: string; value: string }[]
  seller: PdfParty
  buyer: PdfParty
  subject: string | null
  lines: PdfLine[]
  totals: PdfTotals
  mentions: string[]       // mentions légales et conditions
  notes: string | null
  footer: string | null
  signature?: { name: string; date: string } | null
  extraBlocks?: { title: string; rows: string[] }[]
  /** Correctif P2-03 : origine du contenu documentaire d'une pièce émise. SNAPSHOT = figé à l'émission ; CURRENT_NO_SNAPSHOT =
   *  pièce émise avant la mise en place du snapshot, rééditée depuis les fiches actuelles (signalé sur le document) ; DRAFT = brouillon. */
  reissue?: { source: "SNAPSHOT" | "CURRENT_NO_SNAPSHOT" | "DRAFT"; capturedAt: string | null }
  /** Annexe de suivi des règlements (évolue après l'émission) : distincte de la pièce émise, jamais figée. */
  settlement?: { title: string; rows: string[] } | null
  /** 29/10/2026 — logo géré de l'entreprise émettrice (data URL PNG), embarqué sans accès réseau ; null = dénomination en texte. */
  logoDataUrl?: string | null
  /** 29/10/2026 — identité juridique exacte de l'émetteur en pied de page (données présentes uniquement, jamais générique). */
  legalFooter?: string | null
  /** 29/10/2026 — titre de la section des mentions (défaut : « Conditions et mentions »). */
  mentionsTitle?: string | null
  /** 29/10/2026 — brouillon uniquement : données juridiques indispensables manquantes, signalées sur le document. */
  draftWarnings?: string[]
}

export function sellerParty(company: { name: string; address: string | null; siret: string | null; email: string | null; phone: string | null }, s: BillingSettingsView): PdfParty {
  const siren = sirenFromSiret(company.siret)
  const lines = [
    company.address, [s.legalForm, s.shareCapital ? `au capital de ${s.shareCapital}` : null].filter(Boolean).join(" ") || null,
    company.siret ? `SIRET ${company.siret}` : null, siren ? `SIREN ${siren}` : null, s.rcs, s.vatNumber ? `TVA intracommunautaire ${s.vatNumber}` : null,
    company.email, company.phone,
  ].filter((l): l is string => !!l)
  return { name: company.name, lines }
}

/**
 * Identité du client. 29/10/2026 : SIREN (9 chiffres) et SIRET (14 chiffres) distingués ; un numéro de TVA n'est
 * imprimé que s'il a la forme d'un numéro intracommunautaire (un SIRET recopié dans ce champ n'est pas restitué).
 */
export function buyerParty(client: { name: string; address: string | null; siret: string | null; vatNumber: string | null; email?: string | null }): PdfParty {
  const id = (client.siret ?? "").replace(/\s/g, "")
  const idLine = /^\d{14}$/.test(id) ? `SIRET ${id}` : /^\d{9}$/.test(id) ? `SIREN ${id}` : id ? `Identifiant ${id}` : null
  const vat = (client.vatNumber ?? "").replace(/\s/g, "").toUpperCase()
  const vatLine = vat && isPlausibleVatNumber(vat) ? `TVA intracommunautaire ${vat}` : null
  const lines = [client.address, idLine, vatLine, client.email ?? null].filter((l): l is string => !!l)
  return { name: client.name, lines }
}

/** Client professionnel (B2B) : identifiant d'entreprise ou numéro de TVA plausible renseigné. */
export function buyerIsBusiness(client: { siret: string | null; vatNumber: string | null }): boolean {
  const id = (client.siret ?? "").replace(/\s/g, "")
  return /^\d{9}$|^\d{14}$/.test(id) || isPlausibleVatNumber(client.vatNumber)
}

export interface StoredLine { designation: string; description: string | null; unit: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; vatRate: Prisma.Decimal; lineHT: Prisma.Decimal; discountBp: number; deductsDepositId?: string | null }

export function linesAndTotals(lines: StoredLine[], globalDiscountBp: number, vatReverseCharge: boolean): { pdfLines: PdfLine[]; totals: PdfTotals; raw: DocumentTotals } {
  const inputs = lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), excludeGlobalDiscount: !!l.deductsDepositId }))
  const raw = computeDocumentTotals(inputs, { globalDiscountBp, vatReverseCharge })
  const pdfLines = lines.map((l, i) => ({
    designation: l.designation, description: l.description, unit: l.unit, quantity: l.quantity.toFixed(2).replace(".", ",").replace(/,00$/, ""),
    unitPrice: formatEuro(decimalToCents(l.unitPrice)), discount: l.discountBp ? `${bpToPercentString(l.discountBp)} %` : "", vatRate: `${bpToPercentString(storedVatRateToBp(l.vatRate))} %`,
    lineHT: formatEuro(raw.lines[i].lineHTCents),
  }))
  const totals: PdfTotals = {
    subtotal: formatEuro(raw.subtotalCents),
    globalDiscount: globalDiscountBp ? `−${formatEuro(raw.globalDiscountCents)}` : null,
    globalDiscountLabel: globalDiscountBp ? `Remise globale ${bpToPercentString(globalDiscountBp)} %` : null,
    totalHT: formatEuro(raw.totalHTCents),
    vat: raw.vatSummary.map((v) => ({ label: `TVA ${bpToPercentString(v.vatRateBp)} %`, base: formatEuro(v.baseCents), amount: formatEuro(v.vatCents) })),
    totalVAT: formatEuro(raw.totalVATCents), totalTTC: formatEuro(raw.totalTTCCents),
  }
  return { pdfLines, totals, raw }
}

export const REVERSE_CHARGE_MENTION = "Autoliquidation — TVA due par le preneur (art. 283-2 nonies du CGI)."

export const VAT_EXEMPT_MENTION = "TVA non applicable, art. 293 B du CGI."

export const QUOTE_ACCEPTANCE_MENTION = "Devis gratuit. Pour accord, retourner ce devis daté et signé avec la mention « Bon pour accord », ou signer en ligne via le lien reçu."

export interface LegalMentionOptions {
  vatReverseCharge: boolean
  paymentTerms: string | null
  kind: "quote" | "invoice" | "credit"
  vatExempt?: boolean
  /**
   * 29/10/2026 (devis) — client professionnel : les conditions de retard (pénalités, indemnité forfaitaire de 40 €,
   * art. L441-10 C. com.) figurent dans les conditions du devis ; jamais pour un particulier.
   */
  buyerIsBusiness?: boolean
  /** 29/10/2026 (devis) — date de validité restituée dans les conditions. */
  validUntil?: string | null
  /**
   * 29/10/2026 (devis) — `legacy: true` reproduit exactement les mentions des devis déjà émis (SENT, ACCEPTED,
   * REFUSED, EXPIRED, CONVERTED) : un document émis n'est pas réécrit silencieusement.
   */
  legacy?: boolean
}

export function legalMentions(s: BillingSettingsView, opts: LegalMentionOptions): string[] {
  const m: string[] = []
  if (opts.vatReverseCharge) m.push(REVERSE_CHARGE_MENTION)
  if (opts.vatExempt) m.push(VAT_EXEMPT_MENTION)
  if (opts.kind === "invoice") {
    m.push(opts.paymentTerms ? `Conditions de paiement : ${opts.paymentTerms}` : `Paiement à ${s.paymentTermsDays} jours.`)
    m.push(s.latePenaltyText ?? DEFAULT_LATE_PENALTY_TEXT)
    if (s.iban) m.push(`Règlement par virement : IBAN ${s.iban}${s.bic ? ` — BIC ${s.bic}` : ""}`)
  } else if (opts.kind === "quote") {
    if (opts.legacy) {
      if (opts.paymentTerms) m.push(`Conditions de paiement : ${opts.paymentTerms}`)
      m.push(QUOTE_ACCEPTANCE_MENTION)
      return m
    }
    if (opts.validUntil) m.push(`Validité de l'offre : jusqu'au ${opts.validUntil}. Au-delà, les prix et disponibilités sont à reconfirmer.`)
    m.push(opts.paymentTerms ? `Conditions de paiement : ${opts.paymentTerms}` : `Conditions de paiement : paiement à ${s.paymentTermsDays} jours à compter de la date de facturation (paramètre de l'entreprise).`)
    if (opts.buyerIsBusiness) m.push(`Entre professionnels : ${s.latePenaltyText ?? DEFAULT_LATE_PENALTY_TEXT}`)
    m.push(QUOTE_ACCEPTANCE_MENTION)
  }
  return m
}
