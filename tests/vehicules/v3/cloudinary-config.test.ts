// Véhicules V3 — configuration Cloudinary autonome des adaptateurs (triplet ou CLOUDINARY_URL), sans réseau.
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { v2 as cloudinary } from "cloudinary"
import { ensureCloudinaryConfigured, resolveCloudinaryConfigSource } from "@/lib/vehicules/cloudinary-config"
import { CloudinaryDocumentStorageAdapter, DOCUMENT_STORAGE_NOT_CONFIGURED } from "@/lib/vehicules/v3/document-storage.port"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"

const NAMES = ["CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const
const FIXTURE_URL = "cloudinary://fixture-key-123:fixture-secret-456@fixture-cloud"

function fakeEnv(values: Partial<Record<(typeof NAMES)[number], string>>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

describe("resolveCloudinaryConfigSource", () => {
  it("préfère le triplet complet, sinon CLOUDINARY_URL bien formée, sinon rien", () => {
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" })), "triplet")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s", CLOUDINARY_URL: FIXTURE_URL })), "triplet")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_URL: FIXTURE_URL })), "url")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_URL: "https://not-cloudinary.example" })), "missing")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_URL: "cloudinary://only-key@cloud" })), "missing")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: " ", CLOUDINARY_API_SECRET: "s" })), "missing")
    assert.equal(resolveCloudinaryConfigSource(fakeEnv({})), "missing")
  })
})

describe("ensureCloudinaryConfigured", () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => { for (const name of NAMES) { saved[name] = process.env[name]; delete process.env[name] } })
  afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } cloudinary.config(true) })

  it("configure explicitement le SDK depuis le triplet (valeurs nettoyées, secure)", () => {
    const env = fakeEnv({ CLOUDINARY_CLOUD_NAME: " fixture-cloud ", CLOUDINARY_API_KEY: "fixture-key", CLOUDINARY_API_SECRET: "fixture-secret" })
    assert.equal(ensureCloudinaryConfigured("X_NOT_CONFIGURED", env), "triplet")
    const current = cloudinary.config()
    assert.equal(current.cloud_name, "fixture-cloud")
    assert.equal(current.api_key, "fixture-key")
    assert.equal(current.api_secret, "fixture-secret")
    assert.equal(current.secure, true)
  })

  it("relit CLOUDINARY_URL même si un autre module a déjà initialisé le SDK avec des valeurs vides", () => {
    cloudinary.config({ cloud_name: undefined, api_key: undefined, api_secret: undefined })
    process.env.CLOUDINARY_URL = FIXTURE_URL
    assert.equal(ensureCloudinaryConfigured("X_NOT_CONFIGURED", process.env), "url")
    const current = cloudinary.config()
    assert.equal(current.cloud_name, "fixture-cloud")
    assert.equal(current.api_key, "fixture-key-123")
    assert.equal(current.api_secret, "fixture-secret-456")
    assert.equal(current.secure, true)
  })

  it("refuse avec le code fourni et le statut 503 lorsque rien n'est défini", () => {
    assert.throws(() => ensureCloudinaryConfigured("SOURCE_STORAGE_NOT_CONFIGURED", fakeEnv({})), (error: unknown) =>
      error instanceof MileageDomainError && error.code === "SOURCE_STORAGE_NOT_CONFIGURED" && error.status === 503)
  })

  it("l'adaptateur documents refuse avant tout envoi réseau si le SDK ne peut pas être configuré", async () => {
    const adapter = new CloudinaryDocumentStorageAdapter()
    const location = { companyId: "c1", truckId: "t1", documentId: "d1", versionId: "v1", sha256: "a".repeat(64), extension: ".pdf" }
    const isNotConfigured = (error: unknown) => error instanceof MileageDomainError && error.code === DOCUMENT_STORAGE_NOT_CONFIGURED && error.status === 503
    await assert.rejects(adapter.store(location, new Uint8Array([1])), isNotConfigured)
    await assert.rejects(adapter.createSignedUrl("planificator/c1/x", new Date()), isNotConfigured)
    await assert.rejects(adapter.destroy("planificator/c1/x"), isNotConfigured)
  })

  it("avec le triplet, la signature d'URL privée fonctionne sans réseau et n'expose pas le secret", async () => {
    process.env.CLOUDINARY_CLOUD_NAME = "fixture-cloud"; process.env.CLOUDINARY_API_KEY = "fixture-key"; process.env.CLOUDINARY_API_SECRET = "fixture-secret"
    const url = await new CloudinaryDocumentStorageAdapter().createSignedUrl("planificator/c1/vehicles/t1/documents/d1/v1-aaaaaaaaaaaaaaaa.pdf", new Date(Date.now() + 60_000))
    assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/fixture-cloud\/raw\/download\?/)
    assert.match(url, /signature=[0-9a-f]{40}/)
    assert.doesNotMatch(url, /fixture-secret/)
  })
})
