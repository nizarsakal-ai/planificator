/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A — T-FLAG-1, T-FLAG-3, T-FLAG-4.
 * Flags fail-closed de la passerelle agent (même discipline que mail-shadow).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  AGENT_ANON_RPM_GLOBAL,
  AGENT_ANON_RPM_PER_IP,
  AGENT_GATEWAY_PG_MIN_VERSION_NUM,
  DEFAULT_AGENT_GATEWAY_RPM,
  MAX_AGENT_GATEWAY_RPM,
  PLATFORM_FLAG_NAMES,
} from "@/lib/integration/flags/platform-flag-names"
import {
  getAgentGatewayRpm,
  isAgentGatewayActiveForCompany,
  isAgentGatewayEnabled,
  isCompanyAllowedForAgentGateway,
  parseAgentGatewayRpm,
} from "@/lib/integration/flags/platform-flags"

const ENABLED = PLATFORM_FLAG_NAMES.AGENT_GATEWAY_ENABLED
const ALLOW = PLATFORM_FLAG_NAMES.AGENT_GATEWAY_COMPANY_ALLOWLIST
const RPM = PLATFORM_FLAG_NAMES.AGENT_GATEWAY_RPM

describe("agent gateway flags — noms figés", () => {
  it("les noms d'env suivent le préfixe INTEGRATION_ du dépôt", () => {
    assert.equal(ENABLED, "INTEGRATION_AGENT_GATEWAY_ENABLED")
    assert.equal(ALLOW, "INTEGRATION_AGENT_GATEWAY_COMPANY_ALLOWLIST")
    assert.equal(RPM, "INTEGRATION_AGENT_GATEWAY_RPM")
  })

  it("constantes de décision (D1a, D6a, D7)", () => {
    assert.equal(DEFAULT_AGENT_GATEWAY_RPM, 120)
    assert.equal(MAX_AGENT_GATEWAY_RPM, 1000)
    assert.equal(AGENT_ANON_RPM_GLOBAL, 300)
    assert.equal(AGENT_ANON_RPM_PER_IP, 30)
    assert.equal(AGENT_GATEWAY_PG_MIN_VERSION_NUM, 170000)
  })
})

describe("T-FLAG-1 — flag structurel fail-closed", () => {
  it("'true' strict ⇒ actif", () => {
    assert.equal(isAgentGatewayEnabled({ [ENABLED]: "true" }), true)
  })
  for (const bad of [undefined, "", "1", "TRUE", "true ", " true", "yes", "on"]) {
    it(`${JSON.stringify(bad)} ⇒ inactif`, () => {
      assert.equal(isAgentGatewayEnabled({ [ENABLED]: bad }), false)
    })
  }
})

describe("T-FLAG-3 — allowlist société", () => {
  it("société listée ⇒ autorisée ; non listée ⇒ refusée", () => {
    const env = { [ALLOW]: "cmp_a, cmp_b ,cmp_c" }
    assert.equal(isCompanyAllowedForAgentGateway("cmp_a", env), true)
    assert.equal(isCompanyAllowedForAgentGateway("cmp_b", env), true)
    assert.equal(isCompanyAllowedForAgentGateway("cmp_z", env), false)
  })
  for (const bad of [undefined, "", "   ", ",,,", " , "]) {
    it(`allowlist ${JSON.stringify(bad)} ⇒ personne`, () => {
      assert.equal(isCompanyAllowedForAgentGateway("cmp_a", { [ALLOW]: bad }), false)
    })
  }
  it("companyId vide ⇒ refusé même si l'allowlist est non vide", () => {
    assert.equal(isCompanyAllowedForAgentGateway("", { [ALLOW]: "cmp_a" }), false)
  })
  it("fail-closed combiné : flag ∧ allowlist", () => {
    assert.equal(isAgentGatewayActiveForCompany("cmp_a", { [ENABLED]: "true", [ALLOW]: "cmp_a" }), true)
    assert.equal(isAgentGatewayActiveForCompany("cmp_a", { [ENABLED]: "true" }), false)
    assert.equal(isAgentGatewayActiveForCompany("cmp_a", { [ALLOW]: "cmp_a" }), false)
    assert.equal(isAgentGatewayActiveForCompany("cmp_b", { [ENABLED]: "true", [ALLOW]: "cmp_a" }), false)
  })
})

describe("T-FLAG-4 — débit par principal", () => {
  it("absent ⇒ défaut 120", () => {
    assert.equal(parseAgentGatewayRpm(undefined), 120)
    assert.equal(parseAgentGatewayRpm(""), 120)
    assert.equal(getAgentGatewayRpm({}), 120)
  })
  for (const bad of ["0", "-1", "abc", "1.5", "NaN", "Infinity"]) {
    it(`${JSON.stringify(bad)} ⇒ défaut 120 (jamais 0)`, () => {
      assert.equal(parseAgentGatewayRpm(bad), 120)
    })
  }
  it("borne haute 1000 ; valeurs valides conservées", () => {
    assert.equal(parseAgentGatewayRpm("5000"), 1000)
    assert.equal(parseAgentGatewayRpm("1"), 1)
    assert.equal(parseAgentGatewayRpm("60"), 60)
    assert.equal(getAgentGatewayRpm({ [RPM]: "300" }), 300)
  })
})
