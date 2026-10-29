/**
 * Logo d'entreprise (réglages « Identité et documents ») — validation et normalisation côté serveur.
 *
 * Choix (mission du 29/10/2026, point A) : le logo est stocké sous forme de data URL PNG dans
 * `Company.logoUrl` (colonne existante, aucune migration), après validation du TYPE RÉEL du fichier par
 * `sharp` (en-tête binaire, pas l'extension ni le `Content-Type` déclaré), redimensionnement borné et
 * ré-encodage PNG (toute charge utile non image est éliminée). Isolation : la ligne `companies` de la
 * session uniquement ; le rendu PDF embarque la data URL sans accès réseau. Les URL externes historiques
 * (`http(s)`) restent affichables mais ne sont ni téléchargeables ni embarquées par cette voie.
 */

import sharp from "sharp"

export const LOGO_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // 2 Mio
export const LOGO_MAX_STORED_BYTES = 600 * 1024 // PNG normalisé
export const LOGO_MIN_SIDE_PX = 32
export const LOGO_MAX_WIDTH_PX = 1200
export const LOGO_MAX_HEIGHT_PX = 480
export const LOGO_ACCEPTED_FORMATS = ["png", "jpeg", "webp"] as const
export const LOGO_DATA_URL_PREFIX = "data:image/png;base64,"

export type LogoNormalization =
  | { ok: true; dataUrl: string; width: number; height: number; bytes: number; sourceFormat: string }
  | { ok: false; error: string }

export async function normalizeCompanyLogo(input: Buffer): Promise<LogoNormalization> {
  if (input.length === 0) return { ok: false, error: "Fichier vide." }
  if (input.length > LOGO_MAX_UPLOAD_BYTES) return { ok: false, error: "Fichier trop volumineux (2 Mo maximum)." }
  let meta: sharp.Metadata
  try {
    meta = await sharp(input, { limitInputPixels: 25_000_000, animated: false }).metadata()
  } catch {
    return { ok: false, error: "Format non reconnu : le fichier n'est pas une image PNG, JPEG ou WebP." }
  }
  const format = meta.format ?? ""
  if (!(LOGO_ACCEPTED_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, error: `Format non accepté (${format || "inconnu"}) : PNG, JPEG ou WebP attendu.` }
  }
  if (!meta.width || !meta.height || meta.width < LOGO_MIN_SIDE_PX || meta.height < LOGO_MIN_SIDE_PX) {
    return { ok: false, error: `Image trop petite (${LOGO_MIN_SIDE_PX} px minimum par côté).` }
  }
  let out: Buffer
  let info: sharp.OutputInfo
  try {
    const r = await sharp(input, { limitInputPixels: 25_000_000, animated: false })
      .rotate()
      .resize({ width: LOGO_MAX_WIDTH_PX, height: LOGO_MAX_HEIGHT_PX, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true })
    out = r.data
    info = r.info
  } catch {
    return { ok: false, error: "Image illisible ou corrompue." }
  }
  if (out.length > LOGO_MAX_STORED_BYTES) return { ok: false, error: "Logo trop lourd après normalisation (600 Ko maximum) : réduisez l'image." }
  return { ok: true, dataUrl: `${LOGO_DATA_URL_PREFIX}${out.toString("base64")}`, width: info.width, height: info.height, bytes: out.length, sourceFormat: format }
}

/** Décode une data URL PNG produite par `normalizeCompanyLogo` ; `null` pour toute autre valeur (URL externe, autre type). */
export function logoDataUrlToPng(logoUrl: string | null | undefined): Buffer | null {
  if (!logoUrl || !logoUrl.startsWith(LOGO_DATA_URL_PREFIX)) return null
  const b64 = logoUrl.slice(LOGO_DATA_URL_PREFIX.length)
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null
  const buf = Buffer.from(b64, "base64")
  // Signature PNG
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 ? buf : null
}

export function isManagedLogo(logoUrl: string | null | undefined): boolean {
  return logoDataUrlToPng(logoUrl) !== null
}

/** Valeur embarquable dans un PDF (data URL PNG gérée) ; les URL externes ne sont pas embarquées (pas d'accès réseau au rendu). */
export function logoForPdf(logoUrl: string | null | undefined): string | null {
  return isManagedLogo(logoUrl) ? (logoUrl as string) : null
}
