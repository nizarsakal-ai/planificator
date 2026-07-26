/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-3
 * Décision Tenant Router (SPEC §16, IMPL idempotence niveau 4).
 *
 * Aucun Draft, aucune mutation métier, aucun connectorType / PII / provider.
 * Dates publiques Platform : UTC RFC3339 avec suffixe `Z`.
 */

import { z } from "zod"
import {
  ROUTING_OUTCOMES,
  type RoutingOutcome,
} from "@/lib/integration/types/routing-outcome"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

const routingOutcomeSchema = z.enum([
  ROUTING_OUTCOMES.MATCH,
  ROUTING_OUTCOMES.NO_MATCH,
  ROUTING_OUTCOMES.AMBIGUOUS_SOURCE,
  ROUTING_OUTCOMES.DUPLICATE,
  ROUTING_OUTCOMES.NO_ACTIVE_BINDING,
  ROUTING_OUTCOMES.ERROR,
])

export const routingDecisionSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    normalizedInboundId: opaqueIdSchema,
    outcome: routingOutcomeSchema,
    /** Sources candidates / matchées — IDs opaques uniquement. */
    matchedSourceIds: z.array(opaqueIdSchema),
    /** Pipelines concernés — IDs opaques (V1 typiquement `consultations` côté admission). */
    pipelineIds: z.array(opaqueIdSchema),
    /** Code machine-readable — jamais un message libre. */
    reasonCode: z.string().min(1).optional(),
    routingConfigurationVersion: z.string().min(1),
    decidedAt: isoDateTimeSchema,
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
  })
  .strict()

export type RoutingDecision = Omit<
  z.infer<typeof routingDecisionSchema>,
  "outcome" | "schemaVersion"
> & {
  outcome: RoutingOutcome
  schemaVersion: PlatformSchemaVersion
}

export type RoutingDecisionInput = z.input<typeof routingDecisionSchema>
