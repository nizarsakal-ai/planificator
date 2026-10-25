// V3 — aides HTTP : drapeau, origine, en-têtes privés, erreurs normalisées.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertImportOrigin } from "@/lib/vehicules/import-api"
import { handleTours } from "@/lib/vehicules/v3/tour-api"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { assertTrustedOrigin, assertVehiclesV3Enabled, v3Failure, v3Json, v3Route } from "@/lib/vehicules/v3/v3-http"

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv
const request = (method: string, headers: Record<string, string> = {}) => new Request("https://app.example.test/api/trucks/t/documents", { method, headers })
const code = (fn: () => unknown) => { try { fn(); return null } catch (error) { return (error as MileageDomainError).code } }

describe("V3 — drapeau et en-têtes", () => {
  it("le prototype est désactivé par défaut et exige exactement « true »", () => {
    assert.equal(isVehiclesV3Enabled(env({})), false)
    assert.equal(isVehiclesV3Enabled(env({ PLANIFICATOR_VEHICLES_V3_ENABLED: "1" })), false)
    assert.equal(isVehiclesV3Enabled(env({ PLANIFICATOR_VEHICLES_V3_ENABLED: " true " })), true)
    assert.equal(code(() => assertVehiclesV3Enabled(env({}))), "FEATURE_DISABLED")
  })

  it("réponses privées sans stockage et erreurs sans détail technique", async () => {
    const ok = v3Json({ a: 1 })
    assert.equal(ok.headers.get("Cache-Control"), "private, no-store")
    assert.equal(ok.headers.get("Vary"), "Cookie")
    const failure = v3Failure(new Error("postgresql://user:secret@db/prod failed"))
    assert.equal(failure.status, 500)
    const body = await failure.json()
    assert.deepEqual(body, { code: "SERVER_ERROR", error: "Erreur serveur" })
    const domain = v3Failure(new MileageDomainError("DOCUMENT_NOT_FOUND", 404))
    assert.equal(domain.status, 404)
    assert.equal((await domain.json()).code, "DOCUMENT_NOT_FOUND")
  })
})

describe("V3 — origine des requêtes mutantes", () => {
  it("GET passe toujours ; POST exige même origine, hôte servi ou origine approuvée", () => {
    assert.equal(code(() => assertTrustedOrigin(request("GET"), env({}))), null)
    assert.equal(code(() => assertTrustedOrigin(request("POST", { "sec-fetch-site": "same-origin" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { host: "app.example.test", origin: "https://app.example.test" }), env({}))), null)
    assert.equal(code(() => assertTrustedOrigin(request("POST", { "x-forwarded-host": "app.example.test", host: "internal", origin: "https://app.example.test" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { host: "app.example.test", referer: "https://app.example.test/vehicules/t" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { host: "app.example.test", origin: "https://evil.example.net" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { host: "app.example.test", "sec-fetch-site": "cross-site", origin: "https://evil.example.net" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { host: "app.example.test" }), env({}))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("PUT", { host: "app.example.test", origin: "capacitor://localhost" }), env({ PLANIFICATOR_TRUSTED_ORIGINS: "capacitor://localhost, https://other.example.test" }))), null)
    assert.equal(code(() => assertTrustedOrigin(request("DELETE", { host: "app.example.test", origin: "null" }), env({}))), "INVALID_ORIGIN")
  })

  it("protocol, port, origin and Host remain authoritative despite browser or proxy hints", () => {
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "http://app.example.test" },
      { origin: "https://app.example.test:8443" },
      { origin: "https://evil.example.test", "sec-fetch-site": "same-origin" },
      { origin: "https://evil.example.test", "x-forwarded-host": "evil.example.test" },
      { origin: "null" },
      { origin: "capacitor://evil" },
      { origin: "https://app.example.test", host: "app.example.test,evil.test" },
    ]
    for (const headers of rejectedHeaders) {
      assert.equal(code(() => assertTrustedOrigin(request("POST", headers), env({ PLANIFICATOR_TRUSTED_ORIGINS: "capacitor://localhost, https://app.example.test:9443" }))), "INVALID_ORIGIN")
    }
    assert.equal(code(() => assertTrustedOrigin(request("POST", { origin: "http://other.test" }), env({ PLANIFICATOR_TRUSTED_ORIGINS: "https://other.test" }))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { origin: "https://other.test:8443" }), env({ PLANIFICATOR_TRUSTED_ORIGINS: "https://other.test" }))), "INVALID_ORIGIN")
    assert.equal(code(() => assertTrustedOrigin(request("POST", { origin: "capacitor://localhost", "sec-fetch-site": "cross-site" }), env({ PLANIFICATOR_TRUSTED_ORIGINS: "capacitor://localhost" }))), null)
  })

  it("documents, imports and tours share explicit mobile-origin admission and deny foreign origins before authentication", async () => {
    const savedTrusted = process.env.PLANIFICATOR_TRUSTED_ORIGINS, savedFlag = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
    process.env.PLANIFICATOR_TRUSTED_ORIGINS = "capacitor://localhost"
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
    try {
      const deps = { auth: async () => null, db: { $transaction: async () => { throw new Error("must not access database") } } } as never
      const make = (origin: string) => request("POST", { origin, "content-type": "application/json", "sec-fetch-site": "cross-site" })
      assert.doesNotThrow(() => assertImportOrigin(make("capacitor://localhost")))
      assert.throws(() => assertImportOrigin(make("capacitor://other")), /ORIGIN_FORBIDDEN/)
      assert.equal((await handleTours(make("capacitor://localhost"), "truck", undefined, deps)).status, 401)
      assert.equal((await handleTours(make("capacitor://other"), "truck", undefined, deps)).status, 403)
      const admitted = await v3Route(make("capacitor://localhost"), async () => v3Json({ admitted: true }))
      assert.equal(admitted.status, 200)
      const refused = await v3Route(make("capacitor://other"), async () => { throw new Error("must not handle") })
      assert.equal(refused.status, 403)
    } finally {
      if (savedTrusted === undefined) delete process.env.PLANIFICATOR_TRUSTED_ORIGINS; else process.env.PLANIFICATOR_TRUSTED_ORIGINS = savedTrusted
      if (savedFlag === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedFlag
    }
  })

  it("v3Route refuse avant tout traitement quand le drapeau est absent ou l'origine invalide", async () => {
    const saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
    delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
    let handled = 0
    const disabled = await v3Route(request("GET"), async () => { handled++; return v3Json({}) })
    assert.equal(disabled.status, 404)
    assert.equal((await disabled.json()).code, "FEATURE_DISABLED")
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
    const badOrigin = await v3Route(request("POST", { host: "app.example.test", origin: "https://evil.example.net" }), async () => { handled++; return v3Json({}) })
    assert.equal(badOrigin.status, 403)
    const ok = await v3Route(request("POST", { "sec-fetch-site": "same-origin", origin: "https://app.example.test" }), async () => { handled++; return v3Json({ ok: true }) })
    assert.equal(ok.status, 200)
    assert.equal(handled, 1)
    if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved
  })
})
