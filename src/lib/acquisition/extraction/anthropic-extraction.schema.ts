/**
 * PLAN-ACQ-005B-3 — Schéma tool / raw Anthropic → ExtractionProviderResult.
 */

import { z } from "zod"
import type { Tool } from "@anthropic-ai/sdk/resources/messages"
import {
  EXTRACTION_EVIDENCE_SOURCES,
  EXTRACTION_WARNING_CODES,
  MAX_EVIDENCE_QUOTE,
  MAX_PROVIDER_WARNINGS,
  extractionProviderResultSchema,
} from "@/lib/acquisition/extraction/extraction.schema"
import {
  ANTHROPIC_MAX_CONFIDENCE,
  EXTRACTION_TOOL_NAME,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { evidenceQuoteInHaystack } from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import type { ExtractionProviderResult } from "@/lib/acquisition/extraction/extraction-provider.port"

const finiteConf = z
  .number()
  .min(0)
  .max(1)
  .refine((n) => Number.isFinite(n), { message: "not_finite" })

const evidenceSchema = z
  .object({
    source: z.enum(EXTRACTION_EVIDENCE_SOURCES),
    quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE),
  })
  .strict()

const fieldSchema = z
  .object({
    value: z.unknown(),
    confidence: finiteConf,
    evidence: evidenceSchema.optional(),
  })
  .strict()

const optionalField = fieldSchema.optional()

/** Sortie tool fermée (clés canoniques uniquement). */
export const anthropicExtractionRawSchema = z
  .object({
    fields: z
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
      .strict(),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64),
            field: z.string().max(64).optional(),
          })
          .strict()
      )
      .max(MAX_PROVIDER_WARNINGS)
      .default([]),
  })
  .strict()

export type AnthropicExtractionRaw = z.infer<typeof anthropicExtractionRawSchema>

/** JSON Schema pour l'outil Messages API (SDK Tool.input_schema). */
export const EXTRACTION_TOOL_INPUT_JSON_SCHEMA: {
  type: "object"
  additionalProperties: false
  required: string[]
  properties: Record<string, unknown>
} = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "warnings"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        [
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
        ].map((k) => [
          k,
          {
            type: "object",
            additionalProperties: false,
            required: ["value", "confidence"],
            properties: {
              value: {},
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence: {
                type: "object",
                additionalProperties: false,
                required: ["source", "quote"],
                properties: {
                  source: { type: "string", enum: [...EXTRACTION_EVIDENCE_SOURCES] },
                  quote: { type: "string", maxLength: MAX_EVIDENCE_QUOTE },
                },
              },
            },
          },
        ])
      ),
    },
    warnings: {
      type: "array",
      maxItems: MAX_PROVIDER_WARNINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: { type: "string", maxLength: 64 },
          field: { type: "string", maxLength: 64 },
        },
      },
    },
  },
}

export const EXTRACTION_TOOL_DEFINITION: Tool = {
  name: EXTRACTION_TOOL_NAME,
  description:
    "Extract structured worksite consultation fields from the provided email JSON only.",
  input_schema: EXTRACTION_TOOL_INPUT_JSON_SCHEMA,
}

const STRONG_FIELDS = new Set([
  "worksiteName",
  "clientName",
  "address",
  "consultationReference",
  "requestedStartDate",
  "requestedEndDate",
  "clientEmail",
  "contactEmail",
])

const ALLOWED_WARNING = new Set<string>(EXTRACTION_WARNING_CODES)

/**
 * Map raw tool input → ExtractionProviderResult.
 * Quote doit apparaître dans `haystack` (texte réellement envoyé).
 * Confidence plafonnée. Champs forts sans evidence crédible → omis.
 */
export function mapAnthropicRawToProviderResult(input: {
  raw: unknown
  haystack: string
  model: string
  latencyMs: number
  extraWarningCodes?: string[]
}): ExtractionProviderResult {
  const parsed = anthropicExtractionRawSchema.safeParse(input.raw)
  if (!parsed.success) {
    throw new Error("PROVIDER_INVALID_OUTPUT")
  }

  const fields: ExtractionProviderResult["fields"] = {}
  for (const [key, field] of Object.entries(parsed.data.fields)) {
    if (!field) continue
    let confidence = Math.min(Number(field.confidence), ANTHROPIC_MAX_CONFIDENCE)
    confidence = Math.round(confidence * 100) / 100

    const evidence = field.evidence as
      | { source: (typeof EXTRACTION_EVIDENCE_SOURCES)[number]; quote: string }
      | undefined
    if (STRONG_FIELDS.has(key)) {
      if (!evidence?.quote || !evidenceQuoteInHaystack(input.haystack, evidence.quote)) {
        continue
      }
    } else if (evidence?.quote && !evidenceQuoteInHaystack(input.haystack, evidence.quote)) {
      fields[key] = { value: field.value, confidence: Math.min(confidence, 0.35) }
      continue
    }

    fields[key] = {
      value: field.value,
      confidence,
      evidence: evidence
        ? { source: evidence.source, quote: evidence.quote.slice(0, MAX_EVIDENCE_QUOTE) }
        : undefined,
    }
  }

  const warnings: ExtractionProviderResult["warnings"] = []
  for (const w of parsed.data.warnings) {
    if (ALLOWED_WARNING.has(w.code)) {
      warnings.push({ code: w.code, field: w.field })
    } else {
      warnings.push({ code: "PROVIDER_PARTIAL_RESULT" })
    }
  }
  for (const code of input.extraWarningCodes ?? []) {
    warnings.push({ code })
  }

  const result = {
    fields,
    warnings,
    providerMetadata: {
      providerId: "anthropic",
      model: input.model.slice(0, 128),
      latencyMs: input.latencyMs,
    },
  }

  const revalidated = extractionProviderResultSchema.safeParse(result)
  if (!revalidated.success) {
    throw new Error("PROVIDER_INVALID_OUTPUT")
  }

  return {
    fields: revalidated.data.fields as ExtractionProviderResult["fields"],
    warnings: revalidated.data.warnings,
    providerMetadata: revalidated.data.providerMetadata,
  }
}
