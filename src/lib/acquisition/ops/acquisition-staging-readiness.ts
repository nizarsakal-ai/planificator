/**
 * PLAN-ACQ-V2 Lot C — Snapshot readiness staging (lecture seule).
 * Pas d’écriture. À appeler avant activation scheduler.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getAcquisitionFlagMatrix, validateAcquisitionFlagMatrix } from "@/lib/acquisition/acquisition-flag-matrix"
import { activePartnerDomainListing } from "@/lib/acquisition/connector/active-partner-domain-listing"

export type AcquisitionStagingReadiness = {
  companyId: string
  flags: ReturnType<typeof getAcquisitionFlagMatrix>
  flagIssues: ReturnType<typeof validateAcquisitionFlagMatrix>
  activePartnerDomains: string[]
  activePartnerEmails: string[]
  leaseTablePresent: boolean
  draftCounts: {
    pendingExtraction: number
    pendingReview: number
    approved: number
    converted: number
    failed: number
  }
  messageCounts: {
    draftCreated: number
    rejected: number
  }
  readyForOrchestratorE2E: boolean
}

export async function getAcquisitionStagingReadiness(
  companyId: string,
  db: PrismaClient = prisma
): Promise<AcquisitionStagingReadiness> {
  const flags = getAcquisitionFlagMatrix()
  const flagIssues = validateAcquisitionFlagMatrix(flags)
  const identities = await activePartnerDomainListing.listActiveIdentities(companyId)
  const activePartnerDomains = identities.domains
  const activePartnerEmails = identities.emails

  let leaseTablePresent = false
  try {
    await db.$queryRaw`SELECT 1 FROM "acquisition_orchestrator_leases" LIMIT 1`
    leaseTablePresent = true
  } catch {
    leaseTablePresent = false
  }

  const [
    pendingExtraction,
    pendingReview,
    approved,
    converted,
    failed,
    draftCreated,
    rejected,
  ] = await Promise.all([
    db.worksiteImportDraft.count({
      where: { companyId, status: "PENDING_EXTRACTION" },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "PENDING_REVIEW" },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "APPROVED" },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "CONVERTED" },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "FAILED" },
    }),
    db.acquisitionMessage.count({
      where: { companyId, status: "DRAFT_CREATED" },
    }),
    db.acquisitionMessage.count({
      where: { companyId, status: "REJECTED" },
    }),
  ])

  const hasIdentity =
    activePartnerDomains.length > 0 || activePartnerEmails.length > 0

  const readyForOrchestratorE2E =
    flags.master &&
    flags.orchestratorCron &&
    leaseTablePresent &&
    hasIdentity &&
    !flags.conversionFully &&
    !flags.autoApprove &&
    flagIssues.filter((i) => i.code.startsWith("INV_ORCHESTRATOR")).length === 0

  return {
    companyId,
    flags,
    flagIssues,
    activePartnerDomains,
    activePartnerEmails,
    leaseTablePresent,
    draftCounts: {
      pendingExtraction,
      pendingReview,
      approved,
      converted,
      failed,
    },
    messageCounts: { draftCreated, rejected },
    readyForOrchestratorE2E,
  }
}
