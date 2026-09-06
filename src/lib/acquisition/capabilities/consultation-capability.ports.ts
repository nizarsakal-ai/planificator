/**
 * PLAN-ACQ-AGENTS-LOT-1 — Ports capabilities Consultations (A–E).
 * Interfaces uniquement — aucune implémentation runtime dans ce lot.
 */

import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"
import type {
  ConsultationClassification,
  ConsultationPipelineContext,
  PartnerExtractionProfile,
  RecoveryDecision,
  ValidationDecision,
  WorksiteCreationActor,
  WorksiteCreationDecision,
} from "@/lib/acquisition/capabilities/consultation-capability.types"

/** A — Detection (éligibilité + classification). */
export type ConsultationDetectionInput = {
  companyId: string
  acquisitionMessageId: string
  subject: string | null
  senderEmail: string | null
  senderDomain: string | null
}

export type ConsultationDetectionResult = {
  eligible: boolean
  classification: ConsultationClassification | null
  draftId: string | null
  resolvedPartnerId: string | null
  partnerCode: string | null
}

export interface ConsultationDetectionCapability {
  detectConsultation(
    input: ConsultationDetectionInput
  ): Promise<ConsultationDetectionResult>
}

/** B — Extraction (délègue au service extraction existant). */
export type ConsultationExtractionInput = {
  companyId: string
  draftId: string
  contentHash?: string | null
  partnerProfile?: PartnerExtractionProfile | null
  leaseOwnerId?: string | null
}

export interface ConsultationExtractionCapability {
  extractConsultation(input: ConsultationExtractionInput): Promise<ExtractDraftResult>
}

/** C — Validation déterministe (pure / sync préféré). */
export type ConsultationValidationInput = {
  companyId: string
  draftId: string
  classification: ConsultationClassification | null
  /** Champs / confiances / warnings déjà normalisés — structure opaque au port. */
  extractedSnapshot: unknown
  partnerProfile?: PartnerExtractionProfile | null
}

export interface ConsultationValidationCapability {
  validateConsultation(input: ConsultationValidationInput): ValidationDecision
}

/** D — Création chantier (délègue à conversion.service). */
export type WorksiteCreationInput = {
  companyId: string
  draftId: string
  actor: WorksiteCreationActor
  ackDuplicate?: boolean
}

export interface WorksiteCreationCapability {
  createWorksiteFromConsultation(
    input: WorksiteCreationInput
  ): Promise<WorksiteCreationDecision>
}

/** E — Recovery agrégée (délègue aux reclaimers existants). */
export type ConsultationRecoveryInput = {
  companyId?: string
  runId: string
  leaseOwnerId: string | null
  budgetMs?: number
  /** Contexte optionnel pour cibler un draft/message. */
  context?: Pick<
    ConsultationPipelineContext,
    "acquisitionMessageId" | "draftId" | "companyId"
  >
}

export interface ConsultationRecoveryCapability {
  recoverConsultationPipeline(
    input: ConsultationRecoveryInput
  ): Promise<RecoveryDecision[]>
}
