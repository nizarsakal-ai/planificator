/**
 * PLAN-ACQ-V2 Lot F — Tests policy auto-decision (pure) + R2 query/excerpts.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"
import { buildAcquisitionGmailLookbackQuery } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { buildAttachmentTextExcerpts } from "@/lib/acquisition/extraction/attachment-text-excerpts"
import { normalizeAddressKey } from "@/lib/acquisition/matching/client-match.service"
import * as orchestratorWorkers from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { runProductionAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"

describe("evaluateAutoDecision", () => {
  const base = {
    worksiteName: "Chantier Alpha",
    startDate: new Date("2026-08-01"),
    endDate: new Date("2026-08-05"),
    address: "10 rue Test",
    city: "Paris",
    clientName: "Client SA",
    clientEmail: "c@example.com",
    confidenceData: {
      worksiteName: 0.9,
      requestedStartDate: 0.9,
      requestedEndDate: 0.9,
    },
    warningData: [],
    autoApproveEnabled: true,
    autoConvertEnabled: true,
    minConfidence: 0.75,
  }

  it("seuils OK + convert → AUTO_APPROVE_CONVERT", () => {
    const r = evaluateAutoDecision(base)
    assert.equal(r.code, "AUTO_APPROVE_CONVERT")
  })

  it("convert OFF → AUTO_APPROVE_ONLY", () => {
    const r = evaluateAutoDecision({ ...base, autoConvertEnabled: false })
    assert.equal(r.code, "AUTO_APPROVE_ONLY")
  })

  it("confiance basse → HUMAN_REVIEW", () => {
    const r = evaluateAutoDecision({
      ...base,
      confidenceData: { worksiteName: 0.2, requestedStartDate: 0.9, requestedEndDate: 0.9 },
    })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(r.reasons.some((x) => x.startsWith("LOW_CONFIDENCE")))
  })

  it("approve OFF → HUMAN_REVIEW", () => {
    const r = evaluateAutoDecision({ ...base, autoApproveEnabled: false })
    assert.equal(r.code, "HUMAN_REVIEW_REQUIRED")
  })
})

describe("buildAcquisitionGmailLookbackQuery Lot D/R2", () => {
  it("sans domaines → fail-closed", () => {
    const q = buildAcquisitionGmailLookbackQuery(7)
    assert.equal(q.ok, false)
  })

  it("avec domaines → from:@", () => {
    const q = buildAcquisitionGmailLookbackQuery(7, {
      domains: ["lauralu.fr", "@Other.FR"],
      emails: [],
    })
    assert.equal(q.ok, true)
    if (q.ok) {
      assert.ok(q.query.includes("from:@lauralu.fr"))
      assert.ok(q.query.includes("from:@other.fr"))
    }
  })
})

describe("attachment-text-excerpts Lot E", () => {
  it("PDF avec texte → excerpt ; image ignorée", async () => {
    const { excerpts } = await buildAttachmentTextExcerpts([
      {
        filename: "plan.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        extractedText: "Surface 120m2",
      },
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        category: "PHOTO",
        extractedText: "ignored",
      },
    ])
    assert.equal(excerpts.length, 1)
    assert.equal(excerpts[0].filename, "plan.pdf")
  })
})

describe("normalizeAddressKey Lot G", () => {
  it("normalise espaces et casse", () => {
    assert.equal(
      normalizeAddressKey({ address: "  10 Rue  Test ", postalCode: "75001", city: "Paris" }),
      "10 rue test|75001|paris"
    )
  })
})

describe("Lot B production wiring", () => {
  it("entrée production unique, factory runners non exportée", () => {
    assert.equal(typeof runProductionAcquisitionOrchestrator, "function")
    assert.equal("createProductionStepRunners" in orchestratorWorkers, false)
    assert.equal("ProductionStepRunnersDeps" in orchestratorWorkers, false)
  })
})
