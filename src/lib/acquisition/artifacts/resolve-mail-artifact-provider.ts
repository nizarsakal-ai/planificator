import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { gmailAdmissionKey } from "@/lib/acquisition/artifacts/gmail-admission-key"
import { legacyMailArtifactSources } from "@/lib/acquisition/artifacts/legacy-mail-artifact-sources"
import { resolveAcquisitionMailboxForMessage } from "@/lib/acquisition/connector/resolve-acquisition-mailbox"
import { inboundArtifactSchema, type InboundArtifact } from "@/lib/integration/contracts/inbound-artifact"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { createConnectorRegistry } from "@/lib/integration/registry/connector-registry"
import { hasCapability } from "@/lib/integration/registry/capabilities"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import { INTEGRATION_CAPABILITIES } from "@/lib/integration/types/integration-capability"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

type FetchCapability = "CONTENT_FETCH" | "ARTIFACT_FETCH"

const providers = {
  [MAIL_SHADOW_CONNECTOR_TYPE]: legacyMailArtifactSources,
}
const mailConnectorType = MAIL_SHADOW_CONNECTOR_TYPE as ConnectorType
const registry = createConnectorRegistry([{
  connectorType: mailConnectorType,
  family: "MESSAGE",
  capabilities: [INTEGRATION_CAPABILITIES.CONTENT_FETCH, INTEGRATION_CAPABILITIES.ARTIFACT_FETCH],
}])
const mailboxConfig = z.object({ gmailMailboxId: z.string().min(1) })

type ArtifactMetadata = Pick<InboundArtifact, "id" | "externalArtifactId" | "filename" | "mimeType" | "sizeBytes">

export async function resolveMailArtifactProvider(
  db: PrismaClient,
  message: { companyId: string; sourceMailboxKey: string; externalMessageId: string },
  capability: FetchCapability,
  metadata: ArtifactMetadata
) {
  const { companyId, sourceMailboxKey, externalMessageId } = message
  const mailbox = await resolveAcquisitionMailboxForMessage(message, db)
  if (!mailbox.ok) return mailbox

  // Les messages historiques à boîte implicite ne peuvent pas référencer une
  // admission LOT-3, qui exige une boîte Acquisition explicite.
  const envelopes = sourceMailboxKey ? await db.inboundEnvelope.findMany({
    where: {
      companyId,
      externalId: externalMessageId,
      idempotencyKey: gmailAdmissionKey(externalMessageId),
      connection: { config: { path: ["gmailMailboxId"], equals: mailbox.connectionId } },
    },
    select: {
      id: true, connectionId: true, connectorType: true, lifecycleStatus: true,
      connection: { select: { connectorType: true, status: true, secretBackend: true, config: true } },
      normalizedInbounds: {
        where: { family: "MESSAGE", schemaVersion: PLATFORM_SCHEMA_VERSION_V1 },
        select: { message: true },
      },
    },
    take: 2,
  }) : []
  if (!envelopes.length) {
    return { ok: true as const, connectionId: mailbox.connectionId, provider: legacyMailArtifactSources, artifact: undefined }
  }
  const unavailable = { ok: false as const, code: "ARTIFACT_CAPABILITY_UNAVAILABLE" as const }
  const [envelope] = envelopes
  const connection = envelope.connection
  const binding = mailboxConfig.safeParse(connection.config)
  if (
    envelopes.length !== 1 ||
    !binding.success || binding.data.gmailMailboxId !== mailbox.connectionId ||
    connection.status !== "ACTIVE" || connection.secretBackend !== "LEGACY_GMAIL" ||
    envelope.lifecycleStatus !== "NORMALIZED" || envelope.connectorType !== connection.connectorType ||
    connection.connectorType !== MAIL_SHADOW_CONNECTOR_TYPE
  ) return unavailable

  const connector = registry.get(mailConnectorType)
  if (!connector || !hasCapability(connector.capabilities, capability)) return unavailable

  const mailboxIsActive = await db.acquisitionGmailConnection.findFirst({
    where: { id: mailbox.connectionId, companyId, active: true },
    select: { id: true },
  })
  if (!mailboxIsActive) return { ok: false as const, code: "GMAIL_NOT_CONNECTED" as const }

  const normalized = normalizedMessageSchema.safeParse(envelope.normalizedInbounds[0]?.message)
  const messageCapability = capability === "CONTENT_FETCH"
    ? MESSAGE_CONTENT_CAPABILITIES.CONTENT_FETCHABLE
    : MESSAGE_CONTENT_CAPABILITIES.ATTACHMENTS_FETCHABLE
  if (!normalized.success || normalized.data.externalMessageId !== externalMessageId ||
    !normalized.data.contentCapabilities.includes(messageCapability)) return unavailable

  const artifact = inboundArtifactSchema.safeParse({
    ...metadata, companyId, connectionId: envelope.connectionId, envelopeId: envelope.id,
    fetchRef: metadata.id, availability: "PENDING_FETCH", schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  })
  if (!artifact.success) return unavailable
  return {
    ok: true as const, connectionId: mailbox.connectionId,
    provider: providers[connection.connectorType], artifact: artifact.data,
  }
}
