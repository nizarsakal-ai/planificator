/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Mutations Source/Rule sous transaction + verrous FOR UPDATE.
 * Garantit : Source.enabled ⇒ ≥ 1 rule IDENTITÉ enabled.
 * Aucune écriture avant validation de l’état simulé.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"
import {
  IDENTITY_RULE_TYPES,
  isIdentityRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import {
  InboundSourceConflictError,
  InboundSourceError,
  InboundSourceIdentityRequiredError,
  InboundSourceNotFoundError,
  InboundSourcePersistenceError,
  isPrismaForeignKeyError,
  isPrismaUniqueConstraintError,
} from "@/lib/integration/persistence/inbound-source.errors"
import { mapRowToInboundSource } from "@/lib/integration/persistence/inbound-source.mapper"
import { mapRowToInboundSourceRule } from "@/lib/integration/persistence/inbound-source-rule.mapper"

export type UpdateRuleGuardedInput = {
  companyId: string
  ruleId: string
  value?: string
  normalizedValue?: string
  enabled?: boolean
  type?: InboundSourceRuleType
}

export interface InboundSourceIdentityTxPort {
  setSourceEnabled(
    companyId: string,
    sourceId: string,
    enabled: boolean
  ): Promise<InboundSource>
  updateRuleGuarded(input: UpdateRuleGuardedInput): Promise<InboundSourceRule>
}

type Tx = Prisma.TransactionClient

type RuleSnap = {
  id: string
  type: InboundSourceRuleType
  enabled: boolean
}

function mapTxError(error: unknown): never {
  if (error instanceof InboundSourceError) throw error
  if (isPrismaUniqueConstraintError(error)) {
    throw new InboundSourceConflictError()
  }
  if (isPrismaForeignKeyError(error)) {
    throw new InboundSourceNotFoundError()
  }
  throw new InboundSourcePersistenceError()
}

function countEnabledIdentity(rules: readonly RuleSnap[]): number {
  return rules.filter((r) => r.enabled && isIdentityRuleType(r.type)).length
}

async function lockSourceAndRules(
  tx: Tx,
  companyId: string,
  sourceId: string
): Promise<void> {
  // Verrous ligne : sérialise enable Source ↔ disable/change type Rules.
  await tx.$executeRaw`
    SELECT 1 FROM "integration_inbound_sources"
    WHERE "id" = ${sourceId} AND "companyId" = ${companyId}
    FOR UPDATE
  `
  await tx.$executeRaw`
    SELECT 1 FROM "integration_inbound_source_rules"
    WHERE "sourceId" = ${sourceId} AND "companyId" = ${companyId}
    FOR UPDATE
  `
}

export class InboundSourceIdentityTx implements InboundSourceIdentityTxPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async setSourceEnabled(
    companyId: string,
    sourceId: string,
    enabled: boolean
  ): Promise<InboundSource> {
    if (!companyId || !sourceId) throw new InboundSourceNotFoundError()

    try {
      return await this.db.$transaction(async (tx) => {
        await lockSourceAndRules(tx, companyId, sourceId)

        const source = await tx.inboundSource.findUnique({
          where: { id_companyId: { id: sourceId, companyId } },
        })
        if (!source) throw new InboundSourceNotFoundError()

        if (enabled) {
          const identityCount = await tx.inboundSourceRule.count({
            where: {
              companyId,
              sourceId,
              enabled: true,
              type: { in: [...IDENTITY_RULE_TYPES] },
            },
          })
          if (identityCount < 1) {
            throw new InboundSourceIdentityRequiredError()
          }
        }

        // Désactivation : toujours autorisée (aucun invariant violé).
        const row = await tx.inboundSource.update({
          where: { id_companyId: { id: sourceId, companyId } },
          data: { enabled },
        })
        return mapRowToInboundSource(row)
      })
    } catch (error) {
      mapTxError(error)
    }
  }

  async updateRuleGuarded(
    input: UpdateRuleGuardedInput
  ): Promise<InboundSourceRule> {
    const { companyId, ruleId } = input
    if (!companyId || !ruleId) throw new InboundSourceNotFoundError()

    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.inboundSourceRule.findUnique({
          where: { id_companyId: { id: ruleId, companyId } },
        })
        if (!existing) throw new InboundSourceNotFoundError()

        const sourceId = existing.sourceId
        await lockSourceAndRules(tx, companyId, sourceId)

        const source = await tx.inboundSource.findUnique({
          where: { id_companyId: { id: sourceId, companyId } },
        })
        if (!source) throw new InboundSourceNotFoundError()

        const allRules = await tx.inboundSourceRule.findMany({
          where: { companyId, sourceId },
        })

        const simulated: RuleSnap[] = allRules.map((r) => {
          if (r.id !== ruleId) {
            return { id: r.id, type: r.type, enabled: r.enabled }
          }
          return {
            id: r.id,
            type: input.type ?? r.type,
            enabled: input.enabled ?? r.enabled,
          }
        })

        if (source.enabled && countEnabledIdentity(simulated) < 1) {
          throw new InboundSourceIdentityRequiredError()
        }

        const data: {
          value?: string
          normalizedValue?: string
          enabled?: boolean
          type?: InboundSourceRuleType
        } = {}
        if (input.value !== undefined) data.value = input.value
        if (input.normalizedValue !== undefined) {
          data.normalizedValue = input.normalizedValue
        }
        if (input.enabled !== undefined) data.enabled = input.enabled
        if (input.type !== undefined) data.type = input.type

        if (Object.keys(data).length === 0) {
          return mapRowToInboundSourceRule(existing)
        }

        const row = await tx.inboundSourceRule.update({
          where: { id_companyId: { id: ruleId, companyId } },
          data,
        })
        return mapRowToInboundSourceRule(row)
      })
    } catch (error) {
      mapTxError(error)
    }
  }
}
