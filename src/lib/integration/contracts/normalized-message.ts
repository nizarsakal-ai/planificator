/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Variante MESSAGE normalisée (SPEC §9.4) — payload famille uniquement.
 *
 * `companyId` / `connectionId` / `envelopeId` / `normalizedHash` / `schemaVersion`
 * / `artifactRefs` / `occurredAt` / `receivedAt` vivent sur `NormalizedInbound` (racine).
 * Convention dates absente ici (horodatages sur la racine).
 */

import { z } from "zod"
import {
  MESSAGE_CONTENT_CAPABILITIES,
  type MessageContentCapability,
} from "@/lib/integration/types/message-content-capability"

const opaqueRefSchema = z.string().min(1)

const messageParticipantSchema = z
  .object({
    email: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
  })
  .strict()

/** Présent ⇒ au moins `email` ou `domain` (interdit `sender: {}`). */
const messageSenderSchema = messageParticipantSchema.refine(
  (value) => Boolean(value.email || value.domain),
  { message: "sender requires at least email or domain" }
)

const messageContentCapabilitySchema = z.enum([
  MESSAGE_CONTENT_CAPABILITIES.CONTENT_FETCHABLE,
  MESSAGE_CONTENT_CAPABILITIES.ATTACHMENTS_FETCHABLE,
  MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE,
])

export const normalizedMessageSchema = z
  .object({
    sender: messageSenderSchema.optional(),
    recipients: z.array(messageParticipantSchema).optional(),
    subject: z.string().min(1).optional(),
    /** Corps normalisé référencé — jamais de MIME brute / URL signée. */
    bodyRef: opaqueRefSchema.optional(),
    /** Identifiant message externe opaque (requis pour fetch différé). */
    externalMessageId: opaqueRefSchema,
    contentCapabilities: z.array(messageContentCapabilitySchema),
  })
  .strict()

export type NormalizedMessage = Omit<
  z.infer<typeof normalizedMessageSchema>,
  "contentCapabilities"
> & {
  contentCapabilities: MessageContentCapability[]
}

export type NormalizedMessageInput = z.input<typeof normalizedMessageSchema>
