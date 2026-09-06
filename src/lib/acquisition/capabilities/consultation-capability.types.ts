/**
 * PLAN-ACQ-AGENTS-LOT-1 — Contrats types capabilities Consultations (A–E).
 * Types uniquement — aucun runtime, aucune persistance.
 */

import type { ConvertImportDraftFailure } from "@/lib/acquisition/conversion/conversion.types"
import type { ExtractionOutcome } from "@/lib/acquisition/extraction/extraction.types"
import type { OrchestratorStepKey } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import type { AutoDecisionCode } from "@/lib/acquisition/policy/auto-decision.policy"

/** Classification capability-level (mappe les classifications extraction existantes). */
export type ConsultationClassification =
  | "CONSULTATION"
  | "CONSULTATION_UPDATE"
  | "CANCELLATION"
  | "NON_CONSULTATION"
  | "AMBIGUOUS"

export type ValidationDecision =
  | { code: "PASS"; reasons: string[] }
  | { code: "FAIL_RETRYABLE"; reasons: string[]; errorCode: string }
  | { code: "FAIL_TERMINAL"; reasons: string[]; errorCode: string }
  | { code: "QUARANTINE"; reasons: string[] }

/** Acteur création chantier — SYSTEM pipeline ou ADMIN exception. */
export type WorksiteCreationActor =
  | { kind: "SYSTEM" }
  | { kind: "ADMIN"; userId: string }

export type WorksiteCreationDecision =
  | {
      code: "CREATED"
      worksiteId: string
      clientId: string
    }
  | {
      code: "ALREADY_CONVERTED"
      worksiteId: string
      clientId: string
    }
  | {
      code: "SKIPPED"
      reason: "NOT_APPROVED" | "CANCELLED" | "DISABLED" | "QUARANTINED"
    }
  | {
      code: "FAILED"
      outcome: ConvertImportDraftFailure["outcome"]
      errorCode: string
      existingWorksiteId?: string
    }

export type RecoveryStage =
  | OrchestratorStepKey
  | "extraction"
  | "content"
  | "attachment"
  | "lease"

export type RecoveryDecision =
  | { code: "NOOP" }
  | { code: "RECLAIMED"; stage: RecoveryStage }
  | { code: "REQUEUED"; stage: RecoveryStage; nextRetryAt: string | null }
  | { code: "POISON_TERMINAL"; stage: RecoveryStage; reason: string }

/**
 * Profil d’extraction générique — alimenté plus tard depuis le registry existant.
 * Aucune branche fournisseur ; aucune colonne DB dédiée dans ce lot.
 */
export type PartnerExtractionProfile = {
  partnerId: string
  partnerCode: string
  expectedFields?: string[]
  fieldAliases?: Record<string, string[]>
  referenceSemantics?: "clientReference" | "affaire" | "consultationReference"
  dateSemantics?: "intervention" | "montage_demontage" | "week_iso"
  documentExpectations?: Array<"PLAN" | "CCTP" | "OTHER">
  minConfidence?: number | null
}

/**
 * Agrégat runtime de pipeline — pas une table.
 * Les champs décisionnels restent null tant que la capability n’a pas tourné.
 */
export type ConsultationPipelineContext = {
  companyId: string
  runId: string
  leaseOwnerId: string | null
  acquisitionMessageId: string
  draftId: string | null
  resolvedPartnerId: string | null
  partnerCode: string | null
  contentHash: string | null
  classification: ConsultationClassification | null
  extractionOutcome: ExtractionOutcome | null
  validation: ValidationDecision | null
  autoDecisionCode: AutoDecisionCode | null
  worksiteCreation: WorksiteCreationDecision | null
  recovery: RecoveryDecision | null
}
