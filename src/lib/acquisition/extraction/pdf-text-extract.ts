/**
 * PLAN-ACQ-V2 R3 — Extraction couche texte PDF via unpdf (pas d’OCR).
 * PDF image-only → PDF_NO_TEXT_LAYER. Corrupt → PDF_PARSE_FAILED.
 *
 * Choix : `unpdf` (PDF.js serverless, zéro dépendance native) plutôt que
 * `pdf-parse` (canvas natif fragile sur Vercel) ou pdfjs-dist navigateur.
 */

import { deflateSync } from "node:zlib"
import { extractText, getDocumentProxy } from "unpdf"

export type PdfTextExtractStatus =
  | "PDF_TEXT_EXTRACTED"
  | "PDF_NO_TEXT_LAYER"
  | "PDF_PARSE_FAILED"
  | "PDF_TEXT_TRUNCATED"

export type PdfTextExtractResult = {
  status: PdfTextExtractStatus
  text: string
  truncated: boolean
}

const DEFAULT_MAX_CHARS = 8_000
const DEFAULT_TIMEOUT_MS = 3_000
/** Garde-fou mémoire avant parse (10 MiB). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

async function parseWithUnpdf(
  buf: Buffer,
  maxChars: number
): Promise<PdfTextExtractResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  try {
    const result = await extractText(pdf, { mergePages: true })
    const joined = normalizeExtractedText(
      typeof result.text === "string" ? result.text : ""
    )

    if (!joined) {
      return { status: "PDF_NO_TEXT_LAYER", text: "", truncated: false }
    }

    if (joined.length > maxChars) {
      return {
        status: "PDF_TEXT_TRUNCATED",
        text: joined.slice(0, maxChars),
        truncated: true,
      }
    }

    return { status: "PDF_TEXT_EXTRACTED", text: joined, truncated: false }
  } finally {
    // getDocumentProxy / PDF.js : pas d’API destroy stable exposée par unpdf 1.x
  }
}

function failed(): PdfTextExtractResult {
  return { status: "PDF_PARSE_FAILED", text: "", truncated: false }
}

/**
 * Parse la couche texte d’un buffer PDF (async, timeout coopératif).
 * Aucune exception propagée — le message email n’est jamais perdu ici.
 */
export async function extractPdfTextLayer(
  input: Buffer | Uint8Array,
  opts?: { maxChars?: number; timeoutMs?: number; maxBytes?: number }
): Promise<PdfTextExtractResult> {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES

  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return failed()
    }
    if (buf.byteLength > maxBytes) {
      return failed()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timed = new Promise<PdfTextExtractResult>((resolve) => {
        timer = setTimeout(() => resolve(failed()), timeoutMs)
      })
      return await Promise.race([parseWithUnpdf(buf, maxChars), timed])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return failed()
  }
}

/** Construit un PDF minimal avec couche texte (fixtures tests). */
export function buildMinimalTextPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  const content = `BT /F1 12 Tf 50 700 Td (${escaped}) Tj ET`
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, "latin1")
  body += `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}

/**
 * PDF FlateDecode avec plusieurs blocs texte (fixture représentative compressée).
 */
export function buildFlateCompressedMultiBlockPdf(texts: string[]): Buffer {
  const content = texts
    .map((t, i) => {
      const escaped = t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
      return `BT /F1 12 Tf 50 ${700 - i * 28} Td (${escaped}) Tj ET`
    })
    .join("\n")
  const compressed = deflateSync(Buffer.from(content, "latin1"))
  const stream = compressed.toString("latin1")
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
    `4 0 obj<< /Length ${compressed.length} /Filter /FlateDecode >>stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, "latin1")
  body += `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}

/** PDF sans couche texte exploitable (page vide, pas de Contents texte). */
export function buildMinimalEmptyPdf(): Buffer {
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, "latin1")
  body += `xref\n0 4\n0000000000 65535 f \n`
  for (let i = 1; i <= 3; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}
