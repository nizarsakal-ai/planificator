import type { PrismaClient } from "@prisma/client"

export const COPILOT_REQUEST_ENTITY = "CopilotRequest"

/** Réserve une question dans le quota quotidien de la société (verrou transactionnel, comme le résumé des consultations).
 * Seul un compteur est écrit dans le journal : ni question, ni réponse. */
export async function reserveCopilotRequest(
  db: PrismaClient,
  input: { companyId: string; actorId: string; dailyLimit: number },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot:${input.companyId}`}, 0))`
    const since = new Date()
    since.setUTCHours(0, 0, 0, 0)
    const used = await tx.historyLog.count({
      where: { companyId: input.companyId, entityType: COPILOT_REQUEST_ENTITY, createdAt: { gte: since } },
    })
    if (used >= input.dailyLimit) return false
    await tx.historyLog.create({
      data: { companyId: input.companyId, actorId: input.actorId, action: "CREATED", entityType: COPILOT_REQUEST_ENTITY },
    })
    return true
  }, { isolationLevel: "ReadCommitted" })
}
