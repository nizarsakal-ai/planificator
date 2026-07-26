/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Contrat Platform IntegrationConnection (SPEC §21, SECURITY-SPEC §15).
 *
 * Trois machines d’état distinctes : status / credentialStatus / runtimeHealth.
 * Aucune autorisation de run calculée ici.
 *
 * Convention dates publiques Platform : UTC RFC3339 avec suffixe `Z`
 * (`z.string().datetime()` — offsets non activés).
 */

import { z } from "zod"
import { credentialsRefSchema } from "@/lib/integration/contracts/credentials-ref"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import {
  CONNECTION_STATUSES,
  type ConnectionStatus,
} from "@/lib/integration/types/connection-status"
import {
  CREDENTIAL_STATUSES,
  type CredentialStatus,
} from "@/lib/integration/types/credential-status"
import {
  RUNTIME_HEALTH_STATUSES,
  type RuntimeHealth,
} from "@/lib/integration/types/runtime-health"
import {
  SECRET_BACKENDS,
  type SecretBackend,
} from "@/lib/integration/types/secret-backend"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)

const connectorTypeSchema = z
  .string()
  .min(1)
  .transform((value): ConnectorType => value as ConnectorType)

const isoDateTimeSchema = z.string().datetime()

const connectionStatusSchema = z.enum([
  CONNECTION_STATUSES.PENDING_AUTH,
  CONNECTION_STATUSES.ACTIVE,
  CONNECTION_STATUSES.DISABLED,
  CONNECTION_STATUSES.ERROR,
  CONNECTION_STATUSES.ARCHIVED,
])

const credentialStatusSchema = z.enum([
  CREDENTIAL_STATUSES.MISSING,
  CREDENTIAL_STATUSES.PENDING,
  CREDENTIAL_STATUSES.ACTIVE,
  CREDENTIAL_STATUSES.EXPIRED,
  CREDENTIAL_STATUSES.REVOKED,
  CREDENTIAL_STATUSES.RETIRED,
  CREDENTIAL_STATUSES.FAILED,
])

const runtimeHealthSchema = z.enum([
  RUNTIME_HEALTH_STATUSES.UNKNOWN,
  RUNTIME_HEALTH_STATUSES.HEALTHY,
  RUNTIME_HEALTH_STATUSES.DEGRADED,
  RUNTIME_HEALTH_STATUSES.UNHEALTHY,
])

const secretBackendSchema = z.enum([
  SECRET_BACKENDS.LEGACY_GMAIL,
  SECRET_BACKENDS.PLATFORM_ENCRYPTED,
])

/** JSON sérialisable borné — pas de `unknown` libre. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ])
)

/**
 * Paramètres publics non secrets uniquement (SPEC §21.4).
 * Le typage JSON n’empêche pas à lui seul qu’un secret soit placé dans `config` :
 * l’interdiction reste une règle d’autorité / service (future).
 */
export const nonSecretConnectionConfigSchema = z.record(jsonValueSchema)

export const integrationConnectionSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    connectorType: connectorTypeSchema,
    displayName: z.string().min(1),
    status: connectionStatusSchema,
    credentialStatus: credentialStatusSchema,
    runtimeHealth: runtimeHealthSchema,
    secretBackend: secretBackendSchema,
    credentialsRef: credentialsRefSchema.optional(),
    config: nonSecretConnectionConfigSchema,
    /** Curseur / watermark opaque — interprétation réservée au runtime. */
    watermark: z.string().min(1).optional(),
    lastSuccessfulRunAt: isoDateTimeSchema.optional(),
    lastFailedRunAt: isoDateTimeSchema.optional(),
    lastHealthCheckAt: isoDateTimeSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
  })
  .strict()

export type IntegrationConnection = Omit<
  z.infer<typeof integrationConnectionSchema>,
  | "connectorType"
  | "status"
  | "credentialStatus"
  | "runtimeHealth"
  | "secretBackend"
  | "schemaVersion"
> & {
  connectorType: ConnectorType
  status: ConnectionStatus
  credentialStatus: CredentialStatus
  runtimeHealth: RuntimeHealth
  secretBackend: SecretBackend
  schemaVersion: PlatformSchemaVersion
}

export type IntegrationConnectionInput = z.input<typeof integrationConnectionSchema>
