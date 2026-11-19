/** Lot F Planificator V2 : lectures de l'assistant, bornées par `companyId`. */
import type { PrismaClient } from "@prisma/client"

type Db = PrismaClient

export async function loadAssistantPage(db: Db, companyId: string) {
  const [pending, decided, logs, employees] = await Promise.all([
    db.assistantProposal.findMany({ where: { companyId, status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100,
      select: { id: true, rule: true, title: true, rationale: true, payload: true, sources: true, createdAt: true } }),
    db.assistantProposal.findMany({ where: { companyId, status: { not: "PENDING" } }, orderBy: [{ decidedAt: "desc" }, { id: "desc" }], take: 30,
      select: { id: true, rule: true, title: true, status: true, decidedAt: true, decisionNote: true, resultEntityId: true } }),
    db.assistantActionLog.findMany({ where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
      select: { id: true, event: true, detail: true, actorId: true, createdAt: true } }),
    db.employee.findMany({ where: { companyId, active: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 300, select: { id: true, firstName: true, lastName: true } }),
  ])
  return { pending, decided, logs, employees }
}
