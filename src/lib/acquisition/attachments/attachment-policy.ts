import type { AttachmentDownloadErrorCode } from "@/lib/acquisition/attachments/attachment.types"

/** 25 MiB par défaut — surcharge via ACQUISITION_ATTACHMENT_MAX_BYTES. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

export function getAttachmentMaxBytes(): number {
  const raw = process.env.ACQUISITION_ATTACHMENT_MAX_BYTES
  if (!raw) return DEFAULT_ATTACHMENT_MAX_BYTES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ATTACHMENT_MAX_BYTES
  return parsed
}

/** Feature flag dédié — inactif par défaut (PLAN-ACQ-004). */
export function isAttachmentDownloadEnabled(): boolean {
  return process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED === "true"
}

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
])

const CAD_EXTENSIONS = new Set([".dwg", ".dxf"])

const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".sh",
  ".bash",
  ".ps1",
  ".vbs",
  ".html",
  ".htm",
  ".svg",
  ".php",
  ".jar",
  ".app",
])

export interface AttachmentValidationInput {
  filename: string
  declaredMimeType: string
  buffer: Buffer
}

export interface AttachmentValidationResult {
  allowed: boolean
  resolvedMimeType: string
  errorCode?: AttachmentDownloadErrorCode
}

function extensionOf(filename: string): string {
  const trimmed = filename.trim()
  if (!trimmed) return ""
  const dot = trimmed.lastIndexOf(".")
  if (dot <= 0 || dot === trimmed.length - 1) return ""
  return trimmed.slice(dot).toLowerCase()
}

function hasBlockedExtension(filename: string): boolean {
  const ext = extensionOf(filename)
  if (!ext) return true
  return BLOCKED_EXTENSIONS.has(ext)
}

function detectMagicMime(buffer: Buffer): string | null {
  if (buffer.length < 4) return null

  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf"
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
    return "image/png"

  if (buffer.length >= 12) {
    const boxType = buffer.subarray(4, 8).toString("ascii")
    if (boxType === "ftyp") {
      const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase()
      if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic"
      if (brand === "mif1" || brand === "msf1") return "image/heif"
    }
  }

  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05))
    return "application/zip"

  const headAscii = buffer.subarray(0, Math.min(buffer.length, 32)).toString("ascii").toLowerCase()
  if (headAscii.startsWith("<!doctype") || headAscii.startsWith("<html") || headAscii.startsWith("<svg"))
    return "text/html"
  if (headAscii.startsWith("#!/")) return "application/x-shellscript"
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return "application/x-msdownload"

  return null
}

function isCadOctetStream(filename: string, buffer: Buffer): boolean {
  const ext = extensionOf(filename)
  if (!CAD_EXTENSIONS.has(ext)) return false
  if (ext === ".dwg") {
    const head = buffer.subarray(0, 4).toString("ascii")
    return head.startsWith("AC10")
  }
  if (ext === ".dxf") {
    const head = buffer.subarray(0, 32).toString("ascii").trimStart()
    return head.startsWith("0") || head.startsWith("999")
  }
  return false
}

function zipLooksLikeOffice(filename: string): boolean {
  const ext = extensionOf(filename)
  return ext === ".docx" || ext === ".xlsx"
}

/**
 * Validation combinée MIME déclaré + extension + signature magique.
 * Ne fait confiance à aucune source seule.
 */
export function validateAttachmentContent(
  input: AttachmentValidationInput
): AttachmentValidationResult {
  const filename = input.filename.trim()
  if (!filename || hasBlockedExtension(filename)) {
    return { allowed: false, resolvedMimeType: input.declaredMimeType, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
  }

  const declared = input.declaredMimeType.toLowerCase().split(";")[0].trim()
  const magic = detectMagicMime(input.buffer)
  const ext = extensionOf(filename)

  if (magic === "text/html" || magic === "application/x-shellscript" || magic === "application/x-msdownload") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
  }

  if (declared === "application/octet-stream") {
    if (isCadOctetStream(filename, input.buffer)) {
      return { allowed: true, resolvedMimeType: "application/octet-stream" }
    }
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
  }

  if (!ALLOWED_MIME_TYPES.has(declared)) {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
  }

  if (!magic) {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }

  if (magic === "text/html" || magic === "application/x-shellscript" || magic === "application/x-msdownload") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
  }

  if (declared === "application/zip") {
    if (magic !== "application/zip") {
      return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
    }
    if (zipLooksLikeOffice(filename)) {
      return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
    }
    return { allowed: true, resolvedMimeType: declared }
  }

  const compatible =
    magic === declared ||
    (declared === "image/heif" && magic === "image/heic") ||
    (declared === "image/heic" && magic === "image/heif") ||
    (declared.startsWith("application/vnd.openxmlformats") && magic === "application/zip")

  if (!compatible) {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }

  if (declared === "application/pdf" && ext !== ".pdf") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }
  if (declared === "image/jpeg" && ext !== ".jpg" && ext !== ".jpeg") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }
  if (declared === "image/png" && ext !== ".png") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }
  if (declared.startsWith("application/vnd.openxmlformats") && ext !== ".docx" && ext !== ".xlsx") {
    return { allowed: false, resolvedMimeType: declared, errorCode: "ATTACHMENT_SIGNATURE_MISMATCH" }
  }

  return { allowed: true, resolvedMimeType: declared }
}

export function decodeBase64Url(data: string): Buffer {
  if (!data || typeof data !== "string") {
    throw new Error("ATTACHMENT_DECODE_FAILED")
  }
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/")
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + "=".repeat(padLength)
  return Buffer.from(padded, "base64")
}

export function generateStorageFilename(attachmentId: string, sha256: string, ext: string): string {
  const safeExt = ext.startsWith(".") ? ext.slice(1) : ext
  return `${attachmentId}-${sha256.slice(0, 16)}.${safeExt || "bin"}`
}

export function extensionFromFilename(filename: string): string {
  return extensionOf(filename) || ".bin"
}
