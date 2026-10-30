/**
 * Détection du type réel d'un fichier par ses premiers octets — helper partagé
 * (déplacé depuis `src/lib/vehicules/v3/document-domain.ts`, comportement inchangé ; ré-exporté là-bas).
 * Le type déclaré par le client et l'extension ne sont jamais une preuve : seule la signature compte.
 */
export type MagicMime = "application/pdf" | "image/jpeg" | "image/png"

export function detectMagicMime(buffer: Uint8Array): MagicMime | null {
  if (buffer.length < 8) return null
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "application/pdf"
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png"
  return null
}
