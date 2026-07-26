/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Contrat InboundEnvelope (SPEC §8, IMPL §7.3).
 *
 * `payloadRef` opaque — aucune lecture de payload ici.
 * `connectorType` = traçabilité de bordure uniquement.
 * Convention dates : ISO-8601 datetime strings.
 */

import { z } from "zod"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import {
  ENVELOPE_LIFECYCLE_STATUSES,
  type EnvelopeLifecycle,
} from "@/lib/integration/types/envelope-lifecycle"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)
const opaqueRefSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

const connectorTypeSchema = z
  .string()
  .min(1)
  .transform((value): ConnectorType => value as ConnectorType)

const envelopeLifecycleSchema = z.enum([
  ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
  ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED,
  ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED,
  ENVELOPE_LIFECYCLE_STATUSES.ROUTED,
  ENVELOPE_LIFECYCLE_STATUSES.NO_MATCH,
  ENVELOPE_LIFECYCLE_STATUSES.AMBIGUOUS,
  ENVELOPE_LIFECYCLE_STATUSES.DISPATCHED,
  ENVELOPE_LIFECYCLE_STATUSES.DISCARDED,
  ENVELOPE_LIFECYCLE_STATUSES.ARCHIVED,
])

export const inboundEnvelopeSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    connectorType: connectorTypeSchema,
    externalId: opaqueIdSchema,
    idempotencyKey: opaqueIdSchema,
    receivedAt: isoDateTimeSchema,
    payloadRef: opaqueRefSchema,
    contentType: z.string().min(1),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    lifecycleStatus: envelopeLifecycleSchema,
    /** Empreinte optionnelle du payload brut (si calculée côté bordure). */
    rawPayloadHash: z.string().min(1).optional(),
  })
  .strict()

export type InboundEnvelope = Omit<
  z.infer<typeof inboundEnvelopeSchema>,
  "connectorType" | "lifecycleStatus" | "schemaVersion"
> & {
  connectorType: ConnectorType
  lifecycleStatus: EnvelopeLifecycle
  schemaVersion: PlatformSchemaVersion
}

export type InboundEnvelopeInput = z.input<typeof inboundEnvelopeSchema>
