/** Lot G Planificator V2 : lectures du Document Studio, bornées par `companyId`. */
import type { PrismaClient } from "@prisma/client"
import { documentSha256, readSnapshot } from "@/lib/document-studio/studio.core"

type Db = PrismaClient

export async function listTemplates(db: Db, companyId: string) {
  return db.documentTemplate.findMany({
    where: { companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 200,
    select: { id: true, name: true, category: true, versions: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, publishedAt: true } }, _count: { select: { versions: true } } },
  })
}
/** Documents générés, plus récents d'abord. Lot G2 : recherche (numéro, titre ou nom du modèle, sans tenir compte de la
 * casse) et état, appliqués DANS la requête, avant la limite. */
export async function listGeneratedDocuments(db: Db, companyId: string, take = 50, filter: { q?: string; status?: "PENDING_APPROVAL" | "ISSUED" | "REJECTED" | null } = {}) {
  const q = filter.q?.trim()
  return db.generatedDocument.findMany({
    where: {
      companyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" as const } }, { title: { contains: q, mode: "insensitive" as const } }, { version: { template: { name: { contains: q, mode: "insensitive" as const } } } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
    select: { id: true, number: true, title: true, status: true, createdAt: true, version: { select: { version: true, template: { select: { name: true } } } } },
  })
}
/** Lot G2 — « nouveau document à partir de celui-ci » : valeurs et liens d'un document de la MÊME société ET du MÊME modèle
 * (sinon `null`), pour préremplir le formulaire de génération. Aucune écriture. */
export async function getDocumentForReuse(db: Db, companyId: string, templateId: string, documentId: string) {
  return db.generatedDocument.findFirst({ where: { id: documentId, companyId, version: { templateId } }, select: { number: true, values: true, clientId: true, worksiteId: true } })
}
export async function getTemplate(db: Db, companyId: string, id: string) {
  return db.documentTemplate.findFirst({
    where: { id, companyId },
    select: {
      id: true, name: true, category: true,
      versions: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, title: true, body: true, fields: true, requiresApproval: true, contentSha256: true, publishedAt: true, retiredAt: true } },
    },
  })
}
// ── Accueil par outils (accueil-v3) : vues de choix bornées, toujours filtrées par société ET par statut DANS la requête,
// avant la limite (aucun filtrage après coup d'une page tronquée). ──────────────────────────────────────────────────────

/** « Générer un document » : modèles ayant une version publiée. */
export async function listPublishedTemplates(db: Db, companyId: string, take = 200) {
  return db.documentTemplate.findMany({
    where: { companyId, versions: { some: { status: "PUBLISHED" } } }, orderBy: [{ name: "asc" }, { id: "asc" }], take,
    select: { id: true, name: true, category: true, versions: { where: { status: "PUBLISHED" }, select: { version: true, publishedAt: true, requiresApproval: true } } },
  })
}
/** « En attente de validation » : statut filtré côté serveur, plus anciens d'abord. */
export async function listPendingDocuments(db: Db, companyId: string, take = 50) {
  return db.generatedDocument.findMany({
    where: { companyId, status: "PENDING_APPROVAL" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take,
    select: { id: true, number: true, title: true, createdAt: true, createdById: true, version: { select: { version: true, template: { select: { name: true } } } } },
  })
}
/** « Télécharger un PDF » : documents récents, SANS leur instantané (il peut porter le logo figé de l'émetteur : relire
 * cinquante instantanés pour une liste coûtait trop — revue Codex du 23/11/2026). L'empreinte reste contrôlée là où elle
 * compte : écran du document, route PDF (409 si non conforme) et validation. */
export async function listPdfDocuments(db: Db, companyId: string, take = 50) {
  const rows = await db.generatedDocument.findMany({
    where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
    select: { id: true, number: true, title: true, status: true, createdAt: true },
  })
  return rows
}

const DOCUMENT_SELECT = { id: true, number: true, status: true, snapshot: true, snapshotSha256: true, createdById: true, createdAt: true, approvedAt: true, signerName: true, rejectedAt: true, rejectReason: true, version: { select: { templateId: true } } } as const

/** Écran du document (portage sur ef36578f) : SANS les octets de la signature (aucune image dans les propriétés de page). */
export async function getGeneratedDocumentView(db: Db, companyId: string, id: string) {
  const d = await db.generatedDocument.findFirst({ where: { id, companyId }, select: DOCUMENT_SELECT })
  if (!d) return null
  const snapshot = readSnapshot(d.snapshot)
  const intact = !!snapshot && documentSha256(snapshot) === d.snapshotSha256
  return { ...d, snapshot, intact }
}

/** PDF seulement : document et octets PNG de la signature du valideur (lus uniquement par la route PDF). */
export async function getGeneratedDocument(db: Db, companyId: string, id: string) {
  const d = await db.generatedDocument.findFirst({ where: { id, companyId }, select: { ...DOCUMENT_SELECT, signaturePng: true } })
  if (!d) return null
  const snapshot = readSnapshot(d.snapshot)
  const intact = !!snapshot && documentSha256(snapshot) === d.snapshotSha256
  return { ...d, snapshot, intact, signaturePng: d.signaturePng ? Buffer.from(d.signaturePng) : null }
}
