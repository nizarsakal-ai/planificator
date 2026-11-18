import { MAX_UPLOAD_BYTES, tooLargeMessage } from "@/lib/hr-documents/upload-limit"

/**
 * Préparation d'un fichier avant envoi, côté navigateur : une photo trop lourde (JPG, PNG, HEIC lisible par le
 * navigateur) est réduite en JPEG sous la limite d'envoi ; un fichier qui reste trop lourd (PDF notamment, jamais
 * réécrit ici) est refusé avant toute requête, avec la marche à suivre. Un fichier sous la limite part tel quel.
 */
export type Prepared = { ok: true; file: File; reduced: boolean } | { ok: false; error: string }

/** Encodage injectable (tests) : image décodée → JPEG à la taille et qualité demandées ; null si indécodable. */
export type ImageEncoder = (file: File, longSide: number, quality: number) => Promise<Blob | null>

const IMAGE = /^image\/(jpeg|png|heic|heif)$/i
const IMAGE_EXT = /\.(jpe?g|png|heic|heif)$/i
/** Paliers du plus fidèle au plus compact : un document reste lisible à 2000 px de grand côté. */
export const SHRINK_STEPS: readonly { longSide: number; quality: number }[] = [
  { longSide: 3200, quality: 0.85 }, { longSide: 2600, quality: 0.8 }, { longSide: 2000, quality: 0.75 }, { longSide: 1600, quality: 0.7 },
]

export function isImage(file: File): boolean { return IMAGE.test(file.type) || IMAGE_EXT.test(file.name) }

export async function prepareUpload(file: File, encode: ImageEncoder = canvasEncoder, limit = MAX_UPLOAD_BYTES): Promise<Prepared> {
  if (file.size <= limit) return { ok: true, file, reduced: false }
  if (isImage(file)) {
    for (const step of SHRINK_STEPS) {
      const blob = await encode(file, step.longSide, step.quality).catch(() => null)
      if (!blob) break
      if (blob.size <= limit) {
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg"
        return { ok: true, file: new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified }), reduced: true }
      }
    }
  }
  return { ok: false, error: tooLargeMessage(file.name, file.size) }
}

/** Décodage par le navigateur (createImageBitmap, orientation EXIF appliquée), réduction, puis JPEG via canvas. */
export const canvasEncoder: ImageEncoder = async (file, longSide, quality) => {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null)
  if (!bitmap) return null
  try {
    const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext("2d")
    if (!context) return null
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality))
  } finally { bitmap.close() }
}
