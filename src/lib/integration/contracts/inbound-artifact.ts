/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Façade logique InboundArtifact (SPEC §10, IMPL §16.2).
 *
 * Aucun binaire, aucune URL signée, aucun type fournisseur.
 * `storageRef` / `fetchRef` restent opaques.
 */

import { z } from "zod"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

const opaqueIdSchema = z.string().min(1)

const opaqueRefSchema = z.string().min(1)

export const ARTIFACT_AVAILABILITIES = {
  AVAILABLE: "AVAILABLE",
  PENDING_FETCH: "PENDING_FETCH",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
} as const

export type ArtifactAvailability =
  (typeof ARTIFACT_AVAILABILITIES)[keyof typeof ARTIFACT_AVAILABILITIES]

const artifactAvailabilitySchema = z.enum([
  ARTIFACT_AVAILABILITIES.AVAILABLE,
  ARTIFACT_AVAILABILITIES.PENDING_FETCH,
  ARTIFACT_AVAILABILITIES.FAILED,
  ARTIFACT_AVAILABILITIES.UNAVAILABLE,
])

const platformSchemaVersionSchema = z.literal(PLATFORM_SCHEMA_VERSION_V1)

/**
 * Contrat sérialisable InboundArtifact.
 * Convention dates : ISO-8601 strings (`z.string().datetime()`) — absentes ici.
 */
export const inboundArtifactSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    connectionId: opaqueIdSchema,
    envelopeId: opaqueIdSchema,
    externalArtifactId: opaqueIdSchema,
    filename: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().min(1).optional(),
    /** Référence de stockage opaque (si déjà matérialisé). */
    storageRef: opaqueRefSchema.optional(),
    /** Référence de fetch opaque (si récupération différée). */
    fetchRef: opaqueRefSchema.optional(),
    availability: artifactAvailabilitySchema.optional(),
    schemaVersion: platformSchemaVersionSchema,
  })
  .strict()

export type InboundArtifact = z.infer<typeof inboundArtifactSchema> & {
  schemaVersion: PlatformSchemaVersion
}

export type InboundArtifactInput = z.input<typeof inboundArtifactSchema>
