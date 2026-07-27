/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B1 / STEP-2
 * Repository IntegrationConnection — opérations ciblées, toujours tenantées.
 *
 * Périmètre : LOT-1B1 uniquement (IntegrationConnection). LOT-1B2 Envelope hors scope.
 * Pas de delete physique, pas d’update générique, pas de résolution de secrets.
 * Create non idempotent tant qu’aucune clé métier explicite n’est définie (voir SPEC/archi).
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ConnectionHealth } from "@/lib/integration/contracts/connection-health"
import type { IntegrationConnection } from "@/lib/integration/contracts/integration-connection"
import type { ConnectionStatus } from "@/lib/integration/types/connection-status"
import type { CredentialStatus } from "@/lib/integration/types/credential-status"
import {
  IntegrationConnectionError,
  IntegrationConnectionNotFoundError,
  IntegrationConnectionPersistenceError,
  isPrismaForeignKeyError,
  isPrismaUniqueConstraintError,
} from "@/lib/integration/persistence/integration-connection.errors"
import {
  isoUtcZToDate,
  mapRowToConnectionHealth,
  mapRowToIntegrationConnection,
  parseConnectionStatus,
  parseCredentialStatus,
  parseUpdateHealthInput,
  parseWatermark,
  toPrismaCreateData,
  type CreateIntegrationConnectionInput,
  type UpdateHealthInput,
} from "@/lib/integration/persistence/integration-connection.mapper"

export type ListIntegrationConnectionsFilters = {
  status?: ConnectionStatus
}

export interface IntegrationConnectionRepositoryPort {
  create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnection>
  findById(companyId: string, id: string): Promise<IntegrationConnection>
  listByCompany(
    companyId: string,
    filters?: ListIntegrationConnectionsFilters
  ): Promise<IntegrationConnection[]>
  updateStatus(
    companyId: string,
    id: string,
    status: ConnectionStatus
  ): Promise<IntegrationConnection>
  updateCredentialStatus(
    companyId: string,
    id: string,
    credentialStatus: CredentialStatus
  ): Promise<IntegrationConnection>
  updateHealth(
    companyId: string,
    id: string,
    input: UpdateHealthInput
  ): Promise<IntegrationConnection>
  updateWatermark(
    companyId: string,
    id: string,
    watermark: string | null
  ): Promise<IntegrationConnection>
  /** Projection santé — même isolation tenant que findById. */
  findHealthById(companyId: string, id: string): Promise<ConnectionHealth>
}

function requireCompanyId(companyId: string): void {
  if (!companyId) {
    throw new IntegrationConnectionPersistenceError("companyId requis")
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof IntegrationConnectionError) {
    throw error
  }
  if (
    isPrismaUniqueConstraintError(error) ||
    isPrismaForeignKeyError(error)
  ) {
    throw new IntegrationConnectionPersistenceError()
  }
  throw new IntegrationConnectionPersistenceError()
}

/** Seul point d’accès Prisma pour IntegrationConnection (LOT-1B1). */
export class IntegrationConnectionRepository
  implements IntegrationConnectionRepositoryPort
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async create(
    input: CreateIntegrationConnectionInput
  ): Promise<IntegrationConnection> {
    const data = toPrismaCreateData(input)
    requireCompanyId(data.companyId)

    try {
      const row = await this.db.integrationConnection.create({ data })
      return mapRowToIntegrationConnection(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async findById(
    companyId: string,
    id: string
  ): Promise<IntegrationConnection> {
    requireCompanyId(companyId)
    if (!id) throw new IntegrationConnectionNotFoundError()

    const row = await this.db.integrationConnection.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new IntegrationConnectionNotFoundError()
    return mapRowToIntegrationConnection(row)
  }

  async findHealthById(
    companyId: string,
    id: string
  ): Promise<ConnectionHealth> {
    requireCompanyId(companyId)
    if (!id) throw new IntegrationConnectionNotFoundError()

    const row = await this.db.integrationConnection.findUnique({
      where: { id_companyId: { id, companyId } },
    })
    if (!row) throw new IntegrationConnectionNotFoundError()
    return mapRowToConnectionHealth(row)
  }

  async listByCompany(
    companyId: string,
    filters?: ListIntegrationConnectionsFilters
  ): Promise<IntegrationConnection[]> {
    requireCompanyId(companyId)

    const status =
      filters?.status !== undefined
        ? parseConnectionStatus(filters.status)
        : undefined

    const rows = await this.db.integrationConnection.findMany({
      where: {
        companyId,
        ...(status !== undefined ? { status } : {}),
      },
      orderBy: { createdAt: "asc" },
    })

    return rows.map((row) => mapRowToIntegrationConnection(row))
  }

  async updateStatus(
    companyId: string,
    id: string,
    status: ConnectionStatus
  ): Promise<IntegrationConnection> {
    requireCompanyId(companyId)
    const next = parseConnectionStatus(status)
    await this.requireExisting(companyId, id)

    try {
      const row = await this.db.integrationConnection.update({
        where: { id_companyId: { id, companyId } },
        data: { status: next },
      })
      return mapRowToIntegrationConnection(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async updateCredentialStatus(
    companyId: string,
    id: string,
    credentialStatus: CredentialStatus
  ): Promise<IntegrationConnection> {
    requireCompanyId(companyId)
    const next = parseCredentialStatus(credentialStatus)
    await this.requireExisting(companyId, id)

    try {
      const row = await this.db.integrationConnection.update({
        where: { id_companyId: { id, companyId } },
        data: { credentialStatus: next },
      })
      return mapRowToIntegrationConnection(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async updateHealth(
    companyId: string,
    id: string,
    input: UpdateHealthInput
  ): Promise<IntegrationConnection> {
    requireCompanyId(companyId)
    const data = parseUpdateHealthInput(input)
    await this.requireExisting(companyId, id)

    try {
      const row = await this.db.integrationConnection.update({
        where: { id_companyId: { id, companyId } },
        data: {
          runtimeHealth: data.runtimeHealth,
          ...(data.lastSuccessfulRunAt !== undefined
            ? { lastSuccessfulRunAt: isoUtcZToDate(data.lastSuccessfulRunAt) }
            : {}),
          ...(data.lastFailedRunAt !== undefined
            ? { lastFailedRunAt: isoUtcZToDate(data.lastFailedRunAt) }
            : {}),
          ...(data.lastHealthCheckAt !== undefined
            ? { lastHealthCheckAt: isoUtcZToDate(data.lastHealthCheckAt) }
            : {}),
          ...(data.lastStableErrorCode !== undefined
            ? { lastStableErrorCode: data.lastStableErrorCode }
            : {}),
        },
      })
      return mapRowToIntegrationConnection(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  async updateWatermark(
    companyId: string,
    id: string,
    watermark: string | null
  ): Promise<IntegrationConnection> {
    requireCompanyId(companyId)
    const next = parseWatermark(watermark)
    await this.requireExisting(companyId, id)

    try {
      const row = await this.db.integrationConnection.update({
        where: { id_companyId: { id, companyId } },
        data: { watermark: next },
      })
      return mapRowToIntegrationConnection(row)
    } catch (error) {
      mapPersistenceError(error)
    }
  }

  private async requireExisting(
    companyId: string,
    id: string
  ): Promise<void> {
    if (!id) throw new IntegrationConnectionNotFoundError()
    const existing = await this.db.integrationConnection.findUnique({
      where: { id_companyId: { id, companyId } },
      select: { id: true },
    })
    if (!existing) throw new IntegrationConnectionNotFoundError()
  }
}
