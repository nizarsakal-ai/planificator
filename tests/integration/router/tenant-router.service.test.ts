/**
 * LOT-2C — Orchestration du Router (SPEC LOT-2 §9.2, §10, §16, §17) avec des ports simulés.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TenantRouterService, type TenantRouterDeps } from "@/lib/integration/router/tenant-router.service"
import type { RecordRoutingDecisionInput } from "@/lib/integration/persistence/routing-decision.repository"
import type { RoutingConfigRows } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import type { NormalizedInbound } from "@/lib/integration/contracts/normalized-inbound"
import { IntegrationInboundValidationError } from "@/lib/integration/persistence/integration-inbound.errors"

const ON = {
  INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
  INTEGRATION_ROUTING_ENABLED: "true",
  INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "coA",
}
const normalized: NormalizedInbound = {
  id: "ni1", companyId: "coA", connectionId: "cn1", envelopeId: "env1", family: "MESSAGE",
  occurredAt: "2026-11-22T10:00:00.000Z", receivedAt: "2026-11-22T10:00:01.000Z", normalizedHash: "h", artifactRefs: [],
  schemaVersion: "1.0.0",
  message: { externalMessageId: "e1", contentCapabilities: [], sender: { email: "contact@maison-martin.fr" }, subject: "Demande de devis" },
}
const config = (over: Partial<RoutingConfigRows> = {}): RoutingConfigRows => ({
  companyId: "coA",
  sources: [{ id: "s1", enabled: true }],
  rules: [{ id: "r1", sourceId: "s1", type: "SENDER_DOMAIN", normalizedValue: "maison-martin.fr", enabled: true }],
  bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: true, connectionId: null }],
  limitExceeded: false,
  ...over,
})

function harness(over: Partial<TenantRouterDeps> = {}) {
  const store = new Map<string, RecordRoutingDecisionInput & { id: string }>()
  const logs: Record<string, unknown>[] = []
  let bodyReads = 0
  let n = 0
  const deps: Partial<TenantRouterDeps> = {
    env: ON,
    normalized: { findById: async () => normalized },
    config: { load: async () => config() },
    body: { read: async () => { bodyReads++; return { available: false } } },
    decisions: {
      record: async (input) => {
        const key = `${input.companyId}|${input.normalizedInboundId}|${input.routingConfigurationVersion}`
        const existing = store.get(key)
        const row = existing ?? { ...input, id: `d${++n}` }
        if (!existing) store.set(key, row)
        return {
          reused: Boolean(existing),
          decision: { id: row.id, companyId: row.companyId, normalizedInboundId: row.normalizedInboundId, outcome: row.outcome, matchedSourceIds: row.matchedSourceIds, pipelineIds: row.pipelineIds, reasonCode: row.reasonCode, routingConfigurationVersion: row.routingConfigurationVersion, decidedAt: "2026-11-22T10:00:02.000Z", schemaVersion: "1.0.0" },
        }
      },
    },
    log: (f) => logs.push(f),
    ...over,
  }
  return { svc: new TenantRouterService(deps), store, logs, bodyReads: () => bodyReads }
}

describe("TenantRouterService", () => {
  it("flags coupés (foundation, routing ou allowlist) : rien n'est décidé ni écrit", async () => {
    for (const env of [{}, { ...ON, INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "false" }, { ...ON, INTEGRATION_ROUTING_ENABLED: "TRUE" }, { ...ON, INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "coB" }]) {
      const h = harness({ env })
      assert.deepEqual(await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" }), { status: "DISABLED" })
      assert.equal(h.store.size, 0)
    }
  })
  it("MATCH persisté avec l'empreinte ; rejeu : même décision, outcome inchangé, aucune nouvelle ligne", async () => {
    const h = harness()
    const a = await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    const b = await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.ok(a.status === "DECIDED" && b.status === "DECIDED")
    assert.equal(a.decision.outcome, "MATCH")
    assert.match(a.decision.routingConfigurationVersion, /^rcv1_[0-9a-f]{64}$/)
    assert.deepEqual([b.decision.id, b.decision.outcome, b.reused, a.reused], [a.decision.id, "MATCH", true, false])
    assert.equal(h.store.size, 1)
    assert.ok(![...h.store.values()].some((d) => (d.outcome as string) === "DUPLICATE"))
  })
  it("configuration modifiée : nouvelle décision (historique conservé)", async () => {
    let cfg = config()
    const h = harness({ config: { load: async () => cfg } })
    await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    cfg = config({ bindings: [] })
    const r = await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.ok(r.status === "DECIDED" && r.decision.outcome === "NO_ACTIVE_BINDING" && !r.reused)
    assert.equal(h.store.size, 2)
  })
  it("le port corps n'est lu que si une règle BODY_KEYWORD est active", async () => {
    const h1 = harness()
    await h1.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.equal(h1.bodyReads(), 0)
    const h2 = harness({ config: { load: async () => config({ rules: [...config().rules, { id: "r2", sourceId: "s1", type: "BODY_KEYWORD", normalizedValue: "chapiteau", enabled: true }] }) } })
    const r = await h2.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.equal(h2.bodyReads(), 1)
    assert.ok(r.status === "DECIDED" && r.decision.outcome === "NO_MATCH")
  })
  it("NormalizedInbound non conforme → décision ERROR (INVALID_NORMALIZED_MESSAGE)", async () => {
    const h = harness({ normalized: { findById: async () => { throw new IntegrationInboundValidationError("x") } } })
    const r = await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.ok(r.status === "DECIDED")
    assert.deepEqual([r.decision.outcome, r.decision.reasonCode], ["ERROR", "INVALID_NORMALIZED_MESSAGE"])
  })
  it("bornes de configuration dépassées → décision ERROR (CONFIG_LIMIT_EXCEEDED)", async () => {
    const h = harness({ config: { load: async () => config({ limitExceeded: true }) } })
    const r = await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.ok(r.status === "DECIDED" && r.decision.reasonCode === "CONFIG_LIMIT_EXCEEDED")
  })
  it("journal : identifiants opaques et compteurs seulement, jamais email, objet ni valeur de règle", async () => {
    const h = harness()
    await h.svc.route({ companyId: "coA", normalizedInboundId: "ni1" })
    assert.equal(h.logs.length, 1)
    const line = JSON.stringify(h.logs[0])
    assert.doesNotMatch(line, /maison-martin|devis|contact@/i)
    for (const k of ["outcome", "rulesEvaluated", "idempotentReuse", "durationMs", "companyId", "normalizedInboundId"]) assert.ok(k in h.logs[0]!, k)
  })
})
