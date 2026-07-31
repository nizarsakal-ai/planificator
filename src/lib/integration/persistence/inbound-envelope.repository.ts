/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Repository InboundEnvelope — persistance, idempotence, CAS. Pas de validation métier.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { InboundEnvelope } from "@/lib/integration/contracts/inbound-envelope"
import type { EnvelopeLifecycle } from "@/lib/integration/types/envelope-lifecycle"
import {
  IntegrationInboundError,
  IntegrationInboundIdempotencyConflictError,
  IntegrationInboundLifecycleConflictError,
  IntegrationInboundNotFoundError,
  IntegrationInboundPersistenceError,
  INBOUND_CONSTRAINT,
  isPrismaForeignKeyError,
  isPrismaUniqueConstraintError,
  prismaUniqueConstraintName,
} from "@/lib/integration/persistence/integration-inbound.errors"
import {
  areEnvelopeImmutablesCompatible,
  mapRowToInboundEnvelope,
  parseCreateInboundEnvelopeInput,
  parseEnvelopeLifecycle,
  parseExpectedLifecycleStatuses,
  toPrismaCreateEnvelopeData,
  type CreateInboundEnvelopeInput,
} from "@/lib/integration/persistence/inbound-envelope.mapper"

export type ListInboundEnvelopesFilters = {
  lifecycleStatus?: EnvelopeLifecycle
}

export interface InboundEnvelopeRepositoryPort {
  createIdempotent(input: CreateInboundEnvelopeInput): Promise<InboundEnvelope>
  findById(companyId: string, id: string): Promise<InboundEnvelope>
  findByIdempotencyKey(
    companyId: string,
    connectionId: string,
    idempotencyKey: string
  ): Promise<InboundEnvelope>
  listByConnection(
    companyId: string,
    connectionId: string,
    filters?: ListInboundEnvelopesFilters
  ): Promise<InboundEnvelope[]>
  transitionLifecycle(input: {
    companyId: string
    envelopeId: string
    expectedStatuses: EnvelopeLifecycle[]
    targetStatus: EnvelopeLifecycle
  }): Promise<InboundEnvelope>
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

export class InboundEnvelopeRepository
  implements InboundEnvelopeRepositoryPort
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async createIdempotent(
    input: CreateInboundEnvelopeInput
  ): Promise<InboundEnvelope> {
    const parsed = parseCreateInboundEnvelopeInput(input)
    requireCompanyId(parsed.companyId)

    const connection = await this.db.integrationConnection.findUnique({
      where: {
        id_companyId: {
          id: parsed.connectionId,
          companyId: parsed.companyId,
        },
      },
      select: { connectorType: true },
    })
    if (!connection) throw new IntegrationInboundNotFoundError()

    const data = toPrismaCreateEnvelopeData(parsed, connection.connectorType)

    try {
      const row = await this.db.inboundEnvelope.create({ data })
      return mapRowToInboundEnvelope(row)
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const constraint = prismaUniqueConstraintName(error)
        if (constraint === INBOUND_CONSTRAINT.IDEMPOTENCY) {
          const existing = await this.db.inboundEnvelope.findUnique({
            where: {
              companyId_connectionId_idempotencyKey: {
                companyId: data.companyId,
                connectionId: data.connectionId,
                idempotencyKey: data.idempotencyKey,
              },
            },
          })
          if (!existing) throw new IntegrationInboundPersistenceError()
          if (!areEnvelopeImmutablesCompatible(existing, data)) {
            throw new IntegrationInboundIdempotencyConflictError()
          }
          return mapRowToInboundEnvelope(existing)
        }
        throw new IntegrationInboundPersistenceError()
      }
      mapPersistenceError(error)
    }
  }

  async findById(companyId: string, id: string): Promise<InboundEnvelope> {
    requireCompanyId(companyId)
    if (!id) throw new IntegrationInboundNotFoundError()
    const row = await this.db.inboundEnvelope.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new IntegrationInboundNotFoundError()
    return mapRowToInboundEnvelope(row)
  }

  async findByIdempotencyKey(
    companyId: string,
    connectionId: string,
    idempotencyKey: string
  ): Promise<InboundEnvelope> {
    requireCompanyId(companyId)
    if (!connectionId || !idempotencyKey) {
      throw new IntegrationInboundNotFoundError()
    }
    const row = await this.db.inboundEnvelope.findUnique({
      where: {
        companyId_connectionId_idempotencyKey: {
          companyId,
          connectionId,
          idempotencyKey,
        },
      },
    })
    if (!row) throw new IntegrationInboundNotFoundError()
    return mapRowToInboundEnvelope(row)
  }

  async listByConnection(
    companyId: string,
    connectionId: string,
    filters?: ListInboundEnvelopesFilters
  ): Promise<InboundEnvelope[]> {
    requireCompanyId(companyId)
    const lifecycleStatus =
      filters?.lifecycleStatus !== undefined
        ? parseEnvelopeLifecycle(filters.lifecycleStatus)
        : undefined

    const rows = await this.db.inboundEnvelope.findMany({
      where: {
        companyId,
        connectionId,
        ...(lifecycleStatus !== undefined ? { lifecycleStatus } : {}),
      },
      orderBy: { receivedAt: "asc" },
    })
    return rows.map((row) => mapRowToInboundEnvelope(row))
  }

  async transitionLifecycle(input: {
    companyId: string
    envelopeId: string
    expectedStatuses: EnvelopeLifecycle[]
    targetStatus: EnvelopeLifecycle
  }): Promise<InboundEnvelope> {
    requireCompanyId(input.companyId)
    const expectedStatuses = parseExpectedLifecycleStatuses(input.expectedStatuses)
    const targetStatus = parseEnvelopeLifecycle(input.targetStatus)
    if (!input.envelopeId) throw new IntegrationInboundNotFoundError()

    const updated = await this.db.inboundEnvelope.updateMany({
      where: {
        id: input.envelopeId,
        companyId: input.companyId,
        lifecycleStatus: { in: expectedStatuses },
      },
      data: { lifecycleStatus: targetStatus },
    })

    if (updated.count === 0) {
      const existing = await this.db.inboundEnvelope.findUnique({
        where: {
          id_companyId: { id: input.envelopeId, companyId: input.companyId },
        },
        select: { id: true },
      })
      if (!existing) throw new IntegrationInboundNotFoundError()
      throw new IntegrationInboundLifecycleConflictError()
    }

    return this.findById(input.companyId, input.envelopeId)
  }
}
