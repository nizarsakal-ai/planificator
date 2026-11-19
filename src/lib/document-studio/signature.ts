/**
 * Lot G Planificator V2 : signature manuscrite du valideur (second administrateur) d'un document généré.
 *
 * Analyseur LOCAL au lot G (portage sur ef36578f, 19/11/2026) : la version du 04/11 réutilisait `parseSignature` du lot D
 * (réserves), absent de cette base. Le pavé de signature V1 (`components/planning/SignaturePad`) est couplé à l'émargement
 * des affectations et n'est pas modifié. Mêmes règles que la v6 : URL de données PNG base64 stricte, octets décodés bornés
 * (100 à 300 000), signature binaire PNG vérifiée, empreinte SHA-256 des octets. Les octets ne sont lus que par l'action de
 * validation et le PDF ; aucune image n'est renvoyée dans les propriétés des pages.
 */
import { sha256Hex } from "@/lib/document-studio/canonical"

export const STUDIO_SIGNATURE_MIN_BYTES = 100
export const STUDIO_SIGNATURE_MAX_BYTES = 300_000
/** Longueur maximale de l'URL de données acceptée du formulaire (base64 de 300 000 octets + préfixe, arrondi). */
export const STUDIO_SIGNATURE_MAX_CHARS = 2_000_000
export const STUDIO_SIGNATURE_ERROR = "Signature du valideur absente ou invalide : signez dans le cadre."

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/

export const isPng = (b: Uint8Array): boolean => b.length >= PNG_MAGIC.length && PNG_MAGIC.every((v, i) => b[i] === v)

export type SignatureResult = { ok: true; value: { png: Buffer; sha256: string } } | { ok: false; error: string }

/** Signature dessinée : URL de données PNG (base64) → octets PNG vérifiés (signature binaire, taille) et empreinte. */
export function parseStudioSignature(dataUrl: string | null | undefined): SignatureResult {
  const raw = (dataUrl ?? "").trim()
  if (raw.length > STUDIO_SIGNATURE_MAX_CHARS) return { ok: false, error: STUDIO_SIGNATURE_ERROR }
  const m = DATA_URL.exec(raw)
  if (!m) return { ok: false, error: STUDIO_SIGNATURE_ERROR }
  const png = Buffer.from(m[1], "base64")
  if (png.length < STUDIO_SIGNATURE_MIN_BYTES || png.length > STUDIO_SIGNATURE_MAX_BYTES || !isPng(png)) return { ok: false, error: STUDIO_SIGNATURE_ERROR }
  return { ok: true, value: { png, sha256: sha256Hex(png) } }
}
