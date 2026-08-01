/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * InboundSourceRule — règle IDENTITÉ ou QUALIFICATIVE.
 */

import { z } from "zod"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"
import {
  INBOUND_SOURCE_BOUNDS,
  INBOUND_SOURCE_RULE_TYPES,
  type InboundSourceRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

const ruleTypeSchema = z.enum([
  INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL,
  INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN,
  INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD,
  INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD,
  INBOUND_SOURCE_RULE_TYPES.RECIPIENT_EMAIL,
])

/** value stockée : attendue déjà trim+NFC ; borne Unicode après NFC. */
const ruleValueSchema = z
  .string()
  .min(1)
  .refine(
    (v) => {
      const nfc = v.normalize("NFC")
      return (
        nfc.trim().length > 0 &&
        Array.from(nfc).length <= INBOUND_SOURCE_BOUNDS.RULE_VALUE_MAX
      )
    },
    {
      message: `value invalide (vide ou > ${INBOUND_SOURCE_BOUNDS.RULE_VALUE_MAX} points de code NFC)`,
    }
  )

const normalizedValueSchema = z.string().min(1)

export const inboundSourceRuleSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    type: ruleTypeSchema,
    value: ruleValueSchema,
    normalizedValue: normalizedValueSchema,
    enabled: z.boolean(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()

export type InboundSourceRule = Omit<
  z.infer<typeof inboundSourceRuleSchema>,
  "type" | "schemaVersion"
> & {
  type: InboundSourceRuleType
  schemaVersion: PlatformSchemaVersion
}

export type InboundSourceRuleInput = z.input<typeof inboundSourceRuleSchema>
