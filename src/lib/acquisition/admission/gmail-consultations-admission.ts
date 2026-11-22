import { z } from "zod"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { normalizeSenderAddress, registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { admitConsultation, type ConsultationsWriter } from "@/lib/acquisition/admission/consultations-admission"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import { mapCanonicalMailToShadowDto } from "@/lib/acquisition/connector/mail-shadow-dto.mapper"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"
import { MailShadowBridgeService } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { isRoutingActiveForCompany } from "@/lib/integration/flags/platform-flags"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

const bindingSchema = z.object({
  gmailMailboxId: z.string().min(1),
  sourcePartners: z.array(z.object({
    sourceId: z.string().min(1),
    partnerId: z.string().min(1),
  })).min(1),
})

export function isGmailConsultationsAdmissionEnabled(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED === "true" && isRoutingActiveForCompany(companyId, env)
}

/** Projection synchrone de l’unique message déjà lu par le poll Gmail. */
export async function admitGmailConsultation(
  message: CanonicalMailMessage,
  input: RegisterIncomingMessageInput,
  legacy: ConsultationsWriter,
  options: { db?: PrismaClient; env?: NodeJS.ProcessEnv } = {}
) {
  const { db = prisma, env = process.env } = options
  const { companyId, sourceMailboxKey } = input
  if (!isGmailConsultationsAdmissionEnabled(companyId, env)) return legacy(input)

  const mailbox = await db.acquisitionGmailConnection.findFirst({
    where: { id: sourceMailboxKey, companyId, active: true },
    select: { id: true },
  })
  if (!mailbox) throw new Error("Boîte Gmail Acquisition introuvable pour cette société")

  // Une connexion d’intégration dédiée par boîte empêche la collision des
  // clés d’idempotence entre boîtes qui reçoivent le même identifiant externe.
  const connections = await db.integrationConnection.findMany({
    where: { companyId, connectorType: MAIL_SHADOW_CONNECTOR_TYPE, status: "ACTIVE", secretBackend: "LEGACY_GMAIL" },
    select: { id: true, config: true },
  })
  const bindings = connections.flatMap(connection => {
    const parsed = bindingSchema.safeParse(connection.config)
    return parsed.success && parsed.data.gmailMailboxId === mailbox.id
      ? [{ id: connection.id, partners: parsed.data.sourcePartners }]
      : []
  })
  if (bindings.length !== 1) throw new Error("Lien unique entre boîte Gmail et connexion d’intégration requis")
  const [binding] = bindings

  const sender = normalizeSenderAddress(input.senderEmail)
  if (!sender) return { outcome: "NOT_ADMITTED" } as const
  const mapped = mapCanonicalMailToShadowDto({ ...message, fromHeader: sender.email }, {
    companyId, connectionId: binding.id,
  })
  if (!mapped.ok) throw new Error("Message Gmail incompatible avec l’admission")

  const envelopes = new InboundEnvelopeRepository(db)
  const normalized = new NormalizedInboundRepository(db)
  await new MailShadowBridgeService(db).project(mapped.dto, { stats: createMailShadowRunStats() })
  const envelope = await envelopes.findByIdempotencyKey(companyId, binding.id, mapped.dto.idempotencyKey)
  if (envelope.lifecycleStatus !== "NORMALIZED") throw new Error("Enveloppe Gmail non normalisée")
  const inbound = await normalized.findByEnvelopeVersion(companyId, envelope.id, INBOUND_FAMILY.MESSAGE, PLATFORM_SCHEMA_VERSION_V1)
  if (inbound.message.sender?.email !== sender.email) throw new Error("Expéditeur incohérent avec le message normalisé")

  return admitConsultation(input, {
    kind: "router", normalizedInboundId: inbound.id, connectionId: binding.id, mailboxKey: mailbox.id,
  }, {
    envelopes,
    normalized,
    router: new TenantRouterService({
      normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db), env,
    }),
    legacy,
    project: async (record, sourceId) => {
      const links = binding.partners.filter(link => link.sourceId === sourceId)
      if (links.length !== 1) throw new Error("Lien unique entre source et partenaire Consultations requis")
      const partner = await db.acquisitionPartner.findFirst({
        where: { id: links[0].partnerId, companyId, active: true, pipeline: "consultations", connector: "GMAIL" },
      })
      if (!partner) throw new Error("Partenaire Consultations introuvable pour cette société")
      return registerIncomingMessage(record, db, {
        eligibilityResolver: {
          isDomainEligible: async () => false,
          resolveEligibleSender: async () => ({
            partner, matchKind: "DOMAIN",
          }),
        },
      })
    },
  })
}
