/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2D
 * Shadow matching (SPEC LOT-2 §14) : après la projection LOT-1C d'un message, route le NormalizedInbound déjà produit
 * et compare la décision Router au résultat legacy L1 du même message.
 *
 * - Flags I1 : foundation ∧ routing ∧ shadow ∧ allowlist ; sinon rien n'est lu ni écrit.
 * - Budget : celui du run shadow LOT-1C ; au-delà, aucun routage et observation PARITY_UNCOMPARABLE (BUDGET_EXCEEDED).
 * - Best-effort : ne lève JAMAIS vers l'appelant ; une erreur n'altère ni le legacy ni ses statistiques.
 * - Aucun second poll, aucun fetch, aucune transition d'Envelope, aucune admission (barrière LOT-3).
 * - Journaux redacted ; identifiant externe seulement haché dans la table de parité.
 */
import { createHash } from "node:crypto"
import { isRoutingShadowActiveForCompany, type PlatformFlagEnv } from "@/lib/integration/flags/platform-flags"
import { redactLogFields } from "@/lib/integration/observability/redaction/redact"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { IntegrationInboundNotFoundError } from "@/lib/integration/persistence/integration-inbound.errors"
import {
  RoutingParityObservationRepository,
  type RecordParityObservationInput,
  type RoutingParityObservationRepositoryPort,
} from "@/lib/integration/persistence/routing-parity-observation.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import {
  LEGACY_OUTCOME_CLASSES,
  PARITY_BASELINE_CODE,
  PARITY_OUTCOMES,
  classifyLegacyOutcome,
  computeParity,
  isUnexplainedDivergence,
} from "@/lib/integration/shadow/routing-parity"

export const ROUTING_SHADOW_COMPARISON_CODES = {
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  NORMALIZED_NOT_FOUND: "NORMALIZED_NOT_FOUND",
  ROUTER_DISABLED: "ROUTER_DISABLED",
  ROUTER_FAILED: "ROUTER_FAILED",
  /** Routage non terminé dans le budget restant du run : abandonné côté shadow, la synchronisation n'attend pas. */
  ROUTER_TIMEOUT: "ROUTER_TIMEOUT",
} as const

const ROUTER_TIMED_OUT = Symbol("router-timeout")

/** Attend `work` au plus `ms` millisecondes ; au-delà renvoie ROUTER_TIMED_OUT (l'éventuel échec tardif est absorbé). */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof ROUTER_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof ROUTER_TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(ROUTER_TIMED_OUT), Math.max(0, ms)) })
  work.catch(() => undefined)
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface RoutingShadowInput {
  companyId: string
  connectionId: string
  /** Clé d'idempotence de l'Envelope LOT-1C (= identifiant externe du message). */
  idempotencyKey: string
  externalId: string
  /** Résultat brut de `registerIncomingMessage` (DRAFT_CREATED / REJECTED), ou null si inconnu. */
  legacyOutcome: string | null
  deadlineAtMs: number
}

export type RoutingShadowResult =
  | { status: "DISABLED" }
  | { status: "OBSERVED"; parityOutcome: string; recorded: boolean }
  | { status: "FAILED" }

export interface RoutingShadowDeps {
  findNormalizedId: (companyId: string, connectionId: string, idempotencyKey: string) => Promise<string | null>
  router: Pick<TenantRouterService, "route">
  observations: RoutingParityObservationRepositoryPort
  env: PlatformFlagEnv
  now: () => number
  log: (level: "info" | "warn", fields: Record<string, unknown>) => void
}

function defaultLog(level: "info" | "warn", fields: Record<string, unknown>): void {
  const line = JSON.stringify({ scope: "integration.routing_shadow", ...redactLogFields(fields) })
  if (level === "warn") console.warn(line)
  else console.info(line)
}

async function defaultFindNormalizedId(companyId: string, connectionId: string, idempotencyKey: string): Promise<string | null> {
  try {
    const envelope = await new InboundEnvelopeRepository().findByIdempotencyKey(companyId, connectionId, idempotencyKey)
    const normalized = await new NormalizedInboundRepository().findByEnvelopeVersion(
      companyId,
      envelope.id,
      INBOUND_FAMILY.MESSAGE,
      PLATFORM_SCHEMA_VERSION_V1
    )
    return normalized.id
  } catch (error) {
    if (error instanceof IntegrationInboundNotFoundError) return null
    throw error
  }
}

export function hashExternalId(externalId: string): string {
  return createHash("sha256").update(externalId, "utf8").digest("hex")
}

export class RoutingShadowService {
  private readonly deps: RoutingShadowDeps

  constructor(deps: Partial<RoutingShadowDeps> = {}) {
    this.deps = {
      findNormalizedId: deps.findNormalizedId ?? defaultFindNormalizedId,
      router: deps.router ?? new TenantRouterService({ env: deps.env }),
      observations: deps.observations ?? new RoutingParityObservationRepository(),
      env: deps.env ?? process.env,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? defaultLog,
    }
  }

  /** Ne lève jamais. */
  async observe(input: RoutingShadowInput): Promise<RoutingShadowResult> {
    try {
      if (!input.companyId || !isRoutingShadowActiveForCompany(input.companyId, this.deps.env)) return { status: "DISABLED" }
      return await this.observeActive(input)
    } catch (error) {
      this.deps.log("warn", {
        message: "routing_shadow_failed",
        companyId: input.companyId,
        connectionId: input.connectionId,
        parityBaselineCode: PARITY_BASELINE_CODE,
        errorName: error instanceof Error ? error.name : "unknown",
      })
      return { status: "FAILED" }
    }
  }

  private async observeActive(input: RoutingShadowInput): Promise<RoutingShadowResult> {
    const legacy = classifyLegacyOutcome(input.legacyOutcome)
    const base = { companyId: input.companyId, externalIdHash: hashExternalId(input.externalId), legacyOutcome: legacy }
    const noRouter = (normalizedInboundId: string | null, comparisonCode: string, failed = false): RecordParityObservationInput => {
      const parity = computeParity({ legacy, router: null, comparisonFailed: failed })
      return { ...base, normalizedInboundId, routerOutcome: null, routingDecisionId: null, routingConfigurationVersion: null, parityOutcome: parity.parityOutcome, explainedCodes: parity.explainedCodes, comparisonCode }
    }

    if (this.deps.now() >= input.deadlineAtMs) {
      return this.finish(input, noRouter(null, ROUTING_SHADOW_COMPARISON_CODES.BUDGET_EXCEEDED), false)
    }
    const normalizedInboundId = await this.deps.findNormalizedId(input.companyId, input.connectionId, input.idempotencyKey)
    if (!normalizedInboundId) {
      return this.finish(input, noRouter(null, ROUTING_SHADOW_COMPARISON_CODES.NORMALIZED_NOT_FOUND), false)
    }

    let routed: Awaited<ReturnType<TenantRouterService["route"]>>
    try {
      // Revue indépendante du 24/11, point 3 : le routage ne doit jamais dépasser le budget restant du run.
      const outcome = await withinBudget(
        this.deps.router.route({ companyId: input.companyId, normalizedInboundId }),
        input.deadlineAtMs - this.deps.now()
      )
      if (outcome === ROUTER_TIMED_OUT) {
        return this.finish(input, noRouter(normalizedInboundId, ROUTING_SHADOW_COMPARISON_CODES.ROUTER_TIMEOUT), false)
      }
      routed = outcome
    } catch {
      return this.finish(input, noRouter(normalizedInboundId, ROUTING_SHADOW_COMPARISON_CODES.ROUTER_FAILED, true), false)
    }
    if (routed.status !== "DECIDED") {
      return this.finish(input, noRouter(normalizedInboundId, ROUTING_SHADOW_COMPARISON_CODES.ROUTER_DISABLED), false)
    }

    const d = routed.decision
    const parity = computeParity({
      legacy,
      router: d.outcome === "DUPLICATE" ? "ERROR" : d.outcome,
      routerReasonCode: d.reasonCode,
      diagnostics: routed.diagnostics,
    })
    return this.finish(
      input,
      {
        ...base,
        normalizedInboundId,
        routerOutcome: d.outcome === "DUPLICATE" ? "ERROR" : d.outcome,
        routingDecisionId: d.id,
        routingConfigurationVersion: d.routingConfigurationVersion,
        parityOutcome: parity.parityOutcome,
        explainedCodes: parity.explainedCodes,
        comparisonCode: null,
      },
      isUnexplainedDivergence(parity),
      routed.reused
    )
  }

  private async finish(
    input: RoutingShadowInput,
    observation: RecordParityObservationInput,
    unexplained: boolean,
    idempotentReuse = false
  ): Promise<RoutingShadowResult> {
    const recorded = await this.deps.observations.record(observation)
    this.deps.log(unexplained ? "warn" : "info", {
      message: "routing_parity_observed",
      companyId: input.companyId,
      connectionId: input.connectionId,
      normalizedInboundId: observation.normalizedInboundId,
      parityBaselineCode: PARITY_BASELINE_CODE,
      legacyOutcome: observation.legacyOutcome,
      routerOutcome: observation.routerOutcome,
      parityOutcome: observation.parityOutcome,
      explainedCodes: observation.explainedCodes,
      comparisonCode: observation.comparisonCode,
      unexplainedDivergence: unexplained,
      idempotentReuse,
      recorded,
    })
    return { status: "OBSERVED", parityOutcome: observation.parityOutcome, recorded }
  }
}

export { LEGACY_OUTCOME_CLASSES, PARITY_OUTCOMES }
