/**
 * Document Studio — espace PDF : lectures bornées par `companyId`. Les octets ne sont lus que par la route de
 * téléchargement (`getRevisionBytes`) ; les écrans ne reçoivent jamais le contenu du fichier dans leurs propriétés.
 */
import type { PrismaClient } from "@prisma/client"
import { readPageGeometries, readPageTexts, readSources, type PageGeometry } from "@/lib/document-studio/pdf-workspace.core"

type Db = PrismaClient

/** Liste des PDF importés, plus récents d'abord, avec leur dernière révision. */
export async function listStudioPdfs(db: Db, companyId: string, take = 100) {
  const rows = await db.studioPdf.findMany({
    where: { companyId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take,
    select: {
      id: true, title: true, originalName: true, origin: true, createdAt: true, updatedAt: true,
      revisions: { orderBy: { revision: "desc" }, take: 1, select: { revision: true, kind: true, pageCount: true, signerName: true, encrypted: true } },
    },
  })
  return rows.map(({ revisions, ...p }) => ({ ...p, latest: revisions[0] ?? null }))
}

export interface StudioPdfRevisionMeta {
  id: string; revision: number; kind: "ORIGINAL" | "FILLED" | "ORGANIZED"; size: number; sha256: string; pageCount: number
  encrypted: boolean; signerName: string | null; createdAt: Date; createdById: string
}

/** Fiche d'un PDF : métadonnées de toutes les révisions, géométrie et texte de la révision affichée (sans octets). */
export async function getStudioPdfView(db: Db, companyId: string, id: string, revisionNumber: number | null) {
  const pdf = await db.studioPdf.findFirst({
    where: { id, companyId },
    select: {
      id: true, title: true, originalName: true, origin: true, sources: true, createdAt: true,
      revisions: {
        orderBy: { revision: "desc" },
        select: { id: true, revision: true, kind: true, size: true, sha256: true, pageCount: true, encrypted: true, signerName: true, createdAt: true, createdById: true },
      },
    },
  })
  if (!pdf || pdf.revisions.length === 0) return null
  const latest = pdf.revisions[0]
  const shown = (revisionNumber !== null ? pdf.revisions.find((r) => r.revision === revisionNumber) : undefined) ?? latest
  const detail = await db.studioPdfRevision.findFirst({ where: { id: shown.id, companyId }, select: { pages: true, pageTexts: true } })
  const pages: PageGeometry[] | null = detail ? readPageGeometries(detail.pages) : null
  if (!detail || !pages || pages.length !== shown.pageCount) return null
  return {
    id: pdf.id, title: pdf.title, originalName: pdf.originalName, createdAt: pdf.createdAt, origin: pdf.origin, sources: readSources(pdf.sources),
    revisions: pdf.revisions as StudioPdfRevisionMeta[], latest: latest as StudioPdfRevisionMeta, shown: shown as StudioPdfRevisionMeta,
    pages, pageTexts: readPageTexts(detail.pageTexts, shown.pageCount),
  }
}

/** Route de téléchargement uniquement : octets d'une révision de CE PDF et de CETTE entreprise. */
export async function getRevisionBytes(db: Db, companyId: string, pdfId: string, revisionId: string) {
  const r = await db.studioPdfRevision.findFirst({
    where: { id: revisionId, pdfId, companyId },
    select: { revision: true, sha256: true, data: true, pdf: { select: { title: true } } },
  })
  if (!r) return null
  return { revision: r.revision, sha256: r.sha256, title: r.pdf.title, data: Buffer.from(r.data) }
}
