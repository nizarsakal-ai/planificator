/**
 * PLAN-ACQ-005B — Schémas Zod extraction (bornés, catalogue fermé).
 * Le provider ne décide jamais du statut métier.
 */

import { z } from "zod"

export const EXTRACTION_EVIDENCE_SOURCES = [
  "BODY",
  "SUBJECT",
  "ATTACHMENT_META",
  "HEURISTIC",
] as const

export const EXTRACTION_WARNING_CODES = [
  "CONTENT_INSUFFICIENT",
  "EMPTY_EXTRACTION",
  "DATE_RANGE_INVALID",
  "DATE_AMBIGUOUS",
  "MISSING_REQUIRED_FOR_CONVERSION",
  "LOW_CONFIDENCE",
  "INVALID_EMAIL",
  "INVALID_PHONE",
  "CLIENT_IDENTITY_AMBIGUOUS",
  "PROVIDER_PARTIAL_RESULT",
  "UNSUPPORTED_ATTACHMENT_TYPE",
  "POTENTIAL_PROMPT_INJECTION",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "STALE_CONTENT",
  "INPUT_TRUNCATED_FOR_PROVIDER",
] as const

export const EXTRACTION_WARNING_SEVERITIES = ["INFO", "WARNING", "ERROR"] as const
export const EXTRACTION_WARNING_SOURCES = ["SERVICE", "PROVIDER", "VALIDATOR", "PROVIDER_ADAPTER"] as const

export const MAX_PROVIDER_FIELDS = 20
export const MAX_PROVIDER_WARNINGS = 50
export const MAX_EVIDENCE_QUOTE = 120
export const MAX_PROVIDER_STRING = 5000

const trimCollapse = (value: string) => value.trim().replace(/\s+/g, " ")

const finiteNumber = (schema: z.ZodNumber) =>
  schema.refine((n) => Number.isFinite(n), { message: "not_finite" })

export const extractionEvidenceSchema = z
  .object({
    source: z.enum(EXTRACTION_EVIDENCE_SOURCES),
    quote: z
      .preprocess((v) => {
        if (v == null || v === undefined) return undefined
        if (typeof v !== "string") return v
        const t = v.trim()
        if (!t) return undefined
        return t.slice(0, MAX_EVIDENCE_QUOTE)
      }, z.string().max(MAX_EVIDENCE_QUOTE).optional())
      .optional(),
  })
  .strict()

export const extractionFieldValueSchema = z
  .object({
    value: z.custom<unknown>((v) => v !== undefined),
    confidence: finiteNumber(z.number().min(0).max(1)).transform((n) => Math.round(n * 100) / 100),
    evidence: extractionEvidenceSchema.optional(),
  })
  .strict()

const optionalField = extractionFieldValueSchema.optional()

/** Objet fermé : clés canoniques uniquement (pas de z.record ouvert). */
export const extractionProviderFieldsSchema = z
  .object({
    worksiteName: optionalField,
    clientName: optionalField,
    clientEmail: optionalField,
    clientPhone: optionalField,
    contactName: optionalField,
    contactEmail: optionalField,
    contactPhone: optionalField,
    address: optionalField,
    postalCode: optionalField,
    city: optionalField,
    requestedStartDate: optionalField,
    requestedEndDate: optionalField,
    consultationReference: optionalField,
    description: optionalField,
    attachmentClassifications: optionalField,
  })
  .strict()

export const extractionProviderWarningSchema = z
  .object({
    code: z.string().min(1).max(64),
    /** Accepté en entrée puis ignoré (jamais persisté). */
    message: z.string().max(500).optional(),
    field: z.string().max(64).optional(),
  })
  .strict()

export const extractionProviderResultSchema = z
  .object({
    fields: extractionProviderFieldsSchema,
    warnings: z.array(extractionProviderWarningSchema).max(MAX_PROVIDER_WARNINGS).default([]),
    providerMetadata: z
      .object({
        providerId: z.string().min(1).max(64),
        model: z.string().max(128).optional(),
        latencyMs: finiteNumber(z.number().int().nonnegative()).optional(),
      })
      .strict(),
  })
  .strict()

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      if (v == null) return null
      const t = trimCollapse(v)
      return t.length === 0 ? null : t.slice(0, max)
    })

const optionalEmail = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null) return null
    const t = v.trim().toLowerCase()
    if (!t) return null
    const parsed = z.string().email().safeParse(t)
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_EMAIL" })
      return z.NEVER
    }
    return parsed.data
  })

const optionalPhone = z
  .string()
  .nullish()
  .transform((v) => {
    if (v == null) return null
    const t = v.trim()
    if (!t) return null
    const cleaned = t.replace(/[^\d+]/g, "").slice(0, 32)
    return cleaned.length >= 6 ? cleaned : null
  })

/** Date ISO calendaire réelle (pas de rollover JS). */
export function isValidCalendarIsoDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  const d = Number(ymd.slice(8, 10))
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  )
}

const optionalIsoDate = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null) return null
    const t = v.trim()
    if (!t) return null
    if (!isValidCalendarIsoDate(t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DATE_AMBIGUOUS" })
      return z.NEVER
    }
    return t
  })

export const extractionCanonicalFieldsSchema = z.object({
  worksiteName: optionalTrimmed(100),
  clientName: optionalTrimmed(100),
  clientEmail: optionalEmail,
  clientPhone: optionalPhone,
  contactName: optionalTrimmed(100),
  contactEmail: optionalEmail,
  contactPhone: optionalPhone,
  address: optionalTrimmed(500),
  postalCode: optionalTrimmed(16),
  city: optionalTrimmed(100),
  requestedStartDate: optionalIsoDate,
  requestedEndDate: optionalIsoDate,
  consultationReference: z
    .string()
    .nullish()
    .transform((v) => {
      if (v == null) return null
      const t = trimCollapse(v).toUpperCase()
      return t.length === 0 ? null : t.slice(0, 64)
    }),
  description: optionalTrimmed(MAX_PROVIDER_STRING),
  attachmentClassifications: z
    .array(
      z
        .object({
          filename: z.string().min(1).max(255),
          category: z.string().min(1).max(64),
        })
        .strict()
    )
    .max(50)
    .optional()
    .default([]),
})

export const extractionConfidenceMapSchema = z.record(
  z.string().max(64),
  finiteNumber(z.number().min(0).max(1))
)

export const extractionWarningSchema = z
  .object({
    code: z.enum(EXTRACTION_WARNING_CODES),
    severity: z.enum(EXTRACTION_WARNING_SEVERITIES),
    blocking: z.boolean(),
    message: z.string().max(500),
    field: z.string().max(64).optional(),
    source: z.enum(EXTRACTION_WARNING_SOURCES),
  })
  .strict()

export const extractionWarningListSchema = z.array(extractionWarningSchema).max(MAX_PROVIDER_WARNINGS)

export const EXTRACTION_WARNING_CATALOG: Record<
  (typeof EXTRACTION_WARNING_CODES)[number],
  { severity: (typeof EXTRACTION_WARNING_SEVERITIES)[number]; blocking: boolean; message: string }
> = {
  CONTENT_INSUFFICIENT: {
    severity: "ERROR",
    blocking: true,
    message: "Contenu insuffisant pour proposition",
  },
  EMPTY_EXTRACTION: {
    severity: "ERROR",
    blocking: true,
    message: "Aucun signal métier exploitable",
  },
  DATE_RANGE_INVALID: {
    severity: "ERROR",
    blocking: true,
    message: "Date de fin antérieure au début",
  },
  DATE_AMBIGUOUS: {
    severity: "WARNING",
    blocking: false,
    message: "Dates ambiguës ou incomplètes",
  },
  MISSING_REQUIRED_FOR_CONVERSION: {
    severity: "WARNING",
    blocking: false,
    message: "Champs manquants pour conversion future",
  },
  LOW_CONFIDENCE: {
    severity: "WARNING",
    blocking: false,
    message: "Confiance faible sur un champ",
  },
  INVALID_EMAIL: {
    severity: "WARNING",
    blocking: false,
    message: "Email proposé invalide (omis)",
  },
  INVALID_PHONE: {
    severity: "INFO",
    blocking: false,
    message: "Téléphone proposé peu fiable",
  },
  CLIENT_IDENTITY_AMBIGUOUS: {
    severity: "WARNING",
    blocking: false,
    message: "Identité client incertaine",
  },
  PROVIDER_PARTIAL_RESULT: {
    severity: "WARNING",
    blocking: false,
    message: "Résultat partiel du fournisseur",
  },
  UNSUPPORTED_ATTACHMENT_TYPE: {
    severity: "INFO",
    blocking: false,
    message: "Type de PJ non exploité",
  },
  POTENTIAL_PROMPT_INJECTION: {
    severity: "WARNING",
    blocking: false,
    message: "Contenu potentiellement adversariel",
  },
  PROVIDER_TIMEOUT: {
    severity: "ERROR",
    blocking: true,
    message: "Délai d'extraction dépassé",
  },
  PROVIDER_UNAVAILABLE: {
    severity: "ERROR",
    blocking: true,
    message: "Fournisseur indisponible",
  },
  STALE_CONTENT: {
    severity: "ERROR",
    blocking: true,
    message: "Contenu modifié pendant l'extraction",
  },
  INPUT_TRUNCATED_FOR_PROVIDER: {
    severity: "WARNING",
    blocking: false,
    message: "Contenu tronqué avant envoi au fournisseur",
  },
}

/** Message public = catalogue uniquement (jamais message provider libre). */
export function catalogWarning(
  code: (typeof EXTRACTION_WARNING_CODES)[number],
  opts?: { field?: string; source?: (typeof EXTRACTION_WARNING_SOURCES)[number] }
): z.infer<typeof extractionWarningSchema> {
  const cat = EXTRACTION_WARNING_CATALOG[code]
  return {
    code,
    severity: cat.severity,
    blocking: cat.blocking,
    message: cat.message,
    field: opts?.field,
    source: opts?.source ?? "SERVICE",
  }
}
