/**
 * LOT-2E — plan et application de l'amorçage du pilote (plan I8).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { applyPilotSeedPlan, buildPilotSeedPlan, summarizePilotSeedPlan, type LegacyPartnerInput } from "@/lib/integration/sources/pilot-seed"
import { parseSeedArgs } from "../../../scripts/lot2-seed-routing-pilot"

const partner = (over: Partial<LegacyPartnerInput> = {}): LegacyPartnerInput => ({
  id: "p1", name: "Maison Martin", pipeline: "consultations", active: true, requireExactEmail: false,
  domains: [{ value: "Maison-Martin.FR", active: true }, { value: "ancien.fr", active: false }],
  emails: [{ value: "contact@maison-martin.fr", active: true }],
  ...over,
})

describe("buildPilotSeedPlan", () => {
  it("domaines et emails actifs → règles d'identité normalisées, sans doublon", () => {
    const plan = buildPilotSeedPlan([partner({ domains: [{ value: "maison-martin.fr", active: true }, { value: "MAISON-MARTIN.fr", active: true }] })], [])
    assert.deepEqual(plan.sources[0]!.rules, [{ type: "SENDER_DOMAIN", value: "maison-martin.fr" }, { type: "SENDER_EMAIL", value: "contact@maison-martin.fr" }])
  })
  it("email exact requis : emails seulement ; sans email → écarté (NO_VALID_IDENTITY)", () => {
    assert.deepEqual(buildPilotSeedPlan([partner({ requireExactEmail: true })], []).sources[0]!.rules, [{ type: "SENDER_EMAIL", value: "contact@maison-martin.fr" }])
    assert.deepEqual(buildPilotSeedPlan([partner({ requireExactEmail: true, emails: [] })], []).skipped, [{ partnerId: "p1", code: "NO_VALID_IDENTITY" }])
  })
  it("inactif, autre pipeline, déjà amorcé (même nom, casse ignorée) : écartés avec un code stable", () => {
    const plan = buildPilotSeedPlan(
      [partner({ id: "a", active: false }), partner({ id: "b", pipeline: "autre" }), partner({ id: "c", name: "  maison martin " }), partner({ id: "d", name: "Neuf" })],
      ["Maison Martin"]
    )
    assert.deepEqual(plan.skipped, [
      { partnerId: "a", code: "INACTIVE" },
      { partnerId: "b", code: "PIPELINE_NOT_CONSULTATIONS" },
      { partnerId: "c", code: "ALREADY_SEEDED" },
    ])
    assert.deepEqual(plan.sources.map((s) => s.partnerId), ["d"])
  })
  it("valeurs invalides comptées et ignorées ; deux partenaires du même nom → un seul créé", () => {
    const plan = buildPilotSeedPlan([partner({ id: "a", domains: [{ value: "pas un domaine", active: true }] }), partner({ id: "b" })], [])
    assert.equal(plan.sources[0]!.invalidValues, 1)
    assert.deepEqual(plan.skipped, [{ partnerId: "b", code: "DUPLICATE_NAME" }])
  })
  it("résumé : compteurs et noms seulement, aucune valeur de domaine ni d'email", () => {
    const s = summarizePilotSeedPlan(buildPilotSeedPlan([partner(), partner({ id: "x", active: false })], []))
    assert.deepEqual([s.sourcesToCreate, s.rulesToCreate, s.senderDomainRules, s.senderEmailRules, s.skipped], [1, 2, 1, 1, { INACTIVE: 1 }])
    assert.doesNotMatch(JSON.stringify(s), /maison-martin\.fr|contact@/i)
  })
})

describe("rejeu après un échec partiel (revue du 24/11)", () => {
  it("Source du même nom restée incomplète : règles manquantes ajoutées, Binding réactivé, Source activée", () => {
    const plan = buildPilotSeedPlan([partner()], [{ id: "src1", displayName: "Maison Martin", enabled: false, ruleKeys: ["SENDER_DOMAIN|maison-martin.fr"], activeBindingId: null, inactiveBindingIds: ["b9"] }])
    assert.deepEqual(plan.sources, [])
    assert.deepEqual(plan.completions, [{ partnerId: "p1", sourceId: "src1", displayName: "Maison Martin", missingRules: [{ type: "SENDER_EMAIL", value: "contact@maison-martin.fr" }], bindingToEnable: "b9", createBinding: false, enableSource: true }])
  })
  it("Source complète : écartée (ALREADY_SEEDED) ; sans Binding : création prévue", () => {
    const complete = { id: "src1", displayName: "Maison Martin", enabled: true, ruleKeys: ["SENDER_DOMAIN|maison-martin.fr", "SENDER_EMAIL|contact@maison-martin.fr"], activeBindingId: "b1", inactiveBindingIds: [] }
    assert.deepEqual(buildPilotSeedPlan([partner()], [complete]).skipped, [{ partnerId: "p1", code: "ALREADY_SEEDED" }])
    const noBinding = buildPilotSeedPlan([partner()], [{ ...complete, activeBindingId: null }])
    assert.deepEqual([noBinding.completions[0]!.createBinding, noBinding.completions[0]!.bindingToEnable, noBinding.completions[0]!.missingRules], [true, null, []])
  })
  it("application : complète la Source existante", async () => {
    const calls: string[] = []
    const admin = {
      createSource: async () => { throw new Error("pas de création") },
      createRule: async (_a: unknown, i: { type: string; sourceId: string }) => { calls.push(`rule:${i.type}:${i.sourceId}`); return {} as never },
      createBinding: async () => { calls.push("binding"); return { id: "bN" } as never },
      setBindingEnabled: async (_a: unknown, id: string) => { calls.push(`binding:on:${id}`); return {} as never },
      setSourceEnabled: async (_a: unknown, id: string) => { calls.push(`source:on:${id}`); return {} as never },
    }
    const plan = buildPilotSeedPlan([partner()], [{ id: "src1", displayName: "Maison Martin", enabled: false, ruleKeys: [], activeBindingId: null, inactiveBindingIds: [] }])
    const r = await applyPilotSeedPlan(plan, { companyId: "coA", userId: "u1", role: "ADMIN" }, admin)
    assert.deepEqual([r.created.length, r.completed, r.failed], [0, [{ partnerId: "p1", sourceId: "src1", rulesAdded: 2 }], []])
    assert.deepEqual(calls, ["rule:SENDER_DOMAIN:src1", "rule:SENDER_EMAIL:src1", "binding", "binding:on:bN", "source:on:src1"])
  })
})

describe("applyPilotSeedPlan", () => {
  it("ordre : Source désactivée → règles → Binding → activation du Binding → activation de la Source ; un échec n'arrête pas la suite", async () => {
    const calls: string[] = []
    const actor = { companyId: "coA", userId: "u1", role: "ADMIN" }
    const admin = {
      createSource: async (_a: unknown, name: string) => { calls.push(`source:${name}`); if (name === "KO") throw new Error("x"); return { id: `s-${name}` } as never },
      createRule: async (_a: unknown, i: { type: string }) => { calls.push(`rule:${i.type}`); return {} as never },
      createBinding: async () => { calls.push("binding"); return { id: "b1" } as never },
      setBindingEnabled: async () => { calls.push("binding:on"); return {} as never },
      setSourceEnabled: async () => { calls.push("source:on"); return {} as never },
    }
    const plan = buildPilotSeedPlan([partner({ id: "a", name: "KO" }), partner({ id: "b", name: "OK" })], [])
    const r = await applyPilotSeedPlan(plan, actor, admin)
    assert.deepEqual(r.failed, [{ partnerId: "a", errorName: "Error" }])
    assert.deepEqual(r.created.map((c) => [c.partnerId, c.rules]), [["b", 2]])
    assert.deepEqual(calls, ["source:KO", "source:OK", "rule:SENDER_DOMAIN", "rule:SENDER_EMAIL", "binding", "binding:on", "source:on"])
  })
})

describe("script : arguments", () => {
  it("simulation par défaut ; --apply explicite", () => {
    assert.deepEqual(parseSeedArgs(["node", "x", "--companyId=c1", "--actorUserId=u1"]), { companyId: "c1", actorUserId: "u1", apply: false })
    assert.equal(parseSeedArgs(["node", "x", "--companyId=c1", "--actorUserId=u1", "--apply"]).apply, true)
  })
})
