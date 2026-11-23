/**
 * Lot D Planificator V2 : lectures des réserves et procès-verbaux, toutes bornées par `companyId` (session).
 * Les octets des preuves et des signatures ne sont lus que par les routes de téléchargement et de PDF.
 */
import type { PrismaClient } from "@prisma/client"
import { MAX_LISTED_RESERVES, sha256Hex, snapshotSha256, type ReportSnapshot } from "@/lib/reserves/reserves.core"

type Db = PrismaClient

/** Réserves de l'entreprise (filtre d'état facultatif), plus récentes d'abord, plafonnées à 500. */
export async function listReserves(db: Db, companyId: string, status?: "OPEN" | "LIFTED" | "CANCELLED") {
  return db.worksiteReserve.findMany({
    where: { companyId, ...(status ? { status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_LISTED_RESERVES,
    select: { id: true, number: true, title: true, location: true, severity: true, status: true, dueDate: true, createdAt: true, worksite: { select: { id: true, name: true } } },
  })
}

/** Synthèse par chantier : réserves ouvertes, levées, procès-verbaux (chantiers ayant au moins une réserve ou un PV). */
export async function reserveCountsByWorksite(db: Db, companyId: string) {
  const [counts, reports] = await Promise.all([
    db.worksiteReserve.groupBy({ by: ["worksiteId", "status"], where: { companyId }, _count: { _all: true } }),
    db.receptionReport.groupBy({ by: ["worksiteId"], where: { companyId }, _count: { _all: true } }),
  ])
  const by = new Map<string, { open: number; lifted: number; cancelled: number; reports: number }>()
  const row = (id: string) => by.get(id) ?? (by.set(id, { open: 0, lifted: 0, cancelled: 0, reports: 0 }), by.get(id)!)
  for (const c of counts) {
    const r = row(c.worksiteId)
    if (c.status === "OPEN") r.open += c._count._all
    else if (c.status === "LIFTED") r.lifted += c._count._all
    else r.cancelled += c._count._all
  }
  for (const p of reports) row(p.worksiteId).reports += p._count._all
  return by
}

/** Détail d'un chantier : réserves (avec métadonnées des preuves, sans octets, liste affichée plafonnée à 500), nombre
 * EXACT de réserves ouvertes (non plafonné : le procès-verbal les inscrit toutes) et procès-verbaux. Aucune lecture RH. */
export async function getWorksiteReception(db: Db, companyId: string, worksiteId: string) {
  const worksite = await db.worksite.findFirst({ where: { id: worksiteId, companyId }, select: { id: true, name: true, address: true, archivedAt: true, client: { select: { name: true } } } })
  if (!worksite) return null
  const [reserves, openCount, reports] = await Promise.all([
    db.worksiteReserve.findMany({
      where: { companyId, worksiteId: worksite.id },
      orderBy: [{ status: "asc" }, { number: "asc" }], take: MAX_LISTED_RESERVES,
      select: {
        id: true, number: true, title: true, location: true, description: true, severity: true, status: true, dueDate: true, createdAt: true,
        liftedAt: true, liftNote: true, cancelledAt: true, cancelReason: true,
        assigneeLabel: true,
        files: { select: { id: true, kind: true, mime: true, size: true, originalName: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { reports: true } },
      },
    }),
    db.worksiteReserve.count({ where: { companyId, worksiteId: worksite.id, status: "OPEN" } }),
    db.receptionReport.findMany({
      where: { companyId, worksiteId: worksite.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, number: true, decision: true, receptionDate: true, clientSignerName: true, createdAt: true, _count: { select: { reserves: true } } },
    }),
  ])
  return { worksite, reserves, openCount, truncated: reserves.length === MAX_LISTED_RESERVES, reports }
}

/**
 * Procès-verbal pour le PDF : instantané figé, signature, et contrôle d'intégrité AVANT tout rendu. `intact` exige :
 * - l'empreinte recalculée de l'instantané = empreinte stockée ;
 * - l'empreinte des octets de la signature = celle figée dans l'instantané ET celle de la colonne (revue préliminaire D :
 *   une altération isolée des seuls octets de la signature est refusée, la route répond 409).
 */
export async function getReportForPdf(db: Db, companyId: string, reportId: string) {
  const r = await db.receptionReport.findFirst({ where: { id: reportId, companyId }, select: { number: true, snapshot: true, snapshotSha256: true, signaturePng: true, signatureSha256: true } })
  if (!r) return null
  const snapshot = r.snapshot as unknown as ReportSnapshot
  const signaturePng = Buffer.from(r.signaturePng)
  const signatureDigest = sha256Hex(signaturePng)
  const snapshotIntact = snapshotSha256(snapshot) === r.snapshotSha256
  const signatureIntact = signatureDigest === snapshot.signatureSha256 && signatureDigest === r.signatureSha256
  return { number: r.number, snapshot, signaturePng, snapshotIntact, signatureIntact, intact: snapshotIntact && signatureIntact }
}

/** Preuve d'une réserve pour téléchargement (bornée à l'entreprise). */
export async function getReserveFile(db: Db, companyId: string, fileId: string) {
  return db.worksiteReserveFile.findFirst({ where: { id: fileId, companyId }, select: { mime: true, data: true, originalName: true, sha256: true } })
}
