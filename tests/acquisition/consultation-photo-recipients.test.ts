import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { consultationPhotoRecipients } from "@/lib/acquisition/conversion/consultation-photo-recipients"

describe("consultationPhotoRecipients", () => {
  it("contact puis expéditeur, dédoublonné sans tenir compte de la casse", () => {
    assert.deepEqual(
      consultationPhotoRecipients({ contactName: "  Prunille  ", contactEmail: "Prunille@lauralu.fr", senderEmail: "prunille@LAURALU.fr" }),
      [{ label: "Prunille", email: "Prunille@lauralu.fr", active: true }]
    )
  })
  it("exclut adresses invalides et boîtes techniques", () => {
    assert.deepEqual(consultationPhotoRecipients({ contactEmail: "pas une adresse", senderEmail: "noreply@ats67.com" }), [])
    assert.deepEqual(consultationPhotoRecipients({ senderEmail: "notifications+x@gl-events.com" }), [])
    assert.deepEqual(consultationPhotoRecipients({ senderEmail: "eric.loux@ats67.com" }), [
      { label: "Expéditeur de la consultation", email: "eric.loux@ats67.com", active: true },
    ])
  })
  it("libellé borné à 120 caractères, vide → null", () => {
    const [r] = consultationPhotoRecipients({ contactName: "x".repeat(200), contactEmail: "a@b.fr" })
    assert.equal(r.label?.length, 120)
    assert.equal(consultationPhotoRecipients({ contactName: "   ", contactEmail: "a@b.fr" })[0].label, null)
  })
})
