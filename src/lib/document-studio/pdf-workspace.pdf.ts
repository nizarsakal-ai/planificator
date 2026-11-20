/**
 * Document Studio — espace PDF : lecture et écriture des octets PDF (serveur uniquement).
 *
 * - `inspectPdf` (lot 1) : vérifie qu'il s'agit d'un PDF lisible, lit le nombre de pages, la boîte visible et la
 *   rotation de chaque page (pdf-lib), et le texte de chaque page pour la recherche (PDF.js local de `unpdf`, déjà
 *   utilisé par l'import de factures ; un PDF scanné sans couche texte reste importable, simplement non cherchable).
 * - `applyOperations` (lot 2) : écrit textes, dates, coches et signature sur une COPIE du PDF. Les octets d'entrée ne sont
 *   jamais modifiés ; les métadonnées d'origine sont conservées (aucune date de modification inventée).
 *
 * - `assemblePdf` (lot 3) : construit un NOUVEAU PDF à partir de pages d'un ou plusieurs PDF (ordre, rotation ajoutée,
 *   pages retirées) : sert à organiser, extraire et combiner. Les pages sont copiées avec leur contenu et leurs
 *   annotations ; les champs de formulaire interactifs, signets et pièces jointes du document d'origine ne sont pas repris.
 *
 * - `redactPdf` (lot 4) : nouveau PDF où chaque page biffée est REMPLACÉE par une page neuve ne contenant que son image
 *   (rectangles noirs déjà peints) ; les autres pages sont copiées telles quelles. Les objets des pages biffées ne sont
 *   jamais copiés (pdf-lib ne reprend que les objets référencés) : ni texte, ni polices, ni annotations d'origine.
 *
 * Aucun réseau, aucun fichier temporaire, aucune police téléchargée (Helvetica standard, codage WinAnsi vérifié en amont).
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage } from "pdf-lib"
import { extractText } from "unpdf"
import { withPdfDocument } from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  COORD_MAX, PDF_ERRORS, PDF_LIMITS, TEXT_BASELINE_EM, addRotation, imageFitsPage, type PageRedaction, dayText, displaySize, displayToPdf, looksLikePdf, normalizeRotation, roundGeometry,
  type PageGeometry, type PdfOperation, type PlannedPage, type Plan,
} from "@/lib/document-studio/pdf-workspace.core"

export interface PdfInspection { pageCount: number; pages: PageGeometry[]; pageTexts: string[]; encrypted: boolean }

const TEXT_TIMEOUT_MS = 8_000
const INK = rgb(0.06, 0.13, 0.33)
const HIGHLIGHT = rgb(1, 0.86, 0.2)
const BOX = rgb(0.78, 0.1, 0.17)
const NOTE_BG = rgb(1, 0.96, 0.66)
const NOTE_BORDER = rgb(0.85, 0.68, 0.1)

/** Rectangle AFFICHÉ (points, origine en haut à gauche) → rectangle de l'espace PDF (les quarts de tour gardent les axes). */
function displayRectToPdf(g: PageGeometry, dx: number, dy: number, w: number, h: number) {
  const a = displayToPdf(g, dx, dy), b = displayToPdf(g, dx + w, dy + h)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

function geometryOf(page: PDFPage): PageGeometry {
  const box = page.getCropBox()
  return roundGeometry({ x: box.x, y: box.y, width: box.width, height: box.height, rotation: normalizeRotation(page.getRotation().angle) })
}

async function loadForRead(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })
  } catch {
    return null
  }
}

async function pageTextsOf(bytes: Uint8Array, pageCount: number): Promise<string[]> {
  const empty = Array.from({ length: pageCount }, () => "")
  try {
    return await withPdfDocument(Buffer.from(bytes), TEXT_TIMEOUT_MS, async (pdf) => {
      const { text } = await extractText(pdf, { mergePages: false })
      return Array.from({ length: pageCount }, (_, i) => (typeof text[i] === "string" ? text[i].replace(/\s+/g, " ").trim().slice(0, PDF_LIMITS.maxTextPerPage) : ""))
    }, empty)
  } catch {
    return empty
  }
}

/** Lecture d'un PDF importé : refus explicite s'il n'est pas lisible ou trop long. */
export async function inspectPdf(bytes: Uint8Array): Promise<Plan<PdfInspection>> {
  if (!looksLikePdf(bytes)) return { ok: false, error: PDF_ERRORS.notPdf }
  const doc = await loadForRead(bytes)
  if (!doc) return { ok: false, error: PDF_ERRORS.notPdf }
  // Structure lue paresseusement par pdf-lib : un catalogue ou un arbre de pages absent se révèle ici.
  let pageCount: number
  let pages: PageGeometry[]
  try {
    pageCount = doc.getPageCount()
    if (pageCount > PDF_LIMITS.maxPages) return { ok: false, error: PDF_ERRORS.tooManyPages }
    pages = doc.getPages().map(geometryOf)
  } catch {
    return { ok: false, error: PDF_ERRORS.notPdf }
  }
  if (pageCount < 1 || pages.length !== pageCount) return { ok: false, error: PDF_ERRORS.notPdf }
  if (pages.some((p) => !(p.width > 0 && p.height > 0))) return { ok: false, error: PDF_ERRORS.notPdf }
  return { ok: true, value: { pageCount, pages, pageTexts: await pageTextsOf(bytes, pageCount), encrypted: doc.isEncrypted } }
}

/** Signature à poser : octets PNG déjà vérifiés (`parseStudioSignature`). */
export interface SignatureImage { png: Uint8Array }

/**
 * Écrit les éléments sur une copie du PDF. Refus si le PDF est chiffré (l'écriture produirait un fichier corrompu),
 * si une signature est posée sans tracé, ou si la structure du PDF n'est pas prise en charge.
 */
export async function applyOperations(bytes: Uint8Array, ops: readonly PdfOperation[], signature: SignatureImage | null): Promise<Plan<Uint8Array>> {
  // Chargement tolérant, puis refus explicite si le PDF est chiffré (l'erreur dédiée de pdf-lib n'est pas fiable avec
  // instanceof : classe transpilée en ES5).
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    return { ok: false, error: PDF_ERRORS.writeFailed }
  }
  if (doc.isEncrypted) return { ok: false, error: PDF_ERRORS.encrypted }
  try {
    const pages = doc.getPages()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const needsSignature = ops.some((o) => o.kind === "signature")
    if (needsSignature && !signature) return { ok: false, error: PDF_ERRORS.signatureMissing }
    const image = needsSignature && signature ? await doc.embedPng(signature.png) : null

    for (const op of ops) {
      const page = pages[op.page - 1]
      if (!page) return { ok: false, error: PDF_ERRORS.page }
      const g = geometryOf(page)
      const { width: W, height: H } = displaySize(g)
      const dx = (op.x / COORD_MAX) * W
      const dy = (op.y / COORD_MAX) * H
      if (op.kind === "text" || op.kind === "date") {
        const text = op.kind === "text" ? op.text : dayText(op.date)
        const p = displayToPdf(g, dx, dy + op.size * TEXT_BASELINE_EM)
        page.drawText(text, { x: p.x, y: p.y, size: op.size, font, color: INK, rotate: degrees(g.rotation) })
      } else if (op.kind === "check") {
        // Coche dessinée en deux traits (aucun glyphe hors WinAnsi) dans un carré de côté `size` (dix-millièmes de largeur).
        const s = (op.size / COORD_MAX) * W
        const a = displayToPdf(g, dx + s * 0.1, dy + s * 0.55)
        const b = displayToPdf(g, dx + s * 0.4, dy + s * 0.85)
        const c = displayToPdf(g, dx + s * 0.9, dy + s * 0.15)
        const thickness = Math.max(1, s * 0.12)
        page.drawLine({ start: a, end: b, thickness, color: INK })
        page.drawLine({ start: b, end: c, thickness, color: INK })
      } else if (op.kind === "highlight" || op.kind === "box") {
        const r = displayRectToPdf(g, dx, dy, (op.w / COORD_MAX) * W, (op.h / COORD_MAX) * H)
        if (op.kind === "highlight") page.drawRectangle({ ...r, color: HIGHLIGHT, opacity: 0.38, borderWidth: 0 })
        else page.drawRectangle({ ...r, borderColor: BOX, borderWidth: 1.5, opacity: 0, borderOpacity: 1 })
      } else if (op.kind === "note") {
        // Note : texte sur fond jaune, boîte ajustée au texte (marge 0,35 em), lisible à l'impression.
        const pad = op.size * 0.35
        const r = displayRectToPdf(g, dx, dy, font.widthOfTextAtSize(op.text, op.size) + pad * 2, op.size * 1.25 + pad)
        page.drawRectangle({ ...r, color: NOTE_BG, borderColor: NOTE_BORDER, borderWidth: 0.75 })
        const p = displayToPdf(g, dx + pad, dy + pad / 2 + op.size * TEXT_BASELINE_EM)
        page.drawText(op.text, { x: p.x, y: p.y, size: op.size, font, color: INK, rotate: degrees(g.rotation) })
      } else if (op.kind === "signature" && image) {
        const w = (op.width / COORD_MAX) * W
        const h = w * (image.height / image.width)
        // Coin bas-gauche AFFICHÉ de l'image, puis rotation autour de ce coin : l'image reste droite à l'écran.
        const p = displayToPdf(g, dx, dy + h)
        page.drawImage(image, { x: p.x, y: p.y, width: w, height: h, rotate: degrees(g.rotation) })
      }
    }
    const out = await doc.save({ updateFieldAppearances: false })
    if (out.length > PDF_LIMITS.maxStoredBytes) return { ok: false, error: PDF_ERRORS.outputTooLarge }
    return { ok: true, value: out }
  } catch {
    return { ok: false, error: PDF_ERRORS.writeFailed }
  }
}

/** Pages à reprendre d'un PDF source : octets et plan (numéros de page source, rotation ajoutée). */
export interface AssemblyPart { bytes: Uint8Array; pages: readonly PlannedPage[] }

/**
 * Nouveau PDF fait des pages demandées, dans l'ordre des parties puis de leurs plans. Refus si une source est chiffrée,
 * illisible, si une page n'existe pas, ou si le résultat dépasse les bornes (pages, taille téléchargeable).
 */
export async function assemblePdf(parts: readonly AssemblyPart[], meta: { title: string }): Promise<Plan<Uint8Array>> {
  const total = parts.reduce((n, p) => n + p.pages.length, 0)
  if (total < 1) return { ok: false, error: PDF_ERRORS.planEmpty }
  if (total > PDF_LIMITS.maxPages) return { ok: false, error: PDF_ERRORS.tooManyPagesOut }
  try {
    const out = await PDFDocument.create({ updateMetadata: false })
    out.setTitle(meta.title)
    out.setProducer("Planificator")
    out.setCreator("Planificator — Document Studio")
    for (const part of parts) {
      let src: PDFDocument
      try {
        src = await PDFDocument.load(part.bytes, { updateMetadata: false, ignoreEncryption: true })
      } catch {
        return { ok: false, error: PDF_ERRORS.writeFailed }
      }
      if (src.isEncrypted) return { ok: false, error: PDF_ERRORS.sourceEncrypted }
      const count = src.getPageCount()
      if (part.pages.some((p) => p.page < 1 || p.page > count)) return { ok: false, error: PDF_ERRORS.page }
      const copied = await out.copyPages(src, part.pages.map((p) => p.page - 1))
      copied.forEach((page, i) => {
        page.setRotation(degrees(addRotation(page.getRotation().angle, part.pages[i].rotate)))
        out.addPage(page)
      })
    }
    const bytes = await out.save()
    if (bytes.length > PDF_LIMITS.maxStoredBytes) return { ok: false, error: PDF_ERRORS.outputTooLarge }
    return { ok: true, value: bytes }
  } catch {
    return { ok: false, error: PDF_ERRORS.writeFailed }
  }
}

// ── Lot 4 : biffer ──────────────────────────────────────────────────────────────────────────────────────────────────

const JPEG_DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/
/** Image JPEG d'une page biffée (URL de données) : octets vérifiés (signature JPEG, taille bornée). */
export function parseJpegDataUrl(raw: string | null | undefined): Uint8Array | null {
  const m = JPEG_DATA_URL.exec((raw ?? "").trim())
  if (!m) return null
  const b = Buffer.from(m[1], "base64")
  if (b.length < 1000 || b.length > PDF_LIMITS.maxRedactImageBytes) return null
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return null
  return new Uint8Array(b)
}


/**
 * Biffer : chaque page de `redactions` est remplacée par une page neuve de même taille AFFICHÉE ne contenant que son
 * image (rotation déjà appliquée dans l'image, page neuve sans rotation) ; les autres pages sont copiées. Refus si une
 * image manque, n'est pas un JPEG lisible, ne couvre pas la page (proportion) ou est trop peu définie.
 */
export async function redactPdf(bytes: Uint8Array, redactions: readonly PageRedaction[], images: ReadonlyMap<number, Uint8Array>, meta: { title: string }): Promise<Plan<Uint8Array>> {
  let src: PDFDocument
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch {
    return { ok: false, error: PDF_ERRORS.writeFailed }
  }
  if (src.isEncrypted) return { ok: false, error: PDF_ERRORS.encrypted }
  const redacted = new Set(redactions.map((r) => r.page))
  if (images.size !== redacted.size || [...redacted].some((n) => !images.has(n))) return { ok: false, error: PDF_ERRORS.redactImages }
  try {
    const out = await PDFDocument.create({ updateMetadata: false })
    out.setTitle(meta.title)
    out.setProducer("Planificator")
    out.setCreator("Planificator — Document Studio")
    const srcPages = src.getPages()
    for (let i = 0; i < srcPages.length; i++) {
      const n = i + 1
      if (!redacted.has(n)) {
        const [copied] = await out.copyPages(src, [i])
        out.addPage(copied)
        continue
      }
      const size = displaySize(geometryOf(srcPages[i]))
      let img
      try { img = await out.embedJpg(images.get(n)!) } catch { return { ok: false, error: PDF_ERRORS.redactImages } }
      if (!imageFitsPage(img, size)) return { ok: false, error: PDF_ERRORS.redactImages }
      const page = out.addPage([size.width, size.height])
      page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height })
    }
    const result = await out.save()
    if (result.length > PDF_LIMITS.maxStoredBytes) return { ok: false, error: PDF_ERRORS.outputTooLarge }
    return { ok: true, value: result }
  } catch {
    return { ok: false, error: PDF_ERRORS.writeFailed }
  }
}
