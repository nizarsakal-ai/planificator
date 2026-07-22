/**
 * PLAN-ACQ-OPS-001 — Matrice des feature flags Acquisition.
 * Lecture env déterministe (`=== "true"`). Aucune dépendance Prisma/UI/provider.
 * Extension OPS-003 : content cron.
 */

import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { isAcquisitionGmailCronEnabled } from "@/lib/acquisition/acquisition-gmail-cron-feature-flag"
import { isAttachmentDownloadEnabled } from "@/lib/acquisition/attachments/attachment-policy"
import { isAttachmentDownloadCronEnabled } from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"
import { isAttachmentRecoveryCronEnabled } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import { isAttachmentAccessEnabled } from "@/lib/acquisition/access/attachment-access.types"
import { isAcquisitionContentFetchEnabled } from "@/lib/acquisition/content/content-fetch-feature-flag"
import { isAcquisitionContentCronEnabled } from "@/lib/acquisition/content/content-cron-feature-flag"
import {
  getExtractionProviderId,
  isAcquisitionExtractionEnabled,
  type ExtractionProviderId,
} from "@/lib/acquisition/extraction/extraction-feature-flag"
import {
  isAcquisitionConversionEnabled,
  isAcquisitionConversionFullyEnabled,
} from "@/lib/acquisition/conversion/conversion-feature-flag"

export {
  isAcquisitionEnabled as isAcquisitionMasterEnabled,
  isAcquisitionGmailCronEnabled,
  isAttachmentDownloadEnabled as isAcquisitionAttachmentDownloadEnabled,
  isAttachmentDownloadCronEnabled as isAcquisitionAttachmentDownloadCronEnabled,
  isAttachmentRecoveryCronEnabled as isAcquisitionAttachmentRecoveryCronEnabled,
  isAttachmentAccessEnabled as isAcquisitionAttachmentAccessEnabled,
  isAcquisitionContentFetchEnabled,
  isAcquisitionContentCronEnabled,
  isAcquisitionExtractionEnabled,
  isAcquisitionConversionFullyEnabled,
  getExtractionProviderId,
}

/** Skip contrôlé des crons Acquisition (compat + extensions OPS-001 / OPS-003). */
export type AcquisitionCronSkipReason =
  | "CRON_DISABLED"
  | "MASTER_DISABLED"
  | "DOWNLOAD_CAPABILITY_DISABLED"
  | "CONTENT_FETCH_DISABLED"

export type AcquisitionFlagIssueCode =
  | "INV_EXTRACTION_WITHOUT_CONTENT"
  | "INV_DOWNLOAD_CRON_WITHOUT_CAPABILITY"
  | "INV_RECOVERY_WITHOUT_MASTER"
  | "INV_RECOVERY_WITHOUT_DOWNLOAD"
  | "INV_GMAIL_CRON_WITHOUT_MASTER"
  | "INV_DOWNLOAD_CRON_WITHOUT_MASTER"
  | "INV_ACCESS_WITHOUT_MASTER"
  | "INV_CONVERSION_WITHOUT_MASTER"
  | "INV_CONTENT_WITHOUT_MASTER"
  | "INV_CONTENT_CRON_WITHOUT_MASTER"
  | "INV_CONTENT_CRON_WITHOUT_CONTENT"
  | "INV_EXTRACTION_WITHOUT_MASTER"
  | "INV_DOWNLOAD_WITHOUT_MASTER"

export interface AcquisitionFlagMatrix {
  master: boolean
  gmailCron: boolean
  attachmentDownload: boolean
  attachmentDownloadCron: boolean
  attachmentRecoveryCron: boolean
  attachmentAccess: boolean
  contentFetch: boolean
  contentCron: boolean
  extraction: boolean
  extractionProvider: ExtractionProviderId
  conversion: boolean
  conversionFully: boolean
}

export interface AcquisitionFlagIssue {
  code: AcquisitionFlagIssueCode
  message: string
}

export function getAcquisitionFlagMatrix(): AcquisitionFlagMatrix {
  const master = isAcquisitionEnabled()
  const conversion = isAcquisitionConversionEnabled()
  return {
    master,
    gmailCron: isAcquisitionGmailCronEnabled(),
    attachmentDownload: isAttachmentDownloadEnabled(),
    attachmentDownloadCron: isAttachmentDownloadCronEnabled(),
    attachmentRecoveryCron: isAttachmentRecoveryCronEnabled(),
    attachmentAccess: isAttachmentAccessEnabled(),
    contentFetch: isAcquisitionContentFetchEnabled(),
    contentCron: isAcquisitionContentCronEnabled(),
    extraction: isAcquisitionExtractionEnabled(),
    extractionProvider: getExtractionProviderId(),
    conversion,
    conversionFully: isAcquisitionConversionFullyEnabled(),
  }
}

/** Détecte les combinaisons invalides (SPEC §6) — pure, pas de side-effect. */
export function validateAcquisitionFlagMatrix(
  matrix: AcquisitionFlagMatrix = getAcquisitionFlagMatrix()
): AcquisitionFlagIssue[] {
  const issues: AcquisitionFlagIssue[] = []

  if (matrix.gmailCron && !matrix.master) {
    issues.push({
      code: "INV_GMAIL_CRON_WITHOUT_MASTER",
      message: "Gmail cron ON requires PLANIFICATOR_ACQUISITION_ENABLED",
    })
  }
  if (matrix.attachmentDownload && !matrix.master) {
    issues.push({
      code: "INV_DOWNLOAD_WITHOUT_MASTER",
      message: "Attachment download ON requires master",
    })
  }
  if (matrix.attachmentDownloadCron && !matrix.master) {
    issues.push({
      code: "INV_DOWNLOAD_CRON_WITHOUT_MASTER",
      message: "Attachment download cron ON requires master",
    })
  }
  if (matrix.attachmentDownloadCron && !matrix.attachmentDownload) {
    issues.push({
      code: "INV_DOWNLOAD_CRON_WITHOUT_CAPABILITY",
      message: "Attachment download cron ON requires download capability",
    })
  }
  if (matrix.attachmentRecoveryCron && !matrix.master) {
    issues.push({
      code: "INV_RECOVERY_WITHOUT_MASTER",
      message: "Attachment recovery cron ON requires master",
    })
  }
  if (matrix.attachmentRecoveryCron && !matrix.attachmentDownload) {
    issues.push({
      code: "INV_RECOVERY_WITHOUT_DOWNLOAD",
      message: "Attachment recovery cron ON requires download capability",
    })
  }
  if (matrix.attachmentAccess && !matrix.master) {
    issues.push({
      code: "INV_ACCESS_WITHOUT_MASTER",
      message: "Attachment access ON requires master",
    })
  }
  if (matrix.contentFetch && !matrix.master) {
    issues.push({
      code: "INV_CONTENT_WITHOUT_MASTER",
      message: "Content fetch ON requires master",
    })
  }
  if (matrix.contentCron && !matrix.master) {
    issues.push({
      code: "INV_CONTENT_CRON_WITHOUT_MASTER",
      message: "Content cron ON requires PLANIFICATOR_ACQUISITION_ENABLED",
    })
  }
  if (matrix.contentCron && !matrix.contentFetch) {
    issues.push({
      code: "INV_CONTENT_CRON_WITHOUT_CONTENT",
      message: "Content cron ON requires ACQUISITION_CONTENT_FETCH_ENABLED",
    })
  }
  if (matrix.extraction && !matrix.master) {
    issues.push({
      code: "INV_EXTRACTION_WITHOUT_MASTER",
      message: "Extraction ON requires master",
    })
  }
  if (matrix.extraction && !matrix.contentFetch) {
    issues.push({
      code: "INV_EXTRACTION_WITHOUT_CONTENT",
      message: "Extraction ON requires content fetch",
    })
  }
  if (matrix.conversion && !matrix.master) {
    issues.push({
      code: "INV_CONVERSION_WITHOUT_MASTER",
      message: "Conversion ON without master is not Fully enabled",
    })
  }

  return issues
}

export function resolveAcquisitionGmailCronGate(): {
  allowed: boolean
  skipReason?: AcquisitionCronSkipReason
} {
  if (!isAcquisitionGmailCronEnabled()) {
    return { allowed: false, skipReason: "CRON_DISABLED" }
  }
  if (!isAcquisitionEnabled()) {
    return { allowed: false, skipReason: "MASTER_DISABLED" }
  }
  return { allowed: true }
}

export function resolveAcquisitionAttachmentDownloadCronGate(): {
  allowed: boolean
  skipReason?: AcquisitionCronSkipReason
} {
  if (!isAttachmentDownloadCronEnabled()) {
    return { allowed: false, skipReason: "CRON_DISABLED" }
  }
  if (!isAcquisitionEnabled()) {
    return { allowed: false, skipReason: "MASTER_DISABLED" }
  }
  if (!isAttachmentDownloadEnabled()) {
    return { allowed: false, skipReason: "DOWNLOAD_CAPABILITY_DISABLED" }
  }
  return { allowed: true }
}

export function resolveAcquisitionAttachmentRecoveryCronGate(): {
  allowed: boolean
  skipReason?: AcquisitionCronSkipReason
} {
  if (!isAttachmentRecoveryCronEnabled()) {
    return { allowed: false, skipReason: "CRON_DISABLED" }
  }
  if (!isAcquisitionEnabled()) {
    return { allowed: false, skipReason: "MASTER_DISABLED" }
  }
  if (!isAttachmentDownloadEnabled()) {
    return { allowed: false, skipReason: "DOWNLOAD_CAPABILITY_DISABLED" }
  }
  return { allowed: true }
}

export function resolveAcquisitionContentCronGate(): {
  allowed: boolean
  skipReason?: AcquisitionCronSkipReason
} {
  if (!isAcquisitionContentCronEnabled()) {
    return { allowed: false, skipReason: "CRON_DISABLED" }
  }
  if (!isAcquisitionEnabled()) {
    return { allowed: false, skipReason: "MASTER_DISABLED" }
  }
  if (!isAcquisitionContentFetchEnabled()) {
    return { allowed: false, skipReason: "CONTENT_FETCH_DISABLED" }
  }
  return { allowed: true }
}

/** Log structuré minimal pour un refus de flag (pas de secrets). */
export function logAcquisitionFlagSkip(
  log: (event: string, payload?: Record<string, unknown>) => void,
  input: {
    scope: string
    capability: string
    outcome: AcquisitionCronSkipReason | "DISABLED"
    companyId?: string
  }
): void {
  log("FLAG_SKIP", {
    scope: input.scope,
    event: "FLAG_SKIP",
    capability: input.capability,
    outcome: input.outcome,
    ...(input.companyId ? { companyId: input.companyId } : {}),
  })
}
