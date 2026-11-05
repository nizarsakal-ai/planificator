/**
 * VEHICLE-DOC-OCR-001 R4 — empaquetage du processus de lecture OCR : scripts npm, déclaration de dépendance
 * cohérente avec le verrou (sans installation), manifeste de fermeture, traçage Next, et lecture réelle depuis une
 * copie de la fermeture hors du dépôt (témoins négatifs compris). Aucun build Next, aucun réseau, données synthétiques.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { MANIFEST_FILE, WORKER_DIR, WORKER_FILE, buildVehicleOcrWorker, isSafeManifestPath } from "../../../scripts/build-vehicle-ocr-worker.mjs"
import { nodeModulesAncestors, verifyVehicleOcrWorkerClosure } from "../../../scripts/verification/vehicle-ocr-worker-closure.support"
import { vehicleOcrWorkerTraceIncludes } from "../../../next.config"

const ROOT = process.cwd()
const json = (f: string) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8"))
const pkg = json("package.json")
const lock = json("package-lock.json")
const ROUTE = "/api/trucks/*/documents/recognize"
const HR_ROUTE = "/api/hr-documents/recognize"

/**
 * Configuration Next évaluée dans un processus NEUF (comme `next build` après le script d'empaquetage) : aucune valeur
 * mise en cache par un import antérieur de next.config dans ce processus de test.
 */
function freshTraceIncludes(): Record<string, string[]> {
  const code = "const c = require('./next.config.ts').default; process.stdout.write('\\n@@CONFIG@@' + JSON.stringify(c.outputFileTracingIncludes ?? {}))"
  const out = execFileSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } })
  return JSON.parse(out.slice(out.lastIndexOf("@@CONFIG@@") + "@@CONFIG@@".length))
}

describe("R4 — scripts npm et dépendance directe", () => {
  it("build et dev empaquettent le processus de lecture AVANT Next", () => {
    assert.equal(pkg.scripts.build, "prisma generate && node scripts/build-vehicle-ocr-worker.mjs && next build")
    assert.equal(pkg.scripts.dev, "node scripts/build-vehicle-ocr-worker.mjs && next dev")
    assert.equal(pkg.scripts["build:vehicle-ocr-worker"], "node scripts/build-vehicle-ocr-worker.mjs")
  })
  it("esbuild déclaré en dépendance de développement, version exacte déjà verrouillée et installée", () => {
    assert.equal(pkg.devDependencies.esbuild, "0.28.0")
    assert.equal(lock.packages["node_modules/esbuild"].version, "0.28.0")
    assert.equal(json("node_modules/esbuild/package.json").version, "0.28.0")
  })
  it("verrou cohérent : dépendances racine du verrou = package.json, à l'identique", () => {
    const root = lock.packages[""]
    assert.deepEqual(root.dependencies, pkg.dependencies)
    assert.deepEqual(root.devDependencies, pkg.devDependencies)
    // Drapeau inchangé : esbuild reste accessible par tsx (lui-même pair facultatif de postcss-load-config).
    assert.equal(lock.packages["node_modules/esbuild"].devOptional, true)
    assert.equal(lock.packages["node_modules/tsx"].devOptional, true)
  })
  it("dépendances d'exécution du processus présentes dans le verrou (aucune installation requise)", () => {
    for (const name of ["sharp", "tesseract.js", "tesseract.js-core", "unpdf", "@tesseract.js-data/fra", "@tesseract.js-data/eng"])
      assert.ok(lock.packages[`node_modules/${name}`]?.version, name)
  })
})

describe("R4 — chemins du manifeste et traçage Next", () => {
  let tmp = ""
  before(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "vocr-manifest-")) })
  after(() => { rmSync(tmp, { recursive: true, force: true }) })
  /** Manifeste synthétique ; les fichiers listés sont créés vides sauf `omit` (simulation d'existence seulement). */
  const writeManifest = (dir: string, m: { files?: unknown }, worker = true, omit: string[] = []) => {
    mkdirSync(path.join(dir, ".vehicle-ocr-worker"), { recursive: true })
    writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(m))
    if (worker) writeFileSync(path.join(dir, WORKER_FILE), "")
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (typeof f !== "string" || !isSafeManifestPath(f) || omit.includes(f)) continue
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), "")
    }
  }
  const valid = { schema: 1, worker: ".vehicle-ocr-worker/worker.cjs", files: ["node_modules/sharp/package.json"] }

  it("chemin sûr : un fichier précis sous node_modules, sans motif ni remontée", () => {
    assert.equal(isSafeManifestPath("node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"), true)
    for (const bad of ["", "/etc/passwd", "src/x.ts", "node_modules/../.env", "node_modules/a/*.wasm", "node_modules/a/[id].js",
      "node_modules/a/{x}.js", "node_modules/a/(x).js", "node_modules/a/!x", "node_modules/a//b", "node_modules/a/./b", ".env", 3])
      assert.equal(isSafeManifestPath(bad), false, String(bad))
  })
  it("manifeste absent : rien n'est ajouté (la route répond 503)", () => {
    assert.deepEqual(vehicleOcrWorkerTraceIncludes(path.join(tmp, "vide")), [])
  })
  it("manifeste valide : processus + fichiers exacts, relatifs à la racine", () => {
    const dir = path.join(tmp, "ok"); writeManifest(dir, valid)
    assert.deepEqual(vehicleOcrWorkerTraceIncludes(dir), ["./.vehicle-ocr-worker/worker.cjs", "./node_modules/sharp/package.json"])
  })
  it("manifeste invalide : la configuration échoue (pas d'embarquement partiel silencieux)", () => {
    const cases: [string, unknown, boolean][] = [
      ["schema", { ...valid, schema: 2 }, true], ["worker", { ...valid, worker: "../x.cjs" }, true],
      ["vide", { ...valid, files: [] }, true], ["motif", { ...valid, files: ["node_modules/**"] }, true],
      ["remontee", { ...valid, files: ["node_modules/../.env"] }, true], ["hors", { ...valid, files: [".env.local"] }, true],
      ["absolu", { ...valid, files: ["/etc/hosts"] }, true], ["sans-worker", valid, false],
    ]
    for (const [name, m, worker] of cases) {
      const dir = path.join(tmp, name); writeManifest(dir, m as { files?: unknown }, worker)
      assert.throws(() => vehicleOcrWorkerTraceIncludes(dir), /Manifeste du processus de lecture OCR invalide/, name)
    }
    const incomplete = path.join(tmp, "incomplet")
    writeManifest(incomplete, { ...valid, files: ["node_modules/sharp/package.json", "node_modules/sharp/lib/index.js"] }, true, ["node_modules/sharp/lib/index.js"])
    assert.throws(() => vehicleOcrWorkerTraceIncludes(incomplete), /incomplet \(1 fichier\(s\) absent\(s\)\)/)
    const broken = path.join(tmp, "json"); mkdirSync(path.join(broken, ".vehicle-ocr-worker"), { recursive: true })
    writeFileSync(path.join(broken, MANIFEST_FILE), "{")
    assert.throws(() => vehicleOcrWorkerTraceIncludes(broken))
  })
})

describe("R4 — fermeture réelle du processus de lecture", () => {
  let manifest: { schema: number; worker: string; platform: string; files: string[]; bytes: number }
  let cleanIncludes: Record<string, string[]> = {}
  let builtIncludes: Record<string, string[]> = {}
  before(async () => {
    // État propre : aucun artefact préalable (seul le produit du build, ignoré par git, est retiré).
    rmSync(path.join(ROOT, WORKER_DIR), { recursive: true, force: true })
    assert.equal(existsSync(path.join(ROOT, WORKER_DIR)), false)
    cleanIncludes = freshTraceIncludes()
    manifest = (await buildVehicleOcrWorker({ root: ROOT })).manifest
    builtIncludes = freshTraceIncludes()
  })

  it("état propre : configuration évaluée sans processus empaqueté → rien d'embarqué pour lui (route 503)", () => {
    assert.equal((cleanIncludes[ROUTE] ?? []).some((f) => f.startsWith("./.vehicle-ocr-worker/") || f.startsWith("./node_modules/sharp/")), false)
    assert.ok((cleanIncludes[ROUTE] ?? []).length > 0, "inclusions OCR historiques conservées")
  })

  it("manifeste : fichiers exacts et existants ; natifs, WASM et modèles best_int présents ; modèles 4.0.0 absents", () => {
    assert.equal(manifest.schema, 1); assert.equal(manifest.worker, WORKER_FILE)
    assert.ok(manifest.files.every(isSafeManifestPath))
    assert.deepEqual(manifest.files, [...new Set(manifest.files)].sort())
    const has = (re: RegExp) => manifest.files.some((f) => re.test(f))
    assert.ok(has(/^node_modules\/@img\/sharp-[^/]+\/lib\/sharp-[^/]+\.node$/), "binaire natif sharp")
    assert.ok(has(/^node_modules\/tesseract\.js-core\/tesseract-core.*\.wasm$/), "cœur WASM")
    assert.ok(has(/^node_modules\/tesseract\.js\/src\/worker-script\/node\/index\.js$/), "script du worker Tesseract")
    for (const lang of ["fra", "eng"]) assert.ok(manifest.files.includes(`node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), lang)
    assert.equal(has(/\/4\.0\.0\//), false, "modèles non utilisés exclus")
    assert.equal(has(/(^|\/)\.env/), false)
  })
  it("next.config évalué après l'empaquetage (processus neuf) : la route véhicule embarque le processus et toute sa fermeture", () => {
    const includes = builtIncludes[ROUTE] ?? []
    assert.ok(includes.includes("./.vehicle-ocr-worker/worker.cjs"))
    for (const f of manifest.files) assert.ok(includes.includes(`./${f}`), f)
    // Route RH inchangée : pas de processus véhicule embarqué avec elle, mêmes inclusions qu'en état propre.
    assert.deepEqual(builtIncludes[HR_ROUTE], cleanIncludes[HR_ROUTE])
    assert.equal((builtIncludes[HR_ROUTE] ?? []).includes("./.vehicle-ocr-worker/worker.cjs"), false)
  })
  it("ancêtres : détection d'un node_modules parent", () => {
    assert.ok(nodeModulesAncestors(path.join(ROOT, "src", "lib")).includes(path.join(ROOT, "node_modules")))
  })
  it("copie hors du dépôt, sans node_modules ancêtre : PDF et OCR réels ; sans WASM ou sans sharp : échec", async () => {
    const report = await verifyVehicleOcrWorkerClosure({ root: ROOT, rebuild: false, tmpBase: os.tmpdir() })
    console.log(`# fermeture : ${report.files} fichiers, ${(report.bytes / 1048576).toFixed(1)} Mo (${report.platform}) — `
      + report.checks.map((c) => `${c.ok ? "OK" : "ÉCHEC"} ${c.name} (${c.detail})`).join(" ; "))
    assert.deepEqual(report.checks.filter((c) => !c.ok), [])
    assert.equal(report.checks.length, 7)
    assert.equal(report.closureDir, null, "copie supprimée")
  })
})
