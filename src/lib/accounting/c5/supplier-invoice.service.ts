// ═══════════════════════════════════════════════════════════════════════════
// Factures fournisseurs (SPEC-BILLING-C5 §3.6) : téléversement sûr (signature binaire, taille, sha256), extraction OCR via
// interface injectable, saisie/correction, validation transactionnelle idempotente (fournisseur par SIRET, écriture d'achat).
// Contexte = requireAccountingAdmin (société de session).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { LifecycleAbort, withLifecycleAbort } from "@/lib/billing/lifecycle-abort"
import { MAX_OCR_FILE_BYTES, OcrError, getOcrProvider, sniffMime, type OcrExtraction } from "./ocr-provider"
import { postSupplierInvoiceEntry } from "./postings"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
import { SUPPLIER_CATEGORIES, CATEGORY_ACCOUNT } from "./supplier-classification"
export { SUPPLIER_CATEGORIES, CATEGORY_ACCOUNT } from "./supplier-classification"
export const CATEGORY_LABEL: Record<string, string> = { marchandises: "Marchandises", services: "Prestations", location: "Locations", deplacement: "Déplacements", honoraires: "Honoraires", entretien: "Entretien", restauration: "Restauration", autre: "Autre" }

export const SUPPLIER_ERRORS = {
  fileType: "Fichier refusé : seuls JPEG, PNG, WebP et PDF sont acceptés (type vérifié par signature).",
  fileSize: "Fichier trop volumineux (10 Mo maximum).",
  duplicateFile: "Ce fichier a déjà été importé.",
  notFound: "Facture fournisseur introuvable.",
  notPending: "Seule une facture en attente peut être modifiée ou validée.",
  amounts: "Montants incohérents : HT + TVA doit être égal au TTC.",
  number: "Numéro de facture obligatoire.",
  supplier: "Nom du fournisseur obligatoire.",
  duplicateNumber: "Une facture validée porte déjà ce numéro pour ce fournisseur.",
} as const

export interface UploadResult { fileId: string; mime: string; size: number; sha256: string; duplicate: boolean }

/** Stocke le fichier (signature binaire, taille, empreinte) ; doublon ⇒ refus. */
export async function storeSupplierFile(db: Db, ctx: AccountingContext, data: Buffer, originalName: string): Promise<LifecycleResult<UploadResult>> {
  if (data.length === 0 || data.length > MAX_OCR_FILE_BYTES) return { ok: false, error: SUPPLIER_ERRORS.fileSize }
  const mime = sniffMime(data)
  if (!mime) return { ok: false, error: SUPPLIER_ERRORS.fileType }
  const sha256 = createHash("sha256").update(data).digest("hex")
  const existing = await db.supplierInvoiceFile.findFirst({ where: { companyId: ctx.companyId, sha256 }, select: { id: true, invoices: { where: { status: { not: "REJECTED" } }, select: { id: true }, take: 1 } } })
  // Fichier déjà stocké mais jamais rattaché (formulaire abandonné) ou rattaché seulement à une facture REJETÉE : réutilisé ;
  // rattaché à une facture en cours/validée : doublon refusé (audit R3, #8).
  if (existing) return existing.invoices.length ? { ok: false, error: SUPPLIER_ERRORS.duplicateFile } : { ok: true, value: { fileId: existing.id, mime, size: data.length, sha256, duplicate: true } }
  const f = await db.supplierInvoiceFile.create({ data: { companyId: ctx.companyId, sha256, mime, size: data.length, data, originalName: originalName.slice(0, 200) }, select: { id: true } })
  return { ok: true, value: { fileId: f.id, mime, size: data.length, sha256, duplicate: false } }
}

export interface SupplierInvoiceInput {
  supplierName: string; siret: string | null; number: string; date: Date; dueDate: Date | null
  totalHTCents: bigint; vatCents: bigint; totalTTCCents: bigint; vatRateBp: number | null; category: string | null; expenseAccountId: string | null; notes: string | null
}

function validateInput(i: SupplierInvoiceInput): string | null {
  if (!i.supplierName.trim()) return SUPPLIER_ERRORS.supplier
  if (!i.number.trim()) return SUPPLIER_ERRORS.number
  if (i.totalHTCents < BigInt(0) || i.vatCents < BigInt(0) || i.totalTTCCents <= BigInt(0)) return SUPPLIER_ERRORS.amounts
  if (i.totalHTCents + i.vatCents !== i.totalTTCCents) return SUPPLIER_ERRORS.amounts
  if (i.siret && !/^\d{14}$/.test(i.siret)) return "SIRET invalide (14 chiffres)."
  if (i.category && !(SUPPLIER_CATEGORIES as readonly string[]).includes(i.category)) return "Catégorie inconnue."
  return null
}

/** Crée une facture fournisseur en attente (après téléversement + OCR éventuel, ou saisie manuelle). */
export async function createSupplierInvoice(db: Pick<Db, "supplierInvoiceFile" | "accountingAccount" | "supplierInvoice" | "historyLog">, ctx: AccountingContext, input: SupplierInvoiceInput, extra: { fileId: string | null; ocr: OcrExtraction | null }): Promise<LifecycleResult<{ id: string }>> {
  const err = validateInput(input)
  if (err) return { ok: false, error: err }
  if (extra.fileId) {
    const f = await db.supplierInvoiceFile.findFirst({ where: { id: extra.fileId, companyId: ctx.companyId }, select: { id: true } })
    if (!f) return { ok: false, error: "Fichier introuvable." }
  }
  if (input.expenseAccountId) {
    const a = await db.accountingAccount.findFirst({ where: { id: input.expenseAccountId, companyId: ctx.companyId, active: true }, select: { id: true } })
    if (!a) return { ok: false, error: "Compte de charge introuvable." }
  }
  const created = await db.supplierInvoice.create({
    data: {
      companyId: ctx.companyId, supplierName: input.supplierName.trim().slice(0, 200), siret: input.siret, number: input.number.trim().slice(0, 64), date: input.date, dueDate: input.dueDate,
      totalHTCents: input.totalHTCents, vatCents: input.vatCents, totalTTCCents: input.totalTTCCents, vatRateBp: input.vatRateBp, category: input.category, expenseAccountId: input.expenseAccountId,
      notes: input.notes, status: "PENDING", fileId: extra.fileId, createdById: ctx.userId,
      ocrProvider: extra.ocr ? "ocr" : null,
      ocrRaw: extra.ocr ? { supplier: extra.ocr.supplier, siret: extra.ocr.siret, invoiceNumber: extra.ocr.invoiceNumber, date: extra.ocr.date, totalHTCents: extra.ocr.totalHTCents?.toString() ?? null, vatCents: extra.ocr.vatCents?.toString() ?? null, totalTTCCents: extra.ocr.totalTTCCents?.toString() ?? null, vatRateBp: extra.ocr.vatRateBp, category: extra.ocr.category, amountsAdjusted: extra.ocr.amountsAdjusted } : undefined,
      ocrConfidence: extra.ocr ? extra.ocr.confidence : undefined,
    },
    select: { id: true },
  })
  await db.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "SupplierInvoice", entityId: created.id, detail: `Facture fournisseur ${input.number} (${input.supplierName}) enregistrée en attente` } })
  return { ok: true, value: created }
}

export async function updateSupplierInvoice(db: Db, ctx: AccountingContext, id: string, input: SupplierInvoiceInput, authorOnly = false): Promise<LifecycleResult> {
  const err = validateInput(input)
  if (err) return { ok: false, error: err }
  if (input.expenseAccountId) {
    const a = await db.accountingAccount.findFirst({ where: { id: input.expenseAccountId, companyId: ctx.companyId, active: true }, select: { id: true } })
    if (!a) return { ok: false, error: "Compte de charge introuvable." }
  }
  const u = await db.supplierInvoice.updateMany({
    where: { id, companyId: ctx.companyId, status: "PENDING", ...(authorOnly ? { createdById: ctx.userId } : {}) },
    data: { supplierName: input.supplierName.trim().slice(0, 200), siret: input.siret, number: input.number.trim().slice(0, 64), date: input.date, dueDate: input.dueDate, totalHTCents: input.totalHTCents, vatCents: input.vatCents, totalTTCCents: input.totalTTCCents, vatRateBp: input.vatRateBp, category: input.category, expenseAccountId: input.expenseAccountId, notes: input.notes },
  })
  if (u.count !== 1) return { ok: false, error: (await db.supplierInvoice.findFirst({ where: { id, companyId: ctx.companyId, ...(authorOnly ? { createdById: ctx.userId } : {}) }, select: { id: true } })) ? SUPPLIER_ERRORS.notPending : SUPPLIER_ERRORS.notFound }
  return { ok: true, value: undefined }
}

/** Extraction OCR d'un fichier stocké (interface injectable ; désactivée ⇒ erreur explicite, saisie manuelle). */
export async function extractSupplierInvoice(db: Db, ctx: AccountingContext, fileId: string): Promise<LifecycleResult<OcrExtraction>> {
  const f = await db.supplierInvoiceFile.findFirst({ where: { id: fileId, companyId: ctx.companyId }, select: { data: true, mime: true } })
  if (!f) return { ok: false, error: "Fichier introuvable." }
  try {
    const r = await getOcrProvider().extract({ data: Buffer.from(f.data), mime: f.mime })
    return { ok: true, value: r }
  } catch (e) {
    if (e instanceof OcrError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * Validation (transaction comptable rejouable, ADMIN revérifié sous verrou par le moteur) : fournisseur créé ou associé par
 * SIRET (sinon nom exact), compte de charge choisi/déduit de la catégorie, statut VALIDATED, écriture d'achat (idempotente).
 * Validation humaine explicite : l'OCR et ses suggestions ne valent pas approbation.
 * L'action authentifiée « Valider et comptabiliser » confirme la revue des montants,
 * de la catégorie et du compte (C5Actions). Pour la restauration, le compte confirmé
 * doit correspondre au compte courant sous verrou ; une confirmation périmée est refusée.
 * L'appelant autorisé reste responsable de la sincérité de sa confirmation.
 * Idempotent : une facture déjà validée renvoie son écriture.
 */
export async function validateSupplierInvoice(db: Db, ctx: AccountingContext, id: string, confirmedExpenseAccountId?: string): Promise<LifecycleResult<{ entryId: string; supplierId: string }>> {
  // Mandat §2.6 (même classe que P1-06) : un refus survenant APRÈS la première écriture (fournisseur créé/associé) lève
  // LifecycleAbort ⇒ ROLLBACK complet, au lieu d'un résultat d'échec qui laisserait committer le fournisseur.
  return withLifecycleAbort(() => runAccountingTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "supplier_invoices" WHERE "id" = ${id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
    const s = await tx.supplierInvoice.findFirst({ where: { id, companyId: ctx.companyId } })
    if (!s) return { ok: false as const, error: SUPPLIER_ERRORS.notFound }
    if (s.status === "VALIDATED" && s.supplierId) {
      const e = await postSupplierInvoiceEntry(tx, ctx, s.id)
      return { ok: true as const, value: { entryId: e.entryId, supplierId: s.supplierId } }
    }
    if (s.status !== "PENDING") return { ok: false as const, error: SUPPLIER_ERRORS.notPending }
    // La nature du repas ne détermine pas son imputation : choix humain obligatoire.
    if (s.category === "restauration" && (!s.expenseAccountId || confirmedExpenseAccountId !== s.expenseAccountId)) return { ok: false as const, error: "Restauration : choisissez et confirmez un compte de charge avant de comptabiliser." }
    const supplier = await findOrCreateSupplier(tx, ctx, { name: s.supplierName, siret: s.siret })
    const dup = await tx.supplierInvoice.findFirst({ where: { companyId: ctx.companyId, supplierId: supplier.id, number: s.number, status: "VALIDATED", id: { not: s.id } }, select: { id: true } })
    if (dup) throw new LifecycleAbort(SUPPLIER_ERRORS.duplicateNumber)
    let expenseAccountId = s.expenseAccountId ?? supplier.defaultExpenseAccountId
    if (!expenseAccountId) {
      const number = CATEGORY_ACCOUNT[s.category ?? "autre"] ?? "606000"
      await ensureBaseReferential(tx, ctx)
      const acc = await tx.accountingAccount.findFirst({ where: { companyId: ctx.companyId, number, active: true }, select: { id: true } })
      if (!acc) throw new LifecycleAbort(`Compte de charge ${number} absent ou inactif : choisissez un compte.`)
      expenseAccountId = acc.id
    }
    // Audit A4 (même famille que R2) : l'unicité « une facture validée par (fournisseur, numéro) » est garantie en base (index partiel) ;
    // deux validations concurrentes du même document ⇒ la seconde est refusée (ROLLBACK), jamais deux charges/TVA déductibles.
    const u = await tx.supplierInvoice.updateMany({ where: { id: s.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "VALIDATED", supplierId: supplier.id, expenseAccountId, validatedAt: new Date(), validatedById: ctx.userId } })
      .catch((e: { code?: string }) => { if (e.code === "P2002") throw new LifecycleAbort(SUPPLIER_ERRORS.duplicateNumber); throw e })
    if (u.count !== 1) throw new Error("SUPPLIER_INVOICE_CONFLICT")
    const e = await postSupplierInvoiceEntry(tx, ctx, s.id)
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "SupplierInvoice", entityId: s.id, detail: `Facture fournisseur ${s.number} validée (${supplier.name}) — écriture ${e.entryId}`, oldValue: { status: "PENDING" }, newValue: { status: "VALIDATED", supplierId: supplier.id, entryId: e.entryId } } })
    return { ok: true as const, value: { entryId: e.entryId, supplierId: supplier.id } }
  }))
}

export async function rejectSupplierInvoice(db: Db, ctx: AccountingContext, id: string, reason: string | null): Promise<LifecycleResult> {
  const u = await db.supplierInvoice.updateMany({ where: { id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "REJECTED", notes: reason ? `Rejet : ${reason}` : undefined } })
  if (u.count !== 1) return { ok: false, error: SUPPLIER_ERRORS.notPending }
  await db.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "SupplierInvoice", entityId: id, detail: `Facture fournisseur rejetée${reason ? ` — ${reason}` : ""}` } })
  return { ok: true, value: undefined }
}

/** Fournisseur par SIRET (unique par société), sinon par nom exact (insensible à la casse), sinon création. */
export async function findOrCreateSupplier(tx: Tx, ctx: AccountingContext, input: { name: string; siret: string | null }): Promise<{ id: string; name: string; defaultExpenseAccountId: string | null }> {
  const name = input.name.trim().slice(0, 200)
  if (input.siret) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('supplier-siret'), hashtext(${`${ctx.companyId}|${input.siret}`}))`
    const bySiret = await tx.supplier.findFirst({ where: { companyId: ctx.companyId, siret: input.siret }, select: { id: true, name: true, defaultExpenseAccountId: true } })
    if (bySiret) return bySiret
  }
  // Audit A4 : sans SIRET, la recherche par nom puis la création sont sérialisées par nom (sinon deux fournisseurs homonymes
  // créés simultanément, et le contrôle de doublon par fournisseur ne se rencontre jamais).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('supplier-name'), hashtext(${`${ctx.companyId}|${name.toLowerCase()}`}))`
  const byName = await tx.supplier.findFirst({ where: { companyId: ctx.companyId, name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true, siret: true, defaultExpenseAccountId: true } })
  if (byName) {
    if (input.siret && !byName.siret) await tx.supplier.updateMany({ where: { id: byName.id, companyId: ctx.companyId, siret: null }, data: { siret: input.siret } })
    return { id: byName.id, name: byName.name, defaultExpenseAccountId: byName.defaultExpenseAccountId }
  }
  return tx.supplier.create({ data: { companyId: ctx.companyId, name, siret: input.siret }, select: { id: true, name: true, defaultExpenseAccountId: true } })
}

export interface SupplierInvoiceFilters { search?: string; status?: "PENDING" | "VALIDATED" | "REJECTED"; page?: number }
export const SUPPLIER_PAGE_SIZE = 50

export async function listSupplierInvoices(db: Db, ctx: { companyId: string }, f: SupplierInvoiceFilters) {
  const companyId = ctx.companyId
  const where: Prisma.SupplierInvoiceWhereInput = { companyId }
  if (f.status) where.status = f.status
  const q = f.search?.trim().slice(0, 100)
  if (q) {
    const digits = q.replace(/\s/g, "")
    where.OR = [{ supplierName: { contains: q, mode: "insensitive" } }, { number: { contains: q, mode: "insensitive" } }, ...(/^\d{9,14}$/.test(digits) ? [{ siret: { startsWith: digits } }] : []), { supplier: { name: { contains: q, mode: "insensitive" } } }]
  }
  const page = Math.max(1, Math.min(10_000, Math.trunc(f.page ?? 1)))
  const [total, rows] = await Promise.all([
    db.supplierInvoice.count({ where }),
    db.supplierInvoice.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip: (page - 1) * SUPPLIER_PAGE_SIZE, take: SUPPLIER_PAGE_SIZE, select: { id: true, supplierName: true, siret: true, number: true, date: true, dueDate: true, totalHTCents: true, vatCents: true, totalTTCCents: true, status: true, category: true, paidAt: true, fileId: true, expenseAccount: { select: { number: true, label: true } }, supplier: { select: { id: true, name: true } } } }),
  ])
  return { total, page, pageSize: SUPPLIER_PAGE_SIZE, rows }
}

export async function getSupplierInvoice(db: Db, ctx: { companyId: string }, id: string) {
  return db.supplierInvoice.findFirst({ where: { id, companyId: ctx.companyId }, include: { expenseAccount: { select: { id: true, number: true, label: true } }, supplier: { select: { id: true, name: true, siret: true } }, file: { select: { id: true, mime: true, size: true, originalName: true } } } })
}

/** Pièce jointe d'une facture fournisseur (société du contexte). */
export async function getSupplierInvoiceFile(db: Db, ctx: { companyId: string }, id: string) {
  const s = await db.supplierInvoice.findFirst({ where: { id, companyId: ctx.companyId }, select: { file: { select: { data: true, mime: true, originalName: true } } } })
  return s?.file ?? null
}

/**
 * Correctif P1-04 — règlement INTÉGRAL d'une facture fournisseur par rapprochement bancaire (appelé sous verrou FOR UPDATE de
 * la facture, dans la transaction du rapprochement, après contrôle du montant exact par l'appelant). Un échec (facture non
 * validée, déjà réglée, modifiée entre-temps) LÈVE : la transaction appelante est annulée — jamais un booléen ignoré.
 */
export async function settleSupplierInvoiceExact(tx: Tx, companyId: string, id: string, paidAt: Date): Promise<void> {
  const u = await tx.supplierInvoice.updateMany({ where: { id, companyId, status: "VALIDATED", paidAt: null }, data: { paidAt } })
  if (u.count !== 1) throw new LifecycleAbort("Facture fournisseur modifiée entre-temps : règlement annulé.")
}
