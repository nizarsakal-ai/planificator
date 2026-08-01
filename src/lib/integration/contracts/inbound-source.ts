/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * InboundSource — source logique métier (données), pas ConnectorType.
 * Aucun connectionId / scope Connection.
 */

import { z } from "zod"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"
import { INBOUND_SOURCE_BOUNDS } from "@/lib/integration/types/inbound-source-rule-type"

const opaqueIdSchema = z.string().min(1)
const isoDateTimeSchema = z.string().datetime()

/** displayName stocké : déjà trim+NFC ; borne en points de code. */
const displayNameSchema = z
  .string()
  .min(1)
  .refine(
    (v) => {
      const nfc = v.normalize("NFC")
      return (
        nfc.trim().length > 0 &&
        Array.from(nfc).length <= INBOUND_SOURCE_BOUNDS.DISPLAY_NAME_MAX
      )
    },
    {
      message: `displayName invalide (vide ou > ${INBOUND_SOURCE_BOUNDS.DISPLAY_NAME_MAX} points de code NFC)`,
    }
  )

export const inboundSourceSchema = z
  .object({
    id: opaqueIdSchema,
    companyId: opaqueIdSchema,
    displayName: displayNameSchema,
    enabled: z.boolean(),
    schemaVersion: z.literal(PLATFORM_SCHEMA_VERSION_V1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()

export type InboundSource = Omit<
  z.infer<typeof inboundSourceSchema>,
  "schemaVersion"
> & {
  schemaVersion: PlatformSchemaVersion
}

export type InboundSourceInput = z.input<typeof inboundSourceSchema>
