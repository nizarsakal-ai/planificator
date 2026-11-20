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
 * Aucun réseau, aucun fichier temporaire, aucune police téléchargée (Helvetica standard, codage WinAnsi vérifié en amont).
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage } from "pdf-lib"
import { extractText } from "unpdf"
import { withPdfDocument } from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  COORD_MAX, PDF_ERRORS, PDF_LIMITS, TEXT_BASELINE_EM, addRotation, dayText, displaySize, displayToPdf, looksLikePdf, normalizeRotation, roundGeometry,
  type PageGeometry, type PdfOperation, type PlannedPage, type Plan,
} from "@/lib/document-studio/pdf-workspace.core"

export interface PdfInspection { pageCount: number; pages: PageGeometry[]; pageTexts: string[]; encrypted: boolean }

const TEXT_TIMEOUT_MS = 8_000
const INK = rgb(0.06, 0.13, 0.33)

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
      } else if (image) {
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
