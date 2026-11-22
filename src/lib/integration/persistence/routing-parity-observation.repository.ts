/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2D
 * Observations de parité legacy L1 ↔ Router (SPEC LOT-2 §14 ; plan I5) — ajout seul, sans PII.
 * Une observation par (companyId, normalizedInboundId, routingConfigurationVersion) quand les deux sont connus :
 * un rejeu du même message ne la duplique pas (`ON CONFLICT DO NOTHING`). Les observations sans décision Router
 * (budget dépassé, message normalisé introuvable, erreur) sont ajoutées à chaque fois, pour être comptées.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface RecordParityObservationInput {
  companyId: string
  normalizedInboundId: string | null
  externalIdHash: string
  legacyOutcome: "ADMIT" | "REJECT" | "UNKNOWN"
  routerOutcome: "MATCH" | "NO_MATCH" | "NO_ACTIVE_BINDING" | "AMBIGUOUS_SOURCE" | "ERROR" | null
  routingDecisionId: string | null
  routingConfigurationVersion: string | null
  parityOutcome: string
  explainedCodes: string[]
  comparisonCode: string | null
}

export interface RoutingParityObservationRepositoryPort {
  /** Renvoie vrai si une ligne a été ajoutée, faux si l'observation existait déjà. */
  record(input: RecordParityObservationInput): Promise<boolean>
}

export class RoutingParityObservationRepository implements RoutingParityObservationRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async record(input: RecordParityObservationInput): Promise<boolean> {
    if (!input.companyId) throw new Error("companyId requis")
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      INSERT INTO "integration_routing_parity_observations"
        ("id", "companyId", "normalizedInboundId", "externalIdHash", "legacyOutcome", "routerOutcome", "routingDecisionId",
         "routingConfigurationVersion", "parityOutcome", "explainedCodes", "comparisonCode")
      VALUES (${randomUUID()}, ${input.companyId}, ${input.normalizedInboundId}, ${input.externalIdHash}, ${input.legacyOutcome},
              ${input.routerOutcome}, ${input.routingDecisionId}, ${input.routingConfigurationVersion}, ${input.parityOutcome},
              ${input.explainedCodes}::text[], ${input.comparisonCode})
      ON CONFLICT ("companyId", "normalizedInboundId", "routingConfigurationVersion")
        WHERE "normalizedInboundId" IS NOT NULL AND "routingConfigurationVersion" IS NOT NULL
        DO NOTHING
      RETURNING "id"`
    return rows.length === 1
  }
}
