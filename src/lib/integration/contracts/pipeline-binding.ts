/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2B
 * PipelineBinding V1 : une Source → au plus un Binding actif → pipeline « consultations » (SPEC LOT-2 §7).
 * `connectionId` optionnel = seul lieu du scope Connection (D13). Fan-out interdit.
 */
import { z } from "zod"
import { PLATFORM_SCHEMA_VERSION_V1, type PlatformSchemaVersion } from "@/lib/integration/types/schema-version"

export const PIPELINE_ID_CONSULTATIONS = "consultations" as const

export const pipelineBindingSchema = z
  .object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    sourceId: z.string().min(1),
    pipelineId: z.literal(PIPELINE_ID_CONSULTATIONS),
    connectionId: z.string().min(1).nullable(),
    enabled: z.boolean(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export type PipelineBinding = Omit<z.infer<typeof pipelineBindingSchema>, "schemaVersion"> & { schemaVersion: PlatformSchemaVersion }
