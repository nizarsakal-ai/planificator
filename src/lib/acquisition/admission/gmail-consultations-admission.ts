import { createHash } from "node:crypto"
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
import { isRoutingActiveForCompany, isRoutingShadowActiveForCompany } from "@/lib/integration/flags/platform-flags"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import { RoutingParityObservationRepository } from "@/lib/integration/persistence/routing-parity-observation.repository"
import { RoutingShadowService } from "@/lib/integration/shadow/routing-shadow.service"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import {
  defaultLegacyEligibilityReader,
  evaluateLegacyEligibilityReference,
  type LegacyEligibilityReader,
  type LegacyEligibilityReferenceOutcome,
} from "@/lib/acquisition/admission/legacy-eligibility-reference"

const bindingSchema = z.object({
  gmailMailboxId: z.string().min(1),
  sourcePartners: z.array(z.object({
    sourceId: z.string().min(1),
    partnerId: z.string().min(1),
  })).min(1),
})

/**
 * Budget total de la parité après la décision LOT-3 : attente de la référence, routage et écriture de
 * l'observation (un quart réservé à l'écriture). Au-delà : référence inconnue (PARITY_UNCOMPARABLE),
 * routage abandonné (ROUTER_TIMEOUT) ou observation abandonnée ; l'admission rend la main.
 */
export const LEGACY_REFERENCE_PARITY_BUDGET_MS = 2_000

export interface GmailConsultationsAdmissionOptions {
  db?: PrismaClient
  env?: NodeJS.ProcessEnv
  /** Référence historique en lecture seule (tests) ; défaut : registre partenaires. */
  legacyReference?: LegacyEligibilityReader
  /** Observation de parité (tests) ; défaut : shadow LOT-2D. */
  parity?: Pick<RoutingShadowService, "observe">
  /** Budget de parité (tests) ; défaut LEGACY_REFERENCE_PARITY_BUDGET_MS. */
  parityBudgetMs?: number
  now?: () => number
}

const REFERENCE_TIMED_OUT = Symbol("legacy-reference-timeout")

/** Attend `work` au plus `ms` ; au-delà renvoie REFERENCE_TIMED_OUT. Un rejet tardif est absorbé. */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | typeof REFERENCE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof REFERENCE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(REFERENCE_TIMED_OUT), Math.max(0, ms))
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  options: GmailConsultationsAdmissionOptions = {}
) {
  const { db = prisma, env = process.env, now = Date.now } = options
  const { companyId, sourceMailboxKey } = input
  if (!isGmailConsultationsAdmissionEnabled(companyId, env)) return legacy(input)

  // Référence indépendante (lecture seule), seulement si le shadow matching est actif pour la société.
  // Lancée en parallèle : la décision LOT-3 ne l'attend jamais ; une panne devient « inconnue ».
  const parityActive = isRoutingShadowActiveForCompany(companyId, env)
  const referenceRead: Promise<LegacyEligibilityReferenceOutcome | null> | null = parityActive
    ? Promise.resolve()
      .then(() => evaluateLegacyEligibilityReference(
        companyId, input.senderEmail, options.legacyReference ?? defaultLegacyEligibilityReader(db)
      ))
      .catch(() => null)
    : null

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

  // L’admission reconstruit son instantané depuis le message du poll.
  // Les projections shadow antérieures restent immuables, même si leur
  // expéditeur est différent. L’identité métier Acquisition reste la même.
  const digest = createHash("sha256").update(mapped.dto.externalId).digest("hex")
  const dto = { ...mapped.dto, idempotencyKey: `consultations-gmail-v1:${digest}` }
  const envelopes = new InboundEnvelopeRepository(db)
  const normalized = new NormalizedInboundRepository(db)
  await new MailShadowBridgeService(db).project(dto, { stats: createMailShadowRunStats() })
  const envelope = await envelopes.findByIdempotencyKey(companyId, binding.id, dto.idempotencyKey)
  if (envelope.lifecycleStatus !== "NORMALIZED") throw new Error("Enveloppe Gmail non normalisée")
  const inbound = await normalized.findByEnvelopeVersion(companyId, envelope.id, INBOUND_FAMILY.MESSAGE, PLATFORM_SCHEMA_VERSION_V1)
  if (inbound.message.sender?.email !== sender.email) throw new Error("Expéditeur incohérent avec le message normalisé")

  const router = new TenantRouterService({
    normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db), env,
  })
  const result = await admitConsultation(input, {
    kind: "router", normalizedInboundId: inbound.id, connectionId: binding.id, mailboxKey: mailbox.id,
  }, {
    envelopes,
    normalized,
    router,
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

  if (!referenceRead) return result

  // Parité Router ↔ règles historiques : la décision LOT-3 est déjà prise et n'est jamais modifiée.
  // Un seul budget borne TOUT ce qui suit la décision : attente de la référence, routage et écriture de
  // l'observation. Un quart est réservé à l'écriture ; l'appel entier est abandonné à l'échéance (une
  // écriture tardive est absorbée, l'index unique empêche tout doublon). Le Router réutilise la décision
  // existante (même message, même configuration) : aucun double comptage. Rien ne lève vers l'appelant.
  try {
    const budgetMs = options.parityBudgetMs ?? LEGACY_REFERENCE_PARITY_BUDGET_MS
    const deadlineAtMs = now() + budgetMs
    const routingDeadlineAtMs = deadlineAtMs - Math.floor(budgetMs / 4)
    const settled = await settleWithin(referenceRead, routingDeadlineAtMs - now())
    const parity = options.parity ?? new RoutingShadowService({
      env, router, observations: new RoutingParityObservationRepository(db), now,
      findNormalizedId: async () => inbound.id,
    })
    const observing = Promise.resolve().then(() => parity.observe({
      companyId,
      connectionId: binding.id,
      idempotencyKey: dto.idempotencyKey,
      externalId: input.externalMessageId,
      legacyOutcome: settled === REFERENCE_TIMED_OUT ? null : settled,
      deadlineAtMs: routingDeadlineAtMs,
    }))
    observing.catch(() => undefined)
    await settleWithin(observing, deadlineAtMs - now())
  } catch {
    // Best-effort : la parité n'altère jamais l'admission.
  }

  return result
}
