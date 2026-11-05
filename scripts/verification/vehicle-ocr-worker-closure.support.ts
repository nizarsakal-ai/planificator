/**
 * VEHICLE-DOC-OCR-001 R4 — vérification reproductible de la fermeture des dépendances du processus de lecture OCR.
 *
 * 1. Empaquetage par le chemin du build (`buildVehicleOcrWorker`, comme npm run build/dev) : worker.cjs + trace.json.
 * 2. Copie du fichier produit et des SEULS fichiers du manifeste dans un dossier temporaire neuf, hors du dépôt, sans
 *    aucun `node_modules` parmi ses ancêtres : un module manquant ne peut pas être rattrapé par celui du dépôt.
 * 3. Lecture réelle depuis cette copie, par le lecteur isolé de production (fork, environnement réduit à NODE_ENV et
 *    aux deux bornes du chien de garde, cwd = la copie) : PDF à couche texte puis image (OCR Tesseract).
 * 4. Témoins négatifs : la même copie privée des cœurs WASM, puis de sharp, doit ÉCHOUER. S'ils réussissaient, la
 *    lecture n'aurait pas lieu depuis la copie.
 *
 * Données synthétiques seulement. Aucun réseau, aucune base, aucun secret, aucune installation, aucun build Next.
 * Ne prouve PAS l'exécution sur Vercel (autre système, binaires natifs, limites mémoire et taille non éprouvées).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"
import type { Reading } from "@/lib/hr-documents/recognition/ocr"
import { createIsolatedReader } from "@/lib/vehicules/v3/ocr-isolation/isolated-reader"
import { MANIFEST_FILE, WORKER_FILE, buildVehicleOcrWorker, isSafeManifestPath } from "../build-vehicle-ocr-worker.mjs"

export type ClosureCheck = { name: string; ok: boolean; detail: string }
export type ClosureReport = { ok: boolean; platform: string; files: number; bytes: number; checks: ClosureCheck[]; closureDir: string | null }
type Manifest = { schema: number; worker: string; platform: string; files: string[]; bytes: number }

/** PDF d'une page avec une vraie couche texte (police standard Helvetica). */
export function syntheticTextPdf(lines: string[]): Uint8Array {
  const content = `BT /F1 14 Tf 40 780 Td 18 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${out.length}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, "latin1"))
}

/** Image synthétique d'une attestation (aucune donnée réelle). */
export async function syntheticInsurancePng(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="500"><rect width="100%" height="100%" fill="#fff"/>
    <text x="60" y="140" font-family="Helvetica" font-size="56" font-weight="bold">ATTESTATION D'ASSURANCE</text>
    <text x="60" y="260" font-family="Helvetica" font-size="44">Contrat n° 1234567 89</text>
    <text x="60" y="360" font-family="Helvetica" font-size="44">Période de validité : du 01/01/2026 au 31/12/2026</text></svg>`
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer())
}

/** Ancêtres de `dir` (lui exclu) qui contiennent un dossier node_modules. */
export function nodeModulesAncestors(dir: string): string[] {
  const found: string[] = []
  for (let d = path.dirname(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, "node_modules"))) found.push(path.join(d, "node_modules"))
    if (path.dirname(d) === d) break
  }
  return found
}

function readManifest(root: string): Manifest {
  const m = JSON.parse(readFileSync(path.join(root, MANIFEST_FILE), "utf8")) as Manifest
  if (m.schema !== 1 || m.worker !== WORKER_FILE || !Array.isArray(m.files) || !m.files.every(isSafeManifestPath))
    throw new Error("Manifeste du processus de lecture invalide.")
  return m
}

function listTree(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name)
    return e.isDirectory() ? listTree(abs, base) : [path.relative(base, abs).split(path.sep).join("/")]
  })
}

/** Copie le fichier produit et les fichiers du manifeste (sauf `omit`) dans `dest` ; renvoie les chemins copiés. */
function copyClosure(root: string, files: string[], dest: string, omit: (f: string) => boolean = () => false): string[] {
  const copied = [WORKER_FILE, ...files.filter((f) => !omit(f))]
  for (const rel of copied) {
    const to = path.join(dest, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(realpathSync(path.join(root, rel)), to)
  }
  return copied
}

export async function verifyVehicleOcrWorkerClosure(
  { root = process.cwd(), rebuild = true, keep = false, tmpBase = os.tmpdir() }: { root?: string; rebuild?: boolean; keep?: boolean; tmpBase?: string } = {},
): Promise<ClosureReport> {
  const checks: ClosureCheck[] = []
  const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok }
  if (rebuild) await buildVehicleOcrWorker({ root })
  const manifest = readManifest(root)
  const realRoot = realpathSync(root)
  const work = mkdtempSync(path.join(realpathSync(tmpBase), "vocr-closure-"))
  const previousCwd = process.cwd()
  try {
    check("dossier hors du dépôt", !work.startsWith(`${realRoot}${path.sep}`), work)
    const ancestors = nodeModulesAncestors(work)
    check("aucun node_modules ancêtre", ancestors.length === 0, ancestors.join(", ") || "aucun")

    const app = path.join(work, "app")
    const copied = copyClosure(realRoot, manifest.files, app)
    const tree = listTree(app).sort()
    check("copie = manifeste exactement", JSON.stringify(tree) === JSON.stringify([...copied].sort()), `${tree.length} fichiers`)

    const pdf = syntheticTextPdf(["ATTESTATION D'ASSURANCE", "Contrat n 1234567 89", "Periode de validite : du 01/01/2026 au 31/12/2026"])
    const png = await syntheticInsurancePng()
    const readFrom = async (dir: string, bytes: Uint8Array, kind: "pdf" | "png"): Promise<Reading> => {
      // cwd du parent, donc de l'enfant (fork), placé dans la copie : rien n'est résolu depuis le dépôt.
      process.chdir(dir)
      try {
        const read = createIsolatedReader({ workerPath: path.join(dir, WORKER_FILE), maxPdfImagePixels: 25_000_000 })
        return await read(bytes, kind, { timeoutMs: 25_000, signal: new AbortController().signal })
      } finally { process.chdir(previousCwd) }
    }
    const brief = (r: Reading) => `${r.status}${r.reason ? `/${r.reason}` : ""} en ${r.durationMs} ms`

    const textLayer = await readFrom(app, pdf, "pdf")
    check("PDF couche texte lu depuis la copie", textLayer.status === "TEXT_LAYER" && /ATTESTATION D.ASSURANCE/.test(textLayer.text), brief(textLayer))
    const ocr = await readFrom(app, png, "png")
    check("image lue par OCR Tesseract depuis la copie", ocr.status === "OCR" && /ATTESTATION/.test(ocr.text), brief(ocr))

    // Témoins négatifs : dépendance retirée de la copie → la lecture doit échouer (sinon elle vient d'ailleurs).
    const noWasm = path.join(work, "sans-wasm")
    copyClosure(realRoot, manifest.files, noWasm, (f) => /^node_modules\/tesseract\.js-core\/.*\.wasm$/.test(f))
    const withoutWasm = await readFrom(noWasm, png, "png")
    check("témoin : sans cœur WASM, l'OCR échoue", withoutWasm.status !== "OCR" && withoutWasm.text === "", brief(withoutWasm))
    const noSharp = path.join(work, "sans-sharp")
    copyClosure(realRoot, manifest.files, noSharp, (f) => f.startsWith("node_modules/sharp/"))
    const withoutSharp = await readFrom(noSharp, png, "png")
    check("témoin : sans sharp, la lecture échoue", withoutSharp.status === "TECHNICAL_FAILURE" && withoutSharp.text === "", brief(withoutSharp))
  } finally {
    process.chdir(previousCwd)
    if (!keep) rmSync(work, { recursive: true, force: true })
  }
  const bytes = manifest.files.reduce((n, f) => n + statSync(path.join(realRoot, f)).size, statSync(path.join(realRoot, WORKER_FILE)).size)
  return { ok: checks.every((c) => c.ok), platform: manifest.platform, files: manifest.files.length, bytes, checks, closureDir: keep ? work : null }
}
