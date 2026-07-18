import type { AcquisitionSource, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface AcquisitionScanCursorRecord {
  id: string
  companyId: string
  source: AcquisitionSource
  lastHistoryId: string | null
  lastSyncedAt: Date | null
  consecutiveFailures: number
  lastErrorCode: string | null
  lastErrorAt: Date | null
}

export interface AcquisitionScanCursorRepositoryPort {
  getOrCreate(
    companyId: string,
    source: AcquisitionSource
  ): Promise<AcquisitionScanCursorRecord>
  saveSuccessfulPage(
    companyId: string,
    source: AcquisitionSource,
    nextHistoryId: string | null,
    syncedAt: Date
  ): Promise<AcquisitionScanCursorRecord>
  recordFailure(
    companyId: string,
    source: AcquisitionSource,
    errorCode: string,
    occurredAt: Date
  ): Promise<AcquisitionScanCursorRecord>
}

/** Seul point d'accès Prisma pour le curseur de scan Acquisition. */
export class AcquisitionScanCursorRepository implements AcquisitionScanCursorRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getOrCreate(
    companyId: string,
    source: AcquisitionSource
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")

    const existing = await this.db.acquisitionScanCursor.findUnique({
      where: { companyId_source: { companyId, source } },
    })
    if (existing) return existing

    return this.db.acquisitionScanCursor.create({
      data: { companyId, source },
    })
  }

  async saveSuccessfulPage(
    companyId: string,
    source: AcquisitionSource,
    nextHistoryId: string | null,
    syncedAt: Date
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")

    return this.db.acquisitionScanCursor.upsert({
      where: { companyId_source: { companyId, source } },
      create: {
        companyId,
        source,
        lastHistoryId: nextHistoryId,
        lastSyncedAt: syncedAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorAt: null,
      },
      update: {
        lastHistoryId: nextHistoryId,
        lastSyncedAt: syncedAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorAt: null,
      },
    })
  }

  async recordFailure(
    companyId: string,
    source: AcquisitionSource,
    errorCode: string,
    occurredAt: Date
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")

    const current = await this.getOrCreate(companyId, source)
    return this.db.acquisitionScanCursor.update({
      where: { companyId_source: { companyId, source } },
      data: {
        consecutiveFailures: current.consecutiveFailures + 1,
        lastErrorCode: errorCode,
        lastErrorAt: occurredAt,
      },
    })
  }
}

export const acquisitionScanCursorRepository = new AcquisitionScanCursorRepository()
