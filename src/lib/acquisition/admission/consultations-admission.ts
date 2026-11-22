import type { RegisterIncomingMessageResult } from "@/lib/acquisition/acquisition.service"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"
import type { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import type { NormalizedInboundRepositoryPort } from "@/lib/integration/persistence/normalized-inbound.repository"
import type { InboundEnvelopeRepositoryPort } from "@/lib/integration/persistence/inbound-envelope.repository"
import { PIPELINE_ID_CONSULTATIONS } from "@/lib/integration/contracts/pipeline-binding"

export type ConsultationsWriter = (
  input: RegisterIncomingMessageInput
) => Promise<RegisterIncomingMessageResult>

type Authority =
  | { kind: "legacy" }
  | { kind: "router"; normalizedInboundId: string; connectionId: string; mailboxKey: string }

interface Dependencies {
  router: Pick<TenantRouterService, "route">
  normalized: Pick<NormalizedInboundRepositoryPort, "findById">
  envelopes: Pick<InboundEnvelopeRepositoryPort, "findById">
  legacy: ConsultationsWriter
  project: (
    input: RegisterIncomingMessageInput,
    sourceId: string
  ) => Promise<RegisterIncomingMessageResult>
}

/** Le contexte de boîte provient du connecteur. Aucun repli legacy après le choix du routeur. */
export async function admitConsultation(
  input: RegisterIncomingMessageInput,
  authority: Authority,
  deps: Dependencies
): Promise<RegisterIncomingMessageResult | { outcome: "NOT_ADMITTED" }> {
  if (authority.kind === "legacy") return deps.legacy(input)

  if (!authority.mailboxKey || authority.mailboxKey !== input.sourceMailboxKey) {
    throw new Error("Identité de boîte incompatible avec l’admission Consultations")
  }
  const { companyId, externalMessageId } = input
  const { normalizedInboundId, connectionId } = authority
  const normalized = await deps.normalized.findById(companyId, normalizedInboundId)
  const envelope = await deps.envelopes.findById(companyId, normalized.envelopeId)
  if (
    normalized.connectionId !== connectionId ||
    envelope.connectionId !== connectionId ||
    envelope.externalId !== externalMessageId ||
    normalized.message.externalMessageId !== externalMessageId
  ) {
    throw new Error("Message normalisé incompatible avec l’admission Consultations")
  }

  const routed = await deps.router.route({ companyId, normalizedInboundId })
  if (routed.status !== "DECIDED" || routed.decision.outcome === "ERROR") {
    throw new Error("Décision de routage indisponible")
  }
  const { decision } = routed
  if (decision.outcome !== "MATCH") return { outcome: "NOT_ADMITTED" }
  const [sourceId] = decision.matchedSourceIds
  if (
    decision.companyId !== companyId ||
    decision.normalizedInboundId !== normalizedInboundId ||
    !sourceId ||
    decision.matchedSourceIds.length !== 1 ||
    decision.pipelineIds.length !== 1 ||
    decision.pipelineIds[0] !== PIPELINE_ID_CONSULTATIONS
  ) {
    throw new Error("Décision incompatible avec l’admission Consultations")
  }
  return deps.project(input, sourceId)
}
