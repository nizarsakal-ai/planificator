/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Mapper InboundSourceRule — Zod strict ; normalizedValue fourni par orchestration.
 * value brute : trim → NFC → non vide → borne via normalizeAdminText.
 */

import type { InboundSourceRule as InboundSourceRuleRow } from "@prisma/client"
import { z } from "zod"
import {
  inboundSourceRuleSchema,
  type InboundSourceRule,
} from "@/lib/integration/contracts/inbound-source-rule"
import {
  INBOUND_SOURCE_BOUNDS,
  INBOUND_SOURCE_RULE_TYPES,
} from "@/lib/integration/types/inbound-source-rule-type"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { InboundSourceValidationError } from "@/lib/integration/persistence/inbound-source.errors"
import {
  AdminTextNormalizationError,
  normalizeAdminText,
} from "@/lib/integration/util/normalize-admin-text"

const opaqueIdSchema = z.string().min(1)

const ruleTypeSchema = z.enum([
  INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL,
  INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN,
  INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD,
  INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD,
  INBOUND_SOURCE_RULE_TYPES.RECIPIENT_EMAIL,
])

function normalizeRuleValueBrut(raw: string): string {
  try {
    return normalizeAdminText(
      raw,
      INBOUND_SOURCE_BOUNDS.RULE_VALUE_MAX,
      "value"
    )
  } catch (error) {
    if (error instanceof AdminTextNormalizationError) {
      throw new InboundSourceValidationError(error.message)
    }
    throw error
  }
}

export const createInboundSourceRuleInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    type: ruleTypeSchema,
    value: z.string(),
    normalizedValue: z.string().min(1),
    enabled: z.boolean().optional(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
  })
  .strict()

export type CreateInboundSourceRuleInput = z.input<
  typeof createInboundSourceRuleInputSchema
>

/** value/normalizedValue only — enabled/type via InboundSourceIdentityTx. */
export const updateInboundSourceRuleInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    id: opaqueIdSchema,
    value: z.string().optional(),
    normalizedValue: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) => v.value !== undefined || v.normalizedValue !== undefined,
    { message: "aucune mise à jour" }
  )

export type UpdateInboundSourceRuleInput = z.input<
  typeof updateInboundSourceRuleInputSchema
>

function parseOrThrow<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof InboundSourceValidationError) throw error
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join("; ")
        : error instanceof Error
          ? error.message
          : "validation failed"
    throw new InboundSourceValidationError(message)
  }
}

export function parseCreateInboundSourceRuleInput(
  input: CreateInboundSourceRuleInput
): {
  companyId: string
  sourceId: string
  type: z.infer<typeof ruleTypeSchema>
  value: string
  normalizedValue: string
  enabled: boolean
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION_V1
} {
  const parsed = parseOrThrow(() =>
    createInboundSourceRuleInputSchema.parse(input)
  )
  return {
    companyId: parsed.companyId,
    sourceId: parsed.sourceId,
    type: parsed.type,
    value: normalizeRuleValueBrut(parsed.value),
    normalizedValue: parsed.normalizedValue,
    enabled: parsed.enabled ?? true,
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  }
}

export function parseUpdateInboundSourceRuleInput(
  input: UpdateInboundSourceRuleInput
): {
  companyId: string
  id: string
  value?: string
  normalizedValue?: string
} {
  const parsed = parseOrThrow(() =>
    updateInboundSourceRuleInputSchema.parse(input)
  )
  return {
    companyId: parsed.companyId,
    id: parsed.id,
    ...(parsed.value !== undefined
      ? { value: normalizeRuleValueBrut(parsed.value) }
      : {}),
    ...(parsed.normalizedValue !== undefined
      ? { normalizedValue: parsed.normalizedValue }
      : {}),
  }
}

function dateToIsoUtcZ(d: Date): string {
  return d.toISOString()
}

export function mapRowToInboundSourceRule(
  row: InboundSourceRuleRow
): InboundSourceRule {
  return parseOrThrow(() =>
    inboundSourceRuleSchema.parse({
      id: row.id,
      companyId: row.companyId,
      sourceId: row.sourceId,
      type: row.type,
      value: row.value,
      normalizedValue: row.normalizedValue,
      enabled: row.enabled,
      schemaVersion: row.schemaVersion,
      createdAt: dateToIsoUtcZ(row.createdAt),
      updatedAt: dateToIsoUtcZ(row.updatedAt),
    })
  )
}
