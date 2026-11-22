/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Mapper InboundSource — Zod strict, aucune logique Router.
 * displayName : trim → NFC → non vide → borne Unicode (normalizeAdminText).
 */

import type { InboundSource as InboundSourceRow } from "@prisma/client"
import { z } from "zod"
import {
  inboundSourceSchema,
  type InboundSource,
} from "@/lib/integration/contracts/inbound-source"
import { INBOUND_SOURCE_BOUNDS } from "@/lib/integration/types/inbound-source-rule-type"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { InboundSourceValidationError } from "@/lib/integration/persistence/inbound-source.errors"
import {
  AdminTextNormalizationError,
  normalizeAdminText,
} from "@/lib/integration/util/normalize-admin-text"

const opaqueIdSchema = z.string().min(1)

function normalizeDisplayName(raw: string): string {
  try {
    return normalizeAdminText(
      raw,
      INBOUND_SOURCE_BOUNDS.DISPLAY_NAME_MAX,
      "displayName"
    )
  } catch (error) {
    if (error instanceof AdminTextNormalizationError) {
      throw new InboundSourceValidationError(error.message)
    }
    throw error
  }
}

export const createInboundSourceInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    displayName: z.string(),
    /** Défaut false — fail-safe. */
    enabled: z.literal(false).optional(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1).optional(),
  })
  .strict()

export type CreateInboundSourceInput = z.input<
  typeof createInboundSourceInputSchema
>

export const updateInboundSourceInputSchema = z
  .object({
    companyId: opaqueIdSchema,
    id: opaqueIdSchema,
    displayName: z.string().optional(),
  })
  .strict()

export type UpdateInboundSourceInput = z.input<
  typeof updateInboundSourceInputSchema
>

function parseOrThrow<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof InboundSourceValidationError) throw error
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join("; ")
        : error instanceof Error
          ? error.message
          : "validation failed"
    throw new InboundSourceValidationError(message)
  }
}

export function parseCreateInboundSourceInput(
  input: CreateInboundSourceInput
): {
  companyId: string
  displayName: string
  enabled: false
  schemaVersion: typeof PLATFORM_SCHEMA_VERSION_V1
} {
  const parsed = parseOrThrow(() => createInboundSourceInputSchema.parse(input))
  return {
    companyId: parsed.companyId,
    displayName: normalizeDisplayName(parsed.displayName),
    enabled: false,
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  }
}

export function parseUpdateInboundSourceInput(
  input: UpdateInboundSourceInput
): {
  companyId: string
  id: string
  displayName?: string
} {
  const parsed = parseOrThrow(() => updateInboundSourceInputSchema.parse(input))
  return {
    companyId: parsed.companyId,
    id: parsed.id,
    ...(parsed.displayName !== undefined
      ? { displayName: normalizeDisplayName(parsed.displayName) }
      : {}),
  }
}

function dateToIsoUtcZ(d: Date): string {
  return d.toISOString()
}

export function mapRowToInboundSource(row: InboundSourceRow): InboundSource {
  return parseOrThrow(() =>
    inboundSourceSchema.parse({
      id: row.id,
      companyId: row.companyId,
      displayName: row.displayName,
      enabled: row.enabled,
      schemaVersion: row.schemaVersion,
      createdAt: dateToIsoUtcZ(row.createdAt),
      updatedAt: dateToIsoUtcZ(row.updatedAt),
    })
  )
}

export function toPrismaCreateSourceData(
  input: CreateInboundSourceInput
): {
  companyId: string
  displayName: string
  enabled: false
  schemaVersion: string
} {
  return parseCreateInboundSourceInput(input)
}
