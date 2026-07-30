/**
 * PLAN-ACQ-V2 Lot H — Snapshot observabilité ops Acquisition.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type AcquisitionOpsSnapshot = {
  companyId: string
  generatedAt: string
  messages: {
    draftCreated: number
    rejected: number
    withThreadId: number
  }
  drafts: {
    pendingExtraction: number
    extracting: number
    pendingReview: number
    approved: number
    converted: number
    failed: number
    rejected: number
  }
  decisions: {
    autoApproveConvert: number
    autoApproveOnly: number
    humanReviewRequired: number
  }
  worksitesFromAcquisition: {
    plannedUnassigned: number
  }
}

export async function getAcquisitionOpsSnapshot(
  companyId: string,
  db: PrismaClient = prisma
): Promise<AcquisitionOpsSnapshot> {
  const [
    draftCreated,
    rejectedMsg,
    withThreadId,
    pendingExtraction,
    extracting,
    pendingReview,
    approved,
    converted,
    failed,
    rejectedDraft,
    autoApproveConvert,
    autoApproveOnly,
    humanReviewRequired,
    plannedUnassigned,
  ] = await Promise.all([
    db.acquisitionMessage.count({
      where: { companyId, status: "DRAFT_CREATED" },
    }),
    db.acquisitionMessage.count({
      where: { companyId, status: "REJECTED" },
    }),
    db.acquisitionMessage.count({
      where: { companyId, threadId: { not: null } },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "PENDING_EXTRACTION" },
    }),
    db.worksiteImportDraft.count({
      where: { companyId, status: "EXTRACTING" },
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
    db.worksiteImportDraft.count({
      where: { companyId, status: "REJECTED" },
    }),
    db.acquisitionDecisionJournal.count({
      where: { companyId, decisionCode: "AUTO_APPROVE_CONVERT" },
    }),
    db.acquisitionDecisionJournal.count({
      where: { companyId, decisionCode: "AUTO_APPROVE_ONLY" },
    }),
    db.acquisitionDecisionJournal.count({
      where: { companyId, decisionCode: "HUMAN_REVIEW_REQUIRED" },
    }),
    db.worksite.count({
      where: {
        companyId,
        status: "PLANNED",
        assignments: { none: {} },
        importDrafts: { some: {} },
      },
    }),
  ])

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    messages: { draftCreated, rejected: rejectedMsg, withThreadId },
    drafts: {
      pendingExtraction,
      extracting,
      pendingReview,
      approved,
      converted,
      failed,
      rejected: rejectedDraft,
    },
    decisions: {
      autoApproveConvert,
      autoApproveOnly,
      humanReviewRequired,
    },
    worksitesFromAcquisition: { plannedUnassigned },
  }
}
