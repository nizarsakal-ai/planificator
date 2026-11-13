// SPEC-BANK-VERIF-001 — tests unitaires : IBAN (ISO 13616), sélection du prestataire (fail-closed, simulateur interdit en production),
// concordance du titulaire.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isValidIban, maskIban, normalizeIban } from "@/lib/bank-verification/iban"
import { SandboxBankVerificationProvider, isProductionEnv, resolveBankVerificationProvider } from "@/lib/bank-verification/provider"
import { holderMatches } from "@/lib/bank-verification/bank-account.service"

// IBAN d'exemple publics (documentation ISO/SWIFT), jamais des comptes réels.
const FR = "FR14 2004 1010 0505 0001 3M02 606"
describe("IBAN", () => {
  it("normalise, valide la clé modulo 97 et la longueur par pays", () => {
    assert.equal(normalizeIban(" fr14 2004-1010 0505.0001 3m02 606 "), "FR1420041010050500013M02606")
    assert.equal(isValidIban(FR), true)
    assert.equal(isValidIban("DE89 3704 0044 0532 0130 00"), true)
    assert.equal(isValidIban("GB29 NWBK 6016 1331 9268 19"), true)
    assert.equal(isValidIban("FR14 2004 1010 0505 0001 3M02 607"), false) // clé fausse
    assert.equal(isValidIban("FR14 2004 1010 0505 0001 3M02 60"), false) // trop court pour la France
    assert.equal(isValidIban("XX14 2004 1010 0505 0001 3M02 606"), false) // pays inconnu
    assert.equal(isValidIban("FR14<script>"), false)
    assert.equal(isValidIban(""), false)
  })
  it("masque l'IBAN dans les affichages et journaux", () => {
    assert.equal(maskIban(FR), "FR14 •••• •••• 2606")
    assert.ok(!maskIban(FR).includes("2004"))
  })
})

describe("prestataire", () => {
  it("aucun prestataire configuré ou inconnu ⇒ blocage ; simulateur accepté hors production seulement", () => {
    assert.deepEqual(resolveBankVerificationProvider({}), { ok: false, reason: "NOT_CONFIGURED" })
    assert.deepEqual(resolveBankVerificationProvider({ BANK_VERIFICATION_PROVIDER: "inconnu" }), { ok: false, reason: "UNKNOWN_PROVIDER" })
    assert.equal(resolveBankVerificationProvider({ BANK_VERIFICATION_PROVIDER: "sandbox", NODE_ENV: "test" }).ok, true)
    assert.equal(resolveBankVerificationProvider({ BANK_VERIFICATION_PROVIDER: "sandbox", NODE_ENV: "production", VERCEL_ENV: "preview" }).ok, true)
    assert.deepEqual(resolveBankVerificationProvider({ BANK_VERIFICATION_PROVIDER: "sandbox", NODE_ENV: "production", VERCEL_ENV: "production" }), { ok: false, reason: "SANDBOX_IN_PRODUCTION" })
    assert.deepEqual(resolveBankVerificationProvider({ BANK_VERIFICATION_PROVIDER: "sandbox", NODE_ENV: "production" }), { ok: false, reason: "SANDBOX_IN_PRODUCTION" })
    assert.equal(isProductionEnv({ NODE_ENV: "development" }), false)
  })
  it("simulateur : sans issue enregistrée côté serveur, le résultat reste « en attente »", async () => {
    const p = new SandboxBankVerificationProvider()
    assert.deepEqual(await p.fetchResult({ providerRef: "x", iban: "FR1420041010050500013M02606", result: { holderName: "GALYA" } }), { status: "PENDING" })
    assert.deepEqual(await p.fetchResult({ providerRef: "x", iban: "FR1420041010050500013M02606", result: { holderName: "GALYA", sandboxOutcome: "CONFIRMED" } }), { status: "CONFIRMED", iban: "FR1420041010050500013M02606", holderName: "GALYA" })
  })
})

describe("titulaire", () => {
  it("concordance exacte sur clé normalisée (casse, accents, forme juridique) ; jamais par inclusion", () => {
    assert.equal(holderMatches("GALYA EVENTS SAS", ["Galya Events"]), true)
    assert.equal(holderMatches("Galya Évents", ["GALYA EVENTS"]), true)
    assert.equal(holderMatches("Galya", ["Galya Events"]), false)
    assert.equal(holderMatches("Galya Events Holding", ["Galya Events"]), false)
    assert.equal(holderMatches("", ["Galya Events"]), false)
  })
})
