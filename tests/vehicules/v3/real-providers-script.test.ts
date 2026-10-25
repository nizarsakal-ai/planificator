// Véhicules V3 — recette fournisseurs réels : fixtures synthétiques, garde-fous et helpers purs (aucun réseau).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Message } from "@anthropic-ai/sdk/resources/messages"
import { buildSyntheticFixtures, FIXTURE_LINES, KNOWN_ADDRESSES, knownAddressFromText, readPngDimensions, renderTextBitmap, encodePng } from "../../../scripts/verification/vehicle-v3-real-providers.fixtures"
import {
  ACK_PHRASE, candidateInvariants, checkEnvironmentHygiene, collectSensitiveValues, createBoundedClient, createUsageTracker, describeError,
  matchKnownAddresses, parseArgs, redactOutput, summarize, validateRunPrefix,
} from "../../../scripts/verification/vehicle-v3-real-providers.support"
import { extractAddressLines, verifyBytes, type ImportCandidate } from "@/lib/vehicules/import-domain"
import { extractImport } from "@/lib/vehicules/import-extraction"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"

const candidate = (address: string, extra: Partial<ImportCandidate> = {}): ImportCandidate => ({ label: address.slice(0, 20), address, excerpt: address, page: null, latitude: null, longitude: null, confirmed: false, ...extra })

describe("fixtures synthétiques", () => {
  const fixtures = buildSyntheticFixtures()

  it("sont déterministes, valides pour verifyBytes et ne dépendent d'aucun réseau", () => {
    const again = buildSyntheticFixtures()
    assert.deepEqual(again.sha256, fixtures.sha256)
    verifyBytes(fixtures.png, "image/png"); verifyBytes(fixtures.textPdf, "application/pdf"); verifyBytes(fixtures.imagePdf, "application/pdf"); verifyBytes(fixtures.tamperedPng, "image/png")
    assert.notEqual(fixtures.sha256.png, fixtures.sha256.tamperedPng)
    const dimensions = readPngDimensions(fixtures.png)
    assert.ok(dimensions && dimensions.width > 500 && dimensions.height > 50 && dimensions.width <= 8000)
    assert.equal(readPngDimensions(fixtures.textPdf), null)
  })

  it("le PDF texte expose les deux adresses connues à l'extraction déterministe sans aucun appel OCR", async () => {
    const neverCalled = { messagesCreate: async () => { throw new Error("OCR_MUST_NOT_BE_CALLED") } }
    const result = await extractImport(fixtures.textPdf, "application/pdf", true, neverCalled)
    assert.ok(matchKnownAddresses(result.candidates, KNOWN_ADDRESSES).every(m => m.matched && m.excerptPresent))
    assert.deepEqual(result.warnings, ["REVUE_HUMAINE_REQUISE"])
    assert.ok(result.candidates.every(c => c.page === 1 && c.confirmed === false))
  })

  it("le PDF image-seule ne contient aucun texte extractible : sans drapeaux OCR, saisie manuelle et zéro appel", async () => {
    const neverCalled = { messagesCreate: async () => { throw new Error("OCR_MUST_NOT_BE_CALLED") } }
    for (const flag of ["PLANIFICATOR_VEHICLE_OCR_ENABLED", "PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK"]) delete process.env[flag]
    const result = await extractImport(fixtures.imagePdf, "application/pdf", true, neverCalled)
    assert.deepEqual(result, { candidates: [], warnings: ["OCR_NON_PRET_SAISIE_MANUELLE"] })
  })

  it("les lignes imprimées sont reconnues par extractAddressLines et la police couvre tous les caractères", () => {
    const found = extractAddressLines(FIXTURE_LINES.join("\n")).map(c => c.address)
    assert.equal(found.length, 2)
    const bitmap = renderTextBitmap(["A1-.,:'/ Z9"], { scale: 1, margin: 0 })
    assert.equal(bitmap.width, 11 * 6)
    assert.ok(bitmap.pixels.some(p => p === 0))
    assert.equal(encodePng(bitmap).subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  })
})

describe("arguments et accusé explicite", () => {
  const prefix = "recette-20261024-abc123"

  it("refuse sans mode, sans accusé exact, avec un préfixe absent ou non conforme", () => {
    assert.equal((parseArgs([]) as { refusal: { code: string } }).refusal.code, "ARG_MODE_REQUIRED")
    assert.equal((parseArgs(["--mode", "storage", "--prefix", prefix]) as { refusal: { code: string } }).refusal.code, "ACK_REQUIRED")
    assert.equal((parseArgs(["--mode", "storage", "--prefix", prefix, "--ack", "yes"]) as { refusal: { code: string } }).refusal.code, "ACK_INVALID")
    assert.equal((parseArgs(["--mode", "storage", "--ack", ACK_PHRASE]) as { refusal: { code: string } }).refusal.code, "PREFIX_REQUIRED")
    assert.equal((parseArgs(["--mode", "storage", "--ack", ACK_PHRASE, "--prefix", "planificator"]) as { refusal: { code: string } }).refusal.code, "PREFIX_FORBIDDEN")
    assert.equal((parseArgs(["--mode", "storage", "--ack", ACK_PHRASE, "--prefix", "recette"]) as { refusal: { code: string } }).refusal.code, "PREFIX_SHAPE_INVALID")
    assert.equal((parseArgs(["--mode", "ocr", "--ack", ACK_PHRASE, "--ocr-calls", "3"]) as { refusal: { code: string } }).refusal.code, "ARG_OCR_CALLS_INVALID")
    assert.equal((parseArgs(["--mode", "ocr", "--ack", ACK_PHRASE, "--bogus"]) as { refusal: { code: string } }).refusal.code, "ARG_UNKNOWN")
    assert.equal((parseArgs(["--mode", "fixtures"]) as { refusal: { code: string } }).refusal.code, "ARG_DUMP_REQUIRED")
  })

  it("accepte un préfixe unique strict et les options reconnues", () => {
    const storage = parseArgs(["--mode", "storage", "--ack", ACK_PHRASE, "--prefix", prefix, "--out", "r.json"])
    assert.ok(storage.ok && storage.args.prefix === prefix && storage.args.outPath === "r.json" && storage.args.ocrCalls === 2)
    assert.equal((parseArgs(["--mode", "ocr", "--ack", ACK_PHRASE, "--fixture", "tests/fixtures/x.png"]) as { refusal: { code: string } }).refusal.code, "FIXTURE_EXPECT_ADDRESS_REQUIRED")
    assert.equal((parseArgs(["--mode", "ocr", "--ack", ACK_PHRASE, "--expect-address", "12 rue des Lilas 75012 Paris"]) as { refusal: { code: string } }).refusal.code, "EXPECT_ADDRESS_WITHOUT_FIXTURE")
    const ocr = parseArgs(["--mode", "ocr", "--ack", ACK_PHRASE, "--ocr-calls", "1", "--fixture", "tests/fixtures/x.png", "--expect-address", "12 rue des Lilas 75012 Paris", "--expect-address", "8 avenue des Fleurs 31000 Toulouse"])
    assert.ok(ocr.ok && ocr.args.ocrCalls === 1 && ocr.args.fixturePath === "tests/fixtures/x.png" && ocr.args.expectedAddresses.length === 2)
    assert.equal(validateRunPrefix("recette-20261024-a1b2c3"), null)
    assert.equal(validateRunPrefix("Recette-20261024-a1b2c3")?.code, "PREFIX_SHAPE_INVALID")
    assert.equal(validateRunPrefix("recette-20261024-a/b")?.code, "PREFIX_SHAPE_INVALID")
  })
})

describe("hygiène d'environnement", () => {
  const cloud = { CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" }
  it("exige uniquement les variables du service testé et refuse toute base de données", () => {
    assert.equal(checkEnvironmentHygiene("storage", cloud as unknown as NodeJS.ProcessEnv), null)
    assert.equal(checkEnvironmentHygiene("storage", { CLOUDINARY_URL: "cloudinary://k:s@c" } as unknown as NodeJS.ProcessEnv), null)
    assert.equal(checkEnvironmentHygiene("storage", {} as unknown as NodeJS.ProcessEnv)?.code, "ENV_CLOUDINARY_MISSING")
    assert.equal(checkEnvironmentHygiene("storage", { ...cloud, ANTHROPIC_API_KEY: "x" } as unknown as NodeJS.ProcessEnv)?.code, "ENV_NOT_MINIMAL")
    assert.equal(checkEnvironmentHygiene("storage", { ...cloud, DATABASE_URL: "postgresql://x" } as unknown as NodeJS.ProcessEnv)?.code, "ENV_NOT_MINIMAL")
    assert.equal(checkEnvironmentHygiene("ocr", { ANTHROPIC_API_KEY: "x" } as unknown as NodeJS.ProcessEnv), null)
    assert.equal(checkEnvironmentHygiene("ocr", {} as unknown as NodeJS.ProcessEnv)?.code, "ENV_ANTHROPIC_API_KEY_MISSING")
    assert.equal(checkEnvironmentHygiene("ocr", { ANTHROPIC_API_KEY: "x", ...cloud } as unknown as NodeJS.ProcessEnv)?.code, "ENV_NOT_MINIMAL")
    assert.equal(checkEnvironmentHygiene("ocr", { ANTHROPIC_API_KEY: "x", ACQUISITION_EXTRACTION_MODEL: "claude-invente" } as unknown as NodeJS.ProcessEnv)?.code, "OCR_MODEL_NOT_ALLOWLISTED")
    assert.equal(checkEnvironmentHygiene("ocr", { ANTHROPIC_API_KEY: "x", ACQUISITION_EXTRACTION_MODEL: "claude-haiku-4-5" } as unknown as NodeJS.ProcessEnv), null)
  })
})

describe("recette uniquement sur le fournisseur officiel", () => {
  it("refuse endpoint ou authentification Anthropic alternatifs avant réseau", () => {
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
      const env = { NODE_ENV: "test", ANTHROPIC_API_KEY: "fixture-only", [name]: "fixture-only" } as NodeJS.ProcessEnv
      assert.equal(checkEnvironmentHygiene("ocr", env)?.code, "ENV_NOT_MINIMAL")
    }
  })
})

describe("client Anthropic borné", () => {
  const response = (tokens: number): Message => ({ id: "msg", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "{\"candidates\":[]}", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: tokens, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null } } as unknown as Message)

  it("compte les appels, relève l'utilisation et refuse localement le troisième appel", async () => {
    let innerCalls = 0
    const usage = createUsageTracker(2)
    const client = createBoundedClient({ messagesCreate: async () => { innerCalls += 1; return response(100) } }, usage)
    const body = { model: "claude-haiku-4-5", max_tokens: 4096, messages: [] }
    await client.messagesCreate(body); await client.messagesCreate(body)
    await assert.rejects(client.messagesCreate(body), (error: unknown) => error instanceof MileageDomainError && error.code === "OCR_CALL_BUDGET_EXCEEDED")
    assert.equal(innerCalls, 2)
    assert.deepEqual({ calls: usage.calls, attempted: usage.attempted, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model }, { calls: 2, attempted: 3, inputTokens: 200, outputTokens: 2, model: "claude-haiku-4-5" })
  })

  it("refuse un modèle hors allowlist ou un max_tokens excessif sans contacter le fournisseur", async () => {
    let innerCalls = 0
    const client = createBoundedClient({ messagesCreate: async () => { innerCalls += 1; return response(1) } }, createUsageTracker())
    await assert.rejects(client.messagesCreate({ model: "claude-invente", max_tokens: 10, messages: [] }), /OCR_MODEL_NOT_ALLOWLISTED/)
    await assert.rejects(client.messagesCreate({ model: "claude-haiku-4-5", max_tokens: 8192, messages: [] }), /OCR_MAX_TOKENS_INVALID/)
    assert.equal(innerCalls, 0)
  })
})

describe("oracle d'adresses et invariants", () => {
  it("dérive un oracle robuste d'une adresse en clair et refuse une adresse trop faible", () => {
    assert.deepEqual(knownAddressFromText("12 rue des Lilas, 75012 Paris, France").tokens, ["12", "lilas", "75012", "paris"])
    assert.deepEqual(KNOWN_ADDRESSES.map(k => k.tokens), [["12", "paix", "75002", "paris"], ["45", "jean", "jaures", "69007", "lyon"]])
    assert.throws(() => knownAddressFromText("rue de la Paix"), /KNOWN_ADDRESS_TOO_WEAK/)
    const codex = [candidate("12 rue des Lilas, 75012 Paris, France"), candidate("8 avenue des Fleurs, 31000 Toulouse, France")]
    const oracle = ["12 rue des Lilas 75012 Paris", "8 avenue des Fleurs 31000 Toulouse"].map(a => knownAddressFromText(a))
    assert.ok(matchKnownAddresses(codex, oracle).every(m => m.matched))
  })

  it("reconnaît les deux adresses malgré casse et accents, exige preuve et confirmed:false", () => {
    const good = [candidate("12 rue de la Paix, 75002 Paris"), candidate("45 Avenue Jean Jaurès 69007 LYON", { excerpt: "2. 45 AVENUE JEAN JAURES 69007 LYON" })]
    assert.ok(matchKnownAddresses(good, KNOWN_ADDRESSES).every(m => m.matched && m.excerptPresent))
    assert.deepEqual(candidateInvariants(good), { total: 2, allUnconfirmed: true, allWithoutCoordinates: true, allWithExcerpt: true })
    const bad = [candidate("12 rue de la Paix 75002 Paris"), candidate("1 place Bellecour 69002 Lyon", { confirmed: true, latitude: 45.75, longitude: 4.83, excerpt: "" })]
    const matches = matchKnownAddresses(bad, KNOWN_ADDRESSES)
    assert.deepEqual(matches.map(m => m.matched), [true, false])
    assert.deepEqual(candidateInvariants(bad), { total: 2, allUnconfirmed: false, allWithoutCoordinates: false, allWithExcerpt: false })
  })
})

describe("erreurs et redaction", () => {
  it("décrit une erreur sans jamais recopier le message fournisseur", () => {
    assert.deepEqual(describeError(new MileageDomainError("SOURCE_UNAVAILABLE", 503)), { kind: "DOMAIN", code: "SOURCE_UNAVAILABLE", status: 503 })
    assert.deepEqual(describeError({ http_code: 401, message: "Invalid Signature abcdef for cloud secret-cloud", name: "Error" }), { kind: "CLOUDINARY", httpCode: 401 })
    const generic = describeError(new Error("Authentication failed for key sk-ant-xyz"))
    assert.deepEqual(generic, { kind: "Error" })
    assert.deepEqual(describeError(new Error("DOCUMENT_STORAGE_FAILED")), { kind: "Error", code: "DOCUMENT_STORAGE_FAILED" })
    assert.equal(JSON.stringify(describeError(new TypeError("fetch failed https://x"))).includes("https"), false)
  })

  it("masque secrets, nom du cloud et toute URL dans la sortie", () => {
    const env = { CLOUDINARY_URL: "cloudinary://1234567890:s3cr3t-value@my-cloud-name", ANTHROPIC_API_KEY: "sk-ant-fixture-key", DATABASE_URL: "postgresql://u:p@h/db" } as unknown as NodeJS.ProcessEnv
    const sensitive = collectSensitiveValues(env)
    const text = JSON.stringify({ a: "https://res.cloudinary.com/my-cloud-name/raw/authenticated/s--sig--/x.pdf", b: "key sk-ant-fixture-key", c: "cloud my-cloud-name 1234567890 s3cr3t-value", d: "postgresql://u:p@h/db" })
    const redacted = redactOutput(text, sensitive)
    for (const forbidden of ["my-cloud-name", "sk-ant-fixture-key", "s3cr3t-value", "1234567890", "https://", "postgresql://u:p@h/db"]) assert.equal(redacted.includes(forbidden), false, forbidden)
    assert.ok(redacted.includes("[URL_REDACTED]") && redacted.includes("[REDACTED]"))
  })

  it("le résumé échoue si une étape échoue ou si le nettoyage laisse un objet", () => {
    const steps = [{ id: "a", status: "PASS" as const, assertions: 3 }, { id: "b", status: "SKIP" as const, assertions: 0 }]
    assert.deepEqual(summarize(steps, true), { status: "PASS", passed: 1, failed: 0, skipped: 1, assertions: 3 })
    assert.equal(summarize(steps, false).status, "FAIL")
    assert.equal(summarize([...steps, { id: "c", status: "FAIL", assertions: 1 }], true).status, "FAIL")
  })
})
