/**
 * PLAN-ACQ-AGENTS-LOT-3D — Contexte d’évaluation consultation (lectures seules).
 * Réutilisable plus tard par AutoDecision. Aucune écriture.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ConsultationClassification } from "@/lib/acquisition/capabilities/consultation-capability.types"
import type { ConsultationValidationSnapshot } from "@/lib/acquisition/capabilities/validation.capability"
import type { PartnerExtractionProfile } from "@/lib/acquisition/capabilities/consultation-capability.types"
import {
  findDuplicateWorksite,
  matchClientForDraft,
  normalizeAddressKey,
  type ClientMatchResult,
  type DuplicateWorksiteHit,
} from "@/lib/acquisition/matching/client-match.service"
import {
  PartnerRegistryRepository,
  type PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"
import { DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE } from "@/lib/acquisition/policy/auto-decision-feature-flag"
import type { ValidationCycleIdentity } from "@/lib/acquisition/policy/decision-journal.repository"

export type ConsultationEvaluationDraft = {
  id: string
  companyId: string
  status: string
  version: number
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  proposedClientId: string | null
  confidenceData: unknown
  warningData: unknown
  extractedData: unknown
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  acquisitionMessage: {
    resolvedPartnerId: string | null
    senderDomain: string | null
    /** PLAN-ACQ-AGENTS-LOT-3E — requis pour cancellation follow-up. */
    threadId: string | null
  } | null
}

export type ConsultationEvaluationPartner = {
  id: string
  code: string
  minConfidence: number | null
  autoApproveEnabled: boolean
  autoConvertEnabled: boolean
  allowCreateClient: boolean
  clientId: string | null
}

export type ConsultationEvaluationContext = {
  draft: ConsultationEvaluationDraft
  cycle: ValidationCycleIdentity
  classification: ConsultationClassification | null
  partner: ConsultationEvaluationPartner | null
  partnerProfile: PartnerExtractionProfile | null
  clientMatch: ClientMatchResult
  duplicate: DuplicateWorksiteHit
  snapshot: ConsultationValidationSnapshot
}

export type ConsultationEvaluationContextDeps = {
  db?: PrismaClient
  registry?: PartnerRegistryRepositoryPort
  findDuplicate?: (input: {
    companyId: string
    addressKey: string
    postalCode?: string | null
    db?: PrismaClient
  }) => Promise<DuplicateWorksiteHit>
  matchClient?: (input: {
    companyId: string
    clientName: string | null
    clientEmail: string | null
    proposedClientId: string | null
    partnerLinkedClientId?: string | null
    db?: PrismaClient
  }) => Promise<ClientMatchResult>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

export function readExtractedClientEmail(extractedData: unknown): string | null {
  if (!isRecord(extractedData)) return null
  const v = extractedData.clientEmail
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export function readRequestClassification(extractedData: unknown): string | null {
  if (!isRecord(extractedData)) return null
  const v = extractedData.requestClassification
  return typeof v === "string" ? v : null
}

export function readConsultationReference(extractedData: unknown): string | null {
  if (!isRecord(extractedData)) return null
  const v = extractedData.consultationReference
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export function hasConsultationCancelledWarning(warningData: unknown): boolean {
  if (!Array.isArray(warningData)) return false
  return warningData.some(
    (w) =>
      w &&
      typeof w === "object" &&
      (w as { code?: string }).code === "CONSULTATION_CANCELLED"
  )
}

export function hasRequiredDocUnreadable(warningData: unknown): boolean {
  if (!Array.isArray(warningData)) return false
  return warningData.some(
    (w) =>
      w &&
      typeof w === "object" &&
      ((w as { code?: string }).code === "REQUIRED_DOCUMENT_UNREADABLE" ||
        ((w as { code?: string }).code === "PDF_PARSE_FAILED" &&
          (w as { field?: string }).field === "PLAN") ||
        ((w as { code?: string }).code === "PDF_NO_TEXT_LAYER" &&
          (w as { field?: string }).field === "PLAN"))
  )
}

function asConfidenceMap(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
      out[k] = v
    }
  }
  return out
}

function asWarnings(
  warningData: unknown
): ConsultationValidationSnapshot["warnings"] {
  if (!Array.isArray(warningData)) return []
  const out: ConsultationValidationSnapshot["warnings"] = []
  for (const item of warningData) {
    if (!isRecord(item) || typeof item.code !== "string") continue
    out.push({
      code: item.code,
      blocking: typeof item.blocking === "boolean" ? item.blocking : undefined,
      severity: typeof item.severity === "string" ? item.severity : undefined,
    })
  }
  return out
}

function toIsoDateOnly(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Mapping déterministe Lot 3D — pas de classifieur LLM.
 */
export function mapToConsultationClassification(input: {
  requestClassification: string | null
  consultationCancelledWarning: boolean
}): ConsultationClassification | null {
  if (
    input.requestClassification === "CANCELLED_CONSULTATION" ||
    input.consultationCancelledWarning
  ) {
    return "CANCELLATION"
  }
  if (input.requestClassification === "CONSULTATION") return "CONSULTATION"
  if (input.requestClassification === "INTERVENTION") return "CONSULTATION_UPDATE"
  if (input.requestClassification === "TRAVAUX") return "CONSULTATION_UPDATE"
  if (input.requestClassification == null || input.requestClassification === "") {
    return null
  }
  // Valeur inconnue — jamais PASS par défaut
  return "AMBIGUOUS"
}

export function buildValidationCycleIdentity(
  draft: Pick<
    ConsultationEvaluationDraft,
    "contentHashAtExtraction" | "extractionSchemaVersion" | "version"
  >
): ValidationCycleIdentity | null {
  if (!draft.contentHashAtExtraction) return null
  return {
    contentHash: draft.contentHashAtExtraction,
    extractionSchemaVersion: draft.extractionSchemaVersion,
    draftVersion: draft.version,
  }
}

export async function loadConsultationEvaluationDraft(input: {
  companyId: string
  draftId: string
  db?: PrismaClient
}): Promise<ConsultationEvaluationDraft | null> {
  const db = input.db ?? prisma
  const draft = await db.worksiteImportDraft.findFirst({
    where: { id: input.draftId, companyId: input.companyId },
    select: {
      id: true,
      companyId: true,
      status: true,
      version: true,
      proposedWorksiteName: true,
      proposedClientName: true,
      proposedAddress: true,
      proposedPostalCode: true,
      proposedCity: true,
      proposedStartDate: true,
      proposedEndDate: true,
      proposedClientId: true,
      confidenceData: true,
      warningData: true,
      extractedData: true,
      contentHashAtExtraction: true,
      extractionSchemaVersion: true,
      acquisitionMessage: {
        select: {
          resolvedPartnerId: true,
          senderDomain: true,
          threadId: true,
        },
      },
    },
  })
  return draft
}

export async function buildConsultationEvaluationContext(input: {
  companyId: string
  draftId: string
  deps?: ConsultationEvaluationContextDeps
}): Promise<ConsultationEvaluationContext | null> {
  const db = input.deps?.db ?? prisma
  const registry =
    input.deps?.registry ?? new PartnerRegistryRepository(db)
  const findDuplicate = input.deps?.findDuplicate ?? findDuplicateWorksite
  const matchClient = input.deps?.matchClient ?? matchClientForDraft

  const draft = await loadConsultationEvaluationDraft({
    companyId: input.companyId,
    draftId: input.draftId,
    db,
  })
  if (!draft) return null

  const cycle = buildValidationCycleIdentity(draft)
  if (!cycle) return null

  let partner: ConsultationEvaluationPartner | null = null
  let partnerId = draft.acquisitionMessage?.resolvedPartnerId ?? null

  if (partnerId) {
    const p = await registry.findPartnerById(input.companyId, partnerId)
    if (p?.active) {
      partner = {
        id: p.id,
        code: p.code,
        minConfidence: p.minConfidence,
        autoApproveEnabled: p.autoApproveEnabled,
        autoConvertEnabled: p.autoConvertEnabled,
        allowCreateClient: p.allowCreateClient === true,
        clientId: p.clientId ?? null,
      }
    }
  } else if (draft.acquisitionMessage?.senderDomain) {
    const byDomain = await registry.findPartnerByDomain(
      input.companyId,
      draft.acquisitionMessage.senderDomain
    )
    if (byDomain?.active && byDomain.requireExactEmail !== true) {
      partnerId = byDomain.id
      partner = {
        id: byDomain.id,
        code: byDomain.code,
        minConfidence: byDomain.minConfidence,
        autoApproveEnabled: byDomain.autoApproveEnabled,
        autoConvertEnabled: byDomain.autoConvertEnabled,
        allowCreateClient: byDomain.allowCreateClient === true,
        clientId: byDomain.clientId ?? null,
      }
    }
  }

  const addressKey = normalizeAddressKey({
    address: draft.proposedAddress,
    postalCode: draft.proposedPostalCode,
    city: draft.proposedCity,
  })
  const duplicate = await findDuplicate({
    companyId: input.companyId,
    addressKey,
    postalCode: draft.proposedPostalCode,
    db,
  })

  const extractedClientEmail = readExtractedClientEmail(draft.extractedData)
  const clientMatch = await matchClient({
    companyId: input.companyId,
    clientName: draft.proposedClientName,
    clientEmail: extractedClientEmail,
    proposedClientId: draft.proposedClientId,
    partnerLinkedClientId: partner?.clientId ?? null,
    db,
  })

  const cancelWarning = hasConsultationCancelledWarning(draft.warningData)
  const requestClassification = readRequestClassification(draft.extractedData)
  const classification = mapToConsultationClassification({
    requestClassification,
    consultationCancelledWarning: cancelWarning,
  })
  const consultationCancelled =
    requestClassification === "CANCELLED_CONSULTATION" || cancelWarning

  const potentialDuplicate = Boolean(duplicate.worksiteId)
  const snapshot: ConsultationValidationSnapshot = {
    worksiteName: draft.proposedWorksiteName,
    address: draft.proposedAddress,
    city: draft.proposedCity,
    postalCode: draft.proposedPostalCode,
    clientName: draft.proposedClientName,
    clientEmail: extractedClientEmail,
    consultationReference: readConsultationReference(draft.extractedData),
    requestedStartDate: toIsoDateOnly(draft.proposedStartDate),
    requestedEndDate: toIsoDateOnly(draft.proposedEndDate),
    confidenceData: asConfidenceMap(draft.confidenceData),
    warnings: asWarnings(draft.warningData),
    clientAmbiguous: Boolean(clientMatch.ambiguous),
    hasResolvedClient: Boolean(clientMatch.clientId),
    potentialDuplicate,
    duplicateRequiresAck: potentialDuplicate,
    requiredDocumentUnreadable: hasRequiredDocUnreadable(draft.warningData),
    consultationCancelled,
    contentMissingRetryable: false,
  }

  const partnerProfile: PartnerExtractionProfile | null = partner
    ? {
        partnerId: partner.id,
        partnerCode: partner.code,
        minConfidence:
          partner.minConfidence ?? DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE,
      }
    : null

  return {
    draft,
    cycle,
    classification,
    partner,
    partnerProfile,
    clientMatch,
    duplicate,
    snapshot,
  }
}
