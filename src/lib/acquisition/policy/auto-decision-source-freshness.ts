/**
 * PLAN-ACQ-DETECTION-001-R8 / R12 — Fraîcheur du contenu source avant décision AUTO.
 * detectionHash === extractionHash === current AcquisitionMessageContent.contentHash
 *
 * R12 — dans une TX métier, le contentHash source est relu sous SELECT … FOR UPDATE.
 */

import { Prisma, type PrismaClient } from "@prisma/client"

export type AutoDecisionSourceFreshnessReason =
  | "SOURCE_CONTENT_MISSING"
  | "EXTRACTION_HASH_MISSING"
  | "DETECTION_HASH_MISSING"
  | "SOURCE_HASH_STALE"
  | "DETECTION_EXTRACTION_MISMATCH"

export type AutoDecisionSourceFreshness =
  | { ok: true; contentHash: string }
  | { ok: false; reason: AutoDecisionSourceFreshnessReason }

/**
 * Pure — les trois hashes doivent représenter le même contenu courant.
 */
export function evaluateAutoDecisionSourceFreshness(input: {
  detectionContentHash: string | null | undefined
  contentHashAtExtraction: string | null | undefined
  currentSourceContentHash: string | null | undefined
}): AutoDecisionSourceFreshness {
  const detection = input.detectionContentHash?.trim() || null
  const extraction = input.contentHashAtExtraction?.trim() || null
  const source = input.currentSourceContentHash?.trim() || null

  if (!extraction) {
    return { ok: false, reason: "EXTRACTION_HASH_MISSING" }
  }
  if (!detection) {
    return { ok: false, reason: "DETECTION_HASH_MISSING" }
  }
  if (!source) {
    return { ok: false, reason: "SOURCE_CONTENT_MISSING" }
  }
  if (detection !== extraction) {
    return { ok: false, reason: "DETECTION_EXTRACTION_MISMATCH" }
  }
  if (source !== extraction) {
    return { ok: false, reason: "SOURCE_HASH_STALE" }
  }
  return { ok: true, contentHash: extraction }
}

export async function loadCurrentAcquisitionContentHash(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  acquisitionMessageId: string
): Promise<string | null> {
  if (!companyId || !acquisitionMessageId) return null
  const row = await db.acquisitionMessageContent.findFirst({
    where: { companyId, acquisitionMessageId },
    select: { contentHash: true },
  })
  const hash = row?.contentHash?.trim()
  return hash || null
}

/**
 * R12 — lecture verrouillée du contentHash source (même TX que la mutation).
 * Absence de ligne ⇒ null (appelant = STALE). Aucun fallback.
 */
export async function lockCurrentAcquisitionContentHashForUpdate(
  tx: Prisma.TransactionClient,
  companyId: string,
  acquisitionMessageId: string
): Promise<string | null> {
  if (!companyId || !acquisitionMessageId) return null
  const rows = await tx.$queryRaw<Array<{ contentHash: string }>>(
    Prisma.sql`
      SELECT "contentHash"
      FROM "acquisition_message_contents"
      WHERE "companyId" = ${companyId}
        AND "acquisitionMessageId" = ${acquisitionMessageId}
      FOR UPDATE
    `
  )
  const hash = rows[0]?.contentHash?.trim()
  return hash || null
}

/**
 * Revalidation TX : après fence, juste avant mutation métier.
 * expectedContentHash = hash du cycle figé (extraction / frozen).
 * R12 — contentHash source sous SELECT … FOR UPDATE.
 */
export async function assertAutoDecisionSourceFreshInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string
    draftId: string
    expectedContentHash: string
  }
): Promise<"FRESH" | "STALE"> {
  const expected = input.expectedContentHash.trim()
  if (!expected) return "STALE"

  const draft = await tx.worksiteImportDraft.findFirst({
    where: { id: input.draftId, companyId: input.companyId },
    select: {
      detectionContentHash: true,
      contentHashAtExtraction: true,
      acquisitionMessageId: true,
    },
  })
  if (!draft) return "STALE"
  if (!draft.acquisitionMessageId) return "STALE"

  const current = await lockCurrentAcquisitionContentHashForUpdate(
    tx,
    input.companyId,
    draft.acquisitionMessageId
  )

  const freshness = evaluateAutoDecisionSourceFreshness({
    detectionContentHash: draft.detectionContentHash,
    contentHashAtExtraction: draft.contentHashAtExtraction,
    currentSourceContentHash: current,
  })
  if (!freshness.ok) return "STALE"
  if (freshness.contentHash !== expected) return "STALE"
  return "FRESH"
}
