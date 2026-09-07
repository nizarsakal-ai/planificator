/**
 * PLAN-ACQ-MULTI-GMAIL-002 — Résolution mailbox pour messages Gmail Acquisition.
 * Legacy sourceMailboxKey="" : fallback UNIQUEMENT si une seule connexion active.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type ResolveAcquisitionMailboxResult =
  | { ok: true; connectionId: string; resolvedVia: "explicit" | "legacy_single" }
  | { ok: false; code: "GMAIL_NOT_CONNECTED" | "LEGACY_MAILBOX_AMBIGUOUS" }

/**
 * Résout la connexion Gmail à utiliser pour content/attachments.
 * - sourceMailboxKey non vide → connectionId explicite (vérifié côté token client)
 * - legacy "" → 0 active = NOT_CONNECTED ; 1 = fallback ; N>1 = AMBIGUOUS
 */
export async function resolveAcquisitionMailboxForMessage(
  input: {
    companyId: string
    sourceMailboxKey: string
  },
  db: PrismaClient = prisma
): Promise<ResolveAcquisitionMailboxResult> {
  const companyId = input.companyId?.trim()
  if (!companyId) {
    return { ok: false, code: "GMAIL_NOT_CONNECTED" }
  }

  const explicit = input.sourceMailboxKey?.trim() ?? ""
  if (explicit) {
    return { ok: true, connectionId: explicit, resolvedVia: "explicit" }
  }

  const actives = await db.acquisitionGmailConnection.findMany({
    where: { companyId, active: true },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 2,
  })

  if (actives.length === 0) {
    return { ok: false, code: "GMAIL_NOT_CONNECTED" }
  }
  if (actives.length > 1) {
    return { ok: false, code: "LEGACY_MAILBOX_AMBIGUOUS" }
  }
  return {
    ok: true,
    connectionId: actives[0].id,
    resolvedVia: "legacy_single",
  }
}
