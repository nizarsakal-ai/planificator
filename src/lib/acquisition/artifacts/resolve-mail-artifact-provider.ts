/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-4 / LOT-4B
 * Résolution du fournisseur de contenu et de pièces jointes pour les workers Acquisition.
 *
 * - Commun aux deux chemins (ticket « défauts historiques ») : la clé de boîte explicite doit appartenir à la société
 *   du message (MAILBOX_NOT_OWNED, non repris) ; une panne de lecture pendant la résolution rend
 *   ARTIFACT_RESOLUTION_FAILED (repris) au lieu d'une exception.
 * - Flag coupé (défaut) : résolution historique puis adaptateurs Gmail ; une lecture réussie reste silencieuse.
 * - Flag posé (foundation ∧ INTEGRATION_ARTIFACT_RESOLUTION_ENABLED ∧ allowlist) : un message admis par le LOT-3 est
 *   relié à sa connexion d'intégration ; connexion, enveloppe, capacités du connecteur et du message, boîte active sont
 *   vérifiées AVANT toute lecture distante. Une panne de lecture devient ARTIFACT_RESOLUTION_FAILED (reprise).
 * - Journal `acquisition.artifact_resolution` : chemin, issue et motif seulement ; jamais d'identifiant externe,
 *   d'adresse, d'objet ni de nom de fichier.
 */
import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { gmailAdmissionKey } from "@/lib/acquisition/artifacts/gmail-admission-key"
import { legacyMailArtifactSources } from "@/lib/acquisition/artifacts/legacy-mail-artifact-sources"
import { resolveAcquisitionMailboxForMessage } from "@/lib/acquisition/connector/resolve-acquisition-mailbox"
import { inboundArtifactSchema, type InboundArtifact } from "@/lib/integration/contracts/inbound-artifact"
import { normalizedMessageSchema } from "@/lib/integration/contracts/normalized-message"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { isArtifactResolutionActiveForCompany, type PlatformFlagEnv } from "@/lib/integration/flags/platform-flags"
import { redactLogFields } from "@/lib/integration/observability/redaction/redact"
import { createConnectorRegistry } from "@/lib/integration/registry/connector-registry"
import { hasCapability } from "@/lib/integration/registry/capabilities"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import { INTEGRATION_CAPABILITIES } from "@/lib/integration/types/integration-capability"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

export type ArtifactFetchCapability = "CONTENT_FETCH" | "ARTIFACT_FETCH"

/** Motifs de refus journalisés (codes fermés, sans valeur métier). */
export const ARTIFACT_RESOLUTION_REASONS = {
  MAILBOX_NOT_OWNED: "MAILBOX_NOT_OWNED",
  ENVELOPE_AMBIGUOUS: "ENVELOPE_AMBIGUOUS",
  CONNECTION_INVALID: "CONNECTION_INVALID",
  ENVELOPE_NOT_NORMALIZED: "ENVELOPE_NOT_NORMALIZED",
  CONNECTOR_CAPABILITY_MISSING: "CONNECTOR_CAPABILITY_MISSING",
  MAILBOX_INACTIVE: "MAILBOX_INACTIVE",
  MESSAGE_CAPABILITY_MISSING: "MESSAGE_CAPABILITY_MISSING",
  ARTIFACT_MAPPING_FAILED: "ARTIFACT_MAPPING_FAILED",
  READ_FAILED: "READ_FAILED",
} as const
export type ArtifactResolutionReason = (typeof ARTIFACT_RESOLUTION_REASONS)[keyof typeof ARTIFACT_RESOLUTION_REASONS]

type ArtifactMetadata = Pick<InboundArtifact, "id" | "externalArtifactId" | "filename" | "mimeType" | "sizeBytes">

export type MailArtifactResolution =
  | {
      ok: true
      path: "LEGACY" | "LEGACY_FALLBACK" | "PLATFORM"
      connectionId: string
      provider: typeof legacyMailArtifactSources
      artifact: InboundArtifact | undefined
    }
  | { ok: false; code: "GMAIL_NOT_CONNECTED" | "LEGACY_MAILBOX_AMBIGUOUS" }
  | { ok: false; code: "ARTIFACT_CAPABILITY_UNAVAILABLE"; reason: ArtifactResolutionReason }
  | { ok: false; code: "ARTIFACT_RESOLUTION_FAILED"; reason: "READ_FAILED" }

export interface ResolveMailArtifactOptions {
  env?: PlatformFlagEnv
  log?: (fields: Record<string, unknown>) => void
}

const providers: Record<string, typeof legacyMailArtifactSources> = {
  [MAIL_SHADOW_CONNECTOR_TYPE]: legacyMailArtifactSources,
}
const mailConnectorType = MAIL_SHADOW_CONNECTOR_TYPE as ConnectorType
const registry = createConnectorRegistry([{
  connectorType: mailConnectorType,
  family: "MESSAGE",
  capabilities: [INTEGRATION_CAPABILITIES.CONTENT_FETCH, INTEGRATION_CAPABILITIES.ARTIFACT_FETCH],
}])
const mailboxConfig = z.object({ gmailMailboxId: z.string().min(1) })

function defaultLog(fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ scope: "acquisition.artifact_resolution", ...redactLogFields(fields) }))
}

export async function resolveMailArtifactProvider(
  db: PrismaClient,
  message: { companyId: string; sourceMailboxKey: string; externalMessageId: string },
  capability: ArtifactFetchCapability,
  metadata: ArtifactMetadata,
  options: ResolveMailArtifactOptions = {}
): Promise<MailArtifactResolution> {
  const { companyId } = message
  const platform = isArtifactResolutionActiveForCompany(companyId, options.env ?? process.env)
  const log = options.log ?? defaultLog
  const started = Date.now()
  let result: MailArtifactResolution
  try {
    // Commun aux deux chemins (ticket « défauts historiques ») : boîte résolue PUIS appartenance vérifiée,
    // avant toute lecture distante ; une panne de lecture devient ARTIFACT_RESOLUTION_FAILED (reprise).
    const mailbox = await resolveOwnedMailbox(db, message)
    if (!mailbox.ok) result = mailbox
    else if (platform) result = await resolvePlatform(db, message, mailbox.connectionId, capability, metadata)
    else result = { ok: true, path: "LEGACY", connectionId: mailbox.connectionId, provider: legacyMailArtifactSources, artifact: undefined }
  } catch (error) {
    log({
      message: "artifact_resolution_failed", companyId, capability, outcome: "ARTIFACT_RESOLUTION_FAILED",
      reason: ARTIFACT_RESOLUTION_REASONS.READ_FAILED, errorName: error instanceof Error ? error.name : "unknown",
      durationMs: Date.now() - started,
    })
    return { ok: false, code: "ARTIFACT_RESOLUTION_FAILED", reason: "READ_FAILED" }
  }
  // Flag coupé : une lecture historique réussie reste silencieuse (comme main) ; refus et pannes sont journalisés.
  if (!platform && result.ok) return result
  log({
    message: result.ok ? "artifact_resolved" : "artifact_resolution_refused",
    companyId,
    capability,
    path: result.ok ? result.path : null,
    outcome: result.ok ? "RESOLVED" : result.code,
    reason: !result.ok && "reason" in result ? result.reason : null,
    connectorType: result.ok && result.path === "PLATFORM" ? MAIL_SHADOW_CONNECTOR_TYPE : null,
    durationMs: Date.now() - started,
  })
  return result
}

const refuse = (reason: ArtifactResolutionReason): MailArtifactResolution =>
  ({ ok: false, code: "ARTIFACT_CAPABILITY_UNAVAILABLE", reason })

/**
 * Résolution historique de la boîte, puis refus intersociété : une clé de boîte explicite doit désigner une boîte
 * de la société du message (active ou non : une boîte inactive garde son échec GMAIL_NOT_CONNECTED habituel).
 * Refus non repris (ARTIFACT_CAPABILITY_UNAVAILABLE / MAILBOX_NOT_OWNED), sans aucune lecture de jeton ni appel distant.
 */
async function resolveOwnedMailbox(
  db: PrismaClient,
  message: { companyId: string; sourceMailboxKey: string }
): Promise<{ ok: true; connectionId: string } | Extract<MailArtifactResolution, { ok: false }>> {
  const mailbox = await resolveAcquisitionMailboxForMessage(message, db)
  if (!mailbox.ok) return mailbox
  if (message.sourceMailboxKey.trim()) {
    const owned = await db.acquisitionGmailConnection.findFirst({
      where: { id: mailbox.connectionId, companyId: message.companyId },
      select: { id: true },
    })
    if (!owned) return refuse(ARTIFACT_RESOLUTION_REASONS.MAILBOX_NOT_OWNED) as Extract<MailArtifactResolution, { ok: false }>
  }
  return { ok: true, connectionId: mailbox.connectionId }
}

async function resolvePlatform(
  db: PrismaClient,
  message: { companyId: string; sourceMailboxKey: string; externalMessageId: string },
  mailboxConnectionId: string,
  capability: ArtifactFetchCapability,
  metadata: ArtifactMetadata
): Promise<MailArtifactResolution> {
  const { companyId, sourceMailboxKey, externalMessageId } = message
  const mailbox = { connectionId: mailboxConnectionId }

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
    // Message sans admission LOT-3 reliée (historique, ou lien boîte ↔ connexion modifié) : chemin historique, journalisé.
    return { ok: true, path: "LEGACY_FALLBACK", connectionId: mailbox.connectionId, provider: legacyMailArtifactSources, artifact: undefined }
  }

  if (envelopes.length !== 1) return refuse(ARTIFACT_RESOLUTION_REASONS.ENVELOPE_AMBIGUOUS)
  const [envelope] = envelopes
  const connection = envelope.connection
  const binding = mailboxConfig.safeParse(connection.config)
  if (
    !binding.success || binding.data.gmailMailboxId !== mailbox.connectionId ||
    connection.status !== "ACTIVE" || connection.secretBackend !== "LEGACY_GMAIL" ||
    envelope.connectorType !== connection.connectorType ||
    connection.connectorType !== MAIL_SHADOW_CONNECTOR_TYPE
  ) return refuse(ARTIFACT_RESOLUTION_REASONS.CONNECTION_INVALID)
  if (envelope.lifecycleStatus !== "NORMALIZED") return refuse(ARTIFACT_RESOLUTION_REASONS.ENVELOPE_NOT_NORMALIZED)

  const connector = registry.get(mailConnectorType)
  const provider = providers[connection.connectorType]
  if (!connector || !provider || !hasCapability(connector.capabilities, capability)) {
    return refuse(ARTIFACT_RESOLUTION_REASONS.CONNECTOR_CAPABILITY_MISSING)
  }

  // Refus intersociété : la boîte doit appartenir à la société du message, avant toute lecture distante.
  const mailboxIsActive = await db.acquisitionGmailConnection.findFirst({
    where: { id: mailbox.connectionId, companyId, active: true },
    select: { id: true },
  })
  if (!mailboxIsActive) return refuse(ARTIFACT_RESOLUTION_REASONS.MAILBOX_INACTIVE)

  const normalized = normalizedMessageSchema.safeParse(envelope.normalizedInbounds[0]?.message)
  const messageCapability = capability === "CONTENT_FETCH"
    ? MESSAGE_CONTENT_CAPABILITIES.CONTENT_FETCHABLE
    : MESSAGE_CONTENT_CAPABILITIES.ATTACHMENTS_FETCHABLE
  if (!normalized.success || normalized.data.externalMessageId !== externalMessageId ||
    !normalized.data.contentCapabilities.includes(messageCapability)) {
    return refuse(ARTIFACT_RESOLUTION_REASONS.MESSAGE_CAPABILITY_MISSING)
  }

  const artifact = inboundArtifactSchema.safeParse({
    ...metadata, companyId, connectionId: envelope.connectionId, envelopeId: envelope.id,
    fetchRef: metadata.id, availability: "PENDING_FETCH", schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  })
  if (!artifact.success) return refuse(ARTIFACT_RESOLUTION_REASONS.ARTIFACT_MAPPING_FAILED)
  return { ok: true, path: "PLATFORM", connectionId: mailbox.connectionId, provider, artifact: artifact.data }
}
