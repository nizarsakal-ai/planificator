/**
 * LOT-2E — simulateur de routage (SPEC LOT-2 §20.4 ; plan I7) avec un snapshot simulé.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { simulateRouting, RoutingSimulatorForbiddenError, RoutingSimulatorInputError } from "@/lib/integration/simulator/simulate-routing"
import type { RoutingConfigRows } from "@/lib/integration/persistence/routing-config-snapshot.repository"

const admin = { companyId: "coA", userId: "u1", role: "ADMIN" }
const rows = (over: Partial<RoutingConfigRows> = {}): RoutingConfigRows => ({
  companyId: "coA",
  sources: [{ id: "s1", enabled: true }],
  rules: [{ id: "r1", sourceId: "s1", type: "SENDER_DOMAIN", normalizedValue: "maison-martin.fr", enabled: true }],
  bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: true, connectionId: null }],
  limitExceeded: false,
  ...over,
})
const msg = { externalMessageId: "sim-1", contentCapabilities: [], sender: { email: "contact@maison-martin.fr" } }

describe("simulateRouting", () => {
  it("MATCH avec l'empreinte de la configuration ; rien n'est persisté", async () => {
    let loadedFor = ""
    const r = await simulateRouting(admin, { message: msg }, { config: { load: async (co) => { loadedFor = co; return rows() } } })
    assert.deepEqual([r.outcome, r.matchedSourceIds, r.pipelineIds, r.persisted], ["MATCH", ["s1"], ["consultations"], false])
    assert.match(r.routingConfigurationVersion, /^rcv1_[0-9a-f]{64}$/)
    assert.equal(loadedFor, "coA", "toujours la société de la session")
  })
  it("refuse tout rôle non administrateur et toute identité incomplète, sans rien lire", async () => {
    for (const actor of [{ ...admin, role: "EMPLOYEE" }, { ...admin, role: "TEAM_LEADER" }, { ...admin, userId: "" }, { ...admin, companyId: "" }]) {
      await assert.rejects(simulateRouting(actor, { message: msg }, { config: { load: async () => { throw new Error("ne doit pas être lu") } } }), RoutingSimulatorForbiddenError)
    }
  })
  it("message non conforme au contrat MESSAGE V1 refusé", async () => {
    await assert.rejects(simulateRouting(admin, { message: { sender: {} } }, { config: { load: async () => rows() } }), RoutingSimulatorInputError)
  })
  it("Binding limité à une Connection : satisfait seulement avec cette Connection", async () => {
    const scoped = rows({ bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: true, connectionId: "cnX" }] })
    assert.equal((await simulateRouting(admin, { message: msg }, { config: { load: async () => scoped } })).outcome, "NO_MATCH")
    assert.equal((await simulateRouting(admin, { message: msg, connectionId: "cnX" }, { config: { load: async () => scoped } })).outcome, "MATCH")
  })
  it("BODY_KEYWORD : port indisponible par défaut, ne matche pas", async () => {
    const withBody = rows({ rules: [...rows().rules, { id: "r2", sourceId: "s1", type: "BODY_KEYWORD", normalizedValue: "chapiteau", enabled: true }] })
    const r = await simulateRouting(admin, { message: msg }, { config: { load: async () => withBody } })
    assert.deepEqual([r.outcome, r.diagnostics.bodyKeywordRuleActive, r.diagnostics.bodyAvailable], ["NO_MATCH", true, false])
  })
  it("bornes dépassées → ERROR (CONFIG_LIMIT_EXCEEDED)", async () => {
    const r = await simulateRouting(admin, { message: msg }, { config: { load: async () => rows({ limitExceeded: true }) } })
    assert.deepEqual([r.outcome, r.reasonCode], ["ERROR", "CONFIG_LIMIT_EXCEEDED"])
  })
})
