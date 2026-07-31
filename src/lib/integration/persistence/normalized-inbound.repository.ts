/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Repository NormalizedInbound — insert-only versionné. Pas de validation métier.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { NormalizedInbound } from "@/lib/integration/contracts/normalized-inbound"
import type { InboundFamily } from "@/lib/integration/types/inbound-family"
import type { PlatformSchemaVersion } from "@/lib/integration/types/schema-version"
import {
  IntegrationInboundError,
  IntegrationInboundNormalizedVersionConflictError,
  IntegrationInboundNotFoundError,
  IntegrationInboundPersistenceError,
  INBOUND_CONSTRAINT,
  isPrismaForeignKeyError,
  isPrismaUniqueConstraintError,
  prismaUniqueConstraintName,
} from "@/lib/integration/persistence/integration-inbound.errors"
import {
  mapRowToNormalizedInbound,
  toPrismaCreateNormalizedData,
  type CreateNormalizedInboundInput,
} from "@/lib/integration/persistence/normalized-inbound.mapper"

export interface NormalizedInboundRepositoryPort {
  create(input: CreateNormalizedInboundInput): Promise<NormalizedInbound>
  findById(companyId: string, id: string): Promise<NormalizedInbound>
  findByEnvelopeVersion(
    companyId: string,
    envelopeId: string,
    family: InboundFamily,
    schemaVersion: PlatformSchemaVersion
  ): Promise<NormalizedInbound>
  listByEnvelope(
    companyId: string,
    envelopeId: string
  ): Promise<NormalizedInbound[]>
}

function requireCompanyId(companyId: string): void {
  if (!companyId) {
    throw new IntegrationInboundPersistenceError("companyId requis")
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof IntegrationInboundError) throw error
  if (isPrismaUniqueConstraintError(error) || isPrismaForeignKeyError(error)) {
    throw new IntegrationInboundPersistenceError()
  }
  throw new IntegrationInboundPersistenceError()
}

export class NormalizedInboundRepository
  implements NormalizedInboundRepositoryPort
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async create(
    input: CreateNormalizedInboundInput
  ): Promise<NormalizedInbound> {
    const data = toPrismaCreateNormalizedData(input)
    requireCompanyId(data.companyId)

    try {
      const row = await this.db.normalizedInbound.create({ data })
      return mapRowToNormalizedInbound(row)
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const constraint = prismaUniqueConstraintName(error)
        if (constraint === INBOUND_CONSTRAINT.ENVELOPE_VERSION) {
          throw new IntegrationInboundNormalizedVersionConflictError()
        }
        throw new IntegrationInboundPersistenceError()
      }
      mapPersistenceError(error)
    }
  }

  async findById(companyId: string, id: string): Promise<NormalizedInbound> {
    requireCompanyId(companyId)
    if (!id) throw new IntegrationInboundNotFoundError()
    const row = await this.db.normalizedInbound.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new IntegrationInboundNotFoundError()
    return mapRowToNormalizedInbound(row)
  }

  async findByEnvelopeVersion(
    companyId: string,
    envelopeId: string,
    family: InboundFamily,
    schemaVersion: PlatformSchemaVersion
  ): Promise<NormalizedInbound> {
    requireCompanyId(companyId)
    if (!envelopeId) throw new IntegrationInboundNotFoundError()
    const row = await this.db.normalizedInbound.findUnique({
      where: {
        envelopeId_companyId_family_schemaVersion: {
          envelopeId,
          companyId,
          family,
          schemaVersion,
        },
      },
    })
    if (!row) throw new IntegrationInboundNotFoundError()
    return mapRowToNormalizedInbound(row)
  }

  async listByEnvelope(
    companyId: string,
    envelopeId: string
  ): Promise<NormalizedInbound[]> {
    requireCompanyId(companyId)
    const rows = await this.db.normalizedInbound.findMany({
      where: { companyId, envelopeId },
      orderBy: { createdAt: "asc" },
    })
    return rows.map((row) => mapRowToNormalizedInbound(row))
  }
}
