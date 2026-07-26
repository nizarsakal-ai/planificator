/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Vue santé Connection distincte (SPEC §21.3) — pas une copie de IntegrationConnection.
 *
 * Convention dates : ISO-8601 datetime strings.
 * Pas de message brut / stack ; code d’erreur stable optionnel uniquement.
 */

import { z } from "zod"
import {
  RUNTIME_HEALTH_STATUSES,
  type RuntimeHealth,
} from "@/lib/integration/types/runtime-health"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

const runtimeHealthSchema = z.enum([
  RUNTIME_HEALTH_STATUSES.UNKNOWN,
  RUNTIME_HEALTH_STATUSES.HEALTHY,
  RUNTIME_HEALTH_STATUSES.DEGRADED,
  RUNTIME_HEALTH_STATUSES.UNHEALTHY,
])

export const connectionHealthSchema = z
  .object({
    connectionId: opaqueIdSchema,
    companyId: opaqueIdSchema,
    runtimeHealth: runtimeHealthSchema,
    lastSuccessfulRunAt: isoDateTimeSchema.optional(),
    lastFailedRunAt: isoDateTimeSchema.optional(),
    lastHealthCheckAt: isoDateTimeSchema.optional(),
    /** Code d’erreur stable / machine-readable — jamais un message libre. */
    lastStableErrorCode: z.string().min(1).optional(),
  })
  .strict()

export type ConnectionHealth = Omit<
  z.infer<typeof connectionHealthSchema>,
  "runtimeHealth"
> & {
  runtimeHealth: RuntimeHealth
}

export type ConnectionHealthInput = z.input<typeof connectionHealthSchema>
