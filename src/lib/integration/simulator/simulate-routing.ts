/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2E
 * Simulateur de routage (SPEC LOT-2 §20.4 ; plan I7) : un message MESSAGE contrôlé → l'outcome que donnerait le Router
 * avec la configuration actuelle de la société, et l'empreinte de cette configuration.
 *
 * - Lecture seule : AUCUNE persistance (ni NormalizedInbound, ni Envelope, ni RoutingDecision, ni audit de payload).
 * - Accès : ADMIN ou SUPER_ADMIN, toujours sur la société de la SESSION, jamais une société reçue.
 * - Corps local indisponible (port I3) : BODY_KEYWORD ne matche jamais, comme en production V1.
 * - Sans `connectionId`, un Binding limité à une Connection n'est jamais satisfait (comportement du Router).
 * - Aucun flag requis : le simulateur ne décide rien et n'écrit rien. Aucune UI (LOT-6), aucune admission.
 */
import { normalizedMessageSchema, type NormalizedMessage } from "@/lib/integration/contracts/normalized-message"
import {
  RoutingConfigSnapshotRepository,
  type RoutingConfigSnapshotReaderPort,
} from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { UnavailableLocalBodyPort, type LocalMessageBodyPort } from "@/lib/integration/router/local-message-body.port"
import { computeRoutingConfigurationVersion } from "@/lib/integration/router/routing-config-snapshot"
import { ROUTING_REASON_CODES, routeMessage, snapshotNeedsBody, type RouterResult } from "@/lib/integration/router/tenant-router"

export interface SimulatorActor { companyId: string; userId: string; role: string }

export class RoutingSimulatorForbiddenError extends Error {
  readonly code = "ROUTING_SIMULATOR_FORBIDDEN" as const
  constructor() { super("ROUTING_SIMULATOR_FORBIDDEN"); this.name = "RoutingSimulatorForbiddenError" }
}
export class RoutingSimulatorInputError extends Error {
  readonly code = "ROUTING_SIMULATOR_INVALID_MESSAGE" as const
  constructor() { super("ROUTING_SIMULATOR_INVALID_MESSAGE"); this.name = "RoutingSimulatorInputError" }
}

export interface SimulationResult extends Omit<RouterResult, "outcome"> {
  outcome: RouterResult["outcome"]
  routingConfigurationVersion: string
  /** Toujours vrai : rappel explicite qu'aucune donnée n'a été écrite. */
  persisted: false
}

export interface SimulatorDeps {
  config: RoutingConfigSnapshotReaderPort
  body: LocalMessageBodyPort
}

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

export async function simulateRouting(
  actor: SimulatorActor,
  input: { message: unknown; connectionId?: string | null },
  deps: Partial<SimulatorDeps> = {}
): Promise<SimulationResult> {
  if (!actor.companyId || !actor.userId || !ADMIN_ROLES.has(actor.role)) throw new RoutingSimulatorForbiddenError()
  const parsed = normalizedMessageSchema.safeParse(input.message)
  if (!parsed.success) throw new RoutingSimulatorInputError()
  const message = parsed.data as NormalizedMessage

  const config = deps.config ?? new RoutingConfigSnapshotRepository()
  const rows = await config.load(actor.companyId)
  const routingConfigurationVersion = computeRoutingConfigurationVersion(rows)

  let result: RouterResult
  if (rows.limitExceeded) {
    result = {
      outcome: "ERROR", matchedSourceIds: [], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.CONFIG_LIMIT_EXCEEDED, rulesEvaluated: 0,
      diagnostics: { qualifierGap: false, subjectKeywordRuleActive: false, bodyKeywordRuleActive: false, subjectPresent: false, bodyAvailable: false },
    }
  } else {
    const body = snapshotNeedsBody(rows)
      ? await (deps.body ?? new UnavailableLocalBodyPort()).read({ companyId: actor.companyId, normalizedInboundId: "simulation" })
      : ({ available: false } as const)
    result = routeMessage({ connectionId: input.connectionId ?? "", message, snapshot: rows, body })
  }
  return { ...result, routingConfigurationVersion, persisted: false }
}
