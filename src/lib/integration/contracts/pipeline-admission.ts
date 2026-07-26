/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-3
 * Contrat PipelineAdmission (IMPL-PLAN §9).
 *
 * Lien traçable NormalizedInbound + RoutingDecision → pipeline consultations.
 * Pas de connectorType, pas de Draft, pas de payload brut Envelope.
 * Payload MESSAGE : réutilise `normalizedMessageSchema` (pas de copie divergente).
 * Dates publiques Platform : UTC RFC3339 avec suffixe `Z`.
 */

import { z } from "zod"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

/** Pipeline Domain V1 figé (IMPL §9 / §21 — un seul pipeline). */
export const PIPELINE_ID_CONSULTATIONS = "consultations" as const

export type PipelineIdV1 = typeof PIPELINE_ID_CONSULTATIONS

export const pipelineAdmissionSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    /** Référence au NormalizedInbound — pas d’embed racine complet. */
    normalizedInboundId: opaqueIdSchema,
    routingDecisionId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    pipelineId: z.literal(PIPELINE_ID_CONSULTATIONS),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    artifactRefs: z.array(opaqueIdSchema),
    /** Fournie par l’orchestrateur — non recalculée ici. */
    pipelineIdempotencyKey: opaqueIdSchema,
    occurredAt: isoDateTimeSchema,
    admittedAt: isoDateTimeSchema,
    /** Projection MESSAGE sûre pour le pipeline (sans types fournisseur). */
    message: normalizedMessageSchema,
  })
  .strict()

export type PipelineAdmission = Omit<
  z.infer<typeof pipelineAdmissionSchema>,
  "pipelineId" | "schemaVersion"
> & {
  pipelineId: PipelineIdV1
  schemaVersion: PlatformSchemaVersion
}

export type PipelineAdmissionInput = z.input<typeof pipelineAdmissionSchema>
