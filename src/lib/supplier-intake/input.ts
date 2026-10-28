import { z } from "zod"
import { isoDateSchema } from "@/lib/accounting/ui/forms"
import { MoneyError, parseEuroInputToCents, parseVatRateToBp } from "@/lib/billing/money"
import { SUPPLIER_CATEGORIES } from "@/lib/accounting/c5/supplier-classification"
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)
const supplierFormSchema = z.object({
  supplierName: z.string().trim().min(1, "Fournisseur obligatoire").max(200), siret: z.string().trim().max(20).optional(), number: z.string().trim().min(1, "Numéro obligatoire").max(64),
  date: isoDateSchema, dueDate: z.union([isoDateSchema, z.literal("")]).optional(), totalHT: z.string().trim().max(24), vat: z.string().trim().max(24), totalTTC: z.string().trim().max(24),
  vatRate: z.string().trim().max(6).optional(), category: z.enum(SUPPLIER_CATEGORIES).optional(), expenseAccountId: z.string().trim().max(64).optional(), notes: z.string().trim().max(1000).optional(),
  fileId: z.string().trim().max(64).optional(),
  ocr: z.object({
    supplier: z.string().max(200).nullable().optional(), siret: z.string().max(14).nullable().optional(), invoiceNumber: z.string().max(64).nullable().optional(), date: z.string().max(10).nullable().optional(),
    totalHTCents: z.string().regex(/^-?\d{1,15}$/).nullable().optional(), vatCents: z.string().regex(/^-?\d{1,15}$/).nullable().optional(), totalTTCCents: z.string().regex(/^-?\d{1,15}$/).nullable().optional(),
    vatRateBp: z.number().int().min(0).max(10000).nullable().optional(), category: z.string().max(20).nullable().optional(), amountsAdjusted: z.boolean().optional(),
    confidence: z.record(z.number().min(0).max(1)).optional(),
  }).strict().nullable().optional(),
}).strict()

export function parseSupplierForm(raw: unknown) {
  const p = supplierFormSchema.safeParse(raw)
  if (!p.success) return { ok: false as const, error: p.error.issues[0]?.message ?? "Saisie invalide." }
  const v = p.data
  try {
    const siret = (v.siret ?? "").replace(/\s/g, "")
    return { ok: true as const, value: {
      input: { supplierName: v.supplierName, siret: siret || null, number: v.number, date: toDate(v.date), dueDate: v.dueDate ? toDate(v.dueDate) : null, totalHTCents: parseEuroInputToCents(v.totalHT), vatCents: parseEuroInputToCents(v.vat), totalTTCCents: parseEuroInputToCents(v.totalTTC), vatRateBp: v.vatRate ? parseVatRateToBp(v.vatRate) : null, category: v.category ?? null, expenseAccountId: v.expenseAccountId || null, notes: v.notes || null },
      fileId: v.fileId || null, ocr: v.ocr ?? null,
    } }
  } catch (e) { if (e instanceof MoneyError) return { ok: false as const, error: "Montants ou taux invalides." }; throw e }
}

