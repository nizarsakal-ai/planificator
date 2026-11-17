/** Lot E Planificator V2 : lectures des opportunités, toutes bornées par `companyId` (session). */
import type { PrismaClient } from "@prisma/client"
import { computePipeline } from "@/lib/crm/crm.core"

type Db = PrismaClient

export async function listOpportunities(db: Db, companyId: string, today: Date) {
  const items = await db.opportunity.findMany({
    where: { companyId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 1000,
    select: {
      id: true, number: true, title: true, stage: true, probabilityBp: true, amountCents: true, expectedCloseDate: true, nextFollowUpDate: true,
      prospectName: true, client: { select: { name: true } }, owner: { select: { firstName: true, lastName: true } },
    },
  })
  return { items, pipeline: computePipeline(items, today), truncated: items.length === 1000 }
}

export async function getOpportunity(db: Db, companyId: string, id: string) {
  return db.opportunity.findFirst({
    where: { id, companyId },
    select: {
      id: true, number: true, title: true, stage: true, probabilityBp: true, amountCents: true, expectedCloseDate: true, nextFollowUpDate: true,
      followUpNote: true, lostReason: true, closedAt: true, prospectName: true, clientId: true, worksiteId: true, quoteId: true, consultationDraftId: true, ownerEmployeeId: true, createdAt: true,
      client: { select: { name: true } }, worksite: { select: { id: true, name: true } }, quote: { select: { id: true, number: true, status: true } },
      events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200, select: { id: true, type: true, fromStage: true, toStage: true, note: true, actorId: true, createdAt: true } },
    },
  })
}

/** Listes de choix du formulaire (entreprise de session) : clients actifs, chantiers, devis, consultations, salariés. */
export async function opportunityFormOptions(db: Db, companyId: string) {
  const [clients, worksites, quotes, consultations, employees] = await Promise.all([
    db.client.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
    db.worksite.findMany({ where: { companyId, archivedAt: null }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
    db.quote.findMany({ where: { companyId, status: { in: ["DRAFT", "SENT", "ACCEPTED"] } }, orderBy: [{ issueDate: "desc" }, { id: "desc" }], take: 300, select: { id: true, number: true, client: { select: { name: true } } } }),
    db.worksiteImportDraft.findMany({ where: { companyId, status: { in: ["PENDING_REVIEW", "APPROVED"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200, select: { id: true, proposedWorksiteName: true, proposedClientName: true } }),
    db.employee.findMany({ where: { companyId, active: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 500, select: { id: true, firstName: true, lastName: true } }),
  ])
  return { clients, worksites, quotes, consultations, employees }
}
