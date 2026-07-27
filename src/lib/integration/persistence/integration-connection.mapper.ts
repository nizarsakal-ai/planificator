/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B1 / STEP-2
 * Mapping Prisma ↔ contrats LOT-1A (IntegrationConnection / ConnectionHealth).
 *
 * Aucune logique métier, aucune résolution de secret, aucun I/O.
 * Dates publiques : ISO-8601 UTC avec suffixe `Z`.
 */

import type {
  IntegrationConnection as IntegrationConnectionRow,
  Prisma,
} from "@prisma/client"
import { z } from "zod"
import {
  connectionHealthSchema,
  type ConnectionHealth,
} from "@/lib/integration/contracts/connection-health"
import {
  integrationConnectionSchema,
  nonSecretConnectionConfigSchema,
  type IntegrationConnection,
  type JsonValue,
} from "@/lib/integration/contracts/integration-connection"
import type { CredentialsRef } from "@/lib/integration/contracts/credentials-ref"
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
import { IntegrationConnectionValidationError } from "@/lib/integration/persistence/integration-connection.errors"

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

const isoDateTimeSchema = z.string().datetime()

/** Input create — status / secretBackend obligatoires (pas de défaut Prisma). */
export const createIntegrationConnectionInputSchema = z
  .object({
    companyId: z.string().min(1),
    connectorType: z.string().min(1),
    displayName: z.string().min(1),
    status: connectionStatusSchema,
    secretBackend: secretBackendSchema,
    credentialStatus: credentialStatusSchema.optional(),
    runtimeHealth: runtimeHealthSchema.optional(),
    credentialsRef: z.string().min(1).optional(),
    config: nonSecretConnectionConfigSchema,
    watermark: z.string().min(1).optional(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
  })
  .strict()

export type CreateIntegrationConnectionInput = z.input<
  typeof createIntegrationConnectionInputSchema
>

export const updateHealthInputSchema = z
  .object({
    runtimeHealth: runtimeHealthSchema,
    lastSuccessfulRunAt: isoDateTimeSchema.optional(),
    lastFailedRunAt: isoDateTimeSchema.optional(),
    lastHealthCheckAt: isoDateTimeSchema.optional(),
    lastStableErrorCode: z.string().min(1).nullable().optional(),
  })
  .strict()

export type UpdateHealthInput = z.input<typeof updateHealthInputSchema>

function parseOrThrow<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "validation failed"
    throw new IntegrationConnectionValidationError(message)
  }
}

/** Date Prisma → ISO UTC `Z` (contrat LOT-1A). */
export function dateToIsoUtcZ(value: Date): string {
  return value.toISOString()
}

export function optionalDateToIsoUtcZ(
  value: Date | null | undefined
): string | undefined {
  if (value == null) return undefined
  return dateToIsoUtcZ(value)
}

/** ISO UTC `Z` validé → Date pour écriture Prisma. */
export function isoUtcZToDate(value: string): Date {
  const iso = parseOrThrow(() => isoDateTimeSchema.parse(value))
  return new Date(iso)
}

function configFromPrismaJson(value: Prisma.JsonValue): Record<string, JsonValue> {
  return parseOrThrow(() => nonSecretConnectionConfigSchema.parse(value))
}

/**
 * Prisma row → contrat `IntegrationConnection` (Zod strict en lecture).
 */
export function mapRowToIntegrationConnection(
  row: IntegrationConnectionRow
): IntegrationConnection {
  const candidate = {
    id: row.id,
    companyId: row.companyId,
    connectorType: row.connectorType,
    displayName: row.displayName,
    status: row.status,
    credentialStatus: row.credentialStatus,
    runtimeHealth: row.runtimeHealth,
    secretBackend: row.secretBackend,
    credentialsRef: row.credentialsRef ?? undefined,
    config: configFromPrismaJson(row.config),
    watermark: row.watermark ?? undefined,
    lastSuccessfulRunAt: optionalDateToIsoUtcZ(row.lastSuccessfulRunAt),
    lastFailedRunAt: optionalDateToIsoUtcZ(row.lastFailedRunAt),
    lastHealthCheckAt: optionalDateToIsoUtcZ(row.lastHealthCheckAt),
    createdAt: dateToIsoUtcZ(row.createdAt),
    updatedAt: dateToIsoUtcZ(row.updatedAt),
    schemaVersion: row.schemaVersion,
  }

  return parseOrThrow(() => integrationConnectionSchema.parse(candidate))
}

/**
 * Prisma row → vue `ConnectionHealth` (Zod strict en lecture).
 */
export function mapRowToConnectionHealth(
  row: IntegrationConnectionRow
): ConnectionHealth {
  const candidate = {
    connectionId: row.id,
    companyId: row.companyId,
    runtimeHealth: row.runtimeHealth,
    lastSuccessfulRunAt: optionalDateToIsoUtcZ(row.lastSuccessfulRunAt),
    lastFailedRunAt: optionalDateToIsoUtcZ(row.lastFailedRunAt),
    lastHealthCheckAt: optionalDateToIsoUtcZ(row.lastHealthCheckAt),
    lastStableErrorCode: row.lastStableErrorCode ?? undefined,
  }

  return parseOrThrow(() => connectionHealthSchema.parse(candidate))
}

export type PrismaCreateIntegrationConnectionData = {
  companyId: string
  connectorType: string
  displayName: string
  status: ConnectionStatus
  secretBackend: SecretBackend
  credentialStatus?: CredentialStatus
  runtimeHealth?: RuntimeHealth
  credentialsRef?: string
  config: Prisma.InputJsonValue
  watermark?: string
  schemaVersion?: PlatformSchemaVersion
}

/**
 * Valide l’input create et produit le payload Prisma (sans id / timestamps).
 */
export function toPrismaCreateData(
  input: CreateIntegrationConnectionInput
): PrismaCreateIntegrationConnectionData {
  const data = parseOrThrow(() =>
    createIntegrationConnectionInputSchema.parse(input)
  )

  const credentialsRef: CredentialsRef | undefined =
    data.credentialsRef !== undefined
      ? parseOrThrow(() => credentialsRefSchema.parse(data.credentialsRef))
      : undefined

  return {
    companyId: data.companyId,
    connectorType: data.connectorType as ConnectorType,
    displayName: data.displayName,
    status: data.status,
    secretBackend: data.secretBackend,
    ...(data.credentialStatus !== undefined
      ? { credentialStatus: data.credentialStatus }
      : {}),
    ...(data.runtimeHealth !== undefined
      ? { runtimeHealth: data.runtimeHealth }
      : {}),
    ...(credentialsRef !== undefined ? { credentialsRef } : {}),
    config: data.config as Prisma.InputJsonValue,
    ...(data.watermark !== undefined ? { watermark: data.watermark } : {}),
    ...(data.schemaVersion !== undefined
      ? { schemaVersion: data.schemaVersion }
      : {}),
  }
}

export function parseConnectionStatus(value: unknown): ConnectionStatus {
  return parseOrThrow(() => connectionStatusSchema.parse(value))
}

export function parseCredentialStatus(value: unknown): CredentialStatus {
  return parseOrThrow(() => credentialStatusSchema.parse(value))
}

export function parseUpdateHealthInput(input: unknown): UpdateHealthInput {
  return parseOrThrow(() => updateHealthInputSchema.parse(input))
}

export function parseWatermark(
  value: string | null
): string | null {
  if (value === null) return null
  return parseOrThrow(() => z.string().min(1).parse(value))
}
