/**
 * Document Studio — espace PDF : service (lots 1 et 2). Toute lecture et écriture est bornée par `ctx.companyId`
 * (session) ; chaque écriture est auditée (HistoryLog) dans sa transaction.
 *
 * - Import (lot 1) : taille bornée, PDF lisible, pages bornées ; empreinte SHA-256 des octets. Un original déjà importé
 *   par l'entreprise n'est pas dupliqué : la fiche existante est rouverte (garanti aussi en base, index partiel).
 * - Remplir et signer (lot 2) : part TOUJOURS de la dernière révision (sinon « version plus récente »), éléments validés,
 *   signature PNG vérifiée si une signature est posée ; le PDF est écrit HORS transaction (calcul), puis la révision
 *   suivante est insérée sous verrou du PDF (`FOR UPDATE`) après revérification qu'aucune autre ne l'a précédée.
 *   L'original et les révisions précédentes ne sont jamais modifiés (garanti en base).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { canonicalJson, sha256Hex } from "@/lib/document-studio/canonical"
import { parseStudioSignature } from "@/lib/document-studio/signature"
import { validateSignerName } from "@/lib/document-studio/studio.core"
import {
  PDF_ERRORS, PDF_LIMITS, cleanOriginalName, hasSignature, parseOperations, summarizeOperations, validatePdfTitle,
} from "@/lib/document-studio/pdf-workspace.core"
import { applyOperations, inspectPdf } from "@/lib/document-studio/pdf-workspace.pdf"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface PdfContext { companyId: string; userId: string }
export type PdfResult<T> = { ok: true; value: T } | { ok: false; error: string }

class PdfFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "PdfFailure" }
}
const fail = (m: string): never => { throw new PdfFailure(m) }

async function audit(tx: Tx, ctx: PdfContext, a: { action: "CREATED" | "UPDATED"; entityId: string; detail: string }) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: a.action, entityType: "StudioPdf", entityId: a.entityId, detail: a.detail.slice(0, 1000) } })
}
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"

async function existingOriginal(db: Db | Tx, companyId: string, sha256: string) {
  return db.studioPdfRevision.findFirst({ where: { companyId, sha256, kind: "ORIGINAL" }, select: { pdfId: true } })
}

export interface ImportInput { title: string | null; originalName: string; bytes: Uint8Array }

/** Import d'un PDF reçu (révision 1). `duplicate` : cet original était déjà importé, sa fiche est renvoyée. */
export async function importPdf(db: Db, ctx: PdfContext, input: ImportInput): Promise<PdfResult<{ pdfId: string; duplicate: boolean }>> {
  if (input.bytes.length === 0) return { ok: false, error: PDF_ERRORS.noFile }
  if (input.bytes.length > PDF_LIMITS.maxUploadBytes) return { ok: false, error: PDF_ERRORS.tooLarge }
  const originalName = cleanOriginalName(input.originalName)
  const title = validatePdfTitle(input.title, originalName)
  if (!title.ok) return title
  const sha256 = sha256Hex(input.bytes)
  const known = await existingOriginal(db, ctx.companyId, sha256)
  if (known) return { ok: true, value: { pdfId: known.pdfId, duplicate: true } }
  const info = await inspectPdf(input.bytes)
  if (!info.ok) return info
  try {
    const pdfId = await db.$transaction(async (tx) => {
      const pdf = await tx.studioPdf.create({ data: { companyId: ctx.companyId, title: title.value, originalName, createdById: ctx.userId }, select: { id: true } })
      await tx.studioPdfRevision.create({
        data: {
          companyId: ctx.companyId, pdfId: pdf.id, revision: 1, kind: "ORIGINAL", sha256, size: input.bytes.length, data: Buffer.from(input.bytes),
          pageCount: info.value.pageCount, pages: info.value.pages.map((p) => ({ ...p })), pageTexts: info.value.pageTexts, encrypted: info.value.encrypted, createdById: ctx.userId,
        },
      })
      await audit(tx, ctx, { action: "CREATED", entityId: pdf.id, detail: `PDF « ${title.value} » importé (${info.value.pageCount} page${info.value.pageCount > 1 ? "s" : ""})` })
      return pdf.id
    })
    return { ok: true, value: { pdfId, duplicate: false } }
  } catch (e) {
    // Import concurrent du même original : la fiche gagnante est rouverte.
    if (isUniqueViolation(e)) {
      const winner = await existingOriginal(db, ctx.companyId, sha256)
      if (winner) return { ok: true, value: { pdfId: winner.pdfId, duplicate: true } }
    }
    throw e
  }
}

export interface FillInput { baseRevisionId: string; operations: string; signerName: string | null; signature: string | null }

/** Remplir et signer : nouvelle révision construite depuis la dernière. */
export async function fillAndSignPdf(db: Db, ctx: PdfContext, pdfId: string, input: FillInput): Promise<PdfResult<{ revision: number; revisionId: string }>> {
  const latest = await db.studioPdfRevision.findFirst({
    where: { companyId: ctx.companyId, pdfId }, orderBy: { revision: "desc" },
    select: { id: true, revision: true, data: true, pageCount: true, encrypted: true },
  })
  if (!latest) return { ok: false, error: PDF_ERRORS.notFound }
  if (latest.id !== input.baseRevisionId) return { ok: false, error: PDF_ERRORS.notLatest }
  if (latest.revision >= PDF_LIMITS.maxRevisions) return { ok: false, error: PDF_ERRORS.tooManyRevisions }
  if (latest.encrypted) return { ok: false, error: PDF_ERRORS.encrypted }

  const ops = parseOperations(input.operations, latest.pageCount)
  if (!ops.ok) return ops
  const drawn = (input.signature ?? "").trim() !== ""
  let signer: { name: string; png: Buffer; sha256: string } | null = null
  if (hasSignature(ops.value)) {
    const name = validateSignerName(input.signerName)
    if (!name.ok) return name
    if (!drawn) return { ok: false, error: PDF_ERRORS.signatureMissing }
    const sig = parseStudioSignature(input.signature)
    if (!sig.ok) return { ok: false, error: PDF_ERRORS.signatureMissing }
    signer = { name: name.value, png: sig.value.png, sha256: sig.value.sha256 }
  } else if (drawn) {
    return { ok: false, error: PDF_ERRORS.signatureUnused }
  }

  const written = await applyOperations(new Uint8Array(latest.data), ops.value, signer ? { png: signer.png } : null)
  if (!written.ok) return written
  const info = await inspectPdf(written.value)
  if (!info.ok || info.value.pageCount !== latest.pageCount) return { ok: false, error: PDF_ERRORS.writeFailed }
  const operations = ops.value.map((o) => ({ ...o }))
  const operationsSha256 = sha256Hex(canonicalJson(operations))
  const summary = summarizeOperations(ops.value)

  try {
    const created = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; title: string }[]>`SELECT "id", "title" FROM "studio_pdfs" WHERE "id" = ${pdfId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
      const pdf = locked[0] ?? fail(PDF_ERRORS.notFound)
      const head = await tx.studioPdfRevision.findFirst({ where: { companyId: ctx.companyId, pdfId }, orderBy: { revision: "desc" }, select: { id: true } })
      if (!head || head.id !== latest.id) fail(PDF_ERRORS.notLatest)
      const revision = latest.revision + 1
      const r = await tx.studioPdfRevision.create({
        data: {
          companyId: ctx.companyId, pdfId, revision, kind: "FILLED", sha256: sha256Hex(written.value), size: written.value.length, data: Buffer.from(written.value),
          pageCount: info.value.pageCount, pages: info.value.pages.map((p) => ({ ...p })), pageTexts: info.value.pageTexts, encrypted: false,
          operations, operationsSha256, signerName: signer?.name ?? null, signatureSha256: signer?.sha256 ?? null, createdById: ctx.userId,
        },
        select: { id: true },
      })
      await tx.studioPdf.update({ where: { id: pdfId }, data: { updatedAt: new Date() } })
      await audit(tx, ctx, { action: "UPDATED", entityId: pdfId, detail: `PDF « ${pdf.title} » : version ${revision} enregistrée (${summary})${signer ? `, signée par ${signer.name}` : ""}` })
      return { revision, revisionId: r.id }
    })
    return { ok: true, value: created }
  } catch (e) {
    if (e instanceof PdfFailure) return { ok: false, error: e.userMessage }
    if (isUniqueViolation(e)) return { ok: false, error: PDF_ERRORS.notLatest }
    throw e
  }
}
