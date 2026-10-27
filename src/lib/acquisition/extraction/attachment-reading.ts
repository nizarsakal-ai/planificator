/**
 * PLAN-ACQ-MULTIMODAL — Lecture des pièces jointes pour l'extraction.
 *
 * Par fichier (ordre du message conservé, identifié par l'id de pièce), une issue :
 * - PDF à couche texte → extrait texte (unpdf)
 * - PDF sans couche texte → bloc `document` vision (si vision active) sinon ignoré
 * - .xlsx → extrait texte (exceljs, valeurs uniquement) si lecture PJ étendue active
 * - JPEG/PNG (signature magique, même déclarés octet-stream) → bloc `image` si vision active
 * - HEIC/HEIF → ignoré explicitement (aucune conversion)
 * - autre → ignoré (format)
 *
 * Jamais d'exception. Toutes les entrées sont des données non fiables.
 * Échéance globale respectée : au-delà, les pièces restantes sont « FAILED (DEADLINE) ».
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

/**
 * Plafonds vision. Anthropic limite chaque image à 5 Mo — limite appliquée ici
 * sur la taille ENCODÉE base64 (ceil(n/3)*4), et par prudence aussi aux documents
 * PDF. Budget total encodé 20 Mo (requête API ≤ 32 Mo).
 */
export const MAX_VISUAL_FILES = 5
export const MAX_VISUAL_BASE64_BYTES = 5 * 1024 * 1024
export const MAX_VISUAL_TOTAL_BASE64_BYTES = 20 * 1024 * 1024
export const MAX_VISUAL_PDF_PAGES = 10
export const MAX_VISUAL_IMAGE_DIMENSION = 8_000
/** Au-delà, les octets ne sont pas lus (plafond lecture texte PDF/xlsx inclus). */
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024
const MAX_OUTCOMES = 50
/** Bornes mémoire du chargement des octets (avant lecture). */
export const MAX_LOADED_VISUAL_CANDIDATES = 2 * MAX_VISUAL_FILES
export const MAX_TOTAL_LOADED_BYTES = 60 * 1024 * 1024

export function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

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
  /** Id de la pièce (clé d'association ; les noms de fichier peuvent être homonymes). */
  attachmentId?: string
  filename: string
  kind: AttachmentReadKind
  outcome: AttachmentReadOutcomeCode
  /** Code machine court (jamais de texte libre issu du fichier). */
  reason?: string
}

/** FLAG_OFF / AUTO_CONTEXT : désactivation attendue, aucun avertissement bruyant. */
export type VisionDisabledReason = "FLAG_OFF" | "PROVIDER_NOT_VISION" | "AUTO_CONTEXT"

export type AttachmentForReading = {
  id?: string
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
  attachmentId?: string
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
  /**
   * Lecture PJ étendue (.xlsx). false = comportement historique (PDF texte seul).
   * Défaut : true (tests unitaires) ; le service passe le flag explicitement.
   */
  xlsxEnabled?: boolean
  /** Échéance absolue (ms epoch). */
  deadlineAt?: number
  now?: () => number
}

function kindLabel(k: AttachmentFileKind): AttachmentReadKind {
  return k.kind === "unsupported" ? "other" : k.kind
}

function isOctetStream(mimeType: string): boolean {
  return (mimeType || "").toLowerCase().startsWith("application/octet-stream")
}

/**
 * Lisibilité potentielle d'après les métadonnées seules (avant claim).
 * Une pièce STORED d'un format supporté ; xlsx si lecture étendue ; images
 * (et octet-stream) seulement si vision active.
 */
export function isPotentiallyReadableAttachment(
  meta: { filename: string; mimeType: string; status: string; storagePublicId?: string | null },
  opts: { visionEnabled: boolean; xlsxEnabled?: boolean }
): boolean {
  if (meta.status !== "STORED") return false
  if (meta.storagePublicId !== undefined && !meta.storagePublicId?.trim()) return false
  const kind = guessAttachmentKindFromMeta(meta)
  if (kind.kind === "pdf") return true
  if (kind.kind === "xlsx") return opts.xlsxEnabled !== false
  if (kind.kind === "image") return opts.visionEnabled
  if (kind.kind === "unsupported" && isOctetStream(meta.mimeType)) return opts.visionEnabled
  return false
}

/** Faut-il charger les octets de cette pièce ? (évite les téléchargements inutiles). */
export function shouldLoadAttachmentBytes(
  meta: { filename: string; mimeType: string; status: string; sizeBytes: number },
  opts: { visionEnabled: boolean; xlsxEnabled?: boolean }
): boolean {
  if (meta.status !== "STORED") return false
  if (Number.isFinite(meta.sizeBytes) && meta.sizeBytes > MAX_READ_FILE_BYTES) return false
  const kind = guessAttachmentKindFromMeta(meta)
  if (kind.kind === "pdf") return true
  if (kind.kind === "xlsx") return opts.xlsxEnabled !== false
  if (kind.kind === "heic") return false
  if (kind.kind === "image") return opts.visionEnabled
  return opts.visionEnabled && isOctetStream(meta.mimeType)
}

/**
 * Plan de chargement des octets, dans l'ordre du message, borné :
 * ≤ 10 candidats visuels (images / octet-stream) et ≤ 60 Mo déclarés au total.
 * "SKIP" = pas besoin de lire ; "BUDGET" = lisible mais hors budget mémoire.
 */
export function planAttachmentLoads(
  metas: Array<{ filename: string; mimeType: string; status: string; sizeBytes: number }>,
  opts: { visionEnabled: boolean; xlsxEnabled?: boolean }
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
  const xlsxEnabled = options.xlsxEnabled !== false
  const now = options.now ?? Date.now
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY

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
    const attachmentId = att.id
    const metaKind = guessAttachmentKindFromMeta(att)
    const record = (o: Omit<AttachmentReadOutcome, "filename" | "attachmentId">) => {
      outcomes.push({ ...(attachmentId ? { attachmentId } : {}), filename, ...o })
      return outcomes.length - 1
    }
    const pdfOutcome = (status: PdfTextExtractStatus) =>
      pdfOutcomes.push({ ...(attachmentId ? { attachmentId } : {}), filename, status })

    if (now() >= deadlineAt) {
      if (metaKind.kind === "pdf") pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: kindLabel(metaKind), outcome: "FAILED", reason: "DEADLINE" })
      continue
    }

    if (att.status !== "STORED") {
      if (metaKind.kind === "pdf") pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: kindLabel(metaKind), outcome: "UNAVAILABLE", reason: `NOT_STORED_${att.status}`.slice(0, 40) })
      continue
    }

    if (metaKind.kind === "heic") {
      record({ kind: "heic", outcome: "IGNORED_HEIC", reason: "HEIC_NOT_SUPPORTED" })
      continue
    }

    if (metaKind.kind === "xlsx" && !xlsxEnabled) {
      record({ kind: "xlsx", outcome: "IGNORED_FORMAT", reason: "XLSX_FLAG_OFF" })
      continue
    }

    if (att.loadSkippedForBudget && !att.bytes) {
      if (metaKind.kind === "pdf") pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: kindLabel(metaKind), outcome: "IGNORED_TOO_LARGE", reason: "LOAD_BUDGET" })
      continue
    }

    if (Number.isFinite(att.sizeBytes) && att.sizeBytes > MAX_READ_FILE_BYTES && !att.bytes) {
      if (metaKind.kind === "pdf") pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: kindLabel(metaKind), outcome: "IGNORED_TOO_LARGE", reason: "FILE_BYTES" })
      continue
    }

    const bytes = att.bytes && att.bytes.byteLength > 0 ? att.bytes : null
    if (!bytes) {
      if (metaKind.kind === "pdf") {
        pdfOutcome("PDF_PARSE_FAILED")
        record({ kind: "pdf", outcome: "UNAVAILABLE", reason: "BYTES_UNAVAILABLE" })
      } else if (metaKind.kind === "xlsx") {
        record({ kind: "xlsx", outcome: "UNAVAILABLE", reason: "BYTES_UNAVAILABLE" })
      } else if (metaKind.kind === "image" || isOctetStream(att.mimeType)) {
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
      if (metaKind.kind === "pdf") pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: "other", outcome: "IGNORED_FORMAT", reason: "SIGNATURE_UNSUPPORTED" })
      continue
    }

    if (kind.kind === "xlsx") {
      if (!xlsxEnabled) {
        record({ kind: "xlsx", outcome: "IGNORED_FORMAT", reason: "XLSX_FLAG_OFF" })
        continue
      }
      const r = await extractXlsxText(bytes, { maxChars: MAX_EXCERPT_CHARS, deadlineAt })
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
      const remaining = Math.max(1, deadlineAt - now())
      const r = await extractPdfTextLayer(bytes, {
        maxChars: MAX_EXCERPT_CHARS,
        timeoutMs: Math.min(PDF_PARSE_TIMEOUT_MS, remaining),
      })
      if ((r.status === "PDF_TEXT_EXTRACTED" || r.status === "PDF_TEXT_TRUNCATED") && r.text) {
        const pushed = pushExcerpt(filename, "application/pdf", r.text, r.truncated)
        pdfOutcome(pushed.pushed && !pushed.truncated ? "PDF_TEXT_EXTRACTED" : "PDF_TEXT_TRUNCATED")
        if (!pushed.pushed) {
          record({ kind: "pdf", outcome: "IGNORED_TOO_LARGE", reason: "TEXT_BUDGET" })
        } else {
          record({ kind: "pdf", outcome: pushed.truncated ? "READ_TEXT_TRUNCATED" : "READ_TEXT" })
        }
        continue
      }
      if (r.status === "PDF_NO_TEXT_LAYER") {
        pdfOutcome("PDF_NO_TEXT_LAYER")
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
      pdfOutcome("PDF_PARSE_FAILED")
      record({ kind: "pdf", outcome: "FAILED", reason: "PDF_PARSE_FAILED" })
      continue
    }

    // Image JPEG / PNG — y compris déclarée application/octet-stream.
    const idx = record({
      kind: "image",
      outcome: "IGNORED_VISION_DISABLED",
      reason: visionOffReason ?? "PENDING",
    })
    if (visionEnabled) {
      candidates.push({ index: idx, filename, kind: "image", mediaType: kind.mediaType, bytes })
    }
  }

  const visuals = await allocateVisualBudget(candidates, outcomes, { now, deadlineAt })
  return { excerpts, visuals, outcomes, pdfOutcomes }
}

/**
 * Attribue le budget vision : PDF scannés d'abord (bons de commande), puis photos,
 * dans l'ordre du message. Tout dépassement → « ignoré (trop gros) », jamais
 * d'échec global de l'extraction.
 */
async function allocateVisualBudget(
  candidates: VisualCandidate[],
  outcomes: AttachmentReadOutcome[],
  clock: { now: () => number; deadlineAt: number }
): Promise<AttachmentVisualInput[]> {
  const ordered = [
    ...candidates.filter((c) => c.kind === "pdf"),
    ...candidates.filter((c) => c.kind === "image"),
  ]
  const visuals: Array<{ index: number; visual: AttachmentVisualInput }> = []
  let totalEncoded = 0

  const ignore = (c: VisualCandidate, outcome: "IGNORED_TOO_LARGE" | "FAILED", reason: string) => {
    outcomes[c.index] = { ...outcomes[c.index], outcome, reason }
  }

  for (const c of ordered) {
    const encoded = base64EncodedLength(c.bytes.byteLength)
    if (encoded > MAX_VISUAL_BASE64_BYTES) {
      ignore(c, "IGNORED_TOO_LARGE", "VISUAL_FILE_BYTES")
      continue
    }
    if (visuals.length >= MAX_VISUAL_FILES) {
      ignore(c, "IGNORED_TOO_LARGE", "MAX_VISUAL_FILES")
      continue
    }
    if (totalEncoded + encoded > MAX_VISUAL_TOTAL_BASE64_BYTES) {
      ignore(c, "IGNORED_TOO_LARGE", "VISUAL_TOTAL_BUDGET")
      continue
    }
    if (c.kind === "pdf") {
      const remaining = clock.deadlineAt - clock.now()
      if (remaining <= 0) {
        ignore(c, "FAILED", "DEADLINE")
        continue
      }
      const pages = await countPdfPages(c.bytes, { timeoutMs: Math.min(PDF_PARSE_TIMEOUT_MS, remaining) })
      if (pages != null && pages > MAX_VISUAL_PDF_PAGES) {
        ignore(c, "IGNORED_TOO_LARGE", "PDF_PAGES")
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
        ignore(c, "IGNORED_TOO_LARGE", "IMAGE_DIMENSIONS")
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
    totalEncoded += encoded
    const prev = outcomes[c.index]
    outcomes[c.index] = {
      ...(prev.attachmentId ? { attachmentId: prev.attachmentId } : {}),
      filename: prev.filename,
      kind: prev.kind,
      outcome: "READ_VISION",
    }
  }

  // Ordre du message conservé pour l'envoi au provider.
  return visuals.sort((a, b) => a.index - b.index).map((v) => v.visual)
}
