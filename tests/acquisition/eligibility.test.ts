// Tests unitaires — normalisation expéditeur + Zod + PJ (éligibilité → resolver).
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeSenderAddress,
  categorizeAttachment,
} from "@/lib/acquisition/acquisition.service"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"

describe("normalizeSenderAddress", () => {
  it("normalise trim + minuscules", () => {
    const n = normalizeSenderAddress("  CarleneBourgine@LAURALU.FR  ")
    assert.deepEqual(n, { email: "carlenebourgine@lauralu.fr", domain: "lauralu.fr" })
  })

  it("extrait l'adresse réelle de la forme « Nom <adresse> » sans se fier au nom d'affichage", () => {
    const n = normalizeSenderAddress("Service LAURALU lauralu.fr <contact@attacker.com>")
    assert.equal(n?.domain, "attacker.com")
  })

  it("rejette une adresse invalide", () => {
    assert.equal(normalizeSenderAddress("pas-une-adresse"), null)
    assert.equal(normalizeSenderAddress("a@b"), null)
    assert.equal(normalizeSenderAddress("@lauralu.fr"), null)
    assert.equal(normalizeSenderAddress("user@"), null)
    assert.equal(normalizeSenderAddress("user @lauralu.fr"), null)
  })
})

describe("validation Zod des entrées", () => {
  const base = {
    companyId: "cmp_1",
    source: "GMAIL" as const,
    externalMessageId: "gm-123",
    senderEmail: "carlenebourgine@lauralu.fr",
    subject: "Consultation chantier",
    receivedAt: new Date().toISOString(),
  }

  it("accepte une entrée valide", () => {
    assert.equal(registerIncomingMessageSchema.safeParse(base).success, true)
  })

  it("rejette un identifiant externe vide", () => {
    assert.equal(
      registerIncomingMessageSchema.safeParse({ ...base, externalMessageId: "" }).success,
      false
    )
  })

  it("rejette un sujet trop long", () => {
    assert.equal(
      registerIncomingMessageSchema.safeParse({ ...base, subject: "x".repeat(501) }).success,
      false
    )
  })

  it("rejette une taille de pièce jointe négative", () => {
    const r = registerIncomingMessageSchema.safeParse({
      ...base,
      attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: -1 }],
    })
    assert.equal(r.success, false)
  })

  it("rejette une date invalide", () => {
    assert.equal(
      registerIncomingMessageSchema.safeParse({ ...base, receivedAt: "pas-une-date" }).success,
      false
    )
  })

  it("rejette des métadonnées contenant un secret", () => {
    const r = registerIncomingMessageSchema.safeParse({
      ...base,
      rawMetadata: { accessToken: "ya29.secret" },
    })
    assert.equal(r.success, false)
  })
})

describe("categorizeAttachment", () => {
  it("catégorise PDF en PLAN, image en PHOTO, zip en ARCHIVE", () => {
    assert.equal(categorizeAttachment("application/pdf", "plan-chantier.pdf"), "PLAN")
    assert.equal(categorizeAttachment("image/jpeg", "photo.jpg"), "PHOTO")
    assert.equal(categorizeAttachment("application/zip", "docs.zip"), "ARCHIVE")
    assert.equal(categorizeAttachment("application/x-msdownload", "setup.exe"), "UNSUPPORTED")
  })
})
