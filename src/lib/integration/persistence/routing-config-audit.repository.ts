/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2B
 * Audit des mutations de configuration de routage (SPEC LOT-2 §15.3, §18.3) dans `history_logs` : identifiants et
 * libellés fixes seulement. JAMAIS `value`, `normalizedValue`, e-mail, domaine ni mot-clé.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type RoutingConfigEntity = "InboundSource" | "InboundSourceRule" | "PipelineBinding"

export interface RoutingConfigAuditPort {
  record(e: { companyId: string; actorId: string; entityType: RoutingConfigEntity; entityId: string; detail: string }): Promise<void>
}

export class RoutingConfigAuditRepository implements RoutingConfigAuditPort {
  constructor(private readonly db: PrismaClient = prisma) {}
  async record(e: { companyId: string; actorId: string; entityType: RoutingConfigEntity; entityId: string; detail: string }): Promise<void> {
    await this.db.historyLog.create({ data: { companyId: e.companyId, actorId: e.actorId, action: "STATUS_CHANGED", entityType: e.entityType, entityId: e.entityId, detail: e.detail } })
  }
}
