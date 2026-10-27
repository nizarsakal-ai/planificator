/**
 * PLAN-ACQ-MULTIMODAL — Fixtures binaires minimales (aucun fichier réel).
 */

import ExcelJS from "exceljs"

/** JPEG minimal : SOI + APP0 + SOF0 (dimensions) + EOI. */
export function buildMinimalJpeg(width = 640, height = 480, padTo = 0): Buffer {
  const soi = Buffer.from([0xff, 0xd8])
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const eoi = Buffer.from([0xff, 0xd9])
  const base = Buffer.concat([soi, app0, sof, eoi])
  if (padTo > base.length) return Buffer.concat([base, Buffer.alloc(padTo - base.length, 0)])
  return base
}

/** PNG minimal (signature + IHDR). */
export function buildMinimalPng(width = 100, height = 50): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write("IHDR", 4, "ascii")
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  return Buffer.concat([sig, ihdr])
}

/** En-tête HEIC (boîte ftyp, brand heic). */
export function buildMinimalHeic(): Buffer {
  const box = Buffer.alloc(24)
  box.writeUInt32BE(24, 0)
  box.write("ftyp", 4, "ascii")
  box.write("heic", 8, "ascii")
  box.write("mif1heic", 16, "ascii")
  return box
}

export async function buildXlsx(
  sheets: Array<{ name: string; rows: unknown[][] }>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name)
    for (const row of sh.rows) ws.addRow(row as ExcelJS.CellValue[])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** PDF sans couche texte (scan simulé) avec `pages` pages vides. */
export function buildBlankPdfWithPages(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    `2 0 obj<< /Type /Pages /Kids [${kids}] /Count ${pages} >>endobj\n`,
    ...Array.from(
      { length: pages },
      (_, i) => `${3 + i} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>endobj\n`
    ),
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, "latin1")
  const size = objects.length + 1
  body += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let i = 1; i < size; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  body += `trailer<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}
