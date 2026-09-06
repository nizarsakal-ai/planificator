/**
 * PLAN-ACQ-AGENTS-LOT-2 — ConsultationValidationCapability (C).
 * Pure / déterministe — compose gate + règles auto-decision (sans side effects).
 */

import type {
  ConsultationValidationCapability,
  ConsultationValidationInput,
} from "@/lib/acquisition/capabilities/consultation-capability.ports"
import type { ValidationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import { evaluateExtractionGate } from "@/lib/acquisition/extraction/extraction-normalize"
import {
  catalogWarning,
  EXTRACTION_WARNING_CODES,
} from "@/lib/acquisition/extraction/extraction.schema"
import type {
  ExtractionCanonicalFields,
  ExtractionWarning,
} from "@/lib/acquisition/extraction/extraction.types"
import {
  DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE,
} from "@/lib/acquisition/policy/auto-decision-feature-flag"
import { evaluateAutoDecisionRules } from "@/lib/acquisition/policy/auto-decision.policy"

/**
 * Snapshot minimal pour validation — fourni via extractedSnapshot (port opaque).
 * Pas de subject/body : la corroboration cancel est déjà matérialisée
 * (consultationCancelled / warning CONSULTATION_CANCELLED) en amont.
 */
export type ConsultationValidationSnapshot = {
  worksiteName: string | null
  address: string | null
  city: string | null
  postalCode?: string | null
  clientName: string | null
  clientEmail: string | null
  consultationReference?: string | null
  requestedStartDate: string | null
  requestedEndDate: string | null
  confidenceData: Record<string, number>
  warnings: Array<{
    code: string
    blocking?: boolean
    severity?: string
  }>
  clientAmbiguous?: boolean
  hasResolvedClient?: boolean
  potentialDuplicate?: boolean
  /** Doublon nécessitant ack humain — mappe vers potentialDuplicate côté règles. */
  duplicateRequiresAck?: boolean
  requiredDocumentUnreadable?: boolean
  consultationCancelled?: boolean
  /** Contenu temporairement indisponible (extraction retryable). */
  contentMissingRetryable?: boolean
}

const WARNING_CODE_SET = new Set<string>(EXTRACTION_WARNING_CODES)

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function asNullableString(v: unknown): string | null {
  if (v == null) return null
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length === 0 ? null : t
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  return undefined
}

function parseConfidenceData(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(v)) {
    if (
      typeof raw === "number" &&
      Number.isFinite(raw) &&
      raw >= 0 &&
      raw <= 1
    ) {
      out[k] = raw
    }
  }
  return out
}

function parseWarnings(
  v: unknown
): ConsultationValidationSnapshot["warnings"] {
  if (!Array.isArray(v)) return []
  const out: ConsultationValidationSnapshot["warnings"] = []
  for (const item of v) {
    if (!isRecord(item) || typeof item.code !== "string") continue
    out.push({
      code: item.code,
      blocking: typeof item.blocking === "boolean" ? item.blocking : undefined,
      severity: typeof item.severity === "string" ? item.severity : undefined,
    })
  }
  return out
}

/**
 * Narrowing du port opaque `extractedSnapshot: unknown`.
 * Retourne null uniquement si la valeur n’est pas un objet (payload structurellement invalide).
 */
export function parseConsultationValidationSnapshot(
  raw: unknown
): ConsultationValidationSnapshot | null {
  if (!isRecord(raw)) return null

  return {
    worksiteName: asNullableString(raw.worksiteName),
    address: asNullableString(raw.address),
    city: asNullableString(raw.city),
    postalCode: asNullableString(raw.postalCode) ?? undefined,
    clientName: asNullableString(raw.clientName),
    clientEmail: asNullableString(raw.clientEmail),
    consultationReference: asNullableString(raw.consultationReference) ?? undefined,
    requestedStartDate: asNullableString(raw.requestedStartDate),
    requestedEndDate: asNullableString(raw.requestedEndDate),
    confidenceData: parseConfidenceData(raw.confidenceData),
    warnings: parseWarnings(raw.warnings),
    clientAmbiguous: asOptionalBoolean(raw.clientAmbiguous),
    hasResolvedClient: asOptionalBoolean(raw.hasResolvedClient),
    potentialDuplicate: asOptionalBoolean(raw.potentialDuplicate),
    duplicateRequiresAck: asOptionalBoolean(raw.duplicateRequiresAck),
    requiredDocumentUnreadable: asOptionalBoolean(raw.requiredDocumentUnreadable),
    consultationCancelled: asOptionalBoolean(raw.consultationCancelled),
    contentMissingRetryable: asOptionalBoolean(raw.contentMissingRetryable),
  }
}

function toCanonicalFields(
  snap: ConsultationValidationSnapshot
): ExtractionCanonicalFields {
  return {
    worksiteName: snap.worksiteName,
    clientName: snap.clientName,
    clientEmail: snap.clientEmail,
    clientPhone: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    address: snap.address,
    postalCode: snap.postalCode ?? null,
    city: snap.city,
    requestedStartDate: snap.requestedStartDate,
    requestedEndDate: snap.requestedEndDate,
    consultationReference: snap.consultationReference ?? null,
    description: null,
    attachmentClassifications: [],
    interventionNature: null,
    constraints: null,
    clientReference: null,
    endClientName: null,
    requestedWeekNumber: null,
    requestedWeekYear: null,
    requestClassification: null,
    estimatedDurationHours: null,
  }
}

function toExtractionWarnings(
  warnings: ConsultationValidationSnapshot["warnings"]
): ExtractionWarning[] {
  const out: ExtractionWarning[] = []
  for (const w of warnings) {
    if (!WARNING_CODE_SET.has(w.code)) continue
    const cat = catalogWarning(
      w.code as (typeof EXTRACTION_WARNING_CODES)[number],
      { source: "SERVICE" }
    )
    out.push(cat)
  }
  return out
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null
  // YYYY-MM-DD — date-only, pas d’horloge système
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null
  }
  return dt
}

function resolveMinConfidence(
  partnerMin: number | null | undefined
): number {
  if (partnerMin != null && Number.isFinite(partnerMin) && partnerMin >= 0 && partnerMin <= 1) {
    return Math.round(partnerMin * 100) / 100
  }
  return DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE
}

export function validateConsultation(
  input: ConsultationValidationInput
): ValidationDecision {
  const snap = parseConsultationValidationSnapshot(input.extractedSnapshot)
  if (!snap) {
    return {
      code: "FAIL_TERMINAL",
      reasons: ["INVALID_EXTRACTED_SNAPSHOT"],
      errorCode: "INVALID_EXTRACTED_SNAPSHOT",
    }
  }

  if (snap.contentMissingRetryable) {
    return {
      code: "FAIL_RETRYABLE",
      reasons: ["CONTENT_MISSING"],
      errorCode: "CONTENT_MISSING",
    }
  }

  const classification = input.classification

  if (classification == null) {
    return { code: "QUARANTINE", reasons: ["CLASSIFICATION_NULL"] }
  }

  if (classification === "AMBIGUOUS") {
    return { code: "QUARANTINE", reasons: ["CLASSIFICATION_AMBIGUOUS"] }
  }

  if (classification === "NON_CONSULTATION") {
    return {
      code: "FAIL_TERMINAL",
      reasons: ["NON_CONSULTATION"],
      errorCode: "NON_CONSULTATION",
    }
  }

  if (classification === "CANCELLATION") {
    const cancelled =
      Boolean(snap.consultationCancelled) ||
      snap.warnings.some((w) => w.code === "CONSULTATION_CANCELLED")
    if (cancelled) {
      return {
        code: "FAIL_TERMINAL",
        reasons: ["CONSULTATION_CANCELLED"],
        errorCode: "CONSULTATION_CANCELLED",
      }
    }
    return { code: "QUARANTINE", reasons: ["CANCELLATION_UNCONFIRMED"] }
  }

  // CONSULTATION | CONSULTATION_UPDATE
  const fields = toCanonicalFields(snap)
  const gateWarnings = toExtractionWarnings(snap.warnings)
  const gate = evaluateExtractionGate(fields, gateWarnings)

  if (!gate.pass) {
    const code = gate.failureCode ?? "EMPTY_EXTRACTION"
    return { code: "QUARANTINE", reasons: [code] }
  }

  const minConfidence = resolveMinConfidence(input.partnerProfile?.minConfidence)

  const auto = evaluateAutoDecisionRules({
    worksiteName: snap.worksiteName,
    startDate: parseIsoDate(snap.requestedStartDate),
    endDate: parseIsoDate(snap.requestedEndDate),
    address: snap.address,
    postalCode: snap.postalCode ?? null,
    city: snap.city,
    clientName: snap.clientName,
    clientEmail: snap.clientEmail,
    confidenceData: snap.confidenceData,
    warningData: gate.warnings,
    // Validation ≠ auto-approve runtime : on force l’évaluation des seuils purs.
    autoApproveEnabled: true,
    autoConvertEnabled: false,
    minConfidence,
    potentialDuplicate: Boolean(
      snap.potentialDuplicate || snap.duplicateRequiresAck
    ),
    clientAmbiguous: Boolean(snap.clientAmbiguous),
    requiredDocumentUnreadable: Boolean(snap.requiredDocumentUnreadable),
    consultationCancelled: Boolean(snap.consultationCancelled),
    hasResolvedClient: Boolean(snap.hasResolvedClient),
  })

  if (auto.code === "AUTO_REJECT_CANCELLED") {
    return {
      code: "FAIL_TERMINAL",
      reasons: auto.reasons,
      errorCode: "CONSULTATION_CANCELLED",
    }
  }

  if (auto.code === "HUMAN_REVIEW_REQUIRED") {
    return { code: "QUARANTINE", reasons: auto.reasons }
  }

  return { code: "PASS", reasons: ["THRESHOLDS_OK"] }
}

export const consultationValidationCapability: ConsultationValidationCapability = {
  validateConsultation,
}
