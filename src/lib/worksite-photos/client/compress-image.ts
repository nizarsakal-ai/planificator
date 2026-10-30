/**
 * Photos d'engins — compression côté client (SPEC-WORKSITE-PHOTOS-001 §7.1 étape 1, D3).
 * Ré-encode la prise de vue en JPEG (bord long 2048 px, qualité 0,82), avec replis (qualité 0,7 puis 1600 px) pour
 * rester sous le plafond serveur ; l'EXIF disparaît (accepté : la localisation est portée par le chantier).
 * La partie pure (`planCompression`, `targetDimensions`) est testable sans navigateur ; `compressImage` exige le DOM.
 */
export const COMPRESSION_MAX_EDGE = 2048
export const COMPRESSION_QUALITY = 0.82
export const COMPRESSION_FALLBACKS: ReadonlyArray<{ maxEdge: number; quality: number }> = [
  { maxEdge: 2048, quality: 0.82 },
  { maxEdge: 2048, quality: 0.7 },
  { maxEdge: 1600, quality: 0.7 },
]
/** Plafond dur serveur (4 Mio) ; le client vise nettement en dessous. */
export const CLIENT_HARD_MAX_BYTES = 4 * 1024 * 1024

/** Dimensions cibles : réduction proportionnelle au bord long, jamais d'agrandissement, au moins 1 px. */
export function targetDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height))
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const ratio = maxEdge / longest
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) }
}

/** Choisit le premier palier dont la sortie tient sous la borne ; `null` si aucun palier ne convient. */
export function planCompression(attempts: ReadonlyArray<{ maxEdge: number; quality: number; resultBytes: number }>, maxBytes: number): { maxEdge: number; quality: number } | null {
  for (const attempt of attempts) if (attempt.resultBytes > 0 && attempt.resultBytes <= maxBytes) return { maxEdge: attempt.maxEdge, quality: attempt.quality }
  return null
}

export interface CompressedPhoto { blob: Blob; width: number; height: number; quality: number; sha256Hex: string }

export class PhotoCompressionError extends Error {
  constructor(readonly code: "DECODE_FAILED" | "TOO_LARGE_AFTER_COMPRESSION") { super(code); this.name = "PhotoCompressionError" }
}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    // L'orientation EXIF est appliquée au décodage, puis perdue : l'image sortie est déjà « droite ».
    return await createImageBitmap(file, { imageOrientation: "from-image" })
  } catch {
    throw new PhotoCompressionError("DECODE_FAILED")
  }
}

function encode(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob | null> {
  const { width, height } = targetDimensions(bitmap.width, bitmap.height, maxEdge)
  const canvas = document.createElement("canvas")
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return Promise.resolve(null)
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality))
}

export async function sha256HexOf(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Compresse une photo pour l'envoi ; `maxBytes` = plafond serveur (défaut 3 Mio côté client). */
export async function compressImage(file: Blob, maxBytes = 3 * 1024 * 1024): Promise<CompressedPhoto> {
  const bitmap = await decode(file)
  try {
    for (const step of COMPRESSION_FALLBACKS) {
      const blob = await encode(bitmap, step.maxEdge, step.quality)
      if (blob && blob.size > 0 && blob.size <= Math.min(maxBytes, CLIENT_HARD_MAX_BYTES)) {
        const { width, height } = targetDimensions(bitmap.width, bitmap.height, step.maxEdge)
        return { blob, width, height, quality: step.quality, sha256Hex: await sha256HexOf(blob) }
      }
    }
    throw new PhotoCompressionError("TOO_LARGE_AFTER_COMPRESSION")
  } finally {
    bitmap.close()
  }
}
