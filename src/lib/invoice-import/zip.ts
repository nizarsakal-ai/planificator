// SPEC-INVOICE-IMPORT-001 §3 — lecteur ZIP minimal, en mémoire, borné (aucune dépendance : zlib natif).
// Lit le répertoire central (fiable même avec descripteurs de données), ne décompresse que STORE (0) et DEFLATE (8).
// Refus : ZIP chiffré, zip64, entrées trop nombreuses/volumineuses, ratio de décompression anormal (bombe), noms suspects.
// Aucun fichier n'est écrit sur disque : les noms ne servent qu'à l'association CSV ↔ PDF.
import { inflateRawSync } from "node:zlib"

export interface ZipEntry { name: string; data: Buffer }
export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxRatio: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 500, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 200 }

export class ZipError extends Error {
  constructor(readonly code: "ZIP_INVALID" | "ZIP_ENCRYPTED" | "ZIP64_UNSUPPORTED" | "ZIP_TOO_MANY_ENTRIES" | "ZIP_ENTRY_TOO_LARGE" | "ZIP_TOO_LARGE" | "ZIP_METHOD_UNSUPPORTED", message: string) {
    super(message)
    this.name = "ZipError"
  }
}

export const EOCD_SIG = 0x06054b50
export const CEN_SIG = 0x02014b50
export const LOC_SIG = 0x04034b50

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG
}

function findEocd(buf: Buffer): number {
  // L'EOCD fait 22 octets + commentaire (≤ 65 535) : recherche à rebours bornée.
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i
  return -1
}

/** Nom d'entrée ramené à son dernier segment ; entrées de métadonnées macOS/dossiers ignorées par l'appelant (null). */
function cleanName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/")
  if (name.endsWith("/")) return null
  const segments = name.split("/")
  if (segments.some((s) => s === "__MACOSX") || segments[segments.length - 1].startsWith("._")) return null
  const base = segments[segments.length - 1].replace(/[\u0000-\u001f]/g, "").slice(0, 200)
  return base || null
}

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new ZipError("ZIP_INVALID", "Archive ZIP illisible.")
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError("ZIP64_UNSUPPORTED", "Archive ZIP64 non prise en charge.")
  if (total > limits.maxEntries) throw new ZipError("ZIP_TOO_MANY_ENTRIES", `Archive trop volumineuse (${total} fichiers, maximum ${limits.maxEntries}).`)
  if (cdOffset + cdSize > buf.length) throw new ZipError("ZIP_INVALID", "Archive ZIP tronquée.")

  const out: ZipEntry[] = []
  let p = cdOffset
  let sum = 0
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError("ZIP_INVALID", "Répertoire de l'archive corrompu.")
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const utf8 = (flags & 0x0800) !== 0
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(utf8 ? "utf8" : "latin1")
    p += 46 + nameLen + extraLen + commentLen

    const name = cleanName(rawName)
    if (!name) continue
    if (flags & 0x0001) throw new ZipError("ZIP_ENCRYPTED", "Archive protégée par mot de passe : non prise en charge.")
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64_UNSUPPORTED", "Archive ZIP64 non prise en charge.")
    if (size > limits.maxEntryBytes) throw new ZipError("ZIP_ENTRY_TOO_LARGE", `« ${name} » dépasse ${Math.round(limits.maxEntryBytes / 1024 / 1024)} Mo.`)
    if (compSize > 0 && size / compSize > limits.maxRatio) throw new ZipError("ZIP_TOO_LARGE", `« ${name} » : taux de compression anormal.`)
    sum += size
    if (sum > limits.maxTotalBytes) throw new ZipError("ZIP_TOO_LARGE", "Contenu décompressé de l'archive trop volumineux.")

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new ZipError("ZIP_INVALID", "Entrée de l'archive corrompue.")
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    if (start + compSize > buf.length) throw new ZipError("ZIP_INVALID", "Entrée de l'archive tronquée.")
    const comp = buf.subarray(start, start + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(comp)
    else if (method === 8) {
      try {
        // maxOutputLength borne la décompression même si la taille déclarée ment.
        data = inflateRawSync(comp, { maxOutputLength: Math.max(1, size) })
      } catch {
        throw new ZipError("ZIP_INVALID", `« ${name} » : décompression impossible.`)
      }
    } else throw new ZipError("ZIP_METHOD_UNSUPPORTED", `« ${name} » : méthode de compression non prise en charge.`)
    if (data.length !== size) throw new ZipError("ZIP_INVALID", `« ${name} » : taille incohérente.`)
    out.push({ name, data })
  }
  return out
}
