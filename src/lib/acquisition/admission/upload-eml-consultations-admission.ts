import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { admitConsultation } from "./consultations-admission"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { normalizeSenderAddress } from "@/lib/acquisition/normalize-sender-address"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { getContentNormalizedMaxBytes } from "@/lib/acquisition/content/content-fetch-feature-flag"
import type { UploadAdmission } from "@/lib/integration/connectors/upload-eml/handle-admin-eml-upload"
import { normalizeMessageFamily } from "@/lib/integration/normalizers/message/message-family-normalizer"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import {
  IntegrationInboundLifecycleConflictError,
  IntegrationInboundNormalizedVersionConflictError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"

const CONNECTOR_TYPE = "platform.upload.eml"
const configSchema = z.object({
  sourcePartners: z.array(z.object({ sourceId: z.string().min(1), partnerId: z.string().min(1) })).min(1).max(200),
})

export function createUploadEmlAdmission(
  db: PrismaClient = prisma,
  env: NodeJS.ProcessEnv = process.env,
  { allowAttachments = false }: { allowAttachments?: boolean } = {},
): UploadAdmission {
  const envelopes = new InboundEnvelopeRepository(db)
  const normalized = new NormalizedInboundRepository(db)
  const router = new TenantRouterService({
    normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db), env,
  })

  return async ({ companyId, actorId, message }) => {
    // Le From sert au classement. Le brouillon UPLOAD reste soumis à revue humaine.
    const sender = normalizeSenderAddress(message.senderAddress)
    if (!sender) return { outcome: "NOT_ADMITTED" }
    if (!allowAttachments && message.attachments.length) return { outcome: "UPLOAD_ATTACHMENTS_UNAVAILABLE" }

    const content = sanitizeMessageBodyParts({
      textPlain: message.text, textHtml: null, charset: "utf-8", mimeType: "text/plain",
      byteLengthOriginal: Buffer.byteLength(message.text), providerMessageId: message.sha256,
    })
    if (!content.normalizedText || content.byteLengthNormalized > getContentNormalizedMaxBytes()) {
      return { outcome: "UPLOAD_BODY_INVALID" }
    }

    const matches = await db.integrationConnection.findMany({
      where: { companyId, connectorType: CONNECTOR_TYPE, status: "ACTIVE" },
      take: 2,
      select: { id: true, config: true },
    })
    if (matches.length !== 1) return { outcome: "UPLOAD_CONNECTION_UNAVAILABLE" }
    const connection = matches[0]
    const config = configSchema.safeParse(connection.config)
    if (!config.success) return { outcome: "UPLOAD_CONNECTION_UNAVAILABLE" }

    const receivedAt = new Date().toISOString()
    const envelopeInput = {
      companyId, connectionId: connection.id, externalId: message.sha256, idempotencyKey: message.sha256,
      receivedAt, contentType: "message/rfc822", payloadRef: `upload-sha256:${message.sha256}`, rawPayloadHash: message.sha256,
    }
    const result = normalizeMessageFamily({
      ...envelopeInput, occurredAt: receivedAt,
      message: {
        externalMessageId: message.sha256, sender,
        recipients: message.recipientAddresses.map(normalizeSenderAddress).filter((address) => address !== null),
        subject: message.subject, contentCapabilities: [],
      },
    })
    if (!result.ok) return { outcome: "NOT_ADMITTED" }

    const envelope = await envelopes.createIdempotent(envelopeInput)
    if (envelope.lifecycleStatus === "RECEIVED") {
      try {
        await normalized.create({
          companyId, connectionId: connection.id, envelopeId: envelope.id, family: "MESSAGE",
          schemaVersion: "1.0.0", occurredAt: envelope.receivedAt, receivedAt: envelope.receivedAt,
          artifactRefs: [], normalizedHash: result.normalizedHash, message: result.message,
        })
      } catch (error) {
        if (!(error instanceof IntegrationInboundNormalizedVersionConflictError)) throw error
      }
      try {
        await envelopes.transitionLifecycle({
          companyId, envelopeId: envelope.id, expectedStatuses: ["RECEIVED"], targetStatus: "NORMALIZED",
        })
      } catch (error) {
        if (!(error instanceof IntegrationInboundLifecycleConflictError)) throw error
        const current = await envelopes.findById(companyId, envelope.id)
        if (current.lifecycleStatus !== "NORMALIZED") throw error
      }
    } else if (envelope.lifecycleStatus !== "NORMALIZED") {
      return { outcome: "NOT_ADMITTED" }
    }
    const inbound = await normalized.findByEnvelopeVersion(companyId, envelope.id, "MESSAGE", "1.0.0")
    const admission = await admitConsultation({
      companyId, source: "UPLOAD", sourceMailboxKey: connection.id, externalMessageId: message.sha256,
      receivedAt: new Date(envelope.receivedAt), senderEmail: sender.email, subject: (result.message.subject ?? "").slice(0, 500),
      attachments: message.attachments.map(({ filename, mimeType, bytes }) => ({
        filename: filename ?? "piece-jointe.bin", mimeType, sizeBytes: bytes.byteLength,
      })),
    }, {
      kind: "router", connectionId: connection.id, mailboxKey: connection.id, normalizedInboundId: inbound.id,
    }, {
      envelopes, normalized, router,
      legacy: async () => { throw new Error("Repli historique indisponible pour UPLOAD") },
      project: async (data, sourceId) => {
        const links = config.data.sourcePartners.filter((link) => link.sourceId === sourceId)
        const partner = links.length === 1 ? await db.acquisitionPartner.findFirst({
          where: { id: links[0].partnerId, companyId, active: true, connector: "UPLOAD", pipeline: "consultations" },
        }) : null
        if (!partner) throw new Error("Partenaire UPLOAD indisponible")
        return registerIncomingMessage(data, db, {
          eligibilityResolver: {
            isDomainEligible: async () => false,
            resolveEligibleSender: async () => ({ partner, matchKind: "DOMAIN" }),
          },
          uploadActorId: actorId,
          uploadContent: content,
          uploadAttachmentBytes: message.attachments.map(({ bytes }) => bytes),
        })
      },
    })
    return admission.outcome === "DRAFT_CREATED"
      ? { outcome: admission.outcome, draftId: admission.draftId, created: admission.created }
      : { outcome: "NOT_ADMITTED" }
  }
}
