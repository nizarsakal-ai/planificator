/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Orchestration d'un routage (SPEC LOT-2 §10.2) pour UN NormalizedInbound d'UNE société :
 *  1. flags I1 (foundation ∧ routing ∧ allowlist), sinon rien n'est décidé ni écrit ;
 *  2. lecture du NormalizedInbound (société de l'appel uniquement) ;
 *  3. snapshot de configuration + `routingConfigurationVersion` (I2) ;
 *  4. corps local lu seulement si une règle BODY_KEYWORD est active (port I3, sans I/O distante) ;
 *  5. Router pur, puis décision persistée ou réutilisée (idempotence §9.2).
 * Jamais : transition d'Envelope, admission, brouillon, fetch distant (§8.4). Journaux redacted (§16).
 * La société vient toujours de l'appelant serveur, jamais du message.
 */
import { isRoutingActiveForCompany, type PlatformFlagEnv } from "@/lib/integration/flags/platform-flags"
import type { RoutingDecision } from "@/lib/integration/contracts/routing-decision"
import type { NormalizedInbound } from "@/lib/integration/contracts/normalized-inbound"
import { redactLogFields } from "@/lib/integration/observability/redaction/redact"
import {
  NormalizedInboundRepository,
  type NormalizedInboundRepositoryPort,
} from "@/lib/integration/persistence/normalized-inbound.repository"
import { IntegrationInboundValidationError } from "@/lib/integration/persistence/integration-inbound.errors"
import {
  RoutingConfigSnapshotRepository,
  type RoutingConfigSnapshotReaderPort,
} from "@/lib/integration/persistence/routing-config-snapshot.repository"
import {
  RoutingDecisionRepository,
  type RoutingDecisionRepositoryPort,
} from "@/lib/integration/persistence/routing-decision.repository"
import { UnavailableLocalBodyPort, type LocalMessageBodyPort } from "@/lib/integration/router/local-message-body.port"
import { computeRoutingConfigurationVersion } from "@/lib/integration/router/routing-config-snapshot"
import {
  ROUTING_REASON_CODES,
  routeMessage,
  snapshotNeedsBody,
  type RouterDiagnostics,
  type RouterResult,
} from "@/lib/integration/router/tenant-router"

const NO_DIAGNOSTICS: RouterDiagnostics = {
  qualifierGap: false,
  subjectGap: false,
  bodyGap: false,
  subjectKeywordRuleActive: false,
  bodyKeywordRuleActive: false,
  subjectPresent: false,
  bodyAvailable: false,
}

export type RouteNormalizedInboundResult =
  | { status: "DISABLED" }
  | {
      status: "DECIDED"
      decision: RoutingDecision
      /** Métadonnées techniques hors contrat (§9.2, §16). */
      reused: boolean
      rulesEvaluated: number
      durationMs: number
      /** Diagnostics opaques pour la parité (LOT-2D), aucune valeur. */
      diagnostics: RouterDiagnostics
    }

export interface TenantRouterDeps {
  normalized: Pick<NormalizedInboundRepositoryPort, "findById">
  config: RoutingConfigSnapshotReaderPort
  decisions: RoutingDecisionRepositoryPort
  body: LocalMessageBodyPort
  env: PlatformFlagEnv
  now: () => number
  log: (fields: Record<string, unknown>) => void
}

function defaultLog(fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ scope: "integration.router", ...redactLogFields(fields) }))
}

export class TenantRouterService {
  private readonly deps: TenantRouterDeps

  constructor(deps: Partial<TenantRouterDeps> = {}) {
    this.deps = {
      normalized: deps.normalized ?? new NormalizedInboundRepository(),
      config: deps.config ?? new RoutingConfigSnapshotRepository(),
      decisions: deps.decisions ?? new RoutingDecisionRepository(),
      body: deps.body ?? new UnavailableLocalBodyPort(),
      env: deps.env ?? process.env,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? defaultLog,
    }
  }

  async route(input: { companyId: string; normalizedInboundId: string }): Promise<RouteNormalizedInboundResult> {
    const { companyId, normalizedInboundId } = input
    if (!companyId || !normalizedInboundId) throw new Error("companyId et normalizedInboundId requis")
    if (!isRoutingActiveForCompany(companyId, this.deps.env)) return { status: "DISABLED" }
    const started = this.deps.now()

    const rows = await this.deps.config.load(companyId)
    const routingConfigurationVersion = computeRoutingConfigurationVersion(rows)

    let normalized: NormalizedInbound | null = null
    let result: RouterResult
    try {
      normalized = await this.deps.normalized.findById(companyId, normalizedInboundId)
    } catch (error) {
      // Contenu stocké non conforme au contrat MESSAGE V1 : décision ERROR, jamais de matching approximatif.
      if (!(error instanceof IntegrationInboundValidationError)) throw error
    }
    if (!normalized) {
      result = { outcome: "ERROR", matchedSourceIds: [], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.INVALID_NORMALIZED_MESSAGE, rulesEvaluated: 0, diagnostics: NO_DIAGNOSTICS }
    } else if (rows.limitExceeded) {
      result = { outcome: "ERROR", matchedSourceIds: [], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.CONFIG_LIMIT_EXCEEDED, rulesEvaluated: 0, diagnostics: NO_DIAGNOSTICS }
    } else {
      const body = snapshotNeedsBody(rows)
        ? await this.deps.body.read({ companyId, normalizedInboundId })
        : ({ available: false } as const)
      result = routeMessage({ connectionId: normalized.connectionId, message: normalized.message, snapshot: rows, body })
    }

    const recorded = await this.deps.decisions.record({
      companyId,
      normalizedInboundId,
      outcome: result.outcome,
      matchedSourceIds: result.matchedSourceIds,
      pipelineIds: result.pipelineIds,
      reasonCode: result.reasonCode,
      routingConfigurationVersion,
    })
    const durationMs = Math.max(0, this.deps.now() - started)
    this.deps.log({
      message: "routing_decision",
      companyId,
      connectionId: normalized?.connectionId,
      normalizedInboundId,
      decisionId: recorded.decision.id,
      outcome: recorded.decision.outcome,
      reasonCode: recorded.decision.reasonCode,
      sourceIds: recorded.decision.matchedSourceIds,
      rulesEvaluated: result.rulesEvaluated,
      idempotentReuse: recorded.reused,
      durationMs,
    })
    return { status: "DECIDED", decision: recorded.decision, reused: recorded.reused, rulesEvaluated: result.rulesEvaluated, durationMs, diagnostics: result.diagnostics }
  }
}
