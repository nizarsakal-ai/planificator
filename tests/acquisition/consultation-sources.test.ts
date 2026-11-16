process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  extractDomainInput,
  partnerAdminErrorMessage,
  partnerCodeFromName,
} from "@/lib/acquisition/admin/partner-sources"
import { isNowEligibleRejection } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"

describe("helpers sources de consultations", () => {
  it("code partenaire stable depuis le nom", () => {
    assert.equal(partnerCodeFromName("ATS Structures"), "ats-structures")
    assert.equal(partnerCodeFromName("  Élysée Événements!! "), "elysee-evenements")
    assert.equal(partnerCodeFromName("***", "ats67.com"), "ats67")
    assert.equal(partnerCodeFromName("", ""), "partenaire")
    assert.ok(partnerCodeFromName("a".repeat(100)).length <= 64)
  })

  it("domaine extrait d'une adresse ou d'une URL collée", () => {
    assert.equal(extractDomainInput(" Eloux@ATS67.com "), "ats67.com")
    assert.equal(extractDomainInput("https://www.ats67.com/contact"), "ats67.com")
    assert.equal(extractDomainInput("lauralu.fr"), "lauralu.fr")
  })

  it("messages d'erreur métier lisibles", () => {
    assert.match(partnerAdminErrorMessage("DOMAIN_ALREADY_EXISTS"), /déjà/)
    assert.match(partnerAdminErrorMessage(undefined), /Réessayez/)
  })
})

describe("réévaluation des rejets", () => {
  const ids = { domains: ["ats67.com"], emails: ["vip@other.fr"] }
  const row = (o: Partial<{ status: string; lastErrorCode: string | null; senderEmail: string; senderDomain: string }>) => ({
    status: "REJECTED",
    lastErrorCode: "SENDER_NOT_ELIGIBLE",
    senderEmail: "eloux@ats67.com",
    senderDomain: "ats67.com",
    ...o,
  })

  it("rejet dont le domaine ou l'e-mail est devenu partenaire → à relire", () => {
    assert.equal(isNowEligibleRejection(row({}), ids), true)
    assert.equal(isNowEligibleRejection(row({ senderDomain: "other.fr", senderEmail: "VIP@other.fr" }), ids), true)
  })

  it("toujours non partenaire, rejet pour adresse invalide ou message ingéré → reste connu", () => {
    assert.equal(isNowEligibleRejection(row({ senderDomain: "spam.example", senderEmail: "x@spam.example" }), ids), false)
    assert.equal(isNowEligibleRejection(row({ lastErrorCode: "INVALID_SENDER" }), ids), false)
    assert.equal(isNowEligibleRejection(row({ status: "DRAFT_CREATED", lastErrorCode: null }), ids), false)
  })
})
