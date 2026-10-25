/**
 * Recette fournisseurs réels Véhicules V3 — stockage privé Cloudinary et OCR Anthropic.
 *
 * Exécution (environnement épuré : uniquement les variables du service testé) :
 *   npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode fixtures --dump <dir>
 *   npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode storage --prefix recette-AAAAMMJJ-xxxxxx --ack I_ACCEPT_REAL_PROVIDER_COSTS [--out rapport.json]
 *   npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode ocr --ack I_ACCEPT_REAL_PROVIDER_COSTS [--ocr-calls 1|2] [--out rapport.json]
 *       [--fixture tests/fixtures/vehicules/x.png --expect-address "12 rue des Lilas 75012 Paris" --expect-address "8 avenue des Fleurs 31000 Toulouse"]
 *
 * Garanties :
 *   - refus sans accusé explicite, sans préfixe de recette unique strict, ou si l'environnement
 *     contient des variables étrangères au service testé (DATABASE_URL, autre fournisseur…) ;
 *   - aucune base de données ; adaptateurs applicatifs réels (document-storage.port, import-storage,
 *     extractImport multimodal) ; jamais de faux client ;
 *   - fichiers entièrement synthétiques générés localement ;
 *   - suppression uniquement des objets exacts créés pendant l'exécution (aucune liste/suppression de dossier) ;
 *   - OCR : 2 appels réels maximum, plafond appliqué localement avant tout envoi ;
 *   - sortie JSON sans clé, sans URL signée, sans nom de cloud, sans message fournisseur brut.
 * Code de sortie : 0 PASS, 1 FAIL, 2 REFUSED.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { randomBytes } from "node:crypto"
import { v2 as cloudinary } from "cloudinary"
import { CloudinaryDocumentStorageAdapter, buildDocumentStorageKey, type DocumentStorageLocation } from "@/lib/vehicules/v3/document-storage.port"
import { defaultFetchSigned, readVerifiedDocumentBytes } from "@/lib/vehicules/v3/document-service"
import { readImportSource, storeImportSource } from "@/lib/vehicules/import-storage"
import { extractImport } from "@/lib/vehicules/import-extraction"
import { validateReview, verifyBytes, type ImportCandidate } from "@/lib/vehicules/import-domain"
import { createAnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import { readAnthropicApiKey, resolveAnthropicExtractionModel } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { resolveCloudinaryConfigSource } from "@/lib/vehicules/cloudinary-config"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { buildSyntheticFixtures, KNOWN_ADDRESSES, knownAddressFromText, readPngDimensions, type KnownAddress, type SyntheticFixtures } from "./vehicle-v3-real-providers.fixtures"
import {
  candidateInvariants, checkEnvironmentHygiene, collectSensitiveValues, createBoundedClient, createUsageTracker, describeError,
  matchKnownAddresses, parseArgs, redactOutput, sha256Hex, summarize, type ParsedArgs, type RunReport, type StepReport,
} from "./vehicle-v3-real-providers.support"

const REPO_ROOT = resolve(__dirname, "..", "..")
const FIXTURES_ROOT = join(REPO_ROOT, "tests", "fixtures")
const OCR_FLAGS = ["PLANIFICATOR_VEHICLE_OCR_ENABLED", "PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK"] as const

class AssertionFailure extends Error { constructor(readonly code: string, readonly detail?: Record<string, unknown>) { super(code); this.name = "AssertionFailure" } }

function makeReport(args: ParsedArgs, runId: string): RunReport {
  return { script: "vehicle-v3-real-providers", version: 1, mode: args.mode, startedAt: new Date().toISOString(), finishedAt: null, runId, prefix: args.prefix, fixtures: {}, steps: [], ocr: null, cleanup: null, summary: { status: "FAIL", passed: 0, failed: 0, skipped: 0, assertions: 0 } }
}

/** Exécute une étape ; compte les assertions ; n'expose jamais un message fournisseur. */
async function runStep(report: RunReport, id: string, body: (expect: (condition: unknown, code: string, detail?: Record<string, unknown>) => void) => Promise<Record<string, unknown> | void>): Promise<boolean> {
  let assertions = 0
  const expect = (condition: unknown, code: string, detail?: Record<string, unknown>) => { assertions += 1; if (!condition) throw new AssertionFailure(code, detail) }
  const step: StepReport = { id, status: "PASS", assertions: 0 }
  try {
    const detail = await body(expect)
    if (detail) step.detail = detail
  } catch (error) {
    step.status = "FAIL"
    step.error = error instanceof AssertionFailure ? { kind: "ASSERTION", code: error.code } : describeError(error)
    if (error instanceof AssertionFailure && error.detail) step.detail = error.detail
  }
  step.assertions = assertions
  report.steps.push(step)
  return step.status === "PASS"
}

function skipStep(report: RunReport, id: string, reason: string) { report.steps.push({ id, status: "SKIP", assertions: 0, detail: { reason } }) }

function registerFixtures(report: RunReport, fixtures: SyntheticFixtures) {
  report.fixtures = {
    png: { bytes: fixtures.png.length, sha256: fixtures.sha256.png, source: "generated" },
    textPdf: { bytes: fixtures.textPdf.length, sha256: fixtures.sha256.textPdf, source: "generated" },
    imagePdf: { bytes: fixtures.imagePdf.length, sha256: fixtures.sha256.imagePdf, source: "generated" },
    tamperedPng: { bytes: fixtures.tamperedPng.length, sha256: fixtures.sha256.tamperedPng, source: "generated" },
  }
}

/** Fixture PNG externe autorisée uniquement sous tests/fixtures (chemin réel, pas de lien sortant). */
function loadFixturePng(path: string): Buffer {
  let real: string
  try { real = realpathSync(resolve(REPO_ROOT, path)) } catch { throw new MileageDomainError("FIXTURE_NOT_FOUND", 400) }
  if (!real.startsWith(FIXTURES_ROOT + sep)) throw new MileageDomainError("FIXTURE_PATH_OUTSIDE_TESTS_FIXTURES", 400)
  const bytes = readFileSync(real)
  verifyBytes(bytes, "image/png")
  return bytes
}

/* ================================================================== stockage */

async function runStorage(args: ParsedArgs, report: RunReport, fixtures: SyntheticFixtures, recordPlan?: (plan: Record<string, unknown>) => Promise<void>) {
  const prefix = args.prefix!
  process.env.VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX = prefix
  const adapter = new CloudinaryDocumentStorageAdapter()
  const created: string[] = [], destroyed: string[] = []
  const imports: string[] = []
  report.cleanup = { created, destroyed, leftovers: [] }
  const suffix = randomBytes(4).toString("hex")
  const scope = { companyId: `${prefix}-co-${suffix}`, truckId: `${prefix}-truck-${suffix}`, documentId: `doc-${suffix}` }
  const v1: DocumentStorageLocation = { ...scope, versionId: `v1-${suffix}`, sha256: fixtures.sha256.textPdf, extension: ".pdf" }
  const v2: DocumentStorageLocation = { ...scope, versionId: `v2-${suffix}`, sha256: fixtures.sha256.png, extension: ".png" }
  const plan = { scope, configurationPresent: { cloudinaryUrl: !!process.env.CLOUDINARY_URL, cloudinaryTriplet: ["CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"].every(k => !!process.env[k]) }, expectedDocumentKeys: [buildDocumentStorageKey(v1), buildDocumentStorageKey(v2)] }
  report.steps.push({ id: "storage.plan", status: "PASS", assertions: 0, detail: plan })
  if (recordPlan) await recordPlan(plan) // persist before any remote object is created
  const ttl = () => new Date(Date.now() + 5 * 60_000)

  const readSigned = async (storageKey: string, expected: { sizeBytes: number; sha256: string }) => {
    const url = await adapter.createSignedUrl(storageKey, ttl())
    const fetched = await defaultFetchSigned(url)
    return { status: fetched.status, bytes: fetched.ok ? await readVerifiedDocumentBytes(fetched, expected, 4 * 1024 * 1024) : null }
  }
  const unsignedStatus = async (storageKey: string) => {
    const url = cloudinary.url(storageKey, { resource_type: "raw", type: "authenticated", secure: true, sign_url: false })
    const response = await fetch(url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000) })
    const body = response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null
    return { status: response.status, leaked: body !== null && (sha256Hex(body) === fixtures.sha256.textPdf || sha256Hex(body) === fixtures.sha256.png) }
  }

  try {
    const configured = await runStep(report, "storage.config", async expect => {
      const source = resolveCloudinaryConfigSource(process.env)
      expect(source !== "missing", "CLOUDINARY_CONFIG_MISSING")
      await adapter.createSignedUrl(`${prefix}/probe`, ttl()) // configure + signature locale, aucun appel réseau
      const config = cloudinary.config()
      expect(!config.upload_prefix || config.upload_prefix === "https://api.cloudinary.com", "CLOUDINARY_CUSTOM_ENDPOINT_REFUSED")
      expect(!config.api_proxy, "CLOUDINARY_PROXY_REFUSED")
      return { source }
    })
    if (!configured) return

    let keyV1 = ""
    const stored = await runStep(report, "storage.store-v1", async expect => {
      const result = await adapter.store(v1, fixtures.textPdf)
      expect(result.created === true, "STORE_NOT_CREATED")
      expect(result.storageKey.startsWith(`${prefix}/`), "STORE_KEY_OUTSIDE_PREFIX")
      expect(result.storageKey.endsWith(`${v1.versionId}-${v1.sha256.slice(0, 16)}.pdf`), "STORE_KEY_SHAPE")
      keyV1 = result.storageKey; created.push(keyV1)
      return { storageKey: keyV1 }
    })
    if (!stored) return

    await runStep(report, "storage.read-signed-v1", async expect => {
      const read = await readSigned(keyV1, { sizeBytes: fixtures.textPdf.length, sha256: fixtures.sha256.textPdf })
      expect(read.status === 200, "SIGNED_READ_STATUS", { status: read.status })
      expect(read.bytes !== null && Buffer.from(read.bytes).equals(fixtures.textPdf), "SIGNED_READ_BYTES_DIFFER")
      expect(read.bytes !== null && sha256Hex(read.bytes) === fixtures.sha256.textPdf, "SIGNED_READ_SHA_DIFFER")
      return { status: read.status, bytes: read.bytes?.length ?? 0 }
    })

    await runStep(report, "storage.unsigned-refused", async expect => {
      const result = await unsignedStatus(keyV1)
      expect(result.leaked === false, "UNSIGNED_URL_LEAKS_CONTENT", { status: result.status })
      expect(result.status !== 200, "UNSIGNED_URL_RETURNED_200", { status: result.status })
      return { status: result.status }
    })

    await runStep(report, "storage.expired-signature-refused", async expect => {
      const expired = await adapter.createSignedUrl(keyV1, new Date(Date.now() - 120_000))
      const response = await defaultFetchSigned(expired)
      await response.body?.cancel().catch(() => undefined)
      expect(response.status >= 400 && response.status < 500, "EXPIRED_SIGNATURE_ACCEPTED", { status: response.status })
      return { status: response.status }
    })

    await runStep(report, "storage.replay-same-key", async expect => {
      const replay = await adapter.store(v1, fixtures.textPdf)
      expect(replay.created === false, "REPLAY_CREATED_DUPLICATE")
      expect(replay.storageKey === keyV1, "REPLAY_KEY_DIFFERS")
      return { created: replay.created }
    })

    await runStep(report, "storage.immutable-overwrite-refused", async expect => {
      const attempt = await adapter.store(v1, fixtures.tamperedPng)
      expect(attempt.created === false, "OVERWRITE_ACCEPTED")
      const read = await readSigned(keyV1, { sizeBytes: fixtures.textPdf.length, sha256: fixtures.sha256.textPdf })
      expect(read.bytes !== null && sha256Hex(read.bytes) === fixtures.sha256.textPdf, "OVERWRITE_CHANGED_BYTES")
      return { created: attempt.created }
    })

    let keyV2 = ""
    await runStep(report, "storage.store-v2-replacement", async expect => {
      const result = await adapter.store(v2, fixtures.png)
      expect(result.created === true, "V2_NOT_CREATED")
      expect(result.storageKey !== keyV1 && result.storageKey.startsWith(`${prefix}/`), "V2_KEY_INVALID")
      keyV2 = result.storageKey; created.push(keyV2)
      const readV2 = await readSigned(keyV2, { sizeBytes: fixtures.png.length, sha256: fixtures.sha256.png })
      expect(readV2.bytes !== null && sha256Hex(readV2.bytes) === fixtures.sha256.png, "V2_BYTES_DIFFER")
      const readV1 = await readSigned(keyV1, { sizeBytes: fixtures.textPdf.length, sha256: fixtures.sha256.textPdf })
      expect(readV1.bytes !== null && sha256Hex(readV1.bytes) === fixtures.sha256.textPdf, "V1_ALTERED_BY_V2")
      return { storageKey: keyV2 }
    })

    await runStep(report, "storage.destroy-and-absence", async expect => {
      for (const key of [keyV1, keyV2].filter(Boolean)) {
        await adapter.destroy(key)
        destroyed.push(key)
        const after = await defaultFetchSigned(await adapter.createSignedUrl(key, ttl()))
        await after.body?.cancel().catch(() => undefined)
        expect(after.ok === false && after.status === 404, "DESTROYED_OBJECT_STILL_READABLE", { storageKey: key, status: after.status })
        await adapter.destroy(key) // absence tolérée, jamais d'exception
      }
      return { destroyed: [...destroyed] }
    })

    await runStep(report, "import-storage.roundtrip", async expect => {
      const id = await storeImportSource(fixtures.png, scope.companyId, scope.truckId)
      imports.push(id); created.push(id)
      expect(/^vehicle-imports\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-z0-9-]{36}$/.test(id), "IMPORT_ID_SHAPE")
      const bytes = await readImportSource(id)
      expect(sha256Hex(bytes) === fixtures.sha256.png, "IMPORT_BYTES_DIFFER")
      const unsigned = await unsignedStatus(id)
      expect(unsigned.leaked === false && unsigned.status !== 200, "IMPORT_UNSIGNED_URL_OPEN", { status: unsigned.status })
      const result = await cloudinary.uploader.destroy(id, { resource_type: "raw", type: "authenticated", invalidate: true })
      expect(result.result === "ok", "IMPORT_DESTROY_FAILED")
      destroyed.push(id)
      await readImportSource(id).then(() => expect(false, "IMPORT_STILL_READABLE"), error => expect(error instanceof MileageDomainError && error.code === "SOURCE_UNAVAILABLE", "IMPORT_ABSENCE_CODE"))
      return { storageId: id, note: "import-storage utilise un préfixe fixe vehicle-imports/<hash entreprise>/<hash camion>, hors VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX" }
    })
  } finally {
    // Compensation stricte : uniquement les clés exactes créées pendant cette exécution.
    for (const key of created) {
      if (destroyed.includes(key)) continue
      try {
        if (imports.includes(key)) { const r = await cloudinary.uploader.destroy(key, { resource_type: "raw", type: "authenticated", invalidate: true }); if (r.result === "ok" || r.result === "not found") destroyed.push(key) }
        else { await adapter.destroy(key); destroyed.push(key) }
      } catch { /* consigné dans leftovers ci-dessous */ }
    }
    report.cleanup!.leftovers = created.filter(key => !destroyed.includes(key))
    delete process.env.VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX
  }
}

/* ================================================================== OCR */

async function runOcr(args: ParsedArgs, report: RunReport, fixtures: SyntheticFixtures) {
  const usage = createUsageTracker(args.ocrCalls)
  report.ocr = usage
  const key = readAnthropicApiKey()
  const model = resolveAnthropicExtractionModel()
  const png = args.fixturePath ? loadFixturePng(args.fixturePath) : fixtures.png
  if (args.fixturePath) report.fixtures.png = { bytes: png.length, sha256: sha256Hex(png), source: "file" }
  /** Oracle de l'image : adresses déclarées pour une fixture externe, adresses imprimées pour la fixture générée. */
  const pngOracle: readonly KnownAddress[] = args.fixturePath ? args.expectedAddresses.map(address => knownAddressFromText(address)) : KNOWN_ADDRESSES
  const client = createBoundedClient(createAnthropicExtractionClient(key ?? ""), usage)
  const setFlags = (on: boolean) => { for (const flag of OCR_FLAGS) { if (on) process.env[flag] = "true"; else delete process.env[flag] } }
  const assertCandidates = (expect: Parameters<Parameters<typeof runStep>[2]>[0], candidates: ImportCandidate[], warnings: string[], known: readonly KnownAddress[]) => {
    const invariants = candidateInvariants(candidates)
    const matches = matchKnownAddresses(candidates, known)
    expect(invariants.total >= 2, "OCR_TOO_FEW_CANDIDATES", { total: invariants.total })
    expect(invariants.allUnconfirmed, "OCR_CANDIDATE_PRECONFIRMED")
    expect(invariants.allWithoutCoordinates, "OCR_CANDIDATE_HAS_COORDINATES")
    expect(matches.every(m => m.matched), "OCR_KNOWN_ADDRESS_MISSING", { matches })
    expect(matches.every(m => m.excerptPresent), "OCR_PROOF_EXCERPT_MISSING", { matches })
    expect(warnings.includes("OCR_A_VERIFIER") && warnings.includes("REVUE_HUMAINE_REQUISE"), "OCR_WARNINGS_MISSING", { warnings })
    return { candidates: invariants.total, matches, warnings }
  }

  try {
    const ready = await runStep(report, "ocr.config", async expect => {
      expect(key !== null, "ANTHROPIC_API_KEY_MISSING")
      expect(model !== null, "OCR_MODEL_NOT_ALLOWLISTED")
      const dimensions = readPngDimensions(png)
      expect(dimensions !== null, "PNG_FIXTURE_INVALID")
      return { model, pngDimensions: dimensions }
    })
    if (!ready) return

    setFlags(false)
    await runStep(report, "ocr.gate-flags-off", async expect => {
      const result = await extractImport(png, "image/png", true, client)
      expect(result.candidates.length === 0 && result.warnings.includes("OCR_NON_PRET_SAISIE_MANUELLE"), "OCR_RAN_WITHOUT_FLAGS", { warnings: result.warnings })
      expect(usage.calls === 0 && usage.attempted === 0, "OCR_CALLED_WITHOUT_FLAGS")
      return { warnings: result.warnings, calls: usage.calls }
    })

    setFlags(true)
    await runStep(report, "ocr.gate-consent-off", async expect => {
      const result = await extractImport(png, "image/png", false, client)
      expect(result.warnings.includes("OCR_NON_PRET_SAISIE_MANUELLE"), "OCR_RAN_WITHOUT_CONSENT", { warnings: result.warnings })
      expect(usage.calls === 0 && usage.attempted === 0, "OCR_CALLED_WITHOUT_CONSENT")
      return { warnings: result.warnings, calls: usage.calls }
    })

    await runStep(report, "ocr.text-pdf-deterministic-no-call", async expect => {
      const result = await extractImport(fixtures.textPdf, "application/pdf", true, client)
      const matches = matchKnownAddresses(result.candidates, KNOWN_ADDRESSES)
      expect(matches.every(m => m.matched), "DETERMINISTIC_ADDRESS_MISSING", { matches })
      expect(!result.warnings.includes("OCR_A_VERIFIER"), "DETERMINISTIC_PATH_USED_OCR")
      expect(usage.calls === 0 && usage.attempted === 0, "OCR_CALLED_FOR_TEXT_PDF")
      return { candidates: result.candidates.length, calls: usage.calls }
    })

    let ocrCandidates: ImportCandidate[] = []
    await runStep(report, "ocr.real-image-png", async expect => {
      const before = usage.calls
      const result = await extractImport(png, "image/png", true, client)
      expect(usage.calls === before + 1, "OCR_CALL_COUNT_UNEXPECTED", { calls: usage.calls })
      ocrCandidates = result.candidates
      return assertCandidates(expect, result.candidates, result.warnings, pngOracle)
    })

    if (args.ocrCalls === 2) {
      await runStep(report, "ocr.real-document-pdf-image-only", async expect => {
        const before = usage.calls
        const result = await extractImport(fixtures.imagePdf, "application/pdf", true, client)
        expect(usage.calls === before + 1, "OCR_CALL_COUNT_UNEXPECTED", { calls: usage.calls })
        if (!ocrCandidates.length) ocrCandidates = result.candidates
        return assertCandidates(expect, result.candidates, result.warnings, KNOWN_ADDRESSES)
      })
    } else skipStep(report, "ocr.real-document-pdf-image-only", "--ocr-calls 1")

    await runStep(report, "ocr.human-confirmation-gate", async expect => {
      expect(ocrCandidates.length > 0, "NO_CANDIDATES_TO_REVIEW")
      let refused: string | null = null
      try { validateReview({ expectedRevision: 0, approve: true, candidates: ocrCandidates }) } catch (error) { refused = error instanceof MileageDomainError ? error.code : "OTHER" }
      expect(refused === "HUMAN_CONFIRMATION_REQUIRED", "UNCONFIRMED_CANDIDATES_APPROVABLE", { refused })
      const confirmed = validateReview({ expectedRevision: 0, approve: true, candidates: ocrCandidates.map(c => ({ ...c, confirmed: true })) })
      expect(confirmed.candidates.length === ocrCandidates.length, "CONFIRMED_REVIEW_REJECTED")
      return { refusedCode: refused }
    })

    await runStep(report, "ocr.call-budget", async expect => {
      expect(usage.calls <= usage.maxCalls, "OCR_BUDGET_EXCEEDED", { calls: usage.calls })
      expect(usage.attempted === usage.calls, "OCR_LOCAL_REFUSALS_PRESENT", { attempted: usage.attempted })
      return { calls: usage.calls, maxCalls: usage.maxCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    })
  } finally {
    setFlags(false)
  }
}

/* ================================================================== point d'entrée */

async function main(argv: string[]): Promise<number> {
  const sensitive = collectSensitiveValues(process.env)
  const emit = (report: RunReport, outPath: string | null) => {
    const text = redactOutput(JSON.stringify(report, null, 2), sensitive)
    if (outPath) { mkdirSync(dirname(resolve(outPath)), { recursive: true }); writeFileSync(resolve(outPath), text + "\n", { mode: 0o600 }) }
    process.stdout.write(text + "\n")
  }
  const parsed = parseArgs(argv)
  const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`
  if (!parsed.ok) {
    const report = makeReport({ mode: "fixtures", ack: false, prefix: null, fixturePath: null, expectedAddresses: [], dumpDir: null, outPath: null, ocrCalls: 2 }, runId)
    report.finishedAt = new Date().toISOString()
    report.summary = { status: "REFUSED", passed: 0, failed: 0, skipped: 0, assertions: 0, refusal: parsed.refusal }
    emit(report, null)
    return 2
  }
  const { args } = parsed
  const report = makeReport(args, runId)
  const fixtures = buildSyntheticFixtures()
  registerFixtures(report, fixtures)

  if (args.mode === "fixtures") {
    const dir = resolve(args.dumpDir!)
    mkdirSync(dir, { recursive: true })
    for (const [name, bytes] of [["recette-adresses.png", fixtures.png], ["recette-adresses-texte.pdf", fixtures.textPdf], ["recette-adresses-image.pdf", fixtures.imagePdf], ["recette-contenu-modifie.png", fixtures.tamperedPng]] as const) writeFileSync(join(dir, name), bytes)
    report.steps.push({ id: "fixtures.dump", status: "PASS", assertions: 0, detail: { dir, files: 4 } })
    report.finishedAt = new Date().toISOString()
    report.summary = summarize(report.steps, true)
    emit(report, args.outPath)
    return 0
  }

  const hygiene = checkEnvironmentHygiene(args.mode, process.env)
  if (hygiene) {
    report.finishedAt = new Date().toISOString()
    report.summary = { status: "REFUSED", passed: 0, failed: 0, skipped: 0, assertions: 0, refusal: hygiene }
    emit(report, args.outPath)
    return 2
  }

  try {
    if (args.mode === "storage") await runStorage(args, report, fixtures)
    else await runOcr(args, report, fixtures)
  } catch (error) {
    report.steps.push({ id: `${args.mode}.unexpected`, status: "FAIL", assertions: 0, error: describeError(error) })
  }
  report.finishedAt = new Date().toISOString()
  report.summary = summarize(report.steps, (report.cleanup?.leftovers.length ?? 0) === 0)
  emit(report, args.outPath)
  return report.summary.status === "PASS" ? 0 : 1
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write(JSON.stringify({ fatal: describeError(error) }) + "\n"); process.exitCode = 1 })
