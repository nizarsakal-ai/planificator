"use server"
import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { requireSupplierIntake } from "@/lib/supplier-intake/access"
import { issueFileProof, verifyFileProof } from "@/lib/supplier-intake/file-proof"
import { parseSupplierForm } from "@/lib/supplier-intake/input"
import { createSupplierInvoice, updateSupplierInvoice, storeSupplierFile, extractSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { withLifecycleAbort } from "@/lib/billing/lifecycle-abort"
const denied = { ok: false as const, error: "Opération refusée ou accès indisponible." }
const signingSecret = () => process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? ""

export async function uploadIntakeFileAction(form: FormData) {
  try {
    const ctx = await requireSupplierIntake()
    const secret = signingSecret()
    if (secret.length < 32) return denied
    const file = form.get("file")
    if (!(file instanceof File) || file.size === 0 || file.size > 10 * 1024 * 1024) return { ok: false as const, error: "Fichier invalide (10 Mo maximum)." }
    const stored = await storeSupplierFile(prisma, ctx, Buffer.from(await file.arrayBuffer()), file.name || "facture")
    if (!stored.ok) return stored
    const ocr = await extractSupplierInvoice(prisma, ctx, stored.value.fileId)
    const extraction = ocr.ok ? { ...ocr.value, totalHTCents: ocr.value.totalHTCents?.toString() ?? null, vatCents: ocr.value.vatCents?.toString() ?? null, totalTTCCents: ocr.value.totalTTCCents?.toString() ?? null, rawText: undefined } : null
    return { ok: true as const, fileId: stored.value.fileId, mime: stored.value.mime,
      fileProof: issueFileProof(ctx, stored.value.fileId, secret), extraction, extractionError: ocr.ok ? null : ocr.error }
  } catch { return denied }
}

export async function createIntakeInvoiceAction(raw: unknown, fileProof?: string) {
  try {
    const ctx = await requireSupplierIntake()
    const p = parseSupplierForm(raw)
    if (!p.ok) return p
    if (p.value.fileId && !verifyFileProof(ctx, p.value.fileId, fileProof, signingSecret())) return denied
    const o = p.value.ocr
    const big = (v: string | null | undefined) => v == null ? null : BigInt(v)
    const ocr: Parameters<typeof createSupplierInvoice>[3]["ocr"] = o ? {
      supplier: o.supplier ?? null, siret: o.siret ?? null, invoiceNumber: o.invoiceNumber ?? null, date: o.date ?? null,
      totalHTCents: big(o.totalHTCents), vatCents: big(o.vatCents), totalTTCCents: big(o.totalTTCCents),
      vatRateBp: o.vatRateBp ?? null, category: o.category ?? null, confidence: o.confidence ?? {}, amountsAdjusted: o.amountsAdjusted === true, rawText: "",
    } : null
    // 29/10/2026 (M2) : la course sur la même pièce arbitrée par l'index partiel lève LifecycleAbort dans la transaction (ROLLBACK) ;
    // convertie ici en erreur explicite au lieu du refus générique.
    const r = await withLifecycleAbort(() => prisma.$transaction(async tx => {
      if (p.value.fileId) {
        const duplicate = await tx.supplierInvoice.findFirst({ where: { companyId: ctx.companyId, fileId: p.value.fileId, status: { not: "REJECTED" } }, select: { id: true } })
        if (duplicate) return { ok: false as const, error: "Ce fichier a déjà été soumis." }
      }
      return createSupplierInvoice(tx, ctx, p.value.input, { fileId: p.value.fileId, ocr })
    }, { isolationLevel: "Serializable" }))
    if (!r.ok) return r
    revalidatePath("/factures-fournisseurs"); revalidatePath("/comptabilite/fournisseurs")
    return { ok: true as const, id: r.value.id }
  } catch { return denied }
}

export async function updateIntakeInvoiceAction(id: unknown, raw: unknown) {
  try {
    const ctx = await requireSupplierIntake()
    if (typeof id !== "string" || !id || id.length > 64) return denied
    const p = parseSupplierForm(raw)
    if (!p.ok) return p
    // No attachment replacement or fabricated OCR metadata through the edit operation.
    if (p.value.fileId || p.value.ocr) return denied
    const r = await updateSupplierInvoice(prisma, ctx, id, p.value.input, true)
    if (!r.ok) return r
    revalidatePath("/factures-fournisseurs", "layout"); revalidatePath("/comptabilite/fournisseurs", "layout")
    return { ok: true as const }
  } catch { return denied }
}
