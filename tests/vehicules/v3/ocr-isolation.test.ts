/**
 * R3 point 3 (ressources) — lecture des pièces véhicule dans un processus isolé, tué à l'échéance.
 * Processus factices (tests/vehicules/v3/fixtures/ocr-workers, lancés avec `--import tsx` pour les TESTS seulement)
 * pour les blocages impossibles à provoquer de façon fiable avec un vrai PDF ; empaquetage RÉEL (esbuild, comme
 * `scripts/build-vehicle-ocr-worker.mjs`) pour la couche texte, l'OCR Tesseract et des PDF hostiles synthétiques.
 * Tout est borné (temps, mémoire) : aucun test ne peut mettre la machine en danger.
 */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { createRequire, syncBuiltinESMExports } from "node:module"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { after, before, describe, it } from "node:test"
import sharp from "sharp"
import { build } from "esbuild"
import type { Reading } from "@/lib/hr-documents/recognition/ocr"
import { createIsolatedReader, resolveWorkerPath, type IsolatedReaderOptions } from "@/lib/vehicules/v3/ocr-isolation/isolated-reader"
import { parseReadReply } from "@/lib/vehicules/v3/ocr-isolation/protocol"
import { abandonedRecognitions, recognizeVehicleDocument, runningRecognitions, type DocumentReader } from "@/lib/vehicules/v3/document-recognition-service"
import { recognitionError } from "@/components/vehicules/v3/vehicle-document-recognition-ui"
import { ADMIN, PNG_BYTES, TRUCK, V3MemoryDb } from "./v3-test-db"

const ROOT = process.cwd()
const FIXTURES = path.join(ROOT, "tests/vehicules/v3/fixtures/ocr-workers")
// Sous node_modules : les dépendances externes (sharp, tesseract.js, unpdf) se résolvent comme en production.
const BUNDLE = path.join(ROOT, "node_modules/.cache/vehicle-ocr-worker-r3/worker.cjs")
const fixture = (mode: string) => path.join(FIXTURES, `${mode}.ts`)

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pids: number[] = []
const fake = (mode: string, over: Partial<IsolatedReaderOptions> = {}) =>
  createIsolatedReader({ workerPath: fixture(mode), maxPdfImagePixels: 25_000_000, extraExecArgv: ["--import", "tsx"], onSpawn: (pid) => pids.push(pid), ...over })
const real = (over: Partial<IsolatedReaderOptions> = {}) =>
  createIsolatedReader({ workerPath: BUNDLE, maxPdfImagePixels: 25_000_000, onSpawn: (pid) => pids.push(pid), ...over })
const signal = () => new AbortController().signal
const timed = async <T>(p: Promise<T>) => { const t = Date.now(); const value = await p; return { value, ms: Date.now() - t } }

/** PDF d'une page avec une vraie couche texte (police standard Helvetica). */
function textPdf(lines: string[], extraContent = ""): Uint8Array {
  const content = `BT /F1 14 Tf 40 780 Td 18 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET${extraContent}`
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ])
}
function pdf(objs: (string | Buffer)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")]
  const offsets: number[] = []
  let size = parts[0].length
  objs.forEach((o, i) => {
    offsets.push(size)
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"), Buffer.from("\nendobj\n", "latin1")])
    parts.push(b); size += b.length
  })
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, "latin1"))
  return new Uint8Array(Buffer.concat(parts))
}
/** Bombe de décompression : flux de contenu de `mb` Mo d'espaces, compressé (≈ 1/1000). */
function deflateBombPdf(mb: number): Uint8Array {
  const stream = deflateSync(Buffer.alloc(mb * 1024 * 1024, 0x20), { level: 9 })
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1")]),
  ])
}
/** PDF dont l'image déclare 20 000 × 20 000 px (400 Mpx) pour un flux minuscule. */
function hugeImagePdf(): Uint8Array {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${"q 595 0 0 842 0 0 cm /Im0 Do Q".length} >>\nstream\nq 595 0 0 842 0 0 cm /Im0 Do Q\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 20000 /Height 20000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]),
  ])
}
async function insurancePng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="500"><rect width="100%" height="100%" fill="#fff"/>
    <text x="60" y="140" font-family="Helvetica" font-size="56" font-weight="bold">ATTESTATION D'ASSURANCE</text>
    <text x="60" y="260" font-family="Helvetica" font-size="44">Contrat n° 1234567 89</text>
    <text x="60" y="360" font-family="Helvetica" font-size="44">Période de validité : du 01/01/2026 au 31/12/2026</text></svg>`
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer())
}

after(() => {
  // Aucun processus de lecture ne doit survivre à la suite.
  const survivors = pids.filter(alive)
  for (const pid of survivors) try { process.kill(pid, "SIGKILL") } catch { /* déjà parti */ }
  assert.deepEqual(survivors, [], "processus de lecture survivants")
})

describe("R3 point 3 — processus isolé : blocages tués, fin réelle attendue, aucune lecture inventée (factices)", () => {
  it("réponse valide : lecture rendue, processus terminé", async () => {
    const { value } = await timed(fake("reply")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: signal() }))
    assert.deepEqual([value.status, value.text.startsWith("ATTESTATION")], ["TEXT_LAYER", true])
    assert.equal(alive(pids.at(-1)!), false)
  })
  it("boucle de calcul bloquant le fil principal : abandon → SIGKILL, promesse résolue à la fin réelle (TIMEOUT)", async () => {
    const controller = new AbortController()
    const reading = fake("spin")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 1_500)) // démarrage de tsx dans l'enfant, puis calcul bloquant
    const pid = pids.at(-1)!
    assert.equal(alive(pid), true)
    controller.abort()
    const { value, ms } = await timed(reading)
    assert.deepEqual([value.status, value.reason], ["TECHNICAL_FAILURE", "TIMEOUT"])
    assert.ok(ms < 1_000, `fin réelle en ${ms} ms`)
    assert.equal(alive(pid), false, "processus réellement terminé à la résolution")
  })
  it("SIGTERM ignoré : sans effet, SIGKILL utilisé", async () => {
    const controller = new AbortController()
    const reading = fake("ignore-term")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 1_500))
    controller.abort()
    const { value, ms } = await timed(reading)
    assert.equal(value.reason, "TIMEOUT"); assert.ok(ms < 1_000)
  })
  it("échéance absolue du parent sans aucun abandon : tué à délai + marge", async () => {
    const { value, ms } = await timed(fake("silent", { hardMarginMs: 300 })(new Uint8Array([1]), "pdf", { timeoutMs: 1_500, signal: signal() }))
    assert.equal(value.reason, "TIMEOUT"); assert.ok(ms >= 1_700 && ms < 4_000, `${ms} ms`)
  })
  it("plantage, réponse falsifiée, tas JavaScript dépassé : échec technique, jamais une lecture inventée", async () => {
    for (const [mode, over] of [["crash", {}], ["garbage", {}], ["heap-hog", { maxOldSpaceMb: 64 }]] as const) {
      const { value } = await timed(fake(mode, over)(new Uint8Array([1]), "pdf", { timeoutMs: 20_000, signal: signal() }))
      assert.deepEqual([value.status, value.reason, value.text], ["TECHNICAL_FAILURE", "OCR_ERROR", ""], mode)
    }
    assert.equal(parseReadReply({ type: "reading", reading: { text: "x", status: "OCR", reason: "NOPE" } }), null)
  })
  it("mémoire native (hors tas JS) avec fil principal bloqué : tuée par le chien de garde vers 160 Mo", async () => {
    const { value, ms } = await timed(fake("native-hog")(new Uint8Array([1]), "pdf", { timeoutMs: 25_000, signal: signal() }))
    assert.deepEqual([value.status, value.reason], ["TECHNICAL_FAILURE", "OCR_ERROR"])
    assert.ok(ms < 10_000, `${ms} ms`)
  })
  it("réponse puis processus qui ne sort pas (arrêt Tesseract bloqué) : réponse gardée, processus tué après la grâce", async () => {
    const { value, ms } = await timed(fake("reply-linger", { exitGraceMs: 200 })(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: signal() }))
    assert.equal(value.status, "TEXT_LAYER"); assert.ok(ms < 5_000)
    assert.equal(alive(pids.at(-1)!), false)
  })
  it("environnement de l'enfant réduit : aucune variable du serveur (secrets) transmise", async () => {
    process.env.R3_FAKE_SECRET_FOR_TEST = "valeur-synthetique"
    try {
      const { value } = await timed(fake("env")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: signal() }))
      const names = value.text.split(",")
      assert.ok(!names.includes("R3_FAKE_SECRET_FOR_TEST") && !names.includes("DATABASE_URL") && !names.includes("PATH"), value.text)
    } finally { delete process.env.R3_FAKE_SECRET_FOR_TEST }
  })
  it("chemin de l'empaquetage : variable absolue, sinon <cwd>/.vehicle-ocr-worker/worker.cjs ; chemin relatif ignoré", () => {
    assert.equal(resolveWorkerPath({ VEHICLE_OCR_WORKER_PATH: "/opt/app/w.cjs" }, "/srv"), "/opt/app/w.cjs")
    assert.equal(resolveWorkerPath({}, "/srv"), "/srv/.vehicle-ocr-worker/worker.cjs")
    assert.equal(resolveWorkerPath({ VEHICLE_OCR_WORKER_PATH: "../evil.cjs" }, "/srv"), "/srv/.vehicle-ocr-worker/worker.cjs")
  })
})

describe("R3 point 3 — service : 504 borné, place rendue à la fin réelle, aucune accumulation ni 429 durable", () => {
  let savedV3: string | undefined
  before(() => { savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3 })
  const env = { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true" }
  const png = { filename: "photo.png", declaredMimeType: "image/png", bytes: PNG_BYTES }
  const call = (over: Record<string, unknown>) => recognizeVehicleDocument(TRUCK, { category: "INSURANCE" }, png, { ...new V3MemoryDb().deps(ADMIN), env, ...over } as never)
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; status?: number; message?: string }) => (e.code ? `${e.status} ${e.code}` : `ERR ${e.message}`))
  const settle = async () => { const end = Date.now() + 2_000; while (abandonedRecognitions() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)) }

  it("cinq lectures bloquées de suite : chacune 504, place libérée par la mort du processus, lecture suivante acceptée", async () => {
    for (let i = 0; i < 5; i++) {
      const before = pids.length
      assert.equal(await code(call({ read: fake("spin"), deadlineMs: 1_500, graceMs: 1_000 })), "504 RECOGNITION_TIMEOUT", `essai ${i}`)
      await settle()
      assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0], `essai ${i} : rien ne reste compté`)
      assert.equal(alive(pids[before]), false, `essai ${i} : calcul réellement arrêté`)
    }
    assert.equal(await code(call({ read: fake("reply") })), "OK")
  })
  it("empaquetage absent : 503 RECOGNITION_UNAVAILABLE explicite, aucune place occupée, message d'interface clair", async () => {
    assert.equal(await code(call({ env: { ...env, VEHICLE_OCR_WORKER_PATH: "/nonexistent/r3/worker.cjs" } })), "503 RECOGNITION_UNAVAILABLE")
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0])
    assert.match(recognitionError("RECOGNITION_UNAVAILABLE"), /non installée sur ce serveur.*Saisissez les informations/)
  })
})

// ─── R3.1 — cycle de vie : démarrage raté, envoi IPC en échec, arrêt différé, événements en double ─────────────
// Injection de pannes au niveau du système seulement : chemin du binaire Node introuvable (procédé du contre-exemple
// Codex) ou enveloppe de `child_process.fork` qui fait échouer l'envoi / retarde l'arrêt d'un VRAI enfant. Le code du
// lecteur exécuté est celui de production (aucune option de test dans le lecteur pour ces cas).
const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process")
/** Exécute `start` (qui doit appeler le lecteur) avec le binaire Node remplacé, puis restaure aussitôt. */
function withMissingNode<T>(start: () => T): T {
  const original = process.execPath
  Object.defineProperty(process, "execPath", { value: "/private/tmp/nonexistent-node-for-r31-tests", configurable: true, writable: true })
  try { return start() } finally { Object.defineProperty(process, "execPath", { value: original, configurable: true, writable: true }) }
}
/** Exécute `start` avec `fork` enveloppé : chaque enfant réel est passé à `patch` avant usage, puis restauration. */
function withForkPatch<T>(patch: (child: import("node:child_process").ChildProcess) => void, start: () => T): T {
  const real = childProcess.fork
  childProcess.fork = ((...args: Parameters<typeof real>) => { const child = real(...args); patch(child); return child }) as typeof real
  syncBuiltinESMExports()
  try { return start() } finally { childProcess.fork = real; syncBuiltinESMExports() }
}
const PENDING = Symbol("PENDING")
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))])

describe("R3.1 — démarrage raté, envoi IPC en échec, arrêt différé, événements en double (lecteur de production)", () => {
  it("contre-exemple Codex : binaire Node introuvable (aucun pid) → échec technique en < 200 ms, aucun enfant ; lecture suivante réussie", async () => {
    const before = pids.length
    const work = withMissingNode(() => fake("reply", { hardMarginMs: 10 })(new Uint8Array([1]), "png", { timeoutMs: 20, signal: signal() }))
    const outcome = await within(work, 200)
    assert.notEqual(outcome, PENDING, "plus jamais pendant après un démarrage raté")
    assert.deepEqual([(outcome as Reading).status, (outcome as Reading).reason, (outcome as Reading).text], ["TECHNICAL_FAILURE", "OCR_ERROR", ""])
    assert.equal(pids.length, before, "aucun processus n'a démarré")
    assert.equal((await fake("reply")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: signal() })).status, "TEXT_LAYER", "reprise")
  })
  it("démarrage raté puis abandon tardif et échéance : aucune minuterie ni écouteur restant, aucune seconde résolution", async () => {
    const controller = new AbortController()
    const work = withMissingNode(() => fake("reply", { hardMarginMs: 10 })(new Uint8Array([1]), "png", { timeoutMs: 20, signal: controller.signal }))
    assert.equal((await work).reason, "OCR_ERROR")
    controller.abort() // écouteur retiré : sans effet
    await new Promise((r) => setTimeout(r, 100)) // l'échéance (30 ms) aurait déclenché un arrêt si la minuterie restait
    assert.equal((await work).reason, "OCR_ERROR", "résultat inchangé")
  })
  for (const variant of ["exception synchrone", "rappel en erreur"] as const) {
    it(`envoi IPC en échec (${variant}) avec arrêt différé : la place reste tenue tant que l'enfant vit, résolution à sa vraie fin`, async () => {
      let child: import("node:child_process").ChildProcess | undefined
      const work = withForkPatch((c) => {
        child = c
        c.send = ((_message: unknown, callback?: (error: Error | null) => void) => {
          if (variant === "exception synchrone") throw new Error("ERR_IPC_CHANNEL_CLOSED (injecté)")
          setImmediate(() => callback?.(new Error("ERR_IPC_CHANNEL_CLOSED (injecté)")))
          return false
        }) as typeof c.send
        // Arrêt « différé » : le signal n'est pas encore parvenu (cas d'un kill sans effet immédiat).
        c.kill = (() => true) as typeof c.kill
      }, () => fake("silent")(new Uint8Array([1]), "pdf", { timeoutMs: 20_000, signal: signal() }))
      const pid = child!.pid!
      assert.equal(await within(work, 2_000), PENDING, "jamais résolu tant que l'enfant est vivant")
      assert.equal(alive(pid), true)
      process.kill(pid, "SIGKILL") // fin réelle
      const reading = await work
      assert.deepEqual([reading.status, reading.reason, alive(pid)], ["TECHNICAL_FAILURE", "OCR_ERROR", false])
    })
  }
  it("erreur émise après démarrage, en double, puis événements tardifs : arrêt réel, une seule issue, aucun plantage", async () => {
    let child: import("node:child_process").ChildProcess | undefined
    const work = withForkPatch((c) => { child = c; setImmediate(() => { c.emit("error", new Error("injectée 1")); c.emit("error", new Error("injectée 2")) }) },
      () => fake("silent")(new Uint8Array([1]), "pdf", { timeoutMs: 20_000, signal: signal() }))
    const { value, ms } = await timed(work)
    assert.deepEqual([value.status, value.reason, alive(child!.pid!)], ["TECHNICAL_FAILURE", "OCR_ERROR", false]); assert.ok(ms < 5_000, `${ms} ms`)
    // Événements tardifs sur un enfant déjà terminé : absorbés, sans effet ni exception.
    child!.emit("error", new Error("tardive")); child!.emit("exit", 0, null); child!.emit("message", { type: "reading" })
    assert.equal((await work).reason, "OCR_ERROR")
  })
  it("lancement refusé de façon synchrone (exception de fork) : échec technique immédiat", async () => {
    const real = childProcess.fork
    childProcess.fork = (() => { throw new Error("EAGAIN (injecté)") }) as unknown as typeof real
    syncBuiltinESMExports()
    let work: Promise<Reading>
    try { work = fake("reply")(new Uint8Array([1]), "pdf", { timeoutMs: 10_000, signal: signal() }) } finally { childProcess.fork = real; syncBuiltinESMExports() }
    assert.equal((await within(work, 200) as Reading).reason, "OCR_ERROR")
  })
})

describe("R3.1 — service : compteurs exacts après démarrage raté et envoi en échec, reprise", () => {
  let savedV3: string | undefined
  before(() => { savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3 })
  const env = { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true" }
  const png = { filename: "photo.png", declaredMimeType: "image/png", bytes: PNG_BYTES }
  const call = (over: Record<string, unknown>) => recognizeVehicleDocument(TRUCK, { category: "INSURANCE" }, png, { ...new V3MemoryDb().deps(ADMIN), env, ...over } as never)

  it("trois démarrages ratés de suite : réponse « échec technique » sans champ, rien ne reste compté, jamais 429 ; puis lecture normale", async () => {
    for (let i = 0; i < 3; i++) {
      const read: DocumentReader = (b, k, o) => withMissingNode(() => fake("reply")(b, k, o))
      const proposal = await call({ read })
      assert.deepEqual([proposal.reading.status, proposal.reading.reason, Object.keys(proposal.fields).length], ["TECHNICAL_FAILURE", "OCR_ERROR", 0], `essai ${i}`)
      assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0], `essai ${i}`)
    }
    assert.equal((await call({ read: fake("reply") })).reading.status, "TEXT_LAYER")
  })
  it("envoi en échec + arrêt différé : 504 à l'échéance, travail compté « abandonné » tant que l'enfant vit, rendu à sa fin, jamais négatif", async () => {
    let pid = 0
    const read = ((b: Uint8Array, k: never, o: never) => withForkPatch((c) => {
      pid = c.pid!
      c.send = (() => { throw new Error("ERR_IPC_CHANNEL_CLOSED (injecté)") }) as typeof c.send
      c.kill = (() => true) as typeof c.kill
    }, () => fake("silent")(b, k, o)))
    await assert.rejects(call({ read, deadlineMs: 1_500, graceMs: 200 }), (e: { code?: string }) => e.code === "RECOGNITION_TIMEOUT")
    assert.deepEqual([runningRecognitions(), abandonedRecognitions(), alive(pid)], [0, 1, true], "enfant vivant : place tenue")
    process.kill(pid, "SIGKILL")
    const end = Date.now() + 2_000
    while (abandonedRecognitions() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0], "rendu à la fin réelle, jamais négatif")
    assert.equal((await call({ read: fake("reply") })).reading.status, "TEXT_LAYER", "reprise")
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0])
  })
})

describe("R3 point 3 — empaquetage réel : couche texte, OCR Tesseract, PDF hostiles, abandon en plein OCR", () => {
  before(async () => {
    mkdirSync(path.dirname(BUNDLE), { recursive: true })
    await build({ entryPoints: [path.join(ROOT, "src/lib/vehicules/v3/ocr-isolation/worker-entry.ts")], outfile: BUNDLE, bundle: true, platform: "node", format: "cjs",
      target: "node20", tsconfig: path.join(ROOT, "tsconfig.json"), external: ["sharp", "tesseract.js", "unpdf", "@tesseract.js-data/*"], logLevel: "silent" })
  })
  const read = (bytes: Uint8Array, kind: "pdf" | "png", over: Partial<IsolatedReaderOptions> = {}, s = signal(), timeoutMs = 25_000): Promise<Reading> => real(over)(bytes, kind, { timeoutMs, signal: s })

  it("PDF avec couche texte : lu dans l'enfant (TEXT_LAYER)", async () => {
    const r = await read(textPdf(["ATTESTATION D'ASSURANCE", "Contrat n 1234567 89", "Periode de validite : du 01/01/2026 au 31/12/2026"]), "pdf")
    // pdf.js rend l'apostrophe Helvetica en apostrophe typographique.
    assert.equal(r.status, "TEXT_LAYER"); assert.match(r.text, /ATTESTATION D.ASSURANCE/)
  })
  it("PNG : OCR Tesseract réel dans l'enfant", async () => {
    const r = await read(await insurancePng(), "png")
    assert.equal(r.status, "OCR"); assert.match(r.text, /ATTESTATION/)
  })
  it("abandon en plein OCR : processus tué en quelques ms, puis une nouvelle lecture réussit (reprise)", async () => {
    const controller = new AbortController()
    const reading = read(await insurancePng(), "png", {}, controller.signal)
    await new Promise((r) => setTimeout(r, 700))
    const pid = pids.at(-1)!
    controller.abort()
    const { value, ms } = await timed(reading)
    assert.deepEqual([value.reason, alive(pid)], ["TIMEOUT", false]); assert.ok(ms < 1_000, `${ms} ms`)
    assert.equal((await read(textPdf(["ATTESTATION D'ASSURANCE", "Contrat n 1234567 89 Vehicule AB-123-CD"]), "pdf")).status, "TEXT_LAYER")
  })
  it("PDF hostiles : bombe de décompression (300 Mo), image déclarée 400 Mpx, fichier tronqué : issue bornée, processus terminé, reprise", async () => {
    const bomb = await timed(read(deflateBombPdf(300), "pdf", { rssLimitMb: 220, maxOldSpaceMb: 128 }, signal(), 8_000))
    assert.ok(bomb.ms < 15_000, `bombe : ${bomb.ms} ms`)
    // Trace pour le rapport (statut et durée seulement, aucun contenu).
    console.log(`# bombe de décompression : ${bomb.value.status}/${bomb.value.reason} en ${bomb.ms} ms`)
    assert.equal(bomb.value.status === "TEXT_LAYER" && bomb.value.text.length > 0, false, "aucune lecture inventée")
    assert.equal(alive(pids.at(-1)!), false)
    // Témoin : mêmes limites, PDF normal → lu. L'échec de la bombe vient donc bien de la bombe, pas des limites.
    assert.equal((await read(textPdf(["ATTESTATION D'ASSURANCE", "Contrat n 1234567 89 Vehicule AB-123-CD"]), "pdf", { rssLimitMb: 220, maxOldSpaceMb: 128 })).status, "TEXT_LAYER")
    const huge = await read(hugeImagePdf(), "pdf")
    assert.deepEqual([huge.status, huge.reason], ["TECHNICAL_FAILURE", "PDF_IMAGE_TOO_LARGE"])
    const valid = textPdf(["ATTESTATION D'ASSURANCE"])
    const truncated = await read(valid.slice(0, Math.floor(valid.length / 2)), "pdf")
    assert.equal(truncated.status, "TECHNICAL_FAILURE")
    assert.equal((await read(textPdf(["ATTESTATION D'ASSURANCE", "Contrat n 1234567 89 Vehicule AB-123-CD"]), "pdf")).status, "TEXT_LAYER", "reprise après les PDF hostiles")
  })
})
