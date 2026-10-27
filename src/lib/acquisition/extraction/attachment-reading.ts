/**
 * PLAN-ACQ-MULTIMODAL — Lecture des pièces jointes pour l'extraction.
 *
 * Par fichier (ordre du message conservé), une issue explicite :
 * - PDF à couche texte → extrait texte (unpdf)
 * - PDF sans couche texte → bloc `document` vision (si vision active) sinon ignoré
 * - .xlsx → extrait texte (exceljs, valeurs uniquement)
 * - JPEG/PNG/WebP/GIF (signature magique) → bloc `image` vision (si active) sinon ignoré
 * - HEIC/HEIF → ignoré avec avertissement explicite (aucune conversion)
 * - autre → ignoré (format)
 *
 * Jamais d'exception. Toutes les entrées sont des données non fiables.
 */

import type {
  AttachmentTextExcerpt,
  AttachmentVisualInput,
} from "@/lib/acquisition/extraction/extraction-provider.port"
import {
  guessAttachmentKindFromMeta,
  readImageDimensions,
  sniffAttachmentKind,
  type AttachmentFileKind,
} from "@/lib/acquisition/extraction/attachment-file-kind"
import {
  countPdfPages,
  extractPdfTextLayer,
  type PdfTextExtractStatus,
} from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  MAX_EXCERPT_CHARS,
  MAX_TOTAL_CHARS,
  PDF_PARSE_TIMEOUT_MS,
} from "@/lib/acquisition/extraction/attachment-text-excerpts"
import { extractXlsxText } from "@/lib/acquisition/extraction/xlsx-text-extract"

/** Plafonds vision (Anthropic : 5 Mo/image ; requête ≤ 32 Mo, base64 +33 %). */
export const MAX_VISUAL_FILES = 5
export const MAX_VISUAL_FILE_BYTES = 5 * 1024 * 1024
export const MAX_VISUAL_TOTAL_BYTES = 15 * 1024 * 1024
export const MAX_VISUAL_PDF_PAGES = 10
export const MAX_VISUAL_IMAGE_DIMENSION = 8_000
/** Au-delà, les octets ne sont pas lus (plafond lecture texte PDF/xlsx inclus). */
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024
const MAX_OUTCOMES = 50
/** Bornes mémoire du chargement des octets (avant lecture). */
export const MAX_LOADED_VISUAL_CANDIDATES = 2 * MAX_VISUAL_FILES
export const MAX_TOTAL_LOADED_BYTES = 60 * 1024 * 1024

export const ATTACHMENT_READ_OUTCOME_CODES = [
  "READ_TEXT",
  "READ_TEXT_TRUNCATED",
  "READ_VISION",
  "IGNORED_FORMAT",
  "IGNORED_TOO_LARGE",
  "IGNORED_HEIC",
  "IGNORED_VISION_DISABLED",
  "IGNORED_EMPTY",
  "UNAVAILABLE",
  "FAILED",
] as const

export type AttachmentReadOutcomeCode = (typeof ATTACHMENT_READ_OUTCOME_CODES)[number]

export type AttachmentReadKind = "pdf" | "xlsx" | "image" | "heic" | "other"

export type AttachmentReadOutcome = {
  filename: string
  kind: AttachmentReadKind
  outcome: AttachmentReadOutcomeCode
  /** Code machine court (jamais de texte libre issu du fichier). */
  reason?: string
}

export type VisionDisabledReason = "FLAG_OFF" | "PROVIDER_NOT_VISION"

export type AttachmentForReading = {
  filename: string
  mimeType: string
  category: string
  sizeBytes: number
  status: string
  /** Octets chargés (STORED) ; null si indisponibles / non chargés. */
  bytes: Buffer | null
  /** Non chargé faute de budget mémoire (voir planAttachmentLoads). */
  loadSkippedForBudget?: boolean
}

export type AttachmentLegacyPdfOutcome = {
  filename: string
  status: PdfTextExtractStatus
}

export type AttachmentReadingResult = {
  excerpts: AttachmentTextExcerpt[]
  visuals: AttachmentVisualInput[]
  outcomes: AttachmentReadOutcome[]
  /** Compat warnings PDF historiques (PDF_TEXT_EXTRACTED, PDF_NO_TEXT_LAYER…). */
  pdfOutcomes: AttachmentLegacyPdfOutcome[]
}

export type AttachmentReadingOptions = {
  vision: { enabled: true } | { enabled: false; reason: VisionDisabledReason }
}

function kindLabel(k: AttachmentFileKind): AttachmentReadKind {
  return k.kind === "unsupported" ? "other" : k.kind
}

/**
 * Lisibilité potentielle d'après les métadonnées seules (avant claim).
 * Une pièce STORED d'un format supporté ; images seulement si vision active.
 */
export function isPotentiallyReadableAttachment(
  meta: { filename: string; mimeType: string; status: string; storagePublicId?: string | null },
  opts: { visionEnabled: boolean }
): boolean {
  if (meta.status !== "STORED") return false
  if (meta.storagePublicId !== undefined && !meta.storagePublicId?.trim()) return false
  const kind = guessAttachmentKindFromMeta(meta)
  if (kind.kind === "pdf" || kind.kind === "xlsx") return true
  if (kind.kind === "image") return opts.visionEnabled
  // MIME générique (octet-stream) : seule la signature tranchera, si vision active.
  const mime = (meta.mimeType || "").toLowerCase()
  if (kind.kind === "unsupported" && mime.startsWith("application/octet-stream")) {
    return opts.visionEnabled
  }
  return false
}

/** Faut-il charger les octets de cette pièce ? (évite les téléchargements inutiles). */
export function shouldLoadAttachmentBytes(
  meta: { filename: string; mimeType: string; status: string; sizeBytes: number },
  opts: { visionEnabled: boolean }
): boolean {
  if (meta.status !== "STORED") return false
  if (Number.isFinite(meta.sizeBytes) && meta.sizeBytes > MAX_READ_FILE_BYTES) return false
  const kind = guessAttachmentKindFromMeta(meta)
  if (kind.kind === "pdf" || kind.kind === "xlsx") return true
  if (kind.kind === "heic") return false
  if (kind.kind === "image") return opts.visionEnabled
  return opts.visionEnabled && (meta.mimeType || "").toLowerCase().startsWith("application/octet-stream")
}

/**
 * Plan de chargement des octets, dans l'ordre du message, borné :
 * ≤ 10 candidats visuels (images / octet-stream) et ≤ 60 Mo déclarés au total.
 * "SKIP" = pas besoin de lire ; "BUDGET" = lisible mais hors budget mémoire.
 */
export function planAttachmentLoads(
  metas: Array<{ filename: string; mimeType: string; status: string; sizeBytes: number }>,
  opts: { visionEnabled: boolean }
): Array<"LOAD" | "SKIP" | "BUDGET"> {
  let visualCandidates = 0
  let totalBytes = 0
  return metas.map((m) => {
    if (!shouldLoadAttachmentBytes(m, opts)) return "SKIP"
    const kind = guessAttachmentKindFromMeta(m).kind
    const isVisualCandidate = kind === "image" || kind === "unsupported"
    const size = Number.isFinite(m.sizeBytes) && m.sizeBytes > 0 ? m.sizeBytes : 0
    if (isVisualCandidate && visualCandidates >= MAX_LOADED_VISUAL_CANDIDATES) return "BUDGET"
    if (totalBytes + size > MAX_TOTAL_LOADED_BYTES) return "BUDGET"
    if (isVisualCandidate) visualCandidates++
    totalBytes += size
    return "LOAD"
  })
}

type VisualCandidate = {
  index: number
  filename: string
  kind: "image" | "pdf"
  mediaType: AttachmentVisualInput["mediaType"]
  bytes: Buffer
}

export async function readAttachmentsForExtraction(
  attachments: AttachmentForReading[],
  options: AttachmentReadingOptions
): Promise<AttachmentReadingResult> {
  const excerpts: AttachmentTextExcerpt[] = []
  const outcomes: AttachmentReadOutcome[] = []
  const pdfOutcomes: AttachmentLegacyPdfOutcome[] = []
  const candidates: VisualCandidate[] = []
  let totalChars = 0
  const visionEnabled = options.vision.enabled
  const visionOffReason = options.vision.enabled ? undefined : options.vision.reason

  const pushExcerpt = (
    filename: string,
    mimeType: string,
    text: string,
    truncatedAtSource: boolean
  ): { pushed: boolean; truncated: boolean } => {
    const room = MAX_TOTAL_CHARS - totalChars
    if (room <= 0 || !text) return { pushed: false, truncated: true }
    let t = text.slice(0, MAX_EXCERPT_CHARS)
    let truncated = truncatedAtSource || text.length > MAX_EXCERPT_CHARS
    if (t.length > room) {
      t = t.slice(0, room)
      truncated = true
    }
    excerpts.push({ filename, mimeType: mimeType.slice(0, 127), text: t })
    totalChars += t.length
    return { pushed: true, truncated }
  }

  for (const att of attachments.slice(0, MAX_OUTCOMES)) {
    const filename = (att.filename || "piece-jointe").slice(0, 255)
    const metaKind = guessAttachmentKindFromMeta(att)
    const record = (o: Omit<AttachmentReadOutcome, "filename">) => {
      outcomes.push({ filename, ...o })
      return outcomes.length - 1
    }

    if (att.status !== "STORED") {
      if (metaKind.kind === "pdf") pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
      record({ kind: kindLabel(metaKind), outcome: "UNAVAILABLE", reason: `NOT_STORED_${att.status}`.slice(0, 40) })
      continue
    }

    if (metaKind.kind === "heic") {
      record({ kind: "heic", outcome: "IGNORED_HEIC", reason: "HEIC_NOT_SUPPORTED" })
      continue
    }

    if (att.loadSkippedForBudget && !att.bytes) {
      if (metaKind.kind === "pdf") pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
      record({ kind: kindLabel(metaKind), outcome: "IGNORED_TOO_LARGE", reason: "LOAD_BUDGET" })
      continue
    }

    if (Number.isFinite(att.sizeBytes) && att.sizeBytes > MAX_READ_FILE_BYTES && !att.bytes) {
      if (metaKind.kind === "pdf") pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
      record({ kind: kindLabel(metaKind), outcome: "IGNORED_TOO_LARGE", reason: "FILE_BYTES" })
      continue
    }

    const bytes = att.bytes && att.bytes.byteLength > 0 ? att.bytes : null
    if (!bytes) {
      if (metaKind.kind === "pdf") {
        pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
        record({ kind: "pdf", outcome: "UNAVAILABLE", reason: "BYTES_UNAVAILABLE" })
      } else if (metaKind.kind === "xlsx") {
        record({ kind: "xlsx", outcome: "UNAVAILABLE", reason: "BYTES_UNAVAILABLE" })
      } else if (metaKind.kind === "image" || (att.mimeType || "").toLowerCase().startsWith("application/octet-stream")) {
        if (!visionEnabled) {
          record({ kind: kindLabel(metaKind), outcome: "IGNORED_VISION_DISABLED", reason: visionOffReason })
        } else {
          record({ kind: kindLabel(metaKind), outcome: "UNAVAILABLE", reason: "BYTES_UNAVAILABLE" })
        }
      } else {
        record({ kind: "other", outcome: "IGNORED_FORMAT", reason: "UNSUPPORTED_TYPE" })
      }
      continue
    }

    const kind = sniffAttachmentKind(bytes, att)

    if (kind.kind === "heic") {
      record({ kind: "heic", outcome: "IGNORED_HEIC", reason: "HEIC_NOT_SUPPORTED" })
      continue
    }

    if (kind.kind === "unsupported") {
      if (metaKind.kind === "pdf") pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
      record({ kind: "other", outcome: "IGNORED_FORMAT", reason: "SIGNATURE_UNSUPPORTED" })
      continue
    }

    if (kind.kind === "xlsx") {
      const r = await extractXlsxText(bytes, { maxChars: MAX_EXCERPT_CHARS })
      if (r.status === "XLSX_TEXT_EXTRACTED" || r.status === "XLSX_TEXT_TRUNCATED") {
        const pushed = pushExcerpt(filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", r.text, r.truncated)
        if (!pushed.pushed) {
          record({ kind: "xlsx", outcome: "IGNORED_TOO_LARGE", reason: "TEXT_BUDGET" })
        } else {
          record({ kind: "xlsx", outcome: pushed.truncated ? "READ_TEXT_TRUNCATED" : "READ_TEXT" })
        }
      } else if (r.status === "XLSX_EMPTY") {
        record({ kind: "xlsx", outcome: "IGNORED_EMPTY", reason: "NO_CELL_VALUE" })
      } else if (r.status === "XLSX_TOO_LARGE") {
        record({ kind: "xlsx", outcome: "IGNORED_TOO_LARGE", reason: "XLSX_LIMITS" })
      } else {
        record({ kind: "xlsx", outcome: "FAILED", reason: "XLSX_PARSE_FAILED" })
      }
      continue
    }

    if (kind.kind === "pdf") {
      const r = await extractPdfTextLayer(bytes, {
        maxChars: MAX_EXCERPT_CHARS,
        timeoutMs: PDF_PARSE_TIMEOUT_MS,
      })
      if ((r.status === "PDF_TEXT_EXTRACTED" || r.status === "PDF_TEXT_TRUNCATED") && r.text) {
        const pushed = pushExcerpt(filename, "application/pdf", r.text, r.truncated)
        const status: PdfTextExtractStatus =
          pushed.pushed && !pushed.truncated ? "PDF_TEXT_EXTRACTED" : "PDF_TEXT_TRUNCATED"
        pdfOutcomes.push({ filename, status })
        if (!pushed.pushed) {
          record({ kind: "pdf", outcome: "IGNORED_TOO_LARGE", reason: "TEXT_BUDGET" })
        } else {
          record({ kind: "pdf", outcome: pushed.truncated ? "READ_TEXT_TRUNCATED" : "READ_TEXT" })
        }
        continue
      }
      if (r.status === "PDF_NO_TEXT_LAYER") {
        pdfOutcomes.push({ filename, status: "PDF_NO_TEXT_LAYER" })
        const idx = record({
          kind: "pdf",
          outcome: "IGNORED_VISION_DISABLED",
          reason: visionOffReason ?? "PENDING",
        })
        if (visionEnabled) {
          candidates.push({ index: idx, filename, kind: "pdf", mediaType: "application/pdf", bytes })
        }
        continue
      }
      pdfOutcomes.push({ filename, status: "PDF_PARSE_FAILED" })
      record({ kind: "pdf", outcome: "FAILED", reason: "PDF_PARSE_FAILED" })
      continue
    }

    // Image (jpeg/png/webp/gif) — y compris déclarée application/octet-stream.
    const idx = record({
      kind: "image",
      outcome: "IGNORED_VISION_DISABLED",
      reason: visionOffReason ?? "PENDING",
    })
    if (visionEnabled) {
      candidates.push({ index: idx, filename, kind: "image", mediaType: kind.mediaType, bytes })
    }
  }

  const visuals = await allocateVisualBudget(candidates, outcomes)
  return { excerpts, visuals, outcomes, pdfOutcomes }
}

/**
 * Attribue le budget vision : PDF scannés d'abord (bons de commande), puis photos,
 * dans l'ordre du message. Dépassement → « ignoré (trop gros) ».
 */
async function allocateVisualBudget(
  candidates: VisualCandidate[],
  outcomes: AttachmentReadOutcome[]
): Promise<AttachmentVisualInput[]> {
  const ordered = [
    ...candidates.filter((c) => c.kind === "pdf"),
    ...candidates.filter((c) => c.kind === "image"),
  ]
  const visuals: Array<{ index: number; visual: AttachmentVisualInput }> = []
  let totalBytes = 0

  const ignore = (c: VisualCandidate, reason: string) => {
    outcomes[c.index] = { ...outcomes[c.index], outcome: "IGNORED_TOO_LARGE", reason }
  }

  for (const c of ordered) {
    if (c.bytes.byteLength > MAX_VISUAL_FILE_BYTES) {
      ignore(c, "VISUAL_FILE_BYTES")
      continue
    }
    if (visuals.length >= MAX_VISUAL_FILES) {
      ignore(c, "MAX_VISUAL_FILES")
      continue
    }
    if (totalBytes + c.bytes.byteLength > MAX_VISUAL_TOTAL_BYTES) {
      ignore(c, "VISUAL_TOTAL_BUDGET")
      continue
    }
    if (c.kind === "pdf") {
      const pages = await countPdfPages(c.bytes)
      if (pages != null && pages > MAX_VISUAL_PDF_PAGES) {
        ignore(c, "PDF_PAGES")
        continue
      }
      visuals.push({
        index: c.index,
        visual: {
          filename: c.filename,
          kind: "pdf",
          mediaType: "application/pdf",
          base64: c.bytes.toString("base64"),
          byteLength: c.bytes.byteLength,
        },
      })
    } else {
      const mediaType = c.mediaType as Exclude<AttachmentVisualInput["mediaType"], "application/pdf">
      const dims = readImageDimensions(c.bytes, mediaType)
      if (dims && (dims.width > MAX_VISUAL_IMAGE_DIMENSION || dims.height > MAX_VISUAL_IMAGE_DIMENSION)) {
        ignore(c, "IMAGE_DIMENSIONS")
        continue
      }
      visuals.push({
        index: c.index,
        visual: {
          filename: c.filename,
          kind: "image",
          mediaType,
          base64: c.bytes.toString("base64"),
          byteLength: c.bytes.byteLength,
        },
      })
    }
    totalBytes += c.bytes.byteLength
    outcomes[c.index] = {
      filename: outcomes[c.index].filename,
      kind: outcomes[c.index].kind,
      outcome: "READ_VISION",
    }
  }

  // Ordre du message conservé pour l'envoi au provider.
  return visuals.sort((a, b) => a.index - b.index).map((v) => v.visual)
}
