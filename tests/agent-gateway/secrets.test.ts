/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A — T-SECRET-1.
 * Secrets : absent/court/malformé ⇒ erreur typée nommant la variable, jamais la valeur.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { AGENT_GATEWAY_SECRET_NAMES } from "@/lib/integration/flags/platform-flag-names"
import {
  AGENT_GATEWAY_SECRET_MIN_BYTES,
  AgentGatewaySecretError,
  readAgentGatewaySecret,
  readCursorSecret,
  readDigestSecret,
} from "@/lib/agent-gateway/secrets"

const D = AGENT_GATEWAY_SECRET_NAMES.DIGEST_SECRET
const C = AGENT_GATEWAY_SECRET_NAMES.CURSOR_SECRET
const SECRET_VALUE_32 = randomBytes(32)

describe("T-SECRET-1 — secrets de la passerelle", () => {
  it("noms figés et distincts", () => {
    assert.equal(D, "INTEGRATION_AGENT_GATEWAY_DIGEST_SECRET")
    assert.equal(C, "INTEGRATION_AGENT_GATEWAY_CURSOR_SECRET")
    assert.notEqual(D, C)
    assert.equal(AGENT_GATEWAY_SECRET_MIN_BYTES, 32)
  })

  for (const [label, env] of [
    ["absent", {}],
    ["vide", { [D]: "" }],
    ["blanc", { [D]: "   " }],
  ] as const) {
    it(`${label} ⇒ erreur 'missing' sans valeur`, () => {
      assert.throws(
        () => readDigestSecret(env),
        (e: unknown) => e instanceof AgentGatewaySecretError && e.variable === D && e.reason === "missing"
      )
    })
  }

  it("trop court (hex 16 octets, base64 8 octets) ⇒ 'too_short'", () => {
    for (const short of [randomBytes(16).toString("hex"), randomBytes(8).toString("base64")]) {
      assert.throws(
        () => readDigestSecret({ [D]: short }),
        (e: unknown) => e instanceof AgentGatewaySecretError && e.reason === "too_short"
      )
    }
  })

  const malformedCases: ReadonlyArray<readonly [string, string]> = [
    ["caractères hors alphabet", "pas un secret !!! ***"],
    ["base64 : 45 caractères (longueur ≡ 1 mod 4, revue Codex)", "Z".repeat(45)],
    ["base64 : 43 caractères + '==' (padding incohérent, revue Codex)", "Z".repeat(43) + "=="],
    ["base64 : 44 caractères dont '=' avec bits de fin non nuls", "Z".repeat(43) + "="],
    ["base64 : padding au milieu", "QUJD=" + "A".repeat(43)],
    ["base64 : trois '='", "Q".repeat(41) + "==="],
    ["base64 standard sans padding (longueur 46, ≡ 2 mod 4)", SECRET_VALUE_32.toString("base64").replace(/=+$/, "") + "+/"],
    ["base64url avec padding", SECRET_VALUE_32.toString("base64url") + "="],
    ["mélange d'alphabets standard/url", "ab+c" + "_".repeat(40)],
    ["base64url : longueur ≡ 1 mod 4", "_".repeat(45)],
    ["hex de longueur impaire", "a".repeat(65)],
  ]
  for (const [label, value] of malformedCases) {
    it(`malformé ⇒ 'malformed' (${label})`, () => {
      assert.throws(
        () => readDigestSecret({ [D]: value }),
        (e: unknown) => e instanceof AgentGatewaySecretError && e.variable === D && e.reason === "malformed",
        `attendu 'malformed' pour : ${label}`
      )
    })
  }

  it("une valeur dont le décodage tolérant donnerait ≥ 32 octets est quand même rejetée", () => {
    // Avant correction : 45×'Z' donnait 33 octets et 43×'Z'+'==' donnait 32 octets (acceptés).
    assert.equal(Buffer.from("Z".repeat(45), "base64").length, 33)
    assert.equal(Buffer.from("Z".repeat(43) + "==", "base64").length, 32)
    for (const value of ["Z".repeat(45), "Z".repeat(43) + "=="]) {
      assert.throws(
        () => readDigestSecret({ [D]: value }),
        (e: unknown) => e instanceof AgentGatewaySecretError && e.reason === "malformed"
      )
    }
  })

  it("formes valides : base64 standard padé, base64url non padé, pour 32, 33 et 34 octets", () => {
    for (const n of [32, 33, 34]) {
      const bytes = randomBytes(n)
      assert.deepEqual(readDigestSecret({ [D]: bytes.toString("base64") }), bytes)
      assert.deepEqual(readDigestSecret({ [D]: bytes.toString("base64url") }), bytes)
      assert.deepEqual(readDigestSecret({ [D]: bytes.toString("hex") }), bytes)
    }
  })

  it("espaces de bordure tolérés, espaces internes rejetés", () => {
    const b64 = SECRET_VALUE_32.toString("base64")
    assert.deepEqual(readDigestSecret({ [D]: `  ${b64}\n` }), SECRET_VALUE_32)
    assert.throws(
      () => readDigestSecret({ [D]: b64.slice(0, 10) + " " + b64.slice(10) }),
      (e: unknown) => e instanceof AgentGatewaySecretError && e.reason === "malformed"
    )
  })

  it("valide en hex, base64 et base64url ⇒ mêmes octets", () => {
    const hex = SECRET_VALUE_32.toString("hex")
    const b64 = SECRET_VALUE_32.toString("base64")
    const b64url = SECRET_VALUE_32.toString("base64url")
    assert.deepEqual(readDigestSecret({ [D]: hex }), SECRET_VALUE_32)
    assert.deepEqual(readDigestSecret({ [D]: b64 }), SECRET_VALUE_32)
    assert.deepEqual(readDigestSecret({ [D]: b64url }), SECRET_VALUE_32)
    assert.deepEqual(readCursorSecret({ [C]: hex }), SECRET_VALUE_32)
  })

  it("le message d'erreur ne contient jamais la valeur", () => {
    const value = randomBytes(8).toString("hex") // trop court, volontairement
    try {
      readAgentGatewaySecret(D, { [D]: value })
      assert.fail("devait lever")
    } catch (e) {
      assert.ok(e instanceof AgentGatewaySecretError)
      assert.equal(e.message.includes(value), false)
      assert.equal(e.message.includes(D), true)
    }
  })
})
