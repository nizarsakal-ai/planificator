process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { convertImportDraftSchema } from "@/lib/acquisition/conversion/conversion.schema"
import {
  buildWorksiteAddress,
  mapAttachmentCategoryToDocumentType,
} from "@/lib/acquisition/conversion/conversion.service"

describe("conversion.schema", () => {
  it("EXISTING exige existingClientId ; refuse companyId", () => {
    assert.equal(
      convertImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        clientMode: "EXISTING",
      }).success,
      false
    )
    assert.equal(
      convertImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        clientMode: "EXISTING",
        existingClientId: "c1",
        companyId: "evil",
      }).success,
      false
    )
    assert.equal(
      convertImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 1,
        clientMode: "EXISTING",
        existingClientId: "c1",
      }).success,
      true
    )
  })

  it("NEW exige newClient.name ; refuse worksiteName override", () => {
    assert.equal(
      convertImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 0,
        clientMode: "NEW",
      }).success,
      false
    )
    assert.equal(
      convertImportDraftSchema.safeParse({
        draftId: "d1",
        expectedVersion: 0,
        clientMode: "NEW",
        newClient: { name: "  Acme  ", email: null, phone: null, address: null },
        worksiteName: "hack",
      }).success,
      false
    )
    const ok = convertImportDraftSchema.safeParse({
      draftId: "d1",
      expectedVersion: 0,
      clientMode: "NEW",
      newClient: { name: "  Acme  ", email: "", phone: null, address: null },
    })
    assert.equal(ok.success, true)
    if (ok.success) {
      assert.equal(ok.data.newClient?.name, "Acme")
      assert.equal(ok.data.newClient?.email, null)
    }
  })

  it("helpers adresse + type document", () => {
    assert.equal(
      buildWorksiteAddress({
        proposedAddress: "1 rue A",
        proposedPostalCode: "75001",
        proposedCity: "Paris",
      }),
      "1 rue A, 75001, Paris"
    )
    assert.equal(mapAttachmentCategoryToDocumentType("PLAN"), "PLAN")
    assert.equal(mapAttachmentCategoryToDocumentType("UNKNOWN"), "DOCUMENT")
  })
})
