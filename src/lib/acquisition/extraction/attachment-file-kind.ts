/**
 * PLAN-ACQ-MULTIMODAL — Détection du type réel d'une pièce jointe pour l'extraction.
 *
 * Deux niveaux :
 * - `guessAttachmentKindFromMeta` : métadonnées seules (MIME déclaré + extension),
 *   utilisé AVANT claim pour décider si une pièce est potentiellement lisible.
 * - `sniffAttachmentKind` : signature magique sur les octets (autorité finale).
 *   PDF, JPEG, PNG, HEIC/HEIF, ZIP .xlsx ; tout le reste = non pris en charge.
 *   Un JPEG déclaré `application/octet-stream` est reconnu ici.
 *
 * Aucune dépendance Prisma / provider. Pure.
 */

/**
 * Seuls JPEG et PNG : ce sont les seules images que la politique de téléchargement
 * (attachment-policy) laisse stocker. WebP / GIF ne sont jamais STORED → non gérés.
 */
export type AttachmentImageMediaType = "image/jpeg" | "image/png"

export type AttachmentFileKind =
  | { kind: "pdf" }
  | { kind: "xlsx" }
  | { kind: "image"; mediaType: AttachmentImageMediaType }
  | { kind: "heic" }
  | { kind: "unsupported" }

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

function extensionOf(filename: string): string {
  const trimmed = (filename || "").trim().toLowerCase()
  const dot = trimmed.lastIndexOf(".")
  if (dot <= 0 || dot === trimmed.length - 1) return ""
  return trimmed.slice(dot)
}

function normalizedMime(mimeType: string): string {
  return (mimeType || "").toLowerCase().split(";")[0].trim()
}

const IMAGE_EXT_TO_MEDIA: Record<string, AttachmentImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
}

const IMAGE_MIMES = new Set<string>(["image/jpeg", "image/png"])

/**
 * Estimation par métadonnées (MIME déclaré + extension). Jamais suffisante seule
 * pour envoyer des octets à un provider : `sniffAttachmentKind` fait foi.
 */
export function guessAttachmentKindFromMeta(meta: {
  filename: string
  mimeType: string
}): AttachmentFileKind {
  const mime = normalizedMime(meta.mimeType)
  const ext = extensionOf(meta.filename)

  if (mime === "application/pdf" || ext === ".pdf") return { kind: "pdf" }
  if (mime === XLSX_MIME || ext === ".xlsx") return { kind: "xlsx" }
  if (mime === "image/heic" || mime === "image/heif" || ext === ".heic" || ext === ".heif") {
    return { kind: "heic" }
  }
  if (IMAGE_MIMES.has(mime)) return { kind: "image", mediaType: mime as AttachmentImageMediaType }
  const fromExt = IMAGE_EXT_TO_MEDIA[ext]
  if (fromExt) return { kind: "image", mediaType: fromExt }
  return { kind: "unsupported" }
}

function startsWithAscii(buf: Uint8Array, offset: number, ascii: string): boolean {
  if (buf.length < offset + ascii.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

/**
 * Type réel par signature magique. L'extension/MIME ne servent qu'à départager
 * un conteneur ZIP (seul `.xlsx` est accepté comme tableur).
 */
export function sniffAttachmentKind(
  bytes: Uint8Array,
  meta: { filename: string; mimeType: string }
): AttachmentFileKind {
  if (!bytes || bytes.length < 4) return { kind: "unsupported" }

  if (startsWithAscii(bytes, 0, "%PDF-")) return { kind: "pdf" }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mediaType: "image/jpeg" }
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    startsWithAscii(bytes, 1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: "image", mediaType: "image/png" }
  }
  if (bytes.length >= 12 && startsWithAscii(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase()
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return { kind: "heic" }
    }
    return { kind: "unsupported" }
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const ext = extensionOf(meta.filename)
    const mime = normalizedMime(meta.mimeType)
    if (ext === ".xlsx" || (mime === XLSX_MIME && ext !== ".xlsm")) return { kind: "xlsx" }
    return { kind: "unsupported" }
  }
  return { kind: "unsupported" }
}

/**
 * Dimensions d'image lues dans l'en-tête (PNG, JPEG).
 * null si non mesurable — l'appelant décide (pas de décodage complet).
 */
export function readImageDimensions(
  bytes: Uint8Array,
  mediaType: AttachmentImageMediaType
): { width: number; height: number } | null {
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (mediaType === "image/png") {
      if (buf.length < 24 || !startsWithAscii(buf, 12, "IHDR")) return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // JPEG : parcours des segments jusqu'au SOFn.
    let p = 2
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null
      const marker = buf[p + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2
        continue
      }
      const len = buf.readUInt16BE(p + 2)
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) }
      }
      if (len < 2) return null
      p += 2 + len
    }
    return null
  } catch {
    return null
  }
}
