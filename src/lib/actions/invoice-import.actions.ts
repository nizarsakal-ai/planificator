"use server"
// Server Actions de l'import de factures (SPEC-INVOICE-IMPORT-001) : enveloppes fines — drapeaux + garde de session, zod strict,
// société de session. Toute la logique est dans src/lib/invoice-import/import.service.ts.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { BillingAccessError, billingAccessMessage, type BillingContext } from "@/lib/billing/access"
import { requireInvoiceImportAdmin } from "@/lib/invoice-import/access"
import { MAX_UPLOAD_BYTES, addFileToBatch, cancelBatch, commitBatch, createBatch, updateBatchMapping, updateBatchRows, type AddFileResult, type RowPatch } from "@/lib/invoice-import/import.service"
import { applyImportedStatusChange, planImportedStatusChange, type StatusChangePlan } from "@/lib/invoice-import/status-update.service"
import { IMPORT_FIELDS, type BatchSummary, type ColumnMapping } from "@/lib/invoice-import/types"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const idSchema = z.string().trim().min(1).max(64)
const versionSchema = z.number().int().min(0).max(1_000_000)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), "Date invalide").nullable()
const centsSchema = z.string().regex(/^\d{1,12}$/).nullable()

async function run<T>(fn: (ctx: BillingContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn(await requireInvoiceImportAdmin())
  } catch (error) {
    if (error instanceof BillingAccessError) return { ok: false, error: billingAccessMessage(error.reason) }
    console.error("[invoice-import] action échouée", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Une erreur est survenue. Réessayez." }
  }
}

const createSchema = z.object({ sourceSystem: z.enum(["TIIME", "OTHER", "PDF"]), sourceLabel: z.string().trim().max(80).nullable() }).strict()
export async function createInvoiceImportAction(raw: unknown): Promise<Result<{ id: string }>> {
  const p = createSchema.safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  if (p.data.sourceSystem === "OTHER" && !p.data.sourceLabel) return { ok: false, error: "Indiquez le nom du logiciel d'origine." }
  return run(async (ctx) => ({ ok: true, ...(await createBatch(prisma, ctx, p.data)) }))
}

/** Un fichier par appel (limite de taille d'une requête) : le navigateur enchaîne les appels pour un dépôt en lot. */
export async function addInvoiceImportFileAction(formData: FormData): Promise<Result<AddFileResult>> {
  const id = idSchema.safeParse(formData.get("batchId"))
  const file = formData.get("file")
  if (!id.success || !(file instanceof File)) return { ok: false, error: "Demande invalide." }
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "Fichier vide ou trop volumineux." }
  return run(async (ctx) => {
    const r = await addFileToBatch(prisma, ctx, id.data, { name: file.name.slice(0, 200), data: Buffer.from(await file.arrayBuffer()) })
    if (!r.ok) return r
    revalidatePath(`/factures/import/${id.data}`)
    return { ok: true, ...r.value }
  })
}

const mappingSchema = z.object({ headerRows: z.number().int().min(0).max(20), ...Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().min(0).max(200).optional()])) }).strict()
export async function updateInvoiceImportMappingAction(batchId: unknown, version: unknown, raw: unknown): Promise<Result> {
  const id = idSchema.safeParse(batchId), v = versionSchema.safeParse(version), m = mappingSchema.safeParse(raw)
  if (!id.success || !v.success || !m.success) return { ok: false, error: "Association de colonnes invalide." }
  return run(async (ctx) => {
    const r = await updateBatchMapping(prisma, ctx, id.data, v.data, m.data as ColumnMapping)
    if (!r.ok) return r
    revalidatePath(`/factures/import/${id.data}`)
    return { ok: true }
  })
}

const patchSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["INVOICE", "CREDIT_NOTE", "SUPPLIER"]).optional(), number: z.string().trim().max(64).optional(), clientName: z.string().trim().max(200).optional(),
  clientId: idSchema.nullable().optional(), createClient: z.boolean().optional(), worksiteId: idSchema.nullable().optional(),
  issueDate: dateSchema.optional(), dueDate: dateSchema.optional(), htCents: centsSchema.optional(), vatCents: centsSchema.optional(), ttcCents: centsSchema.optional(),
  status: z.enum(["ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED", "UNKNOWN"]).optional(), creditedNumber: z.string().trim().max(64).nullable().optional(),
  decision: z.enum(["KEEP"]).nullable().optional(), excluded: z.boolean().optional(),
}).strict()
export async function updateInvoiceImportRowsAction(batchId: unknown, version: unknown, raw: unknown): Promise<Result> {
  const id = idSchema.safeParse(batchId), v = versionSchema.safeParse(version), p = z.array(patchSchema).min(1).max(2000).safeParse(raw)
  if (!id.success || !v.success) return { ok: false, error: "Demande invalide." }
  if (!p.success) return { ok: false, error: "Valeur invalide dans l'aperçu (date ou montant)." }
  return run(async (ctx) => {
    const r = await updateBatchRows(prisma, ctx, id.data, v.data, p.data as RowPatch[])
    if (!r.ok) return r
    revalidatePath(`/factures/import/${id.data}`)
    return { ok: true }
  })
}

export async function commitInvoiceImportAction(batchId: unknown, version: unknown): Promise<Result<{ summary: BatchSummary }>> {
  const id = idSchema.safeParse(batchId), v = versionSchema.safeParse(version)
  if (!id.success || !v.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await commitBatch(prisma, ctx, id.data, v.data)
    if (!r.ok) return r
    revalidatePath("/factures", "layout"); revalidatePath("/clients")
    return { ok: true, summary: r.value }
  })
}

export async function cancelInvoiceImportAction(batchId: unknown): Promise<Result> {
  const id = idSchema.safeParse(batchId)
  if (!id.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await cancelBatch(prisma, ctx, id.data)
    if (!r.ok) return r
    revalidatePath("/factures", "layout")
    return { ok: true }
  })
}

// Amendement SPEC-INVOICE-IMPORT-001 §5 : « Non précisé » → « Payée » sur un lot validé. Seule transition exposée à l'interface.
// Les montants partent en chaîne (centimes) : aucun BigInt ni flottant ne traverse la frontière client.
export interface MarkPaidPreview {
  count: number; invoiceCount: number; creditNoteCount: number
  invoicesTTCCents: string; creditNotesTTCCents: string; netTTCCents: string
  items: { id: string; number: string; kind: "INVOICE" | "CREDIT_NOTE"; clientName: string; issueDate: string; signedTTCCents: string }[]
}
const toPreview = (p: StatusChangePlan): MarkPaidPreview => ({
  count: p.items.length, invoiceCount: p.invoiceCount, creditNoteCount: p.creditNoteCount,
  invoicesTTCCents: p.invoicesTTCCents.toString(), creditNotesTTCCents: p.creditNotesTTCCents.toString(), netTTCCents: p.netTTCCents.toString(),
  items: p.items.map((i) => ({ id: i.id, number: i.number, kind: i.kind, clientName: i.clientName, issueDate: i.issueDate, signedTTCCents: i.signedTTCCents.toString() })),
})

export async function previewMarkImportedPaidAction(batchId: unknown): Promise<Result<{ preview: MarkPaidPreview }>> {
  const id = idSchema.safeParse(batchId)
  if (!id.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await planImportedStatusChange(prisma, ctx, { batchId: id.data, from: "UNKNOWN", to: "PAID" })
    return r.ok ? { ok: true, preview: toPreview(r.value) } : r
  })
}

export async function applyMarkImportedPaidAction(batchId: unknown, expectedCount: unknown): Promise<Result<{ updated: number }>> {
  const id = idSchema.safeParse(batchId), n = z.number().int().min(1).max(5000).safeParse(expectedCount)
  if (!id.success || !n.success) return { ok: false, error: "Demande invalide." }
  return run(async (ctx) => {
    const r = await applyImportedStatusChange(prisma, ctx, { batchId: id.data, from: "UNKNOWN", to: "PAID", expectedCount: n.data })
    if (!r.ok) return r
    revalidatePath("/factures", "layout"); revalidatePath("/clients")
    return { ok: true, updated: r.value.items.length }
  })
}
