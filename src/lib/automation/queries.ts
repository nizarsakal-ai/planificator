/** Lot E Planificator V2 : lectures des règles et du journal d'automatisation, bornées par `companyId` (session). */
import type { PrismaClient } from "@prisma/client"

export async function listRules(db: PrismaClient, companyId: string) {
  return db.automationRule.findMany({
    where: { companyId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200,
    select: {
      id: true, name: true, trigger: true, stageFilter: true, action: true, taskTitle: true, taskDueInDays: true, message: true, status: true,
      approvedAt: true, activatedAt: true, disabledAt: true, createdAt: true, taskAssignee: { select: { firstName: true, lastName: true } }, _count: { select: { runs: true } },
    },
  })
}

export async function listRuns(db: PrismaClient, companyId: string) {
  return db.automationRun.findMany({
    where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
    select: { id: true, eventKey: true, status: true, detail: true, taskId: true, notified: true, createdAt: true, rule: { select: { name: true } } },
  })
}
