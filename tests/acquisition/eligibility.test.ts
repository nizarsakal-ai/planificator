// Tests unitaires — règle d'admissibilité LAURALU et normalisation expéditeur.
// Exécution : npm run test:acquisition (node:test via tsx, aucune BDD requise).
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeSenderAddress,
  isEligibleSenderDomain,
  categorizeAttachment,
  ELIGIBLE_SENDER_DOMAIN,
} from "@/lib/acquisition/acquisition.service"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"

const isEligible = (raw: string): boolean => {
  const n = normalizeSenderAddress(raw)
  return n !== null && isEligibleSenderDomain(n.domain)
}

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
    assert.equal(normalizeSenderAddress("a@b"), null) // domaine sans point
    assert.equal(normalizeSenderAddress("@lauralu.fr"), null)
    assert.equal(normalizeSenderAddress("user@"), null)
    assert.equal(normalizeSenderAddress("user @lauralu.fr"), null)
  })
})

describe("admissibilité LAURALU (domaine exact)", () => {
  it(`accepte carlenebourgine@${ELIGIBLE_SENDER_DOMAIN}`, () => {
    assert.equal(isEligible("carlenebourgine@lauralu.fr"), true)
  })

  it("accepte une adresse LAURALU en majuscules après normalisation", () => {
    assert.equal(isEligible("ELODIEAGEZ@LAURALU.FR"), true)
  })

  it("accepte un nouvel utilisateur futur du domaine lauralu.fr", () => {
    assert.equal(isEligible("nouveau.collaborateur2027@lauralu.fr"), true)
  })

  it("rejette user@gmail.com", () => {
    assert.equal(isEligible("user@gmail.com"), false)
  })

  it("rejette user@fake-lauralu.fr", () => {
    assert.equal(isEligible("user@fake-lauralu.fr"), false)
  })

  it("rejette user@lauralu.fr.attacker.com", () => {
    assert.equal(isEligible("user@lauralu.fr.attacker.com"), false)
  })

  it("rejette une adresse invalide", () => {
    assert.equal(isEligible("lauralu.fr"), false)
    assert.equal(isEligible("<lauralu.fr>"), false)
  })

  it("ne se fie pas au nom d'affichage contenant lauralu.fr", () => {
    assert.equal(isEligible("Carlene (lauralu.fr) <carlene@evil.com>"), false)
  })

  it("rejette un sous-domaine (règle stricte V1)", () => {
    assert.equal(isEligible("user@mail.lauralu.fr"), false)
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
