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

import { createHash } from "node:crypto"
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

/** Route d'affichage du logo géré dans la coquille du tableau de bord (voir `companyLogoDisplaySrc`). */
export const COMPANY_LOGO_DISPLAY_PATH = "/api/company/logo/affichage"

/**
 * Adresse d'AFFICHAGE du logo géré dans la coquille (avatar de la barre supérieure, bandeau société) : adresse courte
 * versionnée par l'empreinte du logo, au lieu de la data URL elle-même.
 *
 * Correctif #418 (18/11/2026) : la data URL (jusqu'à ~800 Ko) passait dans la charge RSC de la coquille (props de
 * `Sidebar`, `MobileNav`, `AvatarImage`, `CompanyBrand`). Le serveur Flight de React 19.2 compte la longueur de chaque
 * chaîne et DIFFÈRE tout élément rencontré au-delà de 3 200 caractères (`deferTask`, « $L ») : la colonne de la coquille
 * devenait un nœud paresseux, servi derrière plusieurs centaines de Ko. Lorsque l'hydratation (scripts en cache) atteignait
 * le `div[data-app-backdrop]` avant ce morceau, le div se suspendait puis était rejoué sans restauration du curseur
 * d'hydratation (`replaySuspendedUnitOfWork`) : erreur #418. Le rendu visuel est inchangé ; la data URL reste la source
 * des PDF (`logoForPdf`). `null` dans les mêmes cas que `logoForPdf` (aucun logo géré : rien n'est affiché).
 */
export function companyLogoDisplaySrc(logoUrl: string | null | undefined): string | null {
  const version = companyLogoVersion(logoUrl)
  return version === null ? null : `${COMPANY_LOGO_DISPLAY_PATH}?v=${version}`
}

/** Version d'affichage du logo géré : 16 premiers caractères hexadécimaux du sha256 de la data URL ; `null` sans logo géré.
 *  La route d'affichage ne sert le logo de la société de session que si la version demandée est exactement celle-ci. */
export function companyLogoVersion(logoUrl: string | null | undefined): string | null {
  if (!isManagedLogo(logoUrl)) return null
  return createHash("sha256").update(logoUrl as string).digest("hex").slice(0, 16)
}
