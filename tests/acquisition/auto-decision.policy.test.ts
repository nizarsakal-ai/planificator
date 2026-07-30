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
})
