/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * NormalizedInbound racine discriminée — V1 MESSAGE-only (SPEC §9.2–9.3).
 *
 * Aucune variante DOCUMENT / EVENT exportée.
 * Extension future = nouveaux littéraux `family` dans une révision de schéma,
 * pas une union anticipée ici.
 *
 * Convention dates : ISO-8601 datetime strings.
 */

import { z } from "zod"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

export const normalizedInboundSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    envelopeId: opaqueIdSchema,
    family: z.literal(INBOUND_FAMILY.MESSAGE),
    occurredAt: isoDateTimeSchema,
    receivedAt: isoDateTimeSchema,
    normalizedHash: z.string().min(1),
    artifactRefs: z.array(opaqueIdSchema),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    message: normalizedMessageSchema,
  })
  .strict()

export type NormalizedInbound = Omit<
  z.infer<typeof normalizedInboundSchema>,
  "schemaVersion"
> & {
  schemaVersion: PlatformSchemaVersion
}

export type NormalizedInboundInput = z.input<typeof normalizedInboundSchema>
