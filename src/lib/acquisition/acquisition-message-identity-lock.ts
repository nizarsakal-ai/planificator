/**
 * PLAN-ACQ-MULTI-GMAIL-003 — sérialisation commune legacy "" vs moderne connectionId.
 * Verrou transactionnel PostgreSQL (pg_advisory_xact_lock) sur l’identité logique
 * companyId + source + externalMessageId — indépendant du mailboxKey.
 * Ne transforme pas le multi-mailbox moderne A/B en unicité globale : le métier
 * décide sous le verrou (collapse legacy↔moderne, distincts A vs B).
 */

import { createHash } from "crypto"
import type { Prisma } from "@prisma/client"

/** Clés int4 déterministes pour pg_advisory_xact_lock. */
export function buildAcquisitionMessageIdentityLockKeys(input: {
  companyId: string
  source: string
  externalMessageId: string
}): { key1: number; key2: number } {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "acq-message-identity-lock-v1",
        input.companyId,
        input.source,
        input.externalMessageId,
      ]),
      "utf8"
    )
    .digest()
  return {
    key1: digest.readInt32BE(0),
    key2: digest.readInt32BE(4),
  }
}

export async function acquireAcquisitionMessageIdentityAdvisoryXactLock(
  tx: Prisma.TransactionClient,
  input: { companyId: string; source: string; externalMessageId: string }
): Promise<void> {
  const { key1, key2 } = buildAcquisitionMessageIdentityLockKeys(input)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock((${key1})::integer, (${key2})::integer)`
}
