#!/usr/bin/env node
/**
 * Empaquette le processus de lecture isolé des pièces véhicule (src/lib/vehicules/v3/ocr-isolation/worker-entry.ts)
 * en un fichier CommonJS autonome, lancé par `child_process.fork` depuis la route de lecture, et écrit le manifeste
 * de ses dépendances d'exécution (fermeture calculée, pas une liste écrite à la main).
 *
 * Usage : node scripts/build-vehicle-ocr-worker.mjs
 *   produit .vehicle-ocr-worker/worker.cjs (chemin lu par défaut par resolveWorkerPath, relatif au cwd du serveur)
 *   et .vehicle-ocr-worker/trace.json (fichiers à embarquer, relatifs à la racine du projet).
 *
 * R4 : branché sur `npm run build` et `npm run dev` (avant Next). next.config.ts lit trace.json et l'ajoute à
 * `outputFileTracingIncludes` de la route de lecture : le processus est lancé par fork, donc invisible du traçage
 * automatique de Next, de même que ses dépendances natives/WASM laissées externes.
 *
 * Fermeture : traçage statique (@vercel/nft, livré avec Next) du fichier produit, plus ce que le traçage ne peut voir
 * (lu par chemin à l'exécution) : variantes WASM du cœur Tesseract et modèles « 4.0.0_best_int » fra/eng. Les modèles
 * « 4.0.0 » non utilisés sont retirés. Aucune installation, aucun accès réseau.
 * Toute anomalie (chemin hors racine, caractère de motif, fichier manquant) fait échouer le build : pas d'embarquement
 * partiel silencieux.
 */
import { build } from "esbuild"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const WORKER_DIR = ".vehicle-ocr-worker"
export const WORKER_FILE = `${WORKER_DIR}/worker.cjs`
export const MANIFEST_FILE = `${WORKER_DIR}/trace.json`
export const EXTERNALS = ["sharp", "tesseract.js", "unpdf", "@tesseract.js-data/*"]
export const MANIFEST_SCHEMA = 1
/** Caractères de motif refusés : chaque entrée du manifeste doit désigner exactement un fichier. */
const GLOB_CHARS = /[*?[\]{}()!\\]/

export const defaultRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Vrai si `rel` est un chemin de manifeste acceptable (relatif, posix, sous node_modules, sans motif). */
export function isSafeManifestPath(rel) {
  return typeof rel === "string" && rel.length > 0 && rel.startsWith("node_modules/") && !rel.includes("\0")
    && !GLOB_CHARS.test(rel) && !path.posix.isAbsolute(rel) && path.posix.normalize(rel) === rel
    && !rel.split("/").includes("..")
}

export async function bundleVehicleOcrWorker({ root = defaultRoot(), outfile = path.join(root, WORKER_FILE) } = {}) {
  await build({
    entryPoints: [path.join(root, "src/lib/vehicules/v3/ocr-isolation/worker-entry.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    tsconfig: path.join(root, "tsconfig.json"),
    external: EXTERNALS,
    logLevel: "warning",
    legalComments: "none",
  })
  return outfile
}

const listFiles = (dir, keep) => readdirSync(dir).filter(keep).map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile())

/** Fermeture d'exécution du fichier produit, chemins relatifs à `root`, triée et dédupliquée. */
export async function traceVehicleOcrWorker({ root = defaultRoot(), workerFile = path.join(root, WORKER_FILE) } = {}) {
  const realRoot = realpathSync(root)
  const require = createRequire(path.join(realRoot, "package.json"))
  const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft")
  const traced = await nodeFileTrace([realpathSync(workerFile)], { base: realRoot, processCwd: realRoot })
  // Chemins construits sous la racine, sans résolution des liens : un node_modules lié reste « node_modules/… ».
  const rel = (abs) => path.relative(realRoot, abs).split(path.sep).join("/")
  const workerRel = rel(realpathSync(workerFile))
  // Fichiers seulement : nft liste aussi les liens symboliques traversés (ex. node_modules lié), qui ne sont pas à embarquer.
  const isFile = (f) => { try { return statSync(path.join(realRoot, f)).isFile() } catch { return false } }
  const files = new Set([...traced.fileList].map((f) => f.split(path.sep).join("/")).filter((f) => f !== workerRel && isFile(f)))
  // Modèles 4.0.0 (non LSTM entier) jamais lus : retirés ; modèles best_int et cœurs WASM lus par chemin : ajoutés.
  for (const f of [...files]) if (/^node_modules\/@tesseract\.js-data\/[^/]+\/4\.0\.0\//.test(f)) files.delete(f)
  for (const lang of ["fra", "eng"]) {
    const dir = path.join(realRoot, "node_modules/@tesseract.js-data", lang, "4.0.0_best_int")
    const models = existsSync(dir) ? listFiles(dir, (f) => f.endsWith(".traineddata.gz")) : []
    if (!models.length) throw new Error(`Modèle OCR ${lang} (4.0.0_best_int) introuvable : installation incomplète.`)
    for (const m of models) files.add(rel(m))
  }
  const coreDir = path.join(realRoot, "node_modules/tesseract.js-core")
  const cores = existsSync(coreDir) ? listFiles(coreDir, (f) => /^tesseract-core.*\.wasm$/.test(f)) : []
  if (!cores.length) throw new Error("Cœur WASM Tesseract introuvable : installation incomplète.")
  for (const c of cores) files.add(rel(c))
  const sorted = [...files].sort()
  const bad = sorted.filter((f) => !isSafeManifestPath(f) || !existsSync(path.join(realRoot, f)))
  if (bad.length) throw new Error(`Fermeture refusée (hors node_modules, motif ou fichier absent) : ${bad.slice(0, 5).join(", ")}`)
  for (const required of ["node_modules/sharp/package.json", "node_modules/tesseract.js/package.json", "node_modules/unpdf/package.json"])
    if (!sorted.includes(required)) throw new Error(`Fermeture incomplète : ${required} absent du traçage.`)
  return sorted
}

/** Empaquetage + manifeste (chemin unique utilisé par npm run build/dev et par la vérification de fermeture). */
export async function buildVehicleOcrWorker({ root = defaultRoot() } = {}) {
  const outDir = path.join(root, WORKER_DIR)
  mkdirSync(outDir, { recursive: true })
  const workerFile = await bundleVehicleOcrWorker({ root, outfile: path.join(root, WORKER_FILE) })
  const files = await traceVehicleOcrWorker({ root, workerFile })
  const bytes = files.reduce((n, f) => n + statSync(path.join(root, f)).size, statSync(workerFile).size)
  const manifest = { schema: MANIFEST_SCHEMA, worker: WORKER_FILE, platform: `${process.platform}-${process.arch}`, files, bytes }
  writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return { workerFile, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Pas d'attente au niveau du module : il reste chargeable par require() (tests, vérification de fermeture).
  buildVehicleOcrWorker().then(({ workerFile, manifest }) => {
    console.log(`Processus de lecture empaqueté : ${workerFile} — ${manifest.files.length} fichiers de dépendances, `
      + `${(manifest.bytes / 1048576).toFixed(1)} Mo (${manifest.platform}).`)
  }, (error) => {
    console.error(`Empaquetage du processus de lecture OCR refusé : ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
