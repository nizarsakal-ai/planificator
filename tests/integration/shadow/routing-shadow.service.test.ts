/**
 * LOT-2D — service de shadow matching (SPEC LOT-2 §14, §16, §17 ; plan §7) avec des ports simulés.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { RoutingShadowService, hashExternalId, type RoutingShadowDeps } from "@/lib/integration/shadow/routing-shadow.service"
import type { RecordParityObservationInput } from "@/lib/integration/persistence/routing-parity-observation.repository"

const ON = {
  INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
  INTEGRATION_ROUTING_ENABLED: "true",
  INTEGRATION_ROUTING_SHADOW_ENABLED: "true",
  INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "coA",
}
const RCV = "rcv1_" + "a".repeat(64)
const input = { companyId: "coA", connectionId: "cn1", idempotencyKey: "gmail-123", externalId: "gmail-123", legacyOutcome: "DRAFT_CREATED", deadlineAtMs: 10_000 }
const diag = { qualifierGap: false, subjectGap: false, bodyGap: false, subjectKeywordRuleActive: false, bodyKeywordRuleActive: false, subjectPresent: true, bodyAvailable: false }

function harness(over: Partial<RoutingShadowDeps> = {}, outcome: "MATCH" | "NO_MATCH" | "ERROR" = "MATCH") {
  const observations: RecordParityObservationInput[] = []
  const logs: Record<string, unknown>[] = []
  let routes = 0
  const deps: Partial<RoutingShadowDeps> = {
    env: ON,
    now: () => 1_000,
    findNormalizedId: async () => "ni1",
    router: {
      route: async () => {
        routes++
        return {
          status: "DECIDED" as const,
          reused: false,
          rulesEvaluated: 1,
          durationMs: 1,
          diagnostics: diag,
          decision: {
            id: "d1", companyId: "coA", normalizedInboundId: "ni1", outcome,
            matchedSourceIds: outcome === "MATCH" ? ["s1"] : [], pipelineIds: outcome === "MATCH" ? ["consultations"] : [],
            routingConfigurationVersion: RCV, decidedAt: "2026-11-22T10:00:00.000Z", schemaVersion: "1.0.0",
          },
        }
      },
    },
    observations: { record: async (o) => { observations.push(o); return true } },
    log: (_level, f) => logs.push(f),
    ...over,
  }
  return { svc: new RoutingShadowService(deps), observations, logs, routes: () => routes }
}

describe("RoutingShadowService", () => {
  it("flags coupés (shadow, routing, foundation ou allowlist) : rien n'est lu ni écrit", async () => {
    for (const env of [{}, { ...ON, INTEGRATION_ROUTING_SHADOW_ENABLED: "false" }, { ...ON, INTEGRATION_ROUTING_ENABLED: "" }, { ...ON, INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "1" }, { ...ON, INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "coB" }]) {
      const h = harness({ env, findNormalizedId: async () => { throw new Error("ne doit pas être lu") } })
      assert.deepEqual(await h.svc.observe(input), { status: "DISABLED" })
      assert.equal(h.observations.length, 0)
    }
  })
  it("legacy admit × Router MATCH → PARITY_MATCH, décision citée, identifiant externe haché", async () => {
    const h = harness()
    const r = await h.svc.observe(input)
    assert.deepEqual(r, { status: "OBSERVED", parityOutcome: "PARITY_MATCH", recorded: true })
    const o = h.observations[0]!
    assert.deepEqual([o.legacyOutcome, o.routerOutcome, o.routingDecisionId, o.routingConfigurationVersion, o.normalizedInboundId], ["ADMIT", "MATCH", "d1", RCV, "ni1"])
    assert.equal(o.externalIdHash, hashExternalId("gmail-123"))
    assert.match(o.externalIdHash, /^[0-9a-f]{64}$/)
    assert.deepEqual(o.explainedCodes, ["EXPLAINED_MATCH_NO_DRAFT"])
  })
  it("legacy rejet × Router MATCH → PARITY_ROUTER_ONLY, journal en avertissement (divergence non expliquée)", async () => {
    const h = harness()
    await h.svc.observe({ ...input, legacyOutcome: "REJECTED" })
    assert.equal(h.observations[0]!.parityOutcome, "PARITY_ROUTER_ONLY")
    assert.equal(h.logs[0]!.unexplainedDivergence, true)
  })
  it("budget dépassé : aucun routage, observation PARITY_UNCOMPARABLE (BUDGET_EXCEEDED)", async () => {
    const h = harness({ now: () => 20_000 })
    await h.svc.observe(input)
    assert.equal(h.routes(), 0)
    assert.deepEqual([h.observations[0]!.parityOutcome, h.observations[0]!.comparisonCode, h.observations[0]!.routerOutcome], ["PARITY_UNCOMPARABLE", "BUDGET_EXCEEDED", null])
  })
  it("message normalisé introuvable : PARITY_UNCOMPARABLE (NORMALIZED_NOT_FOUND)", async () => {
    const h = harness({ findNormalizedId: async () => null })
    await h.svc.observe(input)
    assert.deepEqual([h.observations[0]!.parityOutcome, h.observations[0]!.comparisonCode], ["PARITY_UNCOMPARABLE", "NORMALIZED_NOT_FOUND"])
  })
  it("Router en échec : PARITY_ERROR enregistrée, aucune exception", async () => {
    const h = harness({ router: { route: async () => { throw new Error("db down") } } })
    const r = await h.svc.observe(input)
    assert.equal(r.status, "OBSERVED")
    assert.deepEqual([h.observations[0]!.parityOutcome, h.observations[0]!.comparisonCode], ["PARITY_ERROR", "ROUTER_FAILED"])
  })
  it("persistance de l'observation en échec : FAILED, jamais d'exception vers l'appelant", async () => {
    const h = harness({ observations: { record: async () => { throw new Error("db down") } } })
    assert.deepEqual(await h.svc.observe(input), { status: "FAILED" })
  })
  it("journaux : codes et identifiants opaques seulement, jamais l'identifiant externe en clair", async () => {
    const h = harness()
    await h.svc.observe(input)
    const line = JSON.stringify(h.logs)
    assert.doesNotMatch(line, /gmail-123/)
    for (const k of ["parityBaselineCode", "parityOutcome", "legacyOutcome", "routerOutcome", "explainedCodes"]) assert.ok(k in h.logs[0]!, k)
    assert.equal(h.logs[0]!.parityBaselineCode, "L1_REGISTER_INCOMING_MESSAGE")
  })
  it("routage plus long que le budget restant : abandon côté shadow (ROUTER_TIMEOUT), la synchronisation n'attend pas", async () => {
    let clock = 0
    const slow = { route: () => new Promise<never>(() => undefined) }
    const h = harness({ now: () => clock, router: slow as never })
    const started = Date.now()
    const r = await h.svc.observe({ ...input, deadlineAtMs: 50 })
    assert.ok(Date.now() - started < 1_000, "attente bornée au budget restant")
    assert.equal(r.status, "OBSERVED")
    assert.deepEqual([h.observations[0]!.parityOutcome, h.observations[0]!.comparisonCode, h.observations[0]!.routerOutcome], ["PARITY_UNCOMPARABLE", "ROUTER_TIMEOUT", null])
  })
})
