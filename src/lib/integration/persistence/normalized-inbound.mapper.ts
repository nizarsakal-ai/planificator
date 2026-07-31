/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Mapper NormalizedInbound — Zod message, taille UTF-8, artifactRefs, Input ↔ Row.
 */

import type {
  NormalizedInbound as NormalizedInboundRow,
  Prisma,
} from "@prisma/client"
import { z } from "zod"
import {
  normalizedInboundSchema,
  type NormalizedInbound,
} from "@/lib/integration/contracts/normalized-inbound"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"
import {
  IntegrationInboundPayloadTooLargeError,
  IntegrationInboundValidationError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import {
  dateToIsoUtcZ,
  isoUtcZToDate,
} from "@/lib/integration/persistence/inbound-envelope.mapper"

/** Limite SPEC §10 — octets UTF-8 du JSON stringifié. */
export const NORMALIZED_MESSAGE_MAX_BYTES = 262144

/** Borne locale persistence SPEC §11 — pas une révision LOT-1A. */
export const ARTIFACT_REFS_MAX = 100

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

export const createNormalizedInboundInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    envelopeId: opaqueIdSchema,
    family: z.literal(INBOUND_FAMILY.MESSAGE),
    occurredAt: isoDateTimeSchema,
    receivedAt: isoDateTimeSchema,
    normalizedHash: z.string().min(1),
    artifactRefs: z.array(opaqueIdSchema).default([]),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
    message: z.unknown(),
  })
  .strict()

export type CreateNormalizedInboundInput = z.input<
  typeof createNormalizedInboundInputSchema
>

function parseOrThrow<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (
      error instanceof IntegrationInboundValidationError ||
      error instanceof IntegrationInboundPayloadTooLargeError
    ) {
      throw error
    }
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "validation failed"
    throw new IntegrationInboundValidationError(message)
  }
}

export function validateArtifactRefs(refs: string[]): string[] {
  if (refs.length > ARTIFACT_REFS_MAX) {
    throw new IntegrationInboundValidationError(
      `artifactRefs dépasse ${ARTIFACT_REFS_MAX}`
    )
  }
  const seen = new Set<string>()
  for (const ref of refs) {
    if (!ref || ref.trim().length === 0) {
      throw new IntegrationInboundValidationError("artifactRefs élément vide")
    }
    if (seen.has(ref)) {
      throw new IntegrationInboundValidationError("artifactRefs doublons interdits")
    }
    seen.add(ref)
  }
  return refs
}

export function serializeNormalizedMessage(message: unknown): {
  parsed: z.infer<typeof normalizedMessageSchema>
  json: Prisma.InputJsonValue
  byteLength: number
} {
  const parsed = parseOrThrow(() => normalizedMessageSchema.parse(message))
  let serialized: string
  try {
    serialized = JSON.stringify(parsed)
  } catch {
    throw new IntegrationInboundValidationError(
      "sérialisation JSON message impossible"
    )
  }
  const byteLength = Buffer.byteLength(serialized, "utf8")
  if (byteLength > NORMALIZED_MESSAGE_MAX_BYTES) {
    throw new IntegrationInboundPayloadTooLargeError(
      `message dépasse ${NORMALIZED_MESSAGE_MAX_BYTES} octets UTF-8`
    )
  }
  return {
    parsed,
    json: parsed as unknown as Prisma.InputJsonValue,
    byteLength,
  }
}

export type PrismaCreateNormalizedInboundData = {
  companyId: string
  connectionId: string
  envelopeId: string
  family: "MESSAGE"
  occurredAt: Date
  receivedAt: Date
  normalizedHash: string
  artifactRefs: string[]
  schemaVersion: PlatformSchemaVersion
  message: Prisma.InputJsonValue
}

export function toPrismaCreateNormalizedData(
  input: unknown
): PrismaCreateNormalizedInboundData {
  const data = parseOrThrow(() =>
    createNormalizedInboundInputSchema.parse(input)
  )
  const artifactRefs = validateArtifactRefs(data.artifactRefs)
  const { json } = serializeNormalizedMessage(data.message)

  return {
    companyId: data.companyId,
    connectionId: data.connectionId,
    envelopeId: data.envelopeId,
    family: INBOUND_FAMILY.MESSAGE,
    occurredAt: isoUtcZToDate(data.occurredAt),
    receivedAt: isoUtcZToDate(data.receivedAt),
    normalizedHash: data.normalizedHash,
    artifactRefs,
    schemaVersion: data.schemaVersion ?? PLATFORM_SCHEMA_VERSION_V1,
    message: json,
  }
}

export function mapRowToNormalizedInbound(
  row: NormalizedInboundRow
): NormalizedInbound {
  const candidate = {
    id: row.id,
    companyId: row.companyId,
    connectionId: row.connectionId,
    envelopeId: row.envelopeId,
    family: row.family,
    occurredAt: dateToIsoUtcZ(row.occurredAt),
    receivedAt: dateToIsoUtcZ(row.receivedAt),
    normalizedHash: row.normalizedHash,
    artifactRefs: row.artifactRefs,
    schemaVersion: row.schemaVersion,
    message: row.message,
  }
  return parseOrThrow(() => normalizedInboundSchema.parse(candidate))
}
