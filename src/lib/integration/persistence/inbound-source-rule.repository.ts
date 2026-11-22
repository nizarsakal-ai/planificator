/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Repository InboundSourceRule — CRUD tenanté, sans matching.
 *
 * Mutations enabled/type : exclusivement via InboundSourceIdentityTx
 * (orchestration InboundSourceWriteService). Aucun setEnabled ici.
 * update() = value/normalizedValue uniquement (pas d’impact identité).
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import {
  InboundSourceConflictError,
  InboundSourceError,
  InboundSourceNotFoundError,
  InboundSourcePersistenceError,
  SOURCE_CONSTRAINT,
  isPrismaForeignKeyError,
  isPrismaUniqueConstraintError,
  prismaUniqueConstraintName,
} from "@/lib/integration/persistence/inbound-source.errors"
import {
  mapRowToInboundSourceRule,
  parseCreateInboundSourceRuleInput,
  parseUpdateInboundSourceRuleInput,
  type CreateInboundSourceRuleInput,
  type UpdateInboundSourceRuleInput,
} from "@/lib/integration/persistence/inbound-source-rule.mapper"
import { isIdentityRuleType } from "@/lib/integration/types/inbound-source-rule-type"

export interface InboundSourceRuleRepositoryPort {
  create(input: CreateInboundSourceRuleInput): Promise<InboundSourceRule>
  findById(companyId: string, id: string): Promise<InboundSourceRule>
  listBySource(
    companyId: string,
    sourceId: string
  ): Promise<InboundSourceRule[]>
  countBySource(companyId: string, sourceId: string): Promise<number>
  countEnabledByCompany(companyId: string): Promise<number>
  countEnabledIdentityBySource(
    companyId: string,
    sourceId: string
  ): Promise<number>
  update(input: UpdateInboundSourceRuleInput): Promise<InboundSourceRule>
}

function requireCompanyId(companyId: string): void {
  if (!companyId) {
    throw new InboundSourcePersistenceError("companyId requis")
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof InboundSourceError) throw error
  if (isPrismaUniqueConstraintError(error)) {
    const name = prismaUniqueConstraintName(error)
    if (
      name === SOURCE_CONSTRAINT.RULE_MATCH ||
      name?.includes("match_key") ||
      (Array.isArray((error as { meta?: { target?: unknown } }).meta?.target) &&
        String(
          (error as { meta?: { target?: string[] } }).meta?.target?.join(",")
        ).includes("normalizedValue"))
    ) {
      throw new InboundSourceConflictError()
    }
    throw new InboundSourceConflictError()
  }
  if (isPrismaForeignKeyError(error)) {
    throw new InboundSourceNotFoundError("Source introuvable pour ce tenant")
  }
  throw new InboundSourcePersistenceError()
}

export class InboundSourceRuleRepository
  implements InboundSourceRuleRepositoryPort
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async create(
    input: CreateInboundSourceRuleInput
  ): Promise<InboundSourceRule> {
    const data = parseCreateInboundSourceRuleInput(input)
    requireCompanyId(data.companyId)
    try {
      const row = await this.db.inboundSourceRule.create({ data })
      return mapRowToInboundSourceRule(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async findById(companyId: string, id: string): Promise<InboundSourceRule> {
    requireCompanyId(companyId)
    if (!id) throw new InboundSourceNotFoundError()
    const row = await this.db.inboundSourceRule.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new InboundSourceNotFoundError()
    return mapRowToInboundSourceRule(row)
  }

  async listBySource(
    companyId: string,
    sourceId: string
  ): Promise<InboundSourceRule[]> {
    requireCompanyId(companyId)
    if (!sourceId) throw new InboundSourceNotFoundError()
    const rows = await this.db.inboundSourceRule.findMany({
      where: { companyId, sourceId },
      orderBy: { createdAt: "asc" },
    })
    return rows.map(mapRowToInboundSourceRule)
  }

  async countBySource(companyId: string, sourceId: string): Promise<number> {
    requireCompanyId(companyId)
    return this.db.inboundSourceRule.count({ where: { companyId, sourceId } })
  }

  async countEnabledByCompany(companyId: string): Promise<number> {
    requireCompanyId(companyId)
    return this.db.inboundSourceRule.count({
      where: { companyId, enabled: true },
    })
  }

  async countEnabledIdentityBySource(
    companyId: string,
    sourceId: string
  ): Promise<number> {
    requireCompanyId(companyId)
    const rows = await this.db.inboundSourceRule.findMany({
      where: { companyId, sourceId, enabled: true },
      select: { type: true },
    })
    return rows.filter((r) => isIdentityRuleType(r.type)).length
  }

  async update(
    input: UpdateInboundSourceRuleInput
  ): Promise<InboundSourceRule> {
    const parsed = parseUpdateInboundSourceRuleInput(input)
    requireCompanyId(parsed.companyId)
    const data: {
      value?: string
      normalizedValue?: string
    } = {}
    if (parsed.value !== undefined) data.value = parsed.value
    if (parsed.normalizedValue !== undefined) {
      data.normalizedValue = parsed.normalizedValue
    }
    try {
      const row = await this.db.inboundSourceRule.update({
        where: {
          id_companyId: { id: parsed.id, companyId: parsed.companyId },
        },
        data,
      })
      return mapRowToInboundSourceRule(row)
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2025"
      ) {
        throw new InboundSourceNotFoundError()
      }
      mapPersistenceError(error)
    }
  }
}
