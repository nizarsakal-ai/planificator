/**
 * PLAN-ACQ-005B — Normalisation + gate (autorité service).
 * Description seule ≠ signal fort. Catalogue warnings fermé.
 */

import {
  EXTRACTION_WARNING_CODES,
  catalogWarning,
  extractionCanonicalFieldsSchema,
  extractionProviderResultSchema,
} from "@/lib/acquisition/extraction/extraction.schema"
import type {
  ExtractionCanonicalFields,
  ExtractionWarning,
} from "@/lib/acquisition/extraction/extraction.types"

const CANONICAL_KEYS = [
  "worksiteName",
  "clientName",
  "clientEmail",
  "clientPhone",
  "contactName",
  "contactEmail",
  "contactPhone",
  "address",
  "postalCode",
  "city",
  "requestedStartDate",
  "requestedEndDate",
  "consultationReference",
  "description",
  "attachmentClassifications",
] as const

type CanonicalKey = (typeof CANONICAL_KEYS)[number]

function isWarningCode(code: string): code is (typeof EXTRACTION_WARNING_CODES)[number] {
  return (EXTRACTION_WARNING_CODES as readonly string[]).includes(code)
}

export type NormalizedExtraction = {
  fields: ExtractionCanonicalFields
  confidenceData: Record<string, number>
  evidenceData: Record<string, { source: string; quote?: string }>
  warnings: ExtractionWarning[]
  providerId: string
  model: string | null
}

/**
 * Signal métier fort V1 — description seule ne suffit jamais.
 * Le service reste l'autorité ; le provider ne décide pas du statut.
 */
export function hasStrongBusinessSignal(fields: ExtractionCanonicalFields): boolean {
  return (
    Boolean(fields.worksiteName && fields.worksiteName.trim().length >= 3) ||
    Boolean(fields.clientName && fields.clientName.trim().length >= 2) ||
    Boolean(fields.address && fields.address.trim().length >= 8) ||
    Boolean(fields.consultationReference && fields.consultationReference.trim().length >= 3)
  )
}

export function normalizeProviderResult(raw: unknown): NormalizedExtraction {
  const parsed = extractionProviderResultSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error("PROVIDER_INVALID_OUTPUT")
  }

  const result = parsed.data
  const warnings: ExtractionWarning[] = []
  const confidenceData: Record<string, number> = {}
  const evidenceData: Record<string, { source: string; quote?: string }> = {}
  const candidate: Record<string, unknown> = {}

  for (const key of CANONICAL_KEYS) {
    const field = result.fields[key]
    if (!field) continue
    const k = key as CanonicalKey
    const confidence = field.confidence as number
    if (confidence < 0.4) {
      warnings.push(catalogWarning("LOW_CONFIDENCE", { field: k, source: "SERVICE" }))
    }
    confidenceData[k] = confidence
    if (field.evidence) {
      const ev = field.evidence as { source: string; quote?: string }
      evidenceData[k] = {
        source: ev.source,
        quote: ev.quote?.slice(0, 120),
      }
    }
    candidate[k] = field.value
  }

  for (const w of result.warnings) {
    // Message provider libre TOUJOURS ignoré.
    if (isWarningCode(w.code)) {
      warnings.push(
        catalogWarning(w.code, {
          field: w.field,
          source: "PROVIDER",
        })
      )
    } else {
      warnings.push(catalogWarning("PROVIDER_PARTIAL_RESULT", { source: "PROVIDER" }))
    }
  }

  for (const emailKey of ["clientEmail", "contactEmail"] as const) {
    const v = candidate[emailKey]
    if (typeof v === "string" && v.trim()) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
      if (!ok) {
        delete candidate[emailKey]
        delete confidenceData[emailKey]
        warnings.push(catalogWarning("INVALID_EMAIL", { field: emailKey, source: "VALIDATOR" }))
      }
    }
  }

  const fieldsParsed = extractionCanonicalFieldsSchema.safeParse(candidate)
  if (!fieldsParsed.success) {
    for (const issue of fieldsParsed.error.issues) {
      const msg = issue.message
      if (msg === "INVALID_EMAIL") {
        warnings.push(
          catalogWarning("INVALID_EMAIL", {
            field: String(issue.path[0] ?? "") || undefined,
            source: "VALIDATOR",
          })
        )
      } else if (msg === "DATE_AMBIGUOUS") {
        warnings.push(
          catalogWarning("DATE_AMBIGUOUS", {
            field: String(issue.path[0] ?? "") || undefined,
            source: "VALIDATOR",
          })
        )
      }
    }
    const soft: Record<string, unknown> = { ...candidate }
    for (const issue of fieldsParsed.error.issues) {
      const path0 = issue.path[0]
      if (typeof path0 === "string") delete soft[path0]
    }
    const retry = extractionCanonicalFieldsSchema.parse(soft)
    return {
      fields: retry,
      confidenceData,
      evidenceData,
      warnings: dedupeWarnings(warnings),
      providerId: String(result.providerMetadata.providerId),
      model: result.providerMetadata.model != null ? String(result.providerMetadata.model) : null,
    }
  }

  return {
    fields: fieldsParsed.data,
    confidenceData,
    evidenceData,
    warnings: dedupeWarnings(warnings),
    providerId: String(result.providerMetadata.providerId),
    model: result.providerMetadata.model != null ? String(result.providerMetadata.model) : null,
  }
}

function dedupeWarnings(warnings: ExtractionWarning[]): ExtractionWarning[] {
  const seen = new Set<string>()
  const out: ExtractionWarning[] = []
  for (const w of warnings) {
    const key = `${w.code}:${w.field ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out.slice(0, 50)
}

/** Gate §5 R1 : signal fort + pas d'ERROR blocking. Description seule ≠ OK. */
export function evaluateExtractionGate(
  fields: ExtractionCanonicalFields,
  warnings: ExtractionWarning[]
): {
  pass: boolean
  failureCode: "EMPTY_EXTRACTION" | "CONTENT_INSUFFICIENT" | "DATE_RANGE_INVALID" | null
  warnings: ExtractionWarning[]
} {
  const next = [...warnings]

  if (
    fields.requestedStartDate &&
    fields.requestedEndDate &&
    fields.requestedEndDate < fields.requestedStartDate
  ) {
    next.push(catalogWarning("DATE_RANGE_INVALID", { source: "SERVICE" }))
    return { pass: false, failureCode: "DATE_RANGE_INVALID", warnings: dedupeWarnings(next) }
  }

  if (
    (fields.requestedStartDate && !fields.requestedEndDate) ||
    (!fields.requestedStartDate && fields.requestedEndDate)
  ) {
    next.push(catalogWarning("MISSING_REQUIRED_FOR_CONVERSION", { source: "SERVICE" }))
  }

  const strong = hasStrongBusinessSignal(fields)
  const blocking = next.some((w) => w.blocking && w.severity === "ERROR")

  if (!strong) {
    next.push(catalogWarning("CONTENT_INSUFFICIENT", { source: "SERVICE" }))
    return { pass: false, failureCode: "CONTENT_INSUFFICIENT", warnings: dedupeWarnings(next) }
  }

  if (blocking) {
    const first = next.find((w) => w.blocking && w.severity === "ERROR")
    const code =
      first?.code === "DATE_RANGE_INVALID"
        ? "DATE_RANGE_INVALID"
        : first?.code === "CONTENT_INSUFFICIENT"
          ? "CONTENT_INSUFFICIENT"
          : "EMPTY_EXTRACTION"
    return { pass: false, failureCode: code, warnings: dedupeWarnings(next) }
  }

  return { pass: true, failureCode: null, warnings: dedupeWarnings(next) }
}

export function buildExtractedDataPayload(
  fields: ExtractionCanonicalFields,
  evidenceData: Record<string, { source: string; quote?: string }>,
  contentHashAtExtraction: string
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    postalCode: fields.postalCode,
    city: fields.city,
    consultationReference: fields.consultationReference,
    contactEmail: fields.contactEmail,
    contactPhone: fields.contactPhone,
    attachmentClassifications: fields.attachmentClassifications,
    evidence: evidenceData,
    contentHashAtExtraction,
  }
}
