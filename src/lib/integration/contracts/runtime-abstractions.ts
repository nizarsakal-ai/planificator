/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-3
 * Abstractions runtime minimales (IMPL §20.3) — typage seulement.
 *
 * Pas d’auth, pagination, OAuth, secrets, HTTP, Gmail, webhook, upload,
 * cron, retries, logging, factories, registry ni I/O.
 */

import { z } from "zod"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import {
  INTEGRATION_CAPABILITIES,
  type IntegrationCapability,
} from "@/lib/integration/types/integration-capability"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)

const integrationCapabilitySchema = z.enum([
  INTEGRATION_CAPABILITIES.POLL,
  INTEGRATION_CAPABILITIES.UPLOAD,
  INTEGRATION_CAPABILITIES.CONTENT_FETCH,
  INTEGRATION_CAPABILITIES.ARTIFACT_FETCH,
  INTEGRATION_CAPABILITIES.DELTA_CURSOR,
  INTEGRATION_CAPABILITIES.REPLAY_FROM_ENVELOPE,
])

const connectorTypeSchema = z
  .string()
  .min(1)
  .transform((value): ConnectorType => value as ConnectorType)

export const RUNTIME_ERROR_KINDS = {
  RETRYABLE: "RETRYABLE",
  PERMANENT: "PERMANENT",
} as const

export type RuntimeErrorKind =
  (typeof RUNTIME_ERROR_KINDS)[keyof typeof RUNTIME_ERROR_KINDS]

export const integrationRuntimeErrorSchema = z
  .object({
    code: z.string().min(1),
    kind: z.enum([RUNTIME_ERROR_KINDS.RETRYABLE, RUNTIME_ERROR_KINDS.PERMANENT]),
  })
  .strict()

export type IntegrationRuntimeError = z.infer<typeof integrationRuntimeErrorSchema>

export const integrationCapabilitySetSchema = z.array(integrationCapabilitySchema)

export type IntegrationCapabilitySet = IntegrationCapability[]

/**
 * Contexte technique d’exécution d’un run Connector — sans secrets ni I/O.
 */
export const integrationRuntimeContextSchema = z
  .object({
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    connectorType: connectorTypeSchema,
    capabilities: integrationCapabilitySetSchema,
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
  })
  .strict()

export type IntegrationRuntimeContext = Omit<
  z.infer<typeof integrationRuntimeContextSchema>,
  "connectorType" | "capabilities" | "schemaVersion"
> & {
  connectorType: ConnectorType
  capabilities: readonly IntegrationCapability[]
  schemaVersion: PlatformSchemaVersion
}

export const integrationRuntimeRunResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("SUCCEEDED"),
      durationMs: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("FAILED"),
      durationMs: z.number().finite().nonnegative(),
      error: integrationRuntimeErrorSchema,
    })
    .strict(),
])

export type IntegrationRuntimeRunResult = z.infer<
  typeof integrationRuntimeRunResultSchema
>

/**
 * Port Connector Runtime — aucune implémentation dans LOT-1A.
 * Les lots futurs fournissent les adapters concrets.
 */
export interface IntegrationConnectorRuntimePort {
  readonly capabilities: readonly IntegrationCapability[]
  run(
    context: IntegrationRuntimeContext
  ): Promise<IntegrationRuntimeRunResult>
}
