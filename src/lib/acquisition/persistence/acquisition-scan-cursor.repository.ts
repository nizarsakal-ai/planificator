import type { AcquisitionSource, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/**
 * PLAN-ACQ-MULTI-GMAIL-002 — Curseur de scan Acquisition.
 *
 * Contrat mailboxKey :
 * - "" = curseur legacy mono-boîte (historique) — lecture seule / archivage ;
 * - connectionId = scans multi-compte (écriture exclusive des nouveaux runs).
 *
 * Les nouvelles mailboxes ne réutilisent JAMAIS le curseur legacy "" :
 * chaque connexion repart avec sa propre stratégie lookback/history.
 * L’anti-doublon legacy (registerIncomingMessage F1) rend le lookback sûr
 * face aux messages Providence déjà ingérés sous sourceMailboxKey="".
 */
export interface AcquisitionScanCursorRecord {
  id: string
  companyId: string
  source: AcquisitionSource
  mailboxKey: string
  lastHistoryId: string | null
  lastSyncedAt: Date | null
  consecutiveFailures: number
  lastErrorCode: string | null
  lastErrorAt: Date | null
}

export interface AcquisitionScanCursorRepositoryPort {
  getOrCreate(
    companyId: string,
    source: AcquisitionSource,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord>
  saveSuccessfulPage(
    companyId: string,
    source: AcquisitionSource,
    nextHistoryId: string | null,
    syncedAt: Date,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord>
  recordFailure(
    companyId: string,
    source: AcquisitionSource,
    errorCode: string,
    occurredAt: Date,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord>
}

function normalizeMailboxKey(mailboxKey?: string): string {
  return mailboxKey ?? ""
}

/** Seul point d'accès Prisma pour le curseur de scan Acquisition. */
export class AcquisitionScanCursorRepository implements AcquisitionScanCursorRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getOrCreate(
    companyId: string,
    source: AcquisitionSource,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")
    const key = normalizeMailboxKey(mailboxKey)

    const existing = await this.db.acquisitionScanCursor.findUnique({
      where: {
        companyId_source_mailboxKey: { companyId, source, mailboxKey: key },
      },
    })
    if (existing) return existing

    return this.db.acquisitionScanCursor.create({
      data: { companyId, source, mailboxKey: key },
    })
  }

  async saveSuccessfulPage(
    companyId: string,
    source: AcquisitionSource,
    nextHistoryId: string | null,
    syncedAt: Date,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")
    const key = normalizeMailboxKey(mailboxKey)

    return this.db.acquisitionScanCursor.upsert({
      where: {
        companyId_source_mailboxKey: { companyId, source, mailboxKey: key },
      },
      create: {
        companyId,
        source,
        mailboxKey: key,
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
    occurredAt: Date,
    mailboxKey?: string
  ): Promise<AcquisitionScanCursorRecord> {
    if (!companyId) throw new Error("companyId requis")
    const key = normalizeMailboxKey(mailboxKey)

    const current = await this.getOrCreate(companyId, source, key)
    return this.db.acquisitionScanCursor.update({
      where: {
        companyId_source_mailboxKey: { companyId, source, mailboxKey: key },
      },
      data: {
        consecutiveFailures: current.consecutiveFailures + 1,
        lastErrorCode: errorCode,
        lastErrorAt: occurredAt,
      },
    })
  }
}

export const acquisitionScanCursorRepository = new AcquisitionScanCursorRepository()
