/** Lot E Planificator V2 : règles pures des opportunités (champs, étapes, pipeline pondéré au centime, relances). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CRM_ERRORS, DEFAULT_PROBABILITY_BP, computePipeline, planStageChange, validateFields, validateNote, weightedCents } from "@/lib/crm/crm.core"

const NOW = new Date("2026-11-04T09:00:00Z")
const day = (s: string) => new Date(`${s}T00:00:00Z`)

describe("opportunités : champs", () => {
  it("client OU prospect obligatoire ; prospect ignoré si client choisi ; probabilité par défaut de l'étape", () => {
    assert.deepEqual(validateFields({ title: "Façade", prospectName: " M. Prospect ", amountCents: BigInt(100) }, "QUALIFIED"), {
      ok: true, value: { title: "Façade", clientId: null, prospectName: "M. Prospect", amountCents: BigInt(100), probabilityBp: 2500, expectedCloseDate: null, nextFollowUpDate: null, followUpNote: null },
    })
    const withClient = validateFields({ title: "Façade", clientId: "c1", prospectName: "X", amountCents: BigInt(0), probabilityBp: 3333 }, "LEAD")
    assert.ok(withClient.ok)
    if (withClient.ok) assert.deepEqual([withClient.value.prospectName, withClient.value.probabilityBp], [null, 3333])
    assert.deepEqual(validateFields({ title: "Façade", amountCents: BigInt(0) }, "LEAD"), { ok: false, error: CRM_ERRORS.party })
    assert.deepEqual(validateFields({ title: "Fa", clientId: "c", amountCents: BigInt(0) }, "LEAD"), { ok: false, error: CRM_ERRORS.title })
    assert.deepEqual(validateFields({ title: "Façade", clientId: "c", amountCents: -BigInt(1) }, "LEAD"), { ok: false, error: CRM_ERRORS.amount })
    assert.deepEqual(validateFields({ title: "Façade", clientId: "c", amountCents: BigInt(0), probabilityBp: 10001 }, "LEAD"), { ok: false, error: CRM_ERRORS.probability })
    assert.deepEqual(validateFields({ title: "Façade", clientId: "c", amountCents: BigInt(0), followUpNote: "n".repeat(1001) }, "LEAD"), { ok: false, error: CRM_ERRORS.followUpNote })
  })
})

describe("opportunités : étapes", () => {
  it("ouverte → ouverte : probabilité par défaut ; gagnée 100 % et close ; perdue 0 %, motif obligatoire", () => {
    assert.deepEqual(planStageChange("LEAD", "PROPOSAL", null, NOW), { ok: true, value: { stage: "PROPOSAL", probabilityBp: 5000, closedAt: null, lostReason: null } })
    assert.deepEqual(planStageChange("NEGOTIATION", "WON", null, NOW), { ok: true, value: { stage: "WON", probabilityBp: 10000, closedAt: NOW, lostReason: null } })
    assert.deepEqual(planStageChange("PROPOSAL", "LOST", " Prix trop élevé ", NOW), { ok: true, value: { stage: "LOST", probabilityBp: 0, closedAt: NOW, lostReason: "Prix trop élevé" } })
    assert.deepEqual(planStageChange("PROPOSAL", "LOST", "x", NOW), { ok: false, error: CRM_ERRORS.lostReason })
  })
  it("close figée ; étape inconnue ou identique refusée", () => {
    assert.deepEqual(planStageChange("WON", "LEAD", null, NOW), { ok: false, error: CRM_ERRORS.closed })
    assert.deepEqual(planStageChange("LOST", "WON", null, NOW), { ok: false, error: CRM_ERRORS.closed })
    assert.deepEqual(planStageChange("LEAD", "SIGNED", null, NOW), { ok: false, error: CRM_ERRORS.stage })
    assert.deepEqual(planStageChange("LEAD", "LEAD", null, NOW), { ok: false, error: CRM_ERRORS.sameStage })
  })
  it("note : 3 à 2 000 caractères", () => {
    assert.deepEqual(validateNote(" Appel fait "), { ok: true, value: "Appel fait" })
    assert.deepEqual(validateNote("ok"), { ok: false, error: CRM_ERRORS.note })
  })
})

describe("pipeline", () => {
  it("pondéré au centime (moitié vers le haut), étapes ouvertes seulement ; relances dues", () => {
    assert.equal(weightedCents(BigInt(333), 5000), BigInt(167), "166,5 → 167")
    assert.equal(weightedCents(BigInt(10_000_00), DEFAULT_PROBABILITY_BP.QUALIFIED), BigInt(250_000))
    const p = computePipeline([
      { stage: "LEAD", amountCents: BigInt(1_000_000), probabilityBp: 1000, nextFollowUpDate: day("2026-11-04") },
      { stage: "PROPOSAL", amountCents: BigInt(333), probabilityBp: 5000, nextFollowUpDate: day("2026-11-05") },
      { stage: "NEGOTIATION", amountCents: BigInt(2_000_000), probabilityBp: 7500, nextFollowUpDate: day("2026-10-01") },
      { stage: "WON", amountCents: BigInt(5_000_000), probabilityBp: 10000, nextFollowUpDate: day("2026-10-01") },
      { stage: "LOST", amountCents: BigInt(7_000_000), probabilityBp: 0, nextFollowUpDate: null },
    ], day("2026-11-04"))
    assert.equal(p.openCount, 3)
    assert.equal(p.openAmountCents, BigInt(1_000_000) + BigInt(333) + BigInt(2_000_000))
    assert.equal(p.openWeightedCents, BigInt(100_000) + BigInt(167) + BigInt(1_500_000))
    assert.equal(p.followUpsDue, 2, "LEAD (aujourd'hui) et NEGOTIATION (passée) ; WON exclue, PROPOSAL future")
    assert.deepEqual(p.rows.map((r) => [r.stage, r.count]), [["LEAD", 1], ["QUALIFIED", 0], ["PROPOSAL", 1], ["NEGOTIATION", 1], ["WON", 1], ["LOST", 1]])
    assert.equal(p.rows.find((r) => r.stage === "WON")!.weightedCents, BigInt(5_000_000))
  })
})
