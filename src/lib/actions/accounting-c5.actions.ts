"use server"
// Server Actions des écrans comptables C5 : garde A2 (requireAccountingAdmin, société de session), zod strict, services.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { requireAccountingAdmin } from "@/lib/accounting/access/accounting-access"
import { AccountingAccessError } from "@/lib/accounting/access/accounting-access.core"
import { AccountingError, type AccountingContext } from "@/lib/accounting/engine/posting"
import { accountingErrorMessage, isoDateSchema } from "@/lib/accounting/ui/forms"
import { MoneyError, parseEuroInputToCents, parseVatRateToBp } from "@/lib/billing/money"
import { PostingError, postMissingDocuments } from "@/lib/accounting/c5/postings"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { autoReconcile, importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { guessBankMapping, previewCsv } from "@/lib/accounting/c5/bank-import"
import { createSupplierInvoice, extractSupplierInvoice, rejectSupplierInvoice, storeSupplierFile, updateSupplierInvoice, validateSupplierInvoice, SUPPLIER_CATEGORIES } from "@/lib/accounting/c5/supplier-invoice.service"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)

async function run<T>(fn: (ctx: AccountingContext) => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Result<{ value: T }>> {
  try {
    const c = await requireAccountingAdmin()
    const r = await fn({ companyId: c.companyId, userId: c.userId })
    if (!r.ok) return { ok: false, error: r.error }
    revalidatePath("/comptabilite", "layout"); revalidatePath("/factures", "layout")
    return { ok: true, value: r.value }
  } catch (error) {
    if (error instanceof AccountingAccessError) return { ok: false, error: "Accès refusé." }
    if (error instanceof AccountingError) return { ok: false, error: accountingErrorMessage(error.code, error.details) }
    if (error instanceof PostingError) return { ok: false, error: error.message }
    const message = error instanceof Error ? error.message : ""
    if (/\b(ENTRY_[A-Z_]+|PAYMENT_[A-Z_]+|INVOICE_[A-Z_]+|SUPPLIER_INVOICE_CONFLICT)\b/.test(message)) return { ok: false, error: "Opération refusée par les contrôles d'intégrité." }
    console.error("[comptabilite] action C5 en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

export async function postMissingDocumentsAction(): Promise<Result<{ posted: number; existing: number; errors: { source: string; ref: string; error: string }[] }>> {
  const r = await run(async (ctx) => ({ ok: true as const, value: await postMissingDocuments(prisma, ctx) }))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function declareVatAction(raw: unknown): Promise<Result<{ id: string }>> {
  const p = z.object({ periodStart: isoDateSchema, periodEnd: isoDateSchema, basis: z.enum(["DEBITS", "ENCAISSEMENTS"]) }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Période invalide." }
  const r = await run((ctx) => declareVat(prisma, ctx, toDate(p.data.periodStart), toDate(p.data.periodEnd), p.data.basis))
  return r.ok ? { ok: true, id: r.value.id } : r
}

// ─── Banque ───
export async function previewBankCsvAction(text: unknown): Promise<Result<{ header: string[]; sample: string[][]; mapping: ReturnType<typeof guessBankMapping> }>> {
  const t = z.string().max(2_100_000).safeParse(text)
  if (!t.success) return { ok: false, error: "Fichier invalide." }
  try { await requireAccountingAdmin() } catch { return { ok: false, error: "Accès refusé." } }
  const p = previewCsv(t.data)
  return { ok: true, header: p.header, sample: p.sample, mapping: guessBankMapping(p.header) }
}

const mappingSchema = z.object({ date: z.number().int().min(0).max(100), label: z.number().int().min(0).max(100), amount: z.number().int().min(0).max(100).optional(), debit: z.number().int().min(0).max(100).optional(), credit: z.number().int().min(0).max(100).optional(), reference: z.number().int().min(0).max(100).optional(), headerRows: z.number().int().min(0).max(10) }).strict()

export async function importBankStatementAction(raw: unknown): Promise<Result<{ imported: number; duplicates: number; invalid: { row: number; error: string }[] }>> {
  const p = z.object({ text: z.string().max(2_100_000), fileName: z.string().max(200), mapping: mappingSchema }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Import invalide (mapping ou fichier)." }
  if (p.data.mapping.amount === undefined && (p.data.mapping.debit === undefined || p.data.mapping.credit === undefined)) return { ok: false, error: "Indiquez la colonne montant, ou les colonnes débit et crédit." }
  const r = await run((ctx) => importBankStatement(prisma, ctx, p.data.text, p.data.fileName, p.data.mapping))
  return r.ok ? { ok: true, imported: r.value.imported, duplicates: r.value.duplicates, invalid: r.value.invalid } : r
}

export async function autoReconcileAction(): Promise<Result<{ matched: number; unmatched: number; errors: { transactionId: string; error: string }[] }>> {
  const r = await run(async (ctx) => ({ ok: true as const, value: await autoReconcile(prisma, ctx) }))
  return r.ok ? { ok: true, ...r.value } : r
}

export async function matchTransactionAction(raw: unknown): Promise<Result<{ status: string }>> {
  const p = z.object({ transactionId: idSchema, invoiceId: idSchema.optional(), supplierInvoiceId: idSchema.optional(), ignore: z.boolean().optional(), notes: z.string().trim().max(300).optional() }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  const r = await run((ctx) => matchTransaction(prisma, ctx, p.data.transactionId, { invoiceId: p.data.invoiceId, supplierInvoiceId: p.data.supplierInvoiceId, ignore: p.data.ignore, notes: p.data.notes ?? null }))
  return r.ok ? { ok: true, status: r.value.status } : r
}

// ─── Factures fournisseurs ───
export async function uploadSupplierFileAction(form: FormData): Promise<Result<{ fileId: string; mime: string; extraction: Record<string, unknown> | null; extractionError: string | null }>> {
  const file = form.get("file")
  if (!(file instanceof File)) return { ok: false, error: "Fichier manquant." }
  if (file.size > 10 * 1024 * 1024) return { ok: false, error: "Fichier trop volumineux (10 Mo maximum)." }
  const data = Buffer.from(await file.arrayBuffer())
  const r = await run(async (ctx) => {
    const stored = await storeSupplierFile(prisma, ctx, data, file.name || "facture")
    if (!stored.ok) return stored
    const ocr = await extractSupplierInvoice(prisma, ctx, stored.value.fileId)
    const extraction = ocr.ok ? { ...ocr.value, totalHTCents: ocr.value.totalHTCents?.toString() ?? null, vatCents: ocr.value.vatCents?.toString() ?? null, totalTTCCents: ocr.value.totalTTCCents?.toString() ?? null, rawText: undefined } : null
    return { ok: true as const, value: { fileId: stored.value.fileId, mime: stored.value.mime, extraction, extractionError: ocr.ok ? null : ocr.error } }
  })
  return r.ok ? { ok: true, ...r.value } : r
}

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

function parseSupplierForm(raw: unknown) {
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

export async function createSupplierInvoiceAction(raw: unknown): Promise<Result<{ id: string }>> {
  const p = parseSupplierForm(raw)
  if (!p.ok) return p
  const o = p.value.ocr
  const big = (v: string | null | undefined) => (v === null || v === undefined ? null : BigInt(v))
  const ocr: Parameters<typeof createSupplierInvoice>[3]["ocr"] = o ? { supplier: o.supplier ?? null, siret: o.siret ?? null, invoiceNumber: o.invoiceNumber ?? null, date: o.date ?? null, totalHTCents: big(o.totalHTCents), vatCents: big(o.vatCents), totalTTCCents: big(o.totalTTCCents), vatRateBp: o.vatRateBp ?? null, category: o.category ?? null, confidence: o.confidence ?? {}, amountsAdjusted: o.amountsAdjusted === true, rawText: "" } : null
  const r = await run((ctx) => createSupplierInvoice(prisma, ctx, p.value.input, { fileId: p.value.fileId, ocr }))
  return r.ok ? { ok: true, id: r.value.id } : r
}

export async function updateSupplierInvoiceAction(id: unknown, raw: unknown): Promise<Result> {
  const i = idSchema.safeParse(id); const p = parseSupplierForm(raw)
  if (!i.success) return { ok: false, error: "Facture introuvable." }
  if (!p.ok) return p
  const r = await run((ctx) => updateSupplierInvoice(prisma, ctx, i.data, p.value.input))
  return r.ok ? { ok: true } : r
}

export async function validateSupplierInvoiceAction(id: unknown): Promise<Result<{ entryId: string }>> {
  const i = idSchema.safeParse(id)
  if (!i.success) return { ok: false, error: "Facture introuvable." }
  const r = await run((ctx) => validateSupplierInvoice(prisma, ctx, i.data))
  return r.ok ? { ok: true, entryId: r.value.entryId } : r
}

export async function rejectSupplierInvoiceAction(id: unknown, reason: unknown): Promise<Result> {
  const i = idSchema.safeParse(id)
  if (!i.success) return { ok: false, error: "Facture introuvable." }
  const motive = typeof reason === "string" ? reason.trim().slice(0, 300) : ""
  const r = await run((ctx) => rejectSupplierInvoice(prisma, ctx, i.data, motive || null))
  return r.ok ? { ok: true } : r
}
