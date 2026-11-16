import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  assessAcquisitionMailboxHealth,
  type MailboxHealth,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"

export interface AcquisitionMailboxStatus {
  id: string
  gmailAddress: string
  health: MailboxHealth
}

/**
 * Santé des boîtes Gmail Acquisition d'un tenant (connexion + curseur de scan,
 * mailboxKey = connectionId). Calculée côté serveur : pas d'écart d'hydratation.
 */
export async function loadAcquisitionMailboxStatuses(
  companyId: string,
  options: { db?: Pick<PrismaClient, "acquisitionGmailConnection" | "acquisitionScanCursor">; now?: Date } = {}
): Promise<AcquisitionMailboxStatus[]> {
  const db = options.db ?? prisma
  const now = options.now ?? new Date()

  const connections = await db.acquisitionGmailConnection.findMany({
    where: { companyId },
    select: { id: true, gmailAddress: true, active: true, updatedAt: true },
    orderBy: { gmailAddress: "asc" },
  })
  if (connections.length === 0) return []

  const cursors = await db.acquisitionScanCursor.findMany({
    where: { companyId, source: "GMAIL", mailboxKey: { in: connections.map((c) => c.id) } },
    select: {
      mailboxKey: true,
      lastSyncedAt: true,
      consecutiveFailures: true,
      lastErrorCode: true,
      lastErrorAt: true,
    },
  })
  const cursorByConnection = new Map(cursors.map((c) => [c.mailboxKey, c]))

  return connections.map((c) => ({
    id: c.id,
    gmailAddress: c.gmailAddress,
    health: assessAcquisitionMailboxHealth({
      active: c.active,
      cursor: cursorByConnection.get(c.id) ?? null,
      connectionUpdatedAt: c.updatedAt,
      now,
    }),
  }))
}
