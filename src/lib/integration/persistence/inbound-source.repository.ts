/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Repository InboundSource — CRUD tenanté, sans logique métier Router.
 *
 * Activation (enabled=true) : exclusivement via InboundSourceIdentityTx
 * (orchestration InboundSourceWriteService). Aucun setEnabled(true) ici.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
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
  mapRowToInboundSource,
  parseUpdateInboundSourceInput,
  toPrismaCreateSourceData,
  type CreateInboundSourceInput,
  type UpdateInboundSourceInput,
} from "@/lib/integration/persistence/inbound-source.mapper"

export interface InboundSourceRepositoryPort {
  create(input: CreateInboundSourceInput): Promise<InboundSource>
  findById(companyId: string, id: string): Promise<InboundSource>
  listByCompany(companyId: string): Promise<InboundSource[]>
  countByCompany(companyId: string): Promise<number>
  updateDisplayName(input: UpdateInboundSourceInput): Promise<InboundSource>
  /**
   * Désactivation seule (enabled=false).
   * N’accepte pas l’activation — voir InboundSourceIdentityTx.setSourceEnabled.
   */
  disable(companyId: string, id: string): Promise<InboundSource>
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
    if (name?.includes("match") || name === SOURCE_CONSTRAINT.RULE_MATCH) {
      throw new InboundSourceConflictError()
    }
    throw new InboundSourceConflictError()
  }
  if (isPrismaForeignKeyError(error)) {
    throw new InboundSourcePersistenceError()
  }
  throw new InboundSourcePersistenceError()
}

export class InboundSourceRepository implements InboundSourceRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async create(input: CreateInboundSourceInput): Promise<InboundSource> {
    const data = toPrismaCreateSourceData(input)
    requireCompanyId(data.companyId)
    try {
      const row = await this.db.inboundSource.create({ data })
      return mapRowToInboundSource(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async findById(companyId: string, id: string): Promise<InboundSource> {
    requireCompanyId(companyId)
    if (!id) throw new InboundSourceNotFoundError()
    const row = await this.db.inboundSource.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new InboundSourceNotFoundError()
    return mapRowToInboundSource(row)
  }

  async listByCompany(companyId: string): Promise<InboundSource[]> {
    requireCompanyId(companyId)
    const rows = await this.db.inboundSource.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    })
    return rows.map(mapRowToInboundSource)
  }

  async countByCompany(companyId: string): Promise<number> {
    requireCompanyId(companyId)
    return this.db.inboundSource.count({ where: { companyId } })
  }

  async updateDisplayName(
    input: UpdateInboundSourceInput
  ): Promise<InboundSource> {
    const parsed = parseUpdateInboundSourceInput(input)
    requireCompanyId(parsed.companyId)
    if (parsed.displayName === undefined) {
      throw new InboundSourcePersistenceError("displayName requis")
    }
    try {
      const row = await this.db.inboundSource.update({
        where: {
          id_companyId: { id: parsed.id, companyId: parsed.companyId },
        },
        data: { displayName: parsed.displayName },
      })
      return mapRowToInboundSource(row)
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

  async disable(companyId: string, id: string): Promise<InboundSource> {
    requireCompanyId(companyId)
    if (!id) throw new InboundSourceNotFoundError()
    try {
      const row = await this.db.inboundSource.update({
        where: { id_companyId: { id, companyId } },
        data: { enabled: false },
      })
      return mapRowToInboundSource(row)
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
