import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatConversionSuccessMessage } from "@/lib/acquisition/conversion/conversion-success-message"

describe("formatConversionSuccessMessage", () => {
  it("ALREADY_CONVERTED → message simple", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "ALREADY_CONVERTED", documentCount: 3, skippedAttachmentCount: 1 }),
      "Chantier déjà créé"
    )
  })

  it("aucune pièce jointe → message de base", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "CONVERTED", documentCount: 0, skippedAttachmentCount: 0 }),
      "Chantier créé avec succès"
    )
  })

  it("1 pièce jointe copiée (singulier)", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "CONVERTED", documentCount: 1, skippedAttachmentCount: 0 }),
      "Chantier créé avec succès — 1 pièce jointe copiée"
    )
  })

  it("plusieurs copiées, aucune ignorée (pluriel)", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "CONVERTED", documentCount: 2, skippedAttachmentCount: 0 }),
      "Chantier créé avec succès — 2 pièces jointes copiées"
    )
  })

  it("copiées + une ignorée (singulier)", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "CONVERTED", documentCount: 2, skippedAttachmentCount: 1 }),
      "Chantier créé avec succès — 2 pièces jointes copiées — 1 non copiée (téléchargement en attente, en échec ou refusé)"
    )
  })

  it("aucune copiée, plusieurs ignorées (pluriel)", () => {
    assert.equal(
      formatConversionSuccessMessage({ outcome: "CONVERTED", documentCount: 0, skippedAttachmentCount: 3 }),
      "Chantier créé avec succès — 3 non copiées (téléchargement en attente, en échec ou refusé)"
    )
  })
})
