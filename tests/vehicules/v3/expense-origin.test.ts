// Dépenses V3 : même admission d'origine que les autres mutations véhicules (revue de code du 25/10/2026).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertExpenseRequest } from "@/lib/vehicules/v3/expense-api"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"

const req = (headers: Record<string, string>) => new Request("https://app.example.test/api/trucks/t/expenses", { method: "POST", headers: { "content-type": "application/json", host: "app.example.test", ...headers } })
const code = (fn: () => void) => { try { fn(); return "OK" } catch (e) { return e instanceof MileageDomainError ? e.code : String(e) } }

describe("assertExpenseRequest — origine", () => {
  it("même origine acceptée ; origine étrangère, absente ou cross-site refusée", () => {
    assert.equal(code(() => assertExpenseRequest(req({ origin: "https://app.example.test" }))), "OK")
    assert.equal(code(() => assertExpenseRequest(req({ origin: "https://evil.example.net" }))), "INVALID_ORIGIN")
    assert.equal(code(() => assertExpenseRequest(req({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertExpenseRequest(req({ origin: "https://app.example.test", "sec-fetch-site": "cross-site" }))), "INVALID_ORIGIN")
    assert.equal(code(() => assertExpenseRequest(req({ origin: "https://evil.example.net", "x-forwarded-host": "evil.example.net" }))), "INVALID_ORIGIN")
  })
  it("origine de confiance configurée (application mobile) acceptée, comme pour les autres mutations", () => {
    const prev = process.env.PLANIFICATOR_TRUSTED_ORIGINS
    process.env.PLANIFICATOR_TRUSTED_ORIGINS = "capacitor://localhost"
    try {
      assert.equal(code(() => assertExpenseRequest(req({ origin: "capacitor://localhost" }))), "OK")
    } finally { if (prev === undefined) delete process.env.PLANIFICATOR_TRUSTED_ORIGINS; else process.env.PLANIFICATOR_TRUSTED_ORIGINS = prev }
  })
  it("type de contenu et taille toujours contrôlés", () => {
    assert.equal(code(() => assertExpenseRequest(new Request("https://app.example.test/x", { method: "POST", headers: { host: "app.example.test", origin: "https://app.example.test", "content-type": "text/plain" } }))), "INVALID_CONTENT_TYPE")
    assert.equal(code(() => assertExpenseRequest(req({ origin: "https://app.example.test", "content-length": "99999" }))), "PAYLOAD_TOO_LARGE")
  })
})

const env = (v?: string) => (v === undefined ? {} : { PLANIFICATOR_VEHICLES_V3_ENABLED: v }) as unknown as NodeJS.ProcessEnv
describe("drapeau V3 unique", () => {
  it("isVehiclesV3Enabled tolère les espaces, refuse tout le reste", () => {
    assert.equal(isVehiclesV3Enabled(env("true")), true)
    assert.equal(isVehiclesV3Enabled(env(" true\n")), true)
    for (const v of ["TRUE", "1", "yes", "", "false"]) assert.equal(isVehiclesV3Enabled(env(v)), false)
    assert.equal(isVehiclesV3Enabled(env()), false)
  })
})
