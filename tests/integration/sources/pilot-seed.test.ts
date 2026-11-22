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
    assert.deepEqual(plan.skipped, [{ partnerId: "b", code: "ALREADY_SEEDED" }])
  })
  it("résumé : compteurs et noms seulement, aucune valeur de domaine ni d'email", () => {
    const s = summarizePilotSeedPlan(buildPilotSeedPlan([partner(), partner({ id: "x", active: false })], []))
    assert.deepEqual([s.sourcesToCreate, s.rulesToCreate, s.senderDomainRules, s.senderEmailRules, s.skipped], [1, 2, 1, 1, { INACTIVE: 1 }])
    assert.doesNotMatch(JSON.stringify(s), /maison-martin\.fr|contact@/i)
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
