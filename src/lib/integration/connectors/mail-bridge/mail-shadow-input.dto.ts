/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * DTO neutre MailShadow — Zod strict ; connectionId obligatoire.
 */

import { z } from "zod"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

export const mailShadowInputDtoSchema = z
  .object({
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    externalId: opaqueIdSchema,
    idempotencyKey: opaqueIdSchema,
    receivedAt: isoDateTimeSchema,
    occurredAt: isoDateTimeSchema,
    payloadRef: opaqueIdSchema,
    contentType: z.string().min(1),
    /** Si fourni, doit matcher le snapshot Connection. */
    connectorTypeHint: z.string().min(1).optional(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
    rawPayloadHash: z.string().min(1).optional(),
    message: normalizedMessageSchema,
  })
  .strict()

export type MailShadowInputDto = z.infer<typeof mailShadowInputDtoSchema>
export type MailShadowInputDtoInput = z.input<typeof mailShadowInputDtoSchema>

export function parseMailShadowInputDto(input: unknown): MailShadowInputDto {
  return mailShadowInputDtoSchema.parse(input)
}
