process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  getConsultationUiActions,
  getReExtractPolicy,
  mapWarningDataToPublicView,
  truncateSubject,
  hasBlockingWarnings,
} from "@/lib/acquisition/review/consultation-ui"
import { toConsultationProposedFormDto } from "@/lib/acquisition/review/consultation-proposed-form.dto"
import type { ImportDraftReviewBundle } from "@/lib/acquisition/review/import-draft-review.types"

describe("consultation-ui helpers", () => {
  it("matrice actions PENDING_REVIEW", () => {
    const a = getConsultationUiActions("PENDING_REVIEW")
    assert.equal(a.canEdit, true)
    assert.equal(a.canApprove, true)
    assert.equal(a.canReject, true)
    assert.equal(a.canReExtract, true)
  })

  it("matrice actions FAILED", () => {
    const a = getConsultationUiActions("FAILED")
    assert.equal(a.canEdit, true)
    assert.equal(a.canApprove, false)
    assert.equal(a.canReject, false)
    assert.equal(a.canReExtract, true)
  })

  it("matrice APPROVED lecture seule", () => {
    const a = getConsultationUiActions("APPROVED")
    assert.equal(a.canEdit, false)
    assert.equal(a.canSave, false)
    assert.equal(a.canReExtract, false)
  })

  it("re-extract disabled si flag extraction OFF", () => {
    const a = getConsultationUiActions("PENDING_REVIEW", { extractionEnabled: false })
    assert.equal(a.canReExtract, false)
  })

  it("getReExtractPolicy aligné UI", () => {
    const policy = getReExtractPolicy("PENDING_REVIEW")
    assert.equal(policy.allowed, true)
    if (policy.allowed) assert.equal(policy.force, true)
    assert.equal(getConsultationUiActions("EXTRACTING").canReExtract, false)
    assert.equal(getReExtractPolicy("EXTRACTING").allowed, false)
  })

  it("truncateSubject", () => {
    assert.equal(truncateSubject("abc", 10), "abc")
    assert.ok(truncateSubject("x".repeat(200), 20).endsWith("…"))
  })

  it("warning catalogue + inconnu générique sans raw", () => {
    const views = mapWarningDataToPublicView([
      { code: "DATE_RANGE_INVALID", field: "proposedEndDate" },
      { code: "EVIL_RAW", message: "leak", blocking: false },
    ])
    assert.equal(views[0].blocking, true)
    assert.equal(views[0].message.includes("leak"), false)
    assert.equal(views[1].code, "UNKNOWN_WARNING")
    assert.equal(JSON.stringify(views).includes("leak"), false)
  })

  it("hasBlockingWarnings respecte blocking true inconnu", () => {
    assert.equal(hasBlockingWarnings([{ code: "LOW_CONFIDENCE", blocking: false }]), false)
    assert.equal(hasBlockingWarnings([{ code: "CONTENT_INSUFFICIENT", blocking: true }]), true)
    assert.equal(hasBlockingWarnings([{ code: "UNKNOWN_X", blocking: true }]), true)
    assert.equal(hasBlockingWarnings([{ code: "UNKNOWN_Y", blocking: false }]), false)
    assert.equal(hasBlockingWarnings("x"), false)
    assert.equal(hasBlockingWarnings(null), false)
    assert.equal(hasBlockingWarnings([null, "x", [true], { code: "Z" }]), false)
  })

  it("DTO formulaire exclut confidence/warnings/rejection", () => {
    const draft: ImportDraftReviewBundle["draft"] = {
      id: "d1",
      status: "PENDING_REVIEW",
      version: 2,
      proposedWorksiteName: "A",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: "Lyon",
      proposedStartDate: new Date("2026-10-01T00:00:00.000Z"),
      proposedEndDate: new Date("2026-10-05T00:00:00.000Z"),
      proposedDescription: null,
      proposedContactName: "Bob",
      proposedContactEmail: null,
      proposedContactPhone: null,
      confidenceData: { secret: 0.9 },
      warningData: [{ code: "X", blocking: true, message: "raw" }],
      extractionProvider: "anthropic",
      extractionModel: "m",
      lastExtractionErrorCode: "E",
      reviewedByUserId: "u",
      reviewedAt: new Date(),
      rejectionReason: "motif secret",
      createdWorksiteId: null,
      updatedAt: new Date(),
    }
    const dto = toConsultationProposedFormDto(draft, true)
    const json = JSON.stringify(dto)
    assert.equal(dto.id, "d1")
    assert.equal(dto.proposedStartDate, "2026-10-01")
    assert.equal(dto.extractionEnabled, true)
    assert.equal(json.includes("confidenceData"), false)
    assert.equal(json.includes("warningData"), false)
    assert.equal(json.includes("rejectionReason"), false)
    assert.equal(json.includes("motif secret"), false)
    assert.equal(json.includes("anthropic"), false)
  })
})
