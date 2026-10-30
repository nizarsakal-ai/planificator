/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 1 — helpers HTTP partagés déplacés depuis Véhicules :
 * comportement identique, erreur par défaut `HttpGuardError`, refus injectable (façades Véhicules conservées).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpGuardError } from "@/lib/http/guard-error"
import { assertMutationOrigin, serializedOrigin } from "@/lib/http/request-origin"
import { readBoundedBodyBytes } from "@/lib/http/bounded-body"
import { assertMutationOrigin as vehiclesAssertMutationOrigin } from "@/lib/vehicules/request-origin"
import { readV3BodyBytes } from "@/lib/vehicules/v3/v3-http"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { detectMagicMime } from "@/lib/files/magic-mime"
import { detectMagicMime as vehiclesDetectMagicMime } from "@/lib/vehicules/v3/document-domain"
import { testEnv } from "./test-env"

function request(headers: Record<string, string>, body: BodyInit | null = null, url = "https://app.example.test/api/x"): Request {
  return new Request(url, { method: "POST", headers, body })
}

function guard(fn: () => unknown): HttpGuardError {
  try { fn() } catch (error) { if (error instanceof HttpGuardError) return error; throw error }
  throw new Error("expected HttpGuardError")
}

describe("request-origin partagé", () => {
  it("sérialise une origine réelle et rejette les formes dégradées", () => {
    assert.equal(serializedOrigin("https://app.example.test"), "https://app.example.test")
    assert.equal(serializedOrigin("https://app.example.test/"), null)
    assert.equal(serializedOrigin("https://u:p@app.example.test"), null)
    assert.equal(serializedOrigin("capacitor://localhost"), "capacitor://localhost")
    assert.equal(serializedOrigin("pas une origine"), null)
  })
  it("même origine acceptée ; Sec-Fetch-Site étranger refusé ; Origin absent refusé", () => {
    assert.doesNotThrow(() => assertMutationOrigin(request({ host: "app.example.test", origin: "https://app.example.test" })))
    assert.doesNotThrow(() => assertMutationOrigin(request({ host: "app.example.test", origin: "https://app.example.test", "sec-fetch-site": "same-origin" })))
    const crossSite = guard(() => assertMutationOrigin(request({ host: "app.example.test", origin: "https://app.example.test", "sec-fetch-site": "cross-site" })))
    assert.deepEqual([crossSite.code, crossSite.status], ["INVALID_ORIGIN", 403])
    assert.equal(guard(() => assertMutationOrigin(request({ host: "app.example.test" }))).code, "INVALID_ORIGIN")
    assert.equal(guard(() => assertMutationOrigin(request({ host: "app.example.test", origin: "https://evil.example.test" }), "ORIGINE_REFUSEE")).code, "ORIGINE_REFUSEE")
  })
  it("origines de confiance (coque Capacitor) via PLANIFICATOR_TRUSTED_ORIGINS ; X-Forwarded-* sans autorité", () => {
    const env = testEnv({ PLANIFICATOR_TRUSTED_ORIGINS: "capacitor://localhost, https://autre.example.test" })
    assert.doesNotThrow(() => assertMutationOrigin(request({ host: "app.example.test", origin: "capacitor://localhost" }), "INVALID_ORIGIN", env))
    assert.equal(guard(() => assertMutationOrigin(request({ host: "app.example.test", origin: "capacitor://localhost" }), "INVALID_ORIGIN", testEnv())).code, "INVALID_ORIGIN")
    assert.equal(guard(() => assertMutationOrigin(request({ host: "app.example.test", origin: "https://evil.example.test", "x-forwarded-host": "app.example.test" }), "INVALID_ORIGIN", env)).code, "INVALID_ORIGIN")
  })
  it("fail-closed : un reject qui ne lève pas n'admet rien et ne lit rien", async () => {
    const silent = (() => undefined) as unknown as (code: string, status: number) => never
    assert.throws(() => assertMutationOrigin(request({ host: "app.example.test" }), "INVALID_ORIGIN", process.env, silent), (e: unknown) => e instanceof HttpGuardError && e.status === 403)
    const body = await readBoundedBodyBytes(new Request("https://x.test", { method: "POST" }), 10, { reject: silent }).catch((e: unknown) => e)
    assert.ok(body instanceof HttpGuardError)
    assert.equal(body.code, "INVALID_PAYLOAD")
  })
  it("refus injectable : la façade Véhicules lève MileageDomainError(code, 403) comme avant", () => {
    assert.throws(() => vehiclesAssertMutationOrigin(request({ host: "app.example.test" })), (error: unknown) => error instanceof MileageDomainError && error.code === "INVALID_ORIGIN" && error.status === 403)
    assert.doesNotThrow(() => vehiclesAssertMutationOrigin(request({ host: "app.example.test", origin: "https://app.example.test" })))
  })
})

describe("bounded-body partagé", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(0x61)
  it("lit un corps dans la borne et renvoie les octets exacts", async () => {
    const out = await readBoundedBodyBytes(request({}, bytes(10)), 10)
    assert.equal(out.byteLength, 10)
  })
  it("coupe le flux réel au-delà de la borne, quel que soit Content-Length", async () => {
    const error = await readBoundedBodyBytes(request({}, bytes(11)), 10).catch((e: unknown) => e)
    assert.ok(error instanceof HttpGuardError)
    assert.deepEqual([error.code, error.status], ["PAYLOAD_TOO_LARGE", 413])
    const custom = await readBoundedBodyBytes(request({}, bytes(11)), 10, { sizeCode: "PHOTO_FILE_TOO_LARGE" }).catch((e: unknown) => e)
    assert.equal((custom as HttpGuardError).code, "PHOTO_FILE_TOO_LARGE")
  })
  it("Content-Length invalide ou trop grand refusé avant lecture ; corps absent refusé", async () => {
    const invalid = await readBoundedBodyBytes(request({ "content-length": "abc" }, bytes(1)), 10).catch((e: unknown) => e)
    assert.deepEqual([(invalid as HttpGuardError).code, (invalid as HttpGuardError).status], ["INVALID_CONTENT_LENGTH", 400])
    const declaredTooBig = await readBoundedBodyBytes(new Request("https://x.test", { method: "POST", headers: { "content-length": "999" }, body: bytes(1) }), 10).catch((e: unknown) => e)
    assert.equal((declaredTooBig as HttpGuardError).status, 413)
    const noBody = await readBoundedBodyBytes(new Request("https://x.test", { method: "POST" }), 10).catch((e: unknown) => e)
    assert.equal((noBody as HttpGuardError).code, "INVALID_PAYLOAD")
  })
  it("façade Véhicules : même comportement avec MileageDomainError", async () => {
    const ok = await readV3BodyBytes(request({}, bytes(5)), 5)
    assert.equal(ok.byteLength, 5)
    const error = await readV3BodyBytes(request({}, bytes(6)), 5, "DOCUMENT_FILE_TOO_LARGE").catch((e: unknown) => e)
    assert.ok(error instanceof MileageDomainError)
    assert.deepEqual([error.code, error.status], ["DOCUMENT_FILE_TOO_LARGE", 413])
  })
})

describe("magic-mime partagé", () => {
  it("même fonction exposée par Véhicules et par le module partagé", () => {
    assert.equal(vehiclesDetectMagicMime, detectMagicMime)
    assert.equal(detectMagicMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), "image/jpeg")
    assert.equal(detectMagicMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image/png")
    assert.equal(detectMagicMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0])), "application/pdf")
    assert.equal(detectMagicMime(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])), null)
    assert.equal(detectMagicMime(new Uint8Array(3)), null)
  })
})
