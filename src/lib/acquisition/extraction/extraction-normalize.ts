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
import { corroborateCancellationText } from "@/lib/acquisition/extraction/cancellation-corroboration"
import { evidenceQuoteInHaystack } from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import {
  isoWeekToDateRange,
  resolveIsoWeekYearFromReferenceDate,
} from "@/lib/acquisition/extraction/iso-week"
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/acquisition/extraction/extraction-feature-flag"

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
  "clientConsultationDate",
  "consultationReference",
  "description",
  "attachmentClassifications",
  "interventionNature",
  "constraints",
  "clientReference",
  "requestClassification",
  "estimatedDurationHours",
  "endClientName",
  "requestedWeekNumber",
  "requestedWeekYear",
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
    // CONSULTATION_CANCELLED = autorité SERVICE uniquement (triple garde-fou post-enrichment).
    // Un provider ne peut jamais injecter ce warning blocking.
    if (w.code === "CONSULTATION_CANCELLED") {
      warnings.push(catalogWarning("PROVIDER_PARTIAL_RESULT", { source: "PROVIDER" }))
      continue
    }
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

/** Gate §5 R1 : signal fort + pas d'ERROR blocking (hors cancel métier). Description seule ≠ OK. */
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
  // CONSULTATION_CANCELLED = blocking conversion métier, pas échec technique d’extraction.
  // Conserve le warning pour AUTO_REJECT_CANCELLED sans forcer gate FAILED.
  const isGateFailingBlocking = (w: ExtractionWarning) =>
    Boolean(w.blocking && w.severity === "ERROR" && w.code !== "CONSULTATION_CANCELLED")
  const blocking = next.some(isGateFailingBlocking)

  if (!strong) {
    next.push(catalogWarning("CONTENT_INSUFFICIENT", { source: "SERVICE" }))
    return { pass: false, failureCode: "CONTENT_INSUFFICIENT", warnings: dedupeWarnings(next) }
  }

  if (blocking) {
    const first = next.find(isGateFailingBlocking)
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
    // Aligné sur EXTRACTION_SCHEMA_VERSION (colonne draft) — évite le drift 2/3.
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    postalCode: fields.postalCode,
    city: fields.city,
    consultationReference: fields.consultationReference,
    clientEmail: fields.clientEmail,
    clientPhone: fields.clientPhone,
    contactEmail: fields.contactEmail,
    contactPhone: fields.contactPhone,
    endClientName: fields.endClientName,
    requestedWeekNumber: fields.requestedWeekNumber,
    requestedWeekYear: fields.requestedWeekYear,
    attachmentClassifications: fields.attachmentClassifications,
    interventionNature: fields.interventionNature,
    constraints: fields.constraints,
    clientReference: fields.clientReference,
    requestClassification: fields.requestClassification,
    estimatedDurationHours: fields.estimatedDurationHours,
    evidence: evidenceData,
    contentHashAtExtraction,
  }
}

/**
 * Evidence littérale requestClassification présente dans subject/body
 * (même haystack métier que le provider). Non dupliquée ailleurs :
 * requestClassification n’est pas un STRONG_FIELD Anthropic.
 */
function hasValidCancelEvidence(
  evidenceData: Record<string, { source: string; quote?: string }>,
  ctx: { subject: string | null; body: string }
): boolean {
  const quote = evidenceData.requestClassification?.quote
  if (!quote?.trim()) return false
  const haystack = `${ctx.subject ?? ""}\n${ctx.body}`
  return evidenceQuoteInHaystack(haystack, quote)
}

function extractExplicitCalendarWeek(
  subject: string | null,
  body: string
): { week: number; quote: string } | null {
  const sources = [body, subject ?? ""]

  for (const source of sources) {
    const matches = source.matchAll(/(?:\bS\s*|\bsemaine\s+)(\d{1,2})\b/gi)

    for (const match of matches) {
      const week = Number(match[1])
      if (!Number.isInteger(week) || week < 1 || week > 53) continue

      return {
        week,
        quote: match[0].slice(0, 120),
      }
    }
  }

  return null
}

export type DeterministicPostEnrichmentContext = {
  subject: string | null
  body: string
  /** Date réelle du message (Gmail) — FIX-002. Absent/null → pas de résolution d’année. */
  receivedAt?: Date | null
}

/**
 * Enrichissement déterministe post-provider :
 * - ISO week → dates si année+semaine valides et dates encore vides
 * - semaine sans année + receivedAt → résolution année ISO (FIX-002) puis plage
 * - semaine sans année sans résolution → DATE_AMBIGUOUS
 * - annulation blocking = classification CANCELLED + evidence valide + corroboration
 *   (aucun des trois signaux seul ne suffit)
 */
export function applyDeterministicPostEnrichment(
  normalized: NormalizedExtraction,
  ctx: DeterministicPostEnrichmentContext
): NormalizedExtraction {
  const fields = { ...normalized.fields }
  const confidenceData = { ...normalized.confidenceData }
  const evidenceData = { ...normalized.evidenceData }
  const warnings = [...normalized.warnings]
  const receivedAt = ctx.receivedAt ?? null

  if (fields.requestedWeekNumber == null) {
    const explicitWeek = extractExplicitCalendarWeek(ctx.subject, ctx.body)
    if (explicitWeek) {
      fields.requestedWeekNumber = explicitWeek.week
      evidenceData.requestedWeekNumber = {
        source: "HEURISTIC",
        quote: explicitWeek.quote,
      }
    }
  }

  const week = fields.requestedWeekNumber
  let year = fields.requestedWeekYear
  const hasStart = Boolean(fields.requestedStartDate)
  const hasEnd = Boolean(fields.requestedEndDate)

  // FIX-002 : résoudre l’année ISO avant la branche DATE_AMBIGUOUS.
  // Ne jamais écraser une année explicite (R1).
  if (week != null && year == null && receivedAt != null) {
    const resolved = resolveIsoWeekYearFromReferenceDate(week, receivedAt)
    if (resolved != null) {
      year = resolved
      fields.requestedWeekYear = resolved
      // Provenance temporelle — pas de fausse quote email.
      evidenceData.requestedWeekYear = { source: "HEURISTIC" }
    }
  }

  if (week != null && year == null) {
    warnings.push(catalogWarning("DATE_AMBIGUOUS", { field: "requestedWeekNumber", source: "SERVICE" }))
    const c = fields.constraints?.trim() ?? ""
    const tag = `S${week}`
    if (!c.includes(tag)) {
      fields.constraints = c ? `${c} ; ${tag}` : tag
    }
  } else if (week != null && year != null && !hasStart && !hasEnd) {
    const range = isoWeekToDateRange(week, year)
    if (range) {
      fields.requestedStartDate = range.startDate
      fields.requestedEndDate = range.endDate
      confidenceData.requestedStartDate = Math.min(
        confidenceData.requestedWeekNumber ?? 0.7,
        0.7
      )
      confidenceData.requestedEndDate = confidenceData.requestedStartDate
      // FIX-002B — dates dérivées : HEURISTIC sans pseudo-citation (année absente du mail).
      evidenceData.requestedStartDate = { source: "HEURISTIC" }
      evidenceData.requestedEndDate = { source: "HEURISTIC" }
    } else {
      warnings.push(
        catalogWarning("DATE_AMBIGUOUS", { field: "requestedWeekNumber", source: "SERVICE" })
      )
    }
  }

  const classifiedCancelled = fields.requestClassification === "CANCELLED_CONSULTATION"
  const corroborated = corroborateCancellationText(ctx.subject, ctx.body)
  const evidenceValid = hasValidCancelEvidence(evidenceData, ctx)

  if (classifiedCancelled && corroborated && evidenceValid) {
    warnings.push(catalogWarning("CONSULTATION_CANCELLED", { source: "SERVICE" }))
  } else if (classifiedCancelled) {
    // Classification sans corroboration et/ou sans evidence littérale → déclasser
    fields.requestClassification = "CONSULTATION"
    warnings.push(
      catalogWarning("PROVIDER_PARTIAL_RESULT", {
        field: "requestClassification",
        source: "SERVICE",
      })
    )
  }
  // corroboration seule (classification ≠ CANCELLED) : jamais autorité → no-op

  return {
    ...normalized,
    fields,
    confidenceData,
    evidenceData,
    warnings: dedupeWarnings(warnings),
  }
}
