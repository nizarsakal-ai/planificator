/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Lecture du snapshot de configuration de routage d'UNE société (SPEC LOT-2 §10.2-1, §13, §15.4 ; plan I4).
 * - Toujours filtré par `companyId` ; jamais de lecture globale des Rules.
 * - Ensemble actif seulement (Sources enabled, et leurs Rules / Bindings enabled).
 * - Bornes §15.4 : au-delà (Sources > 200 ou Rules actives > 2000), `limitExceeded` est vrai et le Router
 *   produit une décision ERROR plutôt qu'un matching partiel.
 * Pas de cache inter-requêtes (I4) : chargé au début de chaque invocation.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"

export const ROUTING_SNAPSHOT_LIMITS = { SOURCES_PER_COMPANY: 200, ACTIVE_RULES_PER_COMPANY: 2000 } as const

export interface RoutingConfigRows {
  companyId: string
  sources: { id: string; enabled: boolean }[]
  rules: { id: string; sourceId: string; type: InboundSourceRuleType; normalizedValue: string; enabled: boolean }[]
  bindings: { id: string; sourceId: string; pipelineId: string; enabled: boolean; connectionId: string | null }[]
  limitExceeded: boolean
}

export interface RoutingConfigSnapshotReaderPort {
  load(companyId: string): Promise<RoutingConfigRows>
}

export class RoutingConfigSnapshotRepository implements RoutingConfigSnapshotReaderPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async load(companyId: string): Promise<RoutingConfigRows> {
    if (!companyId) throw new Error("companyId requis")
    const { SOURCES_PER_COMPANY, ACTIVE_RULES_PER_COMPANY } = ROUTING_SNAPSHOT_LIMITS
    // Lecture cohérente : les trois listes viennent du même instantané (REPEATABLE READ, lecture seule).
    return this.db.$transaction(
      async (tx) => {
        const sources = await tx.inboundSource.findMany({
          where: { companyId, enabled: true },
          select: { id: true, enabled: true },
          orderBy: { id: "asc" },
          take: SOURCES_PER_COMPANY + 1,
        })
        const sourceIds = sources.slice(0, SOURCES_PER_COMPANY).map((s) => s.id)
        const rules = await tx.inboundSourceRule.findMany({
          where: { companyId, enabled: true, sourceId: { in: sourceIds } },
          select: { id: true, sourceId: true, type: true, normalizedValue: true, enabled: true },
          orderBy: { id: "asc" },
          take: ACTIVE_RULES_PER_COMPANY + 1,
        })
        const bindings = await tx.pipelineBinding.findMany({
          where: { companyId, enabled: true, sourceId: { in: sourceIds } },
          select: { id: true, sourceId: true, pipelineId: true, enabled: true, connectionId: true },
          orderBy: { id: "asc" },
        })
        const limitExceeded = sources.length > SOURCES_PER_COMPANY || rules.length > ACTIVE_RULES_PER_COMPANY
        return {
          companyId,
          sources: sources.slice(0, SOURCES_PER_COMPANY),
          rules: rules.slice(0, ACTIVE_RULES_PER_COMPANY).map((r) => ({ ...r, type: r.type as InboundSourceRuleType })),
          bindings,
          limitExceeded,
        }
      },
      { isolationLevel: "RepeatableRead" }
    )
  }
}
