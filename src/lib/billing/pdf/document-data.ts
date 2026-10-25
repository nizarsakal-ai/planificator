// Données d'un document PDF (devis, facture, acompte, avoir) : tout est calculé en centimes puis formaté en chaînes.
import type { Prisma } from "@prisma/client"
import { bpToPercentString, computeDocumentTotals, decimalToCents, formatEuro, storedVatRateToBp, type DocumentTotals } from "@/lib/billing/money"
import { DEFAULT_LATE_PENALTY_TEXT, sirenFromSiret, type BillingSettingsView } from "@/lib/billing/settings"

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

export function buyerParty(client: { name: string; address: string | null; siret: string | null; vatNumber: string | null; email?: string | null }): PdfParty {
  const lines = [client.address, client.siret ? `SIREN/SIRET ${client.siret}` : null, client.vatNumber ? `TVA ${client.vatNumber}` : null, client.email ?? null].filter((l): l is string => !!l)
  return { name: client.name, lines }
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

export function legalMentions(s: BillingSettingsView, opts: { vatReverseCharge: boolean; paymentTerms: string | null; kind: "quote" | "invoice" | "credit"; vatExempt?: boolean }): string[] {
  const m: string[] = []
  if (opts.vatReverseCharge) m.push(REVERSE_CHARGE_MENTION)
  if (opts.vatExempt) m.push(VAT_EXEMPT_MENTION)
  if (opts.kind === "invoice") {
    m.push(opts.paymentTerms ? `Conditions de paiement : ${opts.paymentTerms}` : `Paiement à ${s.paymentTermsDays} jours.`)
    m.push(s.latePenaltyText ?? DEFAULT_LATE_PENALTY_TEXT)
    if (s.iban) m.push(`Règlement par virement : IBAN ${s.iban}${s.bic ? ` — BIC ${s.bic}` : ""}`)
  } else if (opts.kind === "quote") {
    if (opts.paymentTerms) m.push(`Conditions de paiement : ${opts.paymentTerms}`)
    m.push("Devis gratuit. Pour accord, retourner ce devis daté et signé avec la mention « Bon pour accord », ou signer en ligne via le lien reçu.")
  }
  return m
}
