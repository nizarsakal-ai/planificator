/**
 * Fixtures entièrement synthétiques pour la recette fournisseurs réels Véhicules V3.
 * Aucune dépendance réseau ni binaire natif : PNG encodé à la main (zlib Node), PDF texte et
 * PDF image-seule construits octet par octet. Contenu déterministe (pas d'horodatage) pour que
 * les empreintes SHA-256 soient reproductibles d'une exécution à l'autre.
 *
 * Deux adresses connues, fictives mais plausibles, servent d'oracle pour l'OCR et pour
 * l'extraction déterministe (`extractAddressLines`).
 */
import { deflateSync } from "node:zlib"
import { createHash } from "node:crypto"

export interface KnownAddress {
  label: string
  /** Adresse telle qu'imprimée dans les fixtures (ASCII, sans accent pour la police bitmap). */
  address: string
  /** Jetons que toute lecture correcte doit contenir (numéro, code postal, ville). */
  tokens: string[]
}

/** Mots génériques exclus de l'oracle : une lecture correcte doit contenir tout le reste (numéro, nom de voie, code postal, ville). */
const ADDRESS_STOP_WORDS = new Set(["rue", "avenue", "av", "boulevard", "bd", "route", "chemin", "place", "allee", "impasse", "de", "du", "des", "la", "le", "les", "l", "d", "et", "france"])

export const normalizeAddressText = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** Construit un oracle à partir d'une adresse en clair (fixture générée ou fournie via --expect-address). */
export function knownAddressFromText(address: string, label?: string): KnownAddress {
  const tokens = normalizeAddressText(address).split(" ").filter(token => token.length > 0 && !ADDRESS_STOP_WORDS.has(token))
  if (tokens.length < 2 || !tokens.some(token => /^\d/.test(token))) throw new Error("KNOWN_ADDRESS_TOO_WEAK")
  return { label: label ?? address.slice(0, 40), address, tokens }
}

export const KNOWN_ADDRESSES: readonly KnownAddress[] = [
  knownAddressFromText("12 RUE DE LA PAIX 75002 PARIS", "Depot"),
  knownAddressFromText("45 AVENUE JEAN JAURES 69007 LYON", "Chantier"),
]

export const FIXTURE_TITLE = "ADRESSES DE LIVRAISON - RECETTE SYNTHETIQUE"

export const FIXTURE_LINES: readonly string[] = [
  FIXTURE_TITLE,
  `1. ${KNOWN_ADDRESSES[0].address}`,
  `2. ${KNOWN_ADDRESSES[1].address}`,
]

/* ------------------------------------------------------------------ police bitmap 5x7 */

const GLYPHS: Record<string, readonly string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", "#    ", "#    ", " ####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ####", "#    ", "#    ", "# ###", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
  J: ["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
  ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
  ",": ["     ", "     ", "     ", "     ", " ##  ", " ##  ", "#    "],
  ":": ["     ", " ##  ", " ##  ", "     ", " ##  ", " ##  ", "     "],
  "'": [" ##  ", " ##  ", "  #  ", "     ", "     ", "     ", "     "],
  "/": ["    #", "    #", "   # ", "  #  ", " #   ", "#    ", "#    "],
}

export interface GrayBitmap {
  width: number
  height: number
  /** Un octet par pixel, 0 = noir, 255 = blanc, lignes de haut en bas. */
  pixels: Uint8Array
}

export interface RenderOptions {
  /** Facteur d'agrandissement d'un pixel de police (défaut 5 → glyphe 25x35 px). */
  scale?: number
  margin?: number
}

/** Rasterise des lignes de texte (majuscules ASCII) en bitmap niveaux de gris, sans dépendance. */
export function renderTextBitmap(lines: readonly string[], options: RenderOptions = {}): GrayBitmap {
  const scale = options.scale ?? 5
  const margin = options.margin ?? 24
  const cellW = 6, cellH = 9 // 5x7 glyphe + espacement
  const longest = Math.max(1, ...lines.map(line => line.length))
  const width = margin * 2 + longest * cellW * scale
  const height = margin * 2 + lines.length * cellH * scale
  const pixels = new Uint8Array(width * height).fill(255)
  lines.forEach((line, row) => {
    const chars = line.toUpperCase().split("")
    chars.forEach((char, col) => {
      const glyph = GLYPHS[char] ?? GLYPHS["?"] ?? GLYPHS[" "]
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== "#") continue
        const x0 = margin + (col * cellW + gx) * scale
        const y0 = margin + (row * cellH + gy) * scale
        for (let dy = 0; dy < scale; dy++) {
          const offset = (y0 + dy) * width + x0
          pixels.fill(0, offset, offset + scale)
        }
      }
    })
  })
  return { width, height, pixels }
}

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc])
}

/** Encode un bitmap gris 8 bits en PNG (type couleur 0, filtre 0 par ligne). */
export function encodePng(bitmap: GrayBitmap): Buffer {
  const { width, height, pixels } = bitmap
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ])
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || view.subarray(12, 16).toString("ascii") !== "IHDR") return null
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ PDF */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

/** Assemble des objets PDF numérotés 1..n avec table xref exacte (compatible pdf.js/unpdf). */
function assemblePdf(objects: Buffer[], rootRef = "1 0 R"): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")]
  const offsets: number[] = []
  let position = parts[0].length
  objects.forEach((body, index) => {
    offsets.push(position)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")])
    parts.push(chunk)
    position += chunk.length
  })
  const xrefOffset = position
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`)].join("")
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${rootRef} >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1"))
  return Buffer.concat(parts)
}

function streamObject(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")])
}

/** PDF une page, texte Helvetica réel : l'extraction déterministe doit trouver les adresses sans OCR. */
export function buildTextPdf(lines: readonly string[] = FIXTURE_LINES): Buffer {
  const content = ["BT", "/F1 14 Tf", "16 TL", "50 780 Td", ...lines.map((line, i) => `${i ? "T* " : ""}(${pdfEscape(line)}) Tj`), "ET"].join("\n")
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "latin1"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"),
    streamObject("", Buffer.from(content, "latin1")),
  ])
}

/** PDF une page contenant uniquement une image (aucun opérateur texte) : force la voie OCR du PDF. */
export function buildImageOnlyPdf(bitmap: GrayBitmap): Buffer {
  const pageW = 595, pageH = 842
  const drawW = Math.min(pageW - 40, bitmap.width)
  const drawH = Math.round(drawW * bitmap.height / bitmap.width)
  const x = Math.round((pageW - drawW) / 2), y = pageH - 60 - drawH
  const content = `q\n${drawW} 0 0 ${drawH} ${x} ${y} cm\n/Im0 Do\nQ`
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`, "latin1"),
    streamObject(`/Type /XObject /Subtype /Image /Width ${bitmap.width} /Height ${bitmap.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(Buffer.from(bitmap.pixels), { level: 9 })),
    streamObject("", Buffer.from(content, "latin1")),
  ])
}

/* ------------------------------------------------------------------ jeu complet */

export interface SyntheticFixtures {
  bitmap: GrayBitmap
  png: Buffer
  textPdf: Buffer
  imagePdf: Buffer
  /** Octets différents pour prouver qu'une clé existante n'est jamais réécrite. */
  tamperedPng: Buffer
  sha256: { png: string; textPdf: string; imagePdf: string; tamperedPng: string }
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function buildSyntheticFixtures(): SyntheticFixtures {
  const bitmap = renderTextBitmap(FIXTURE_LINES)
  const png = encodePng(bitmap)
  const textPdf = buildTextPdf()
  const imagePdf = buildImageOnlyPdf(bitmap)
  const tamperedPng = encodePng(renderTextBitmap(["CONTENU MODIFIE - NE DOIT JAMAIS REMPLACER L'ORIGINAL"]))
  return { bitmap, png, textPdf, imagePdf, tamperedPng, sha256: { png: sha256Hex(png), textPdf: sha256Hex(textPdf), imagePdf: sha256Hex(imagePdf), tamperedPng: sha256Hex(tamperedPng) } }
}
