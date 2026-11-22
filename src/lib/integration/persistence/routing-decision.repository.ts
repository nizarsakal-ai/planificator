/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Dépôt des décisions du Router (SPEC LOT-2 §9.2, §19) — idempotent par
 * `(companyId, normalizedInboundId, routingConfigurationVersion)` :
 * `INSERT … ON CONFLICT DO NOTHING`, puis relecture de la décision existante. L'outcome persisté n'est jamais
 * remplacé (ni par `DUPLICATE`, ni autrement) ; `reused` est une métadonnée hors contrat `RoutingDecision`.
 * Aucune transition d'Envelope, aucune admission.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { routingDecisionSchema, type RoutingDecision } from "@/lib/integration/contracts/routing-decision"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

export interface RecordRoutingDecisionInput {
  companyId: string
  normalizedInboundId: string
  outcome: "MATCH" | "NO_MATCH" | "NO_ACTIVE_BINDING" | "AMBIGUOUS_SOURCE" | "ERROR"
  matchedSourceIds: string[]
  pipelineIds: string[]
  reasonCode?: string
  routingConfigurationVersion: string
}

export interface RecordedRoutingDecision {
  decision: RoutingDecision
  /** Vrai si la clé existait déjà : la décision renvoyée est l'originale, inchangée. */
  reused: boolean
}

export interface RoutingDecisionRepositoryPort {
  record(input: RecordRoutingDecisionInput): Promise<RecordedRoutingDecision>
}

type Row = {
  id: string
  companyId: string
  normalizedInboundId: string
  outcome: string
  matchedSourceIds: string[]
  pipelineIds: string[]
  reasonCode: string | null
  routingConfigurationVersion: string
  schemaVersion: string
  decidedAt: Date
}

function toDecision(r: Row): RoutingDecision {
  return routingDecisionSchema.parse({
    id: r.id,
    companyId: r.companyId,
    normalizedInboundId: r.normalizedInboundId,
    outcome: r.outcome,
    matchedSourceIds: r.matchedSourceIds,
    pipelineIds: r.pipelineIds,
    ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
    routingConfigurationVersion: r.routingConfigurationVersion,
    decidedAt: r.decidedAt.toISOString(),
    schemaVersion: r.schemaVersion,
  }) as RoutingDecision
}

export class RoutingDecisionRepository implements RoutingDecisionRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async record(input: RecordRoutingDecisionInput): Promise<RecordedRoutingDecision> {
    if (!input.companyId || !input.normalizedInboundId) throw new Error("companyId et normalizedInboundId requis")
    const inserted = await this.db.$queryRaw<Row[]>`
      INSERT INTO "integration_routing_decisions"
        ("id", "companyId", "normalizedInboundId", "outcome", "matchedSourceIds", "pipelineIds", "reasonCode",
         "routingConfigurationVersion", "schemaVersion")
      VALUES (${randomUUID()}, ${input.companyId}, ${input.normalizedInboundId}, ${input.outcome},
              ${input.matchedSourceIds}::text[], ${input.pipelineIds}::text[], ${input.reasonCode ?? null},
              ${input.routingConfigurationVersion}, ${PLATFORM_SCHEMA_VERSION_V1})
      ON CONFLICT ("companyId", "normalizedInboundId", "routingConfigurationVersion") DO NOTHING
      RETURNING "id", "companyId", "normalizedInboundId", "outcome", "matchedSourceIds", "pipelineIds", "reasonCode",
                "routingConfigurationVersion", "schemaVersion", "decidedAt"`
    if (inserted[0]) return { decision: toDecision(inserted[0]), reused: false }
    const existing = await this.db.routingDecision.findUnique({
      where: {
        companyId_normalizedInboundId_routingConfigurationVersion: {
          companyId: input.companyId,
          normalizedInboundId: input.normalizedInboundId,
          routingConfigurationVersion: input.routingConfigurationVersion,
        },
      },
    })
    if (!existing) throw new Error("décision de routage introuvable après conflit d'idempotence")
    return { decision: toDecision(existing), reused: true }
  }
}
