/**
 * LOT-2D — parité legacy L1 ↔ Router (SPEC LOT-2 §14.5, §14.6 ; plan I6).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classifyLegacyOutcome,
  computeParity,
  isUnexplainedDivergence,
  type ParityInput,
} from "@/lib/integration/shadow/routing-parity"

const NONE = { qualifierGap: false, subjectKeywordRuleActive: false, bodyKeywordRuleActive: false, subjectPresent: true, bodyAvailable: false }

describe("classe legacy L1", () => {
  it("DRAFT_CREATED → ADMIT, REJECTED → REJECT, le reste → UNKNOWN", () => {
    assert.deepEqual(["DRAFT_CREATED", "REJECTED", "AUTRE", null, undefined].map(classifyLegacyOutcome), ["ADMIT", "REJECT", "UNKNOWN", "UNKNOWN", "UNKNOWN"])
  })
})

describe("table de projection §14.5", () => {
  const cases: [ParityInput["legacy"], ParityInput["router"], string][] = [
    ["ADMIT", "MATCH", "PARITY_MATCH"],
    ["REJECT", "NO_MATCH", "PARITY_REJECT"],
    ["REJECT", "NO_ACTIVE_BINDING", "PARITY_REJECT"],
    ["ADMIT", "NO_MATCH", "PARITY_LEGACY_ONLY"],
    ["ADMIT", "NO_ACTIVE_BINDING", "PARITY_LEGACY_ONLY"],
    ["REJECT", "MATCH", "PARITY_ROUTER_ONLY"],
    ["ADMIT", "AMBIGUOUS_SOURCE", "PARITY_UNCOMPARABLE"],
    ["REJECT", "ERROR", "PARITY_UNCOMPARABLE"],
    ["UNKNOWN", "MATCH", "PARITY_UNCOMPARABLE"],
    ["ADMIT", null, "PARITY_UNCOMPARABLE"],
  ]
  for (const [legacy, router, expected] of cases) {
    it(`${legacy} × ${router ?? "aucune décision"} → ${expected}`, () => {
      assert.equal(computeParity({ legacy, router, diagnostics: NONE }).parityOutcome, expected)
    })
  }
  it("erreur technique de comparaison → PARITY_ERROR", () => {
    assert.equal(computeParity({ legacy: "ADMIT", router: null, comparisonFailed: true }).parityOutcome, "PARITY_ERROR")
  })
})

describe("divergences expliquées §14.6", () => {
  it("MATCH Router : annotation EXPLAINED_MATCH_NO_DRAFT, qui n'explique pas une divergence à elle seule", () => {
    const r = computeParity({ legacy: "REJECT", router: "MATCH", diagnostics: NONE })
    assert.deepEqual([r.parityOutcome, r.explainedCodes], ["PARITY_ROUTER_ONLY", ["EXPLAINED_MATCH_NO_DRAFT"]])
    assert.equal(isUnexplainedDivergence(r), true)
    const ok = computeParity({ legacy: "ADMIT", router: "MATCH", diagnostics: NONE })
    assert.deepEqual([ok.parityOutcome, ok.explainedCodes, isUnexplainedDivergence(ok)], ["PARITY_MATCH", ["EXPLAINED_MATCH_NO_DRAFT"], false])
  })
  it("configuration non amorcée, objet absent, corps indisponible, qualificatif manquant", () => {
    const r = computeParity({
      legacy: "ADMIT",
      router: "NO_MATCH",
      routerReasonCode: "NO_ENABLED_SOURCE",
      diagnostics: { qualifierGap: true, subjectKeywordRuleActive: true, bodyKeywordRuleActive: true, subjectPresent: false, bodyAvailable: false },
    })
    assert.equal(r.parityOutcome, "PARITY_LEGACY_ONLY")
    assert.deepEqual(r.explainedCodes, ["EXPLAINED_BODY_UNAVAILABLE", "EXPLAINED_CONFIG_NOT_SEEDED", "EXPLAINED_QUALIFIER_GAP", "EXPLAINED_SUBJECT_ABSENT"])
    assert.equal(isUnexplainedDivergence(r), false)
  })
  it("divergence LEGACY_ONLY sans explication : non expliquée", () => {
    const r = computeParity({ legacy: "ADMIT", router: "NO_MATCH", routerReasonCode: "NO_CANDIDATE", diagnostics: NONE })
    assert.deepEqual([r.explainedCodes, isUnexplainedDivergence(r)], [[], true])
  })
  it("qualificatif manquant ne s'applique qu'à un admit legacy", () => {
    const r = computeParity({ legacy: "REJECT", router: "NO_MATCH", diagnostics: { ...NONE, qualifierGap: true } })
    assert.deepEqual(r.explainedCodes, [])
  })
})
