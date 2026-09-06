/**
 * PLAN-ACQ-V2 Lot F — Tests policy avec seuils partenaire.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"

describe("evaluateAutoDecision Lot F / registre", () => {
  const okBase = {
    worksiteName: "Site",
    startDate: new Date("2026-08-01"),
    endDate: new Date("2026-08-02"),
    address: "1 rue A",
    city: "Lyon",
    clientName: "Client",
    clientEmail: "c@x.fr",
    confidenceData: {
      worksiteName: 0.9,
      requestedStartDate: 0.9,
      requestedEndDate: 0.9,
    },
    warningData: [],
  }

  it("partenaire auto OFF → HUMAN même si flags seraient ON", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      autoApproveEnabled: false,
      autoConvertEnabled: true,
      minConfidence: 0.5,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
  })

  it("seuil partenaire plus strict → HUMAN", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.95,
      confidenceData: {
        worksiteName: 0.8,
        requestedStartDate: 0.9,
        requestedEndDate: 0.9,
      },
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
  })

  it("partenaire auto approve+convert + seuils OK → CONVERT", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
    })
    assert.equal(r.code, "AUTO_APPROVE_CONVERT")
  })

  it("PROVIDENCE-DATES — NULL/NULL → pas INVALID_DATES ni LOW_CONFIDENCE dates", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      startDate: null,
      endDate: null,
      confidenceData: { worksiteName: 0.9 },
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.75,
    })
    assert.equal(r.code, "AUTO_APPROVE_CONVERT")
    assert.equal(r.reasons.includes("INVALID_DATES"), false)
    assert.equal(r.reasons.some((x) => x.startsWith("LOW_CONFIDENCE:requested")), false)
  })

  it("PROVIDENCE-DATES — DATE/NULL → INVALID_DATES", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      endDate: null,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("INVALID_DATES"))
  })

  it("PROVIDENCE-DATES — NULL/DATE → INVALID_DATES", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      startDate: null,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("INVALID_DATES"))
  })

  it("PROVIDENCE-DATES — start > end → INVALID_DATES", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      startDate: new Date("2026-08-10"),
      endDate: new Date("2026-08-01"),
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("INVALID_DATES"))
  })

  it("PROVIDENCE-DATES — dates valides + conf basse → LOW_CONFIDENCE dates", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.75,
      confidenceData: {
        worksiteName: 0.9,
        requestedStartDate: 0.2,
        requestedEndDate: 0.2,
      },
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("LOW_CONFIDENCE:requestedStartDate"))
    assert.ok(r.reasons.includes("LOW_CONFIDENCE:requestedEndDate"))
  })

  it("duplicate → toujours bloqué", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      startDate: null,
      endDate: null,
      confidenceData: { worksiteName: 0.9 },
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
      potentialDuplicate: true,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("POTENTIAL_DUPLICATE"))
  })

  it("adresse insuffisante → toujours bloquée", () => {
    const r = evaluateAutoDecision({
      ...okBase,
      startDate: null,
      endDate: null,
      address: "x",
      city: "Y",
      confidenceData: { worksiteName: 0.9 },
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.7,
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.includes("AMBIGUOUS_ADDRESS"))
  })

  it("fixture Lycée La Providence → AUTO_APPROVE_CONVERT", () => {
    const r = evaluateAutoDecision({
      worksiteName: "LYCEE LA PROVIDENCE 49",
      startDate: null,
      endDate: null,
      address: "33 AVENUE GUSTAVE FERRIE",
      postalCode: "49030",
      city: "CHOLET",
      clientName: "Lycée La Providence",
      clientEmail: null,
      confidenceData: { worksiteName: 0.85 },
      warningData: [
        { code: "DATE_AMBIGUOUS", blocking: false },
        { code: "LOW_CONFIDENCE", field: "requestedWeekNumber", blocking: false },
        { code: "PROVIDER_PARTIAL_RESULT", blocking: false },
      ],
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.75,
      hasResolvedClient: true,
    })
    assert.equal(r.code, "AUTO_APPROVE_CONVERT")
    assert.deepEqual(r.reasons, ["THRESHOLDS_OK"])
  })
})
