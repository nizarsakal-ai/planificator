/**
 * PLAN-ACQ-V2 Lot F — Journal structuré des décisions auto.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type DecisionJournalEntry = {
  companyId: string
  draftId: string
  decisionCode: string
  reasons: string[]
  scores: Record<string, number>
  actorUserId: string | null
  metadata?: Record<string, unknown>
}

export class AcquisitionDecisionJournalRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async append(entry: DecisionJournalEntry): Promise<void> {
    await this.db.acquisitionDecisionJournal.create({
      data: {
        companyId: entry.companyId,
        draftId: entry.draftId,
        decisionCode: entry.decisionCode,
        reasons: entry.reasons as Prisma.InputJsonValue,
        scores: entry.scores as Prisma.InputJsonValue,
        actorUserId: entry.actorUserId,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  }
}

export const acquisitionDecisionJournalRepository =
  new AcquisitionDecisionJournalRepository()
