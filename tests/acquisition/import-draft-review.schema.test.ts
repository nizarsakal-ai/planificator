process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  saveImportDraftCorrectionsSchema,
  rejectImportDraftSchema,
  reExtractImportDraftSchema,
  approveImportDraftSchema,
} from "@/lib/acquisition/review/import-draft-review.schema"

const baseSave = {
  draftId: "d1",
  expectedVersion: 0,
  proposedWorksiteName: null as string | null,
  proposedClientName: null as string | null,
  proposedAddress: null as string | null,
  proposedPostalCode: null as string | null,
  proposedCity: null as string | null,
  proposedStartDate: null as string | null,
  proposedEndDate: null as string | null,
  proposedDescription: null as string | null,
}

describe("import-draft-review.schema", () => {
  it("normalise vides → null et rejette clés inconnues", () => {
    const ok = saveImportDraftCorrectionsSchema.safeParse({
      ...baseSave,
      proposedWorksiteName: "  ",
      proposedClientName: "",
      proposedCity: "Paris",
      proposedStartDate: "",
      proposedDescription: "  desc  ",
    })
    assert.equal(ok.success, true)
    if (ok.success) {
      assert.equal(ok.data.proposedWorksiteName, null)
      assert.equal(ok.data.proposedClientName, null)
      assert.equal(ok.data.proposedCity, "Paris")
      assert.equal(ok.data.proposedDescription, "desc")
      assert.equal(ok.data.proposedStartDate, null)
    }

    const bad = saveImportDraftCorrectionsSchema.safeParse({
      ...baseSave,
      proposedClientId: "evil",
    })
    assert.equal(bad.success, false)
  })

  it("rejette types non-string pour champs texte", () => {
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({ ...baseSave, proposedWorksiteName: {} }).success,
      false
    )
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({ ...baseSave, proposedCity: [] }).success,
      false
    )
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({ ...baseSave, proposedAddress: 12 }).success,
      false
    )
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({ ...baseSave, proposedDescription: true }).success,
      false
    )
  })

  it("description >5000 et expectedVersion négatif rejetés", () => {
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({
        ...baseSave,
        proposedDescription: "x".repeat(5001),
      }).success,
      false
    )
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({ ...baseSave, expectedVersion: -1 }).success,
      false
    )
  })

  it("dates invalides / rollover rejetées", () => {
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({
        ...baseSave,
        proposedStartDate: "2026-02-31",
      }).success,
      false
    )
    assert.equal(
      saveImportDraftCorrectionsSchema.safeParse({
        ...baseSave,
        proposedStartDate: "2026-13-01",
      }).success,
      false
    )
  })

  it("HTML reste texte borné (pas d’exécution)", () => {
    const html = '<script>alert(1)</script>'
    const ok = saveImportDraftCorrectionsSchema.safeParse({
      ...baseSave,
      proposedDescription: html,
    })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.proposedDescription, html)
  })

  it("reject reason borné", () => {
    assert.equal(
      rejectImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        rejectionReason: "abc",
      }).success,
      false
    )
    assert.equal(
      rejectImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        rejectionReason: "Motif valide",
      }).success,
      true
    )
  })

  it("re-extract / approve n’acceptent pas companyId", () => {
    assert.equal(
      reExtractImportDraftSchema.safeParse({ draftId: "d1", companyId: "co1" }).success,
      false
    )
    assert.equal(
      approveImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        companyId: "co1",
      }).success,
      false
    )
  })
})
