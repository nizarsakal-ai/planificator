// Validation (zod strict) et conversion des saisies de devis — pur, importable côté client et serveur.
// Les montants arrivent en chaînes (« 12,50 ») et sont convertis en centimes ; aucun flottant.
import { z } from "zod"
import { isCalendarDay } from "@/lib/accounting/ui/forms"
import {
  MoneyError, computeDocumentTotals, parseEuroInputToCents, parsePercentToBp, parseQuantityToHundredths, parseVatRateToBp,
  type DocumentLineInput, type DocumentTotals,
} from "@/lib/billing/money"

const id = z.string().trim().min(1).max(64)
const text = (max: number) => z.string().trim().max(max)
const isoDate = z.string().refine(isCalendarDay, "Date invalide")

export const quoteLineFormSchema = z.object({
  articleId: z.string().trim().max(64).nullable().optional(),
  designation: z.string().trim().min(1, "Désignation obligatoire").max(200),
  description: text(1000).nullable().optional(),
  unit: text(20).optional(),
  quantity: z.string().trim().max(20),
  unitPrice: z.string().trim().max(24),
  discount: z.string().trim().max(10).optional(),
  vatRate: z.string().trim().max(6),
}).strict()

export const quoteFormSchema = z.object({
  worksiteId: id,
  issueDate: isoDate,
  validUntil: z.union([isoDate, z.literal("")]).optional(),
  subject: text(200).optional(),
  notes: text(2000).optional(),
  paymentTerms: text(500).optional(),
  globalDiscount: z.string().trim().max(10).optional(),
  vatReverseCharge: z.boolean().optional(),
  lines: z.array(quoteLineFormSchema).min(1, "Au moins une ligne").max(200),
}).strict()

export type QuoteFormInput = z.input<typeof quoteFormSchema>
export type QuoteLineFormInput = z.input<typeof quoteLineFormSchema>

export interface ParsedQuoteLine extends DocumentLineInput {
  articleId: string | null
  designation: string
  description: string | null
  unit: string
}

export interface ParsedQuote {
  worksiteId: string
  issueDate: Date
  validUntil: Date | null
  subject: string | null
  notes: string | null
  paymentTerms: string | null
  globalDiscountBp: number
  vatReverseCharge: boolean
  lines: ParsedQuoteLine[]
  totals: DocumentTotals
}

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)

export function parseQuoteForm(raw: unknown): { ok: true; value: ParsedQuote } | { ok: false; error: string } {
  const r = quoteFormSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Saisie invalide" }
  const v = r.data
  const lines: ParsedQuoteLine[] = []
  for (const [i, l] of v.lines.entries()) {
    try {
      lines.push({
        articleId: l.articleId ? l.articleId : null,
        designation: l.designation,
        description: l.description ? l.description : null,
        unit: l.unit ? l.unit : "u",
        quantityHundredths: parseQuantityToHundredths(l.quantity),
        unitPriceCents: parseEuroInputToCents(l.unitPrice),
        discountBp: parsePercentToBp(l.discount ?? ""),
        vatRateBp: parseVatRateToBp(l.vatRate),
      })
    } catch (e) {
      if (e instanceof MoneyError) return { ok: false, error: `Ligne ${i + 1} : ${moneyErrorLabel(e.code)}` }
      throw e
    }
  }
  let globalDiscountBp: number
  let totals: DocumentTotals
  try {
    globalDiscountBp = parsePercentToBp(v.globalDiscount ?? "")
    totals = computeDocumentTotals(lines, { globalDiscountBp, vatReverseCharge: v.vatReverseCharge === true })
  } catch (e) {
    if (e instanceof MoneyError) return { ok: false, error: moneyErrorLabel(e.code) }
    throw e
  }
  const issueDate = toDate(v.issueDate)
  const validUntil = v.validUntil ? toDate(v.validUntil) : null
  if (validUntil && validUntil < issueDate) return { ok: false, error: "La date de validité précède la date d'émission." }
  return { ok: true, value: {
    worksiteId: v.worksiteId, issueDate, validUntil,
    subject: v.subject ? v.subject : null, notes: v.notes ? v.notes : null, paymentTerms: v.paymentTerms ? v.paymentTerms : null,
    globalDiscountBp, vatReverseCharge: v.vatReverseCharge === true, lines, totals,
  } }
}

export function moneyErrorLabel(code: string): string {
  switch (code) {
    case "AMOUNT_INVALID": case "AMOUNT_NOT_STRING": return "montant invalide (2 décimales max, sans signe)"
    case "AMOUNT_TOO_LARGE": return "montant trop élevé (maximum 99 999 999,99 €)"
    case "QUANTITY_INVALID": return "quantité invalide (2 décimales max)"
    case "PERCENT_INVALID": return "pourcentage invalide (0 à 100, 2 décimales max)"
    case "VAT_RATE_INVALID": return "taux de TVA invalide (0, 2.1, 5.5, 10 ou 20)"
    default: return "valeur invalide"
  }
}

/** Totaux en direct côté formulaire (tolérant : renvoie null si une saisie est invalide). */
export function previewQuoteTotals(lines: readonly QuoteLineFormInput[], globalDiscount: string, vatReverseCharge: boolean): DocumentTotals | null {
  try {
    const inputs: DocumentLineInput[] = lines.map((l) => ({
      quantityHundredths: parseQuantityToHundredths(l.quantity || "0"),
      unitPriceCents: parseEuroInputToCents(l.unitPrice || "0"),
      discountBp: parsePercentToBp(l.discount ?? ""),
      vatRateBp: parseVatRateToBp(l.vatRate || "20"),
    }))
    return computeDocumentTotals(inputs, { globalDiscountBp: parsePercentToBp(globalDiscount), vatReverseCharge })
  } catch {
    return null
  }
}
