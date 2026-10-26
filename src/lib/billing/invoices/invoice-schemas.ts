// Validation (zod strict) des saisies de facture (C2) — pur. Réutilise les lignes et la conversion des devis (C1).
import { z } from "zod"
import { isCalendarDay } from "@/lib/accounting/ui/forms"
import { MoneyError, computeDocumentTotals, parseEuroInputToCents, parsePercentToBp, parseQuantityToHundredths, parseVatRateToBp, type DocumentTotals } from "@/lib/billing/money"
import { moneyErrorLabel, quoteLineFormSchema, type ParsedQuoteLine } from "@/lib/billing/quotes/quote-schemas"

const id = z.string().trim().min(1).max(64)
const text = (max: number) => z.string().trim().max(max)
const isoDate = z.string().refine(isCalendarDay, "Date invalide")

export const invoiceFormSchema = z.object({
  worksiteId: id,
  quoteId: z.string().trim().max(64).nullable().optional(),
  dueDate: z.union([isoDate, z.literal("")]).optional(),
  subject: text(200).optional(),
  notes: text(2000).optional(),
  paymentTerms: text(500).optional(),
  globalDiscount: z.string().trim().max(10).optional(),
  vatReverseCharge: z.boolean().optional(),
  lines: z.array(quoteLineFormSchema).min(1, "Au moins une ligne").max(200),
}).strict()
export type InvoiceFormInput = z.input<typeof invoiceFormSchema>

export interface ParsedInvoice {
  worksiteId: string
  quoteId: string | null
  dueDate: Date | null
  subject: string | null
  notes: string | null
  paymentTerms: string | null
  globalDiscountBp: number
  vatReverseCharge: boolean
  lines: ParsedQuoteLine[]
  totals: DocumentTotals
}

export function parseInvoiceForm(raw: unknown): { ok: true; value: ParsedInvoice } | { ok: false; error: string } {
  const r = invoiceFormSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Saisie invalide" }
  const v = r.data
  const lines: ParsedQuoteLine[] = []
  for (const [i, l] of v.lines.entries()) {
    try {
      lines.push({
        articleId: l.articleId ? l.articleId : null, designation: l.designation, description: l.description ? l.description : null, unit: l.unit ? l.unit : "u",
        quantityHundredths: parseQuantityToHundredths(l.quantity), unitPriceCents: parseEuroInputToCents(l.unitPrice),
        discountBp: parsePercentToBp(l.discount ?? ""), vatRateBp: parseVatRateToBp(l.vatRate),
      })
    } catch (e) { if (e instanceof MoneyError) return { ok: false, error: `Ligne ${i + 1} : ${moneyErrorLabel(e.code)}` }; throw e }
  }
  let globalDiscountBp: number; let totals: DocumentTotals
  try {
    globalDiscountBp = parsePercentToBp(v.globalDiscount ?? "")
    totals = computeDocumentTotals(lines, { globalDiscountBp, vatReverseCharge: v.vatReverseCharge === true })
  } catch (e) { if (e instanceof MoneyError) return { ok: false, error: moneyErrorLabel(e.code) }; throw e }
  if (totals.totalTTCCents < BigInt(0)) return { ok: false, error: "Le total TTC d'une facture ne peut pas être négatif." }
  return { ok: true, value: {
    worksiteId: v.worksiteId, quoteId: v.quoteId ? v.quoteId : null, dueDate: v.dueDate ? new Date(`${v.dueDate}T00:00:00.000Z`) : null,
    subject: v.subject ? v.subject : null, notes: v.notes ? v.notes : null, paymentTerms: v.paymentTerms ? v.paymentTerms : null,
    globalDiscountBp, vatReverseCharge: v.vatReverseCharge === true, lines, totals,
  } }
}

export const paymentFormSchema = z.object({
  amount: z.string().trim().min(1, "Montant obligatoire").max(24),
  method: z.enum(["TRANSFER", "CHECK", "CASH", "CARD", "DIRECT_DEBIT", "OTHER"]),
  paidAt: isoDate,
  reference: text(100).optional(),
  notes: text(500).optional(),
}).strict()
export type PaymentFormInput = z.input<typeof paymentFormSchema>

export function parsePaymentForm(raw: unknown): { ok: true; value: { amountCents: bigint; method: PaymentFormInput["method"]; paidAt: Date; reference: string | null; notes: string | null } } | { ok: false; error: string } {
  const r = paymentFormSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Saisie invalide" }
  let amountCents: bigint
  try { amountCents = parseEuroInputToCents(r.data.amount) } catch (e) { if (e instanceof MoneyError) return { ok: false, error: moneyErrorLabel(e.code) }; throw e }
  if (amountCents <= BigInt(0)) return { ok: false, error: "Le montant doit être supérieur à zéro." }
  return { ok: true, value: { amountCents, method: r.data.method, paidAt: new Date(`${r.data.paidAt}T00:00:00.000Z`), reference: r.data.reference ? r.data.reference : null, notes: r.data.notes ? r.data.notes : null } }
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = { TRANSFER: "Virement", CHECK: "Chèque", CASH: "Espèces", CARD: "Carte", DIRECT_DEBIT: "Prélèvement", OTHER: "Autre" }
