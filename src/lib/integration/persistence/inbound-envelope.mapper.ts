/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Mapper InboundEnvelope — validation / normalisation / Input ↔ Row ↔ contrat.
 * Aucun I/O Prisma.
 */

import type { InboundEnvelope as InboundEnvelopeRow } from "@prisma/client"
import { z } from "zod"
import {
  inboundEnvelopeSchema,
  type InboundEnvelope,
} from "@/lib/integration/contracts/inbound-envelope"
import {
  ENVELOPE_LIFECYCLE_STATUSES,
  type EnvelopeLifecycle,
} from "@/lib/integration/types/envelope-lifecycle"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"
import { IntegrationInboundValidationError } from "@/lib/integration/persistence/integration-inbound.errors"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

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

/** Input create — `connectorType` optionnel (snapshot Connection fait autorité). */
export const createInboundEnvelopeInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    /** Si fourni, doit égaler le snapshot Connection — sinon VALIDATION. */
    connectorType: z.string().min(1).optional(),
    externalId: opaqueIdSchema,
    idempotencyKey: opaqueIdSchema,
    receivedAt: isoDateTimeSchema,
    payloadRef: opaqueIdSchema,
    contentType: z.string().min(1),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
    rawPayloadHash: z.string().min(1).optional(),
  })
  .strict()

export type CreateInboundEnvelopeInput = z.input<
  typeof createInboundEnvelopeInputSchema
>

export type ParsedCreateInboundEnvelopeInput = z.infer<
  typeof createInboundEnvelopeInputSchema
>

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
    throw new IntegrationInboundValidationError(message)
  }
}

export function dateToIsoUtcZ(value: Date): string {
  return value.toISOString()
}

export function isoUtcZToDate(value: string): Date {
  const iso = parseOrThrow(() => isoDateTimeSchema.parse(value))
  return new Date(iso)
}

export function parseCreateInboundEnvelopeInput(
  input: unknown
): ParsedCreateInboundEnvelopeInput {
  return parseOrThrow(() => createInboundEnvelopeInputSchema.parse(input))
}

export function parseEnvelopeLifecycle(value: unknown): EnvelopeLifecycle {
  return parseOrThrow(() => envelopeLifecycleSchema.parse(value))
}

export type PrismaCreateInboundEnvelopeData = {
  companyId: string
  connectionId: string
  connectorType: string
  externalId: string
  idempotencyKey: string
  receivedAt: Date
  payloadRef: string
  contentType: string
  schemaVersion: PlatformSchemaVersion
  rawPayloadHash?: string | null
  lifecycleStatus: "RECEIVED"
}

/**
 * Applique le snapshot `connectorType` Connection et produit le payload Prisma.
 */
export function toPrismaCreateEnvelopeData(
  parsed: ParsedCreateInboundEnvelopeInput,
  connectionConnectorType: string
): PrismaCreateInboundEnvelopeData {
  if (!connectionConnectorType) {
    throw new IntegrationInboundValidationError("connectorType Connection manquant")
  }
  if (
    parsed.connectorType !== undefined &&
    parsed.connectorType !== connectionConnectorType
  ) {
    throw new IntegrationInboundValidationError(
      "connectorType incompatible avec IntegrationConnection"
    )
  }

  return {
    companyId: parsed.companyId,
    connectionId: parsed.connectionId,
    connectorType: connectionConnectorType as ConnectorType,
    externalId: parsed.externalId,
    idempotencyKey: parsed.idempotencyKey,
    receivedAt: isoUtcZToDate(parsed.receivedAt),
    payloadRef: parsed.payloadRef,
    contentType: parsed.contentType,
    schemaVersion: parsed.schemaVersion ?? PLATFORM_SCHEMA_VERSION_V1,
    ...(parsed.rawPayloadHash !== undefined
      ? { rawPayloadHash: parsed.rawPayloadHash }
      : { rawPayloadHash: null }),
    lifecycleStatus: "RECEIVED",
  }
}

export function mapRowToInboundEnvelope(
  row: InboundEnvelopeRow
): InboundEnvelope {
  const candidate = {
    id: row.id,
    companyId: row.companyId,
    connectionId: row.connectionId,
    connectorType: row.connectorType,
    externalId: row.externalId,
    idempotencyKey: row.idempotencyKey,
    receivedAt: dateToIsoUtcZ(row.receivedAt),
    payloadRef: row.payloadRef,
    contentType: row.contentType,
    schemaVersion: row.schemaVersion,
    lifecycleStatus: row.lifecycleStatus,
    ...(row.rawPayloadHash != null
      ? { rawPayloadHash: row.rawPayloadHash }
      : {}),
  }
  return parseOrThrow(() => inboundEnvelopeSchema.parse(candidate))
}

/** Comparaison immutables SPEC §6.3 — `receivedAt` / lifecycle / id exclus. */
export function areEnvelopeImmutablesCompatible(
  existing: InboundEnvelopeRow,
  candidate: PrismaCreateInboundEnvelopeData
): boolean {
  const hashEqual =
    (existing.rawPayloadHash ?? null) === (candidate.rawPayloadHash ?? null)
  return (
    existing.companyId === candidate.companyId &&
    existing.connectionId === candidate.connectionId &&
    existing.connectorType === candidate.connectorType &&
    existing.externalId === candidate.externalId &&
    existing.payloadRef === candidate.payloadRef &&
    existing.contentType === candidate.contentType &&
    existing.schemaVersion === candidate.schemaVersion &&
    hashEqual
  )
}

export function parseExpectedLifecycleStatuses(
  statuses: unknown
): EnvelopeLifecycle[] {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new IntegrationInboundValidationError("expectedStatuses non vide requis")
  }
  return statuses.map((s) => parseEnvelopeLifecycle(s))
}
