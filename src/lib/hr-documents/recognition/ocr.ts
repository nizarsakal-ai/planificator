/**
 * PLV2-DOC-RH-002 — lecture locale d'un document : couche texte du PDF d'abord, puis OCR local (Tesseract WASM,
 * modèles fra/eng lus sur le disque, jamais téléchargés) pour les scans et les photos. Rien ne sort de la machine.
 * Bornes : 3 pages, 50 Mpx par image, 4 orientations essayées au plus, délai global. Aucune valeur n'est journalisée.
 *
 * Statuts distincts : moteur absent (ENGINE_MISSING), échec technique (TECHNICAL_FAILURE, avec un motif), contenu
 * effectivement illisible après une vraie tentative OCR (UNREADABLE). Un scan n'est jamais déclaré illisible sans OCR.
 */
import sharp from "sharp"
import { extractPdfTextLayer } from "@/lib/acquisition/extraction/pdf-text-extract"
import type { DocumentKind } from "../domain"
import { parseMrz } from "./mrz"

export type ReadingStatus = "TEXT_LAYER" | "OCR" | "ENGINE_MISSING" | "TECHNICAL_FAILURE" | "UNREADABLE"
export type ReadingReason = "TIMEOUT" | "IMAGE_NOT_DECODABLE" | "PAGE_RENDER_UNAVAILABLE" | "PDF_UNREADABLE" | "OCR_ERROR" | "PDF_IMAGE_TOO_LARGE"
export type Reading = {
  text: string
  status: ReadingStatus
  reason: ReadingReason | null
  durationMs: number
  pages: number
  /** Rotation appliquée (degrés, sens horaire) ; null sans OCR. */
  rotation: number | null
  /** Confiance moyenne Tesseract (0–100) de la page retenue ; null sans OCR. */
  confidence: number | null
  mrzFound: boolean
}

export type Box = { x0: number; y0: number; x1: number; y1: number }
/** `lines` (passe « page ») : lignes lues avec leur cadre, dans les coordonnées de l'image transmise. */
export type OcrPass = { text: string; confidence: number; lines?: { text: string; bbox: Box }[] }
/** Moteur OCR injectable (tests) : « page » = texte libre français, « mrz » = alphabet MRZ seul. */
export type OcrEngine = { recognize(png: Buffer, mode: "page" | "mrz"): Promise<OcrPass> }

const MAX_PAGES = 3
const MAX_INPUT_PIXELS = 50_000_000
const MIN_IMAGE_AREA = 120_000
const TARGET_LONG_SIDE = 2000
const DETAIL_LONG_SIDE = 3200
const PROBE_LONG_SIDE = 1000
const GOOD_ENOUGH = 60
const MRZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"

/** Moteur ou modèles introuvables : distinct d'un échec technique et d'un contenu illisible. */
export class OcrEngineMissing extends Error {}
class Timeout extends Error {}

/** Texte « utile » : lettres et chiffres hors bruit (un scan rend souvent quelques signes isolés). */
export function meaningfulLength(text: string) {
  return (text.match(/[\p{L}\d]{2,}/gu) ?? []).join("").length
}

/** Moteur et arrêt de ses workers : `terminate` met fin au calcul en cours (workers tués), pas seulement à l'attente. */
export type OcrEngineHandle = { engine: OcrEngine; terminate: () => Promise<void> }

// Moteur Tesseract chargé à la demande, une fois par instance, avec deux workers : texte (fra) et bande MRZ (eng).
let engine: Promise<OcrEngine> | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let terminate: (() => Promise<void>) | null = null
async function loadTesseract(): Promise<OcrEngine> {
  const handle = await createOcrEngineHandle()
  terminate = handle.terminate
  return handle.engine
}

/**
 * Moteur indépendant du moteur partagé : ses propres workers, arrêtés par son `terminate` sans toucher aux lectures
 * en cours d'un autre module (documents RH). Utilisé par la lecture des pièces véhicule.
 */
export async function createOcrEngineHandle(): Promise<OcrEngineHandle> {
  let T: typeof import("tesseract.js"), fra: { langPath: string }, eng: { langPath: string }
  try {
    T = await import("tesseract.js")
    fra = (await import("@tesseract.js-data/fra")).default
    eng = (await import("@tesseract.js-data/eng")).default
  } catch {
    throw new OcrEngineMissing()
  }
  // Modèles « best_int » (LSTM) livrés avec le paquet : lus localement, aucun cache écrit, aucune requête réseau.
  // Fichier de modèle absent (paquet mal installé ou non embarqué) = moteur absent, pas un échec de lecture.
  const local = (p: string) => p.replace(/4\.0\.0$/, "4.0.0_best_int")
  const { existsSync } = await import("node:fs")
  if (![`${local(fra.langPath)}/fra.traineddata.gz`, `${local(eng.langPath)}/eng.traineddata.gz`].every((f) => existsSync(f))) throw new OcrEngineMissing()
  const options = { gzip: true, cacheMethod: "none" as const }
  const page = await T.createWorker("fra", T.OEM.LSTM_ONLY, { ...options, langPath: local(fra.langPath) })
  const mrz = await T.createWorker("eng", T.OEM.LSTM_ONLY, { ...options, langPath: local(eng.langPath) })
  // Résolution déclarée : les images préparées n'ont pas de métadonnée fiable (sinon Tesseract suppose 70 dpi).
  await page.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, preserve_interword_spaces: "1", user_defined_dpi: "300" })
  await mrz.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_BLOCK, tessedit_char_whitelist: MRZ_ALPHABET, user_defined_dpi: "300" })
  const stop = async () => { await Promise.allSettled([page.terminate(), mrz.terminate()]) }
  return { terminate: stop, engine: {
    async recognize(png, mode) {
      if (mode === "mrz") { const r = await mrz.recognize(png); return { text: r.data.text ?? "", confidence: r.data.confidence ?? 0 } }
      const r = await page.recognize(png, {}, { text: true, blocks: true })
      const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, bbox: l.bbox }))))
      return { text: r.data.text ?? "", confidence: r.data.confidence ?? 0, lines }
    },
  } }
}
function tesseract(): Promise<OcrEngine> {
  if (idle) clearTimeout(idle)
  // Libère la mémoire (≈ 100 Mo) après une minute sans lecture.
  idle = setTimeout(() => { const t = terminate; engine = null; terminate = null; void t?.() }, 60_000)
  idle.unref?.()
  engine ??= loadTesseract().catch((e) => { engine = null; throw e })
  return engine
}

/** Arrêt immédiat des workers (tests, arrêt du serveur) ; le prochain appel recharge le moteur. */
export async function shutdownOcr() {
  if (idle) clearTimeout(idle)
  const t = terminate; engine = null; terminate = null; idle = null
  await t?.()
}

/** Image de travail : orientation EXIF appliquée, niveaux de gris, côté long borné à 3000 px. */
type Raster = { png: Buffer }
async function open(input: Buffer | { data: Uint8ClampedArray | Uint8Array; width: number; height: number; channels: 1 | 3 | 4 }): Promise<Raster> {
  const image = Buffer.isBuffer(input)
    ? sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate()
    : sharp(Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength),
        { raw: { width: input.width, height: input.height, channels: input.channels }, limitInputPixels: MAX_INPUT_PIXELS })
  const png = await image.flatten({ background: "#ffffff" }).grayscale()
    .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }).png().toBuffer()
  return { png }
}

/** Prétraitement borné : rotation, contraste étiré, côté long ramené à `longSide` (agrandi ou réduit). */
async function prepare(r: Raster, rotation: number, longSide: number): Promise<Buffer> {
  const rotated = await sharp(r.png).rotate(rotation, { background: "#ffffff" }).png().toBuffer({ resolveWithObject: true })
  const { width, height } = rotated.info
  const scale = longSide / Math.max(width, height)
  return sharp(rotated.data).resize(Math.round(width * scale), Math.round(height * scale), { kernel: "lanczos3" })
    .normalize().sharpen({ sigma: 0.8 }).png().toBuffer()
}
/** Bande inférieure (MRZ des cartes et des passeports), agrandie pour des caractères d'au moins 30 px. */
async function bottomBand(png: Buffer, share: number): Promise<Buffer> {
  const meta = await sharp(png).metadata()
  const w = meta.width ?? 0, h = meta.height ?? 0
  const top = Math.floor(h * (1 - share))
  return sharp(png).extract({ left: 0, top, width: w, height: h - top }).resize({ width: Math.max(w, 1800) }).png().toBuffer()
}

function clip(b: Box, W: number, H: number): Box {
  return { x0: Math.max(0, Math.round(b.x0)), y0: Math.max(0, Math.round(b.y0)), x1: Math.min(W, Math.round(b.x1)), y1: Math.min(H, Math.round(b.y1)) }
}
/** Zone agrandie pour que son côté long atteigne `longSide` (bornée à ×4). */
async function zoom(png: Buffer, b: Box, longSide: number): Promise<Buffer> {
  const w = b.x1 - b.x0, h = b.y1 - b.y0
  const scale = Math.min(4, longSide / Math.max(w, h, 1))
  return sharp(png).extract({ left: b.x0, top: b.y0, width: Math.max(1, w), height: Math.max(1, h) })
    .resize(Math.round(w * scale), Math.round(h * scale), { kernel: "lanczos3" }).normalize().png().toBuffer()
}

/** Qualité d'une passe : confiance pondérée par la quantité de mots lisibles (une page vide n'est pas « sûre »). */
const score = (p: OcrPass) => p.confidence * Math.min(1, meaningfulLength(p.text) / 60)
/** Lignes MRZ seules (alphabet, longueur plausible) : le reste d'une passe MRZ n'est que du bruit. */
const mrzOnly = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, "")).filter((l) => l.length >= 28 && l.includes("<")).join("\n")

async function ocrRaster(r: Raster, ocr: OcrEngine, deadline: number, signal?: AbortSignal): Promise<{ text: string; confidence: number; rotation: number; mrz: boolean }> {
  const check = () => { if (Date.now() > deadline || signal?.aborted) throw new Timeout() }
  // Orientation : passe droite d'abord ; si elle est faible, sondes rapides à 90/180/270° puis passe complète sur la meilleure.
  let rotation = 0
  let best = await ocr.recognize(await prepare(r, 0, TARGET_LONG_SIDE), "page")
  if (score(best) < GOOD_ENOUGH) {
    let probeBest = { rotation: 0, value: score(best) }
    for (const angle of [90, 180, 270]) {
      check()
      const probe = await ocr.recognize(await prepare(r, angle, PROBE_LONG_SIDE), "page")
      if (score(probe) > probeBest.value + 5) probeBest = { rotation: angle, value: score(probe) }
    }
    if (probeBest.rotation !== 0) {
      check()
      const full = await ocr.recognize(await prepare(r, probeBest.rotation, TARGET_LONG_SIDE), "page")
      if (score(full) > score(best)) { best = full; rotation = probeBest.rotation }
    }
  }
  check()
  const oriented = await prepare(r, rotation, TARGET_LONG_SIDE)
  const size = await sharp(oriented).metadata()
  const W = size.width ?? 0, H = size.height ?? 0
  // Pièce posée sur une page (scan A4 d'une carte) : la bande MRZ repérée par la passe texte situe la carte. On relit
  // alors la carte seule, agrandie, au lieu de la page entière où les caractères sont trop petits.
  const mrzBoxes = (best.lines ?? []).filter((l) => { const t = l.text.replace(/\s+/g, ""); return t.length >= 20 && (t.match(/</g) ?? []).length >= 3 }).map((l) => l.bbox)
  const crops: { mrz: Box | null; card: Box | null } = { mrz: null, card: null }
  if (mrzBoxes.length >= 2) {
    const u = mrzBoxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }))
    const lineH = (u.y1 - u.y0) / mrzBoxes.length, padX = (u.x1 - u.x0) * 0.04
    crops.mrz = clip({ x0: u.x0 - padX, y0: u.y0 - lineH * 0.6, x1: u.x1 + padX, y1: u.y1 + lineH * 0.6 }, W, H)
    const cardW = (u.x1 - u.x0) * 1.1
    if (cardW < W * 0.8) crops.card = clip({ x0: u.x0 - cardW * 0.05, y0: u.y1 + lineH - cardW * 0.72, x1: u.x0 + cardW, y1: u.y1 + lineH }, W, H)
  }
  const texts = [best.text]
  if (crops.card) { check(); texts.push((await ocr.recognize(await zoom(oriented, crops.card, TARGET_LONG_SIDE), "page")).text) }
  else if (meaningfulLength(best.text) < 150 && Math.max(W, H) < DETAIL_LONG_SIDE) {
    // Peu de texte sur une page entière : seconde passe plus détaillée (petits caractères d'une carte sur une page A4).
    check()
    const detail = await ocr.recognize(await prepare(r, rotation, DETAIL_LONG_SIDE), "page")
    if (meaningfulLength(detail.text) > meaningfulLength(best.text)) texts.push(detail.text)
  }
  // Bande MRZ : zone repérée d'abord, puis le bas de l'image, la page entière, et le bas des autres orientations
  // (Tesseract lit parfois une page tournée sans que la bande du bas soit la bonne).
  let mrzText = ""
  type Attempt = () => Promise<Buffer>
  const attempts: Attempt[] = [
    ...(crops.mrz ? [() => zoom(oriented, crops.mrz!, 2000)] : []),
    () => bottomBand(oriented, 0.32), async () => oriented,
    ...[0, 90, 180, 270].filter((a) => a !== rotation).map((a): Attempt => async () => bottomBand(await prepare(r, a, TARGET_LONG_SIDE), 0.32)),
  ]
  for (const attempt of attempts) {
    if (Date.now() > deadline - 2_000 || signal?.aborted) break
    const lines = mrzOnly((await ocr.recognize(await attempt(), "mrz")).text)
    if (lines && parseMrz(lines)?.checksValid) { mrzText = lines; break }
    if (lines && parseMrz(lines) && !mrzText) mrzText = lines
  }
  return { text: [...texts, mrzText].filter(Boolean).join("\n"), confidence: best.confidence, rotation, mrz: !!mrzText }
}

/**
 * Pixels déclarés par les images du PDF, lus dans leurs dictionnaires AVANT toute décompression (un flux d'image ne
 * peut pas être rangé dans un flux d'objets : son dictionnaire est toujours lisible tel quel). Null si une image a une
 * largeur ou une hauteur indirecte ou absente : taille inconnue, donc refusée par l'appelant qui borne.
 * Ne couvre pas les images « en ligne » d'un flux de contenu compressé (limite documentée).
 */
export function declaredPdfImagePixels(bytes: Uint8Array): { max: number; total: number; count: number } | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")
  let max = 0, total = 0, count = 0
  const marker = /\/Subtype\s*\/Image\b/g
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    const start = Math.max(text.lastIndexOf("obj", m.index), m.index - 4_000, 0)
    const streamAt = text.indexOf("stream", m.index)
    const end = streamAt === -1 ? Math.min(text.length, m.index + 4_000) : Math.min(streamAt, m.index + 4_000)
    const dict = text.slice(start, end)
    const width = /\/Width\s+(\d{1,9})(?![\d.])(?!\s+\d+\s+R)/.exec(dict), height = /\/Height\s+(\d{1,9})(?![\d.])(?!\s+\d+\s+R)/.exec(dict)
    if (!width || !height) return null
    const pixels = Number(width[1]) * Number(height[1])
    max = Math.max(max, pixels); total += pixels; count++
  }
  return { max, total, count }
}

async function pdfImages(bytes: Uint8Array): Promise<{ pages: number; rasters: Raster[] }> {
  const { getDocumentProxy, extractImages } = await import("unpdf")
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try {
    const rasters: Raster[] = []
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
      // Une page scannée = une grande image : on garde la plus grande de chaque page (logos et tampons ignorés).
      const images = (await extractImages(pdf, n)).filter((i) => i.width * i.height >= MIN_IMAGE_AREA && i.width * i.height <= MAX_INPUT_PIXELS)
      const largest = images.sort((a, b) => b.width * b.height - a.width * a.height)[0]
      if (largest) rasters.push(await open({ data: largest.data, width: largest.width, height: largest.height, channels: largest.channels as 1 | 3 | 4 }))
    }
    return { pages: pdf.numPages, rasters }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

/** Promesse rejetée dès l'abandon : l'appelant n'attend plus un calcul que `terminate` arrêtera. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(new Timeout()) }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Timeout())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v) }, (e) => { signal.removeEventListener("abort", onAbort); reject(e) })
  })
}

/**
 * Options ajoutées pour la lecture des pièces véhicule, sans effet si absentes (documents RH inchangés) :
 * `signal` abandonne la lecture (rendu immédiat « TIMEOUT ») ; `maxPdfImagePixels` refuse avant décompression un PDF
 * dont une image déclare plus de pixels, ou dont la taille d'une image est inconnue.
 */
export async function readDocument(bytes: Uint8Array, kind: DocumentKind,
  opts: { engine?: () => Promise<OcrEngine>; timeoutMs?: number; now?: () => number; signal?: AbortSignal; maxPdfImagePixels?: number } = {}): Promise<Reading> {
  const now = opts.now ?? Date.now
  const started = now()
  const deadline = started + (opts.timeoutMs ?? 45_000)
  const { signal } = opts
  const done = (r: Omit<Reading, "durationMs">): Reading => ({ ...r, durationMs: now() - started })
  const base = { text: "", reason: null, pages: 1, rotation: null, confidence: null, mrzFound: false } as const
  const timedOut = (pages = 1) => done({ ...base, pages, status: "TECHNICAL_FAILURE", reason: "TIMEOUT" })

  let rasters: Raster[]
  let pages = 1
  if (signal?.aborted) return timedOut()
  if (kind === "pdf") {
    const layer = await extractPdfTextLayer(bytes, { maxChars: 20_000, timeoutMs: 4_000 })
    if (meaningfulLength(layer.text) >= 40) return done({ ...base, text: layer.text, status: "TEXT_LAYER", mrzFound: !!parseMrz(layer.text) })
    if (signal?.aborted) return timedOut()
    if (opts.maxPdfImagePixels !== undefined) {
      const declared = declaredPdfImagePixels(bytes)
      if (!declared || declared.max > opts.maxPdfImagePixels || declared.total > opts.maxPdfImagePixels * MAX_PAGES)
        return done({ ...base, status: "TECHNICAL_FAILURE", reason: "PDF_IMAGE_TOO_LARGE" })
    }
    try {
      ({ pages, rasters } = await pdfImages(bytes))
    } catch {
      return done({ ...base, status: "TECHNICAL_FAILURE", reason: "PDF_UNREADABLE" })
    }
    // Page vectorielle sans couche texte ni image : il faudrait un moteur de rendu, absent de ce lot.
    if (!rasters.length) return done({ ...base, pages, status: "TECHNICAL_FAILURE", reason: "PAGE_RENDER_UNAVAILABLE" })
  } else {
    // HEIC : décodage selon la version de libvips livrée avec sharp ; sinon échec technique explicite, pas « illisible ».
    try { rasters = [await open(Buffer.from(bytes))] }
    catch { return done({ ...base, status: "TECHNICAL_FAILURE", reason: "IMAGE_NOT_DECODABLE" }) }
  }

  let ocr: OcrEngine
  try {
    const loaded = await abortable((opts.engine ?? tesseract)(), signal)
    ocr = signal ? { recognize: (png, mode) => abortable(loaded.recognize(png, mode), signal) } : loaded
  } catch (e) {
    if (e instanceof Timeout) return timedOut(pages)
    return done({ ...base, pages, status: e instanceof OcrEngineMissing ? "ENGINE_MISSING" : "TECHNICAL_FAILURE", reason: e instanceof OcrEngineMissing ? null : "OCR_ERROR" })
  }

  const texts: string[] = []
  let first: { rotation: number; confidence: number } | null = null
  let mrzFound = false
  try {
    for (const r of rasters) {
      if (now() > deadline || signal?.aborted) throw new Timeout()
      const out = await ocrRaster(r, ocr, deadline, signal)
      texts.push(out.text)
      first ??= { rotation: out.rotation, confidence: out.confidence }
      mrzFound ||= out.mrz
    }
  } catch (e) {
    const reason: ReadingReason = e instanceof Timeout ? "TIMEOUT" : "OCR_ERROR"
    // Pages déjà lues conservées : un délai dépassé en page 3 n'efface pas les pages 1 et 2. Lecture abandonnée : rien.
    if (!texts.length || signal?.aborted) return done({ ...base, pages, status: "TECHNICAL_FAILURE", reason })
  }
  const text = texts.join("\n\f\n")
  // Illisible seulement après une vraie passe OCR : presque aucun mot, ou confiance trop basse sans MRZ valide.
  const unreadable = !mrzFound && (meaningfulLength(text) < 20 || (first?.confidence ?? 0) < 30)
  return done({ text: unreadable ? "" : text, status: unreadable ? "UNREADABLE" : "OCR", reason: null, pages,
    rotation: first?.rotation ?? null, confidence: first ? Math.round(first.confidence) : null, mrzFound })
}
