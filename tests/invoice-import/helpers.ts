// Jeux d'essai SYNTHÉTIQUES (aucune donnée réelle) pour l'import de factures.
import { deflateRawSync } from "node:zlib"
import ExcelJS from "exceljs"

function crc32(b: Buffer): number {
  let c = ~0
  for (const byte of b) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return ~c >>> 0
}

/** ZIP minimal (STORE ou DEFLATE) ; `flags` permet de simuler une archive chiffrée, `fakeSize` une taille déclarée mensongère. */
export function buildZip(entries: { name: string; data: Buffer; deflate?: boolean; flags?: number; fakeSize?: number }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8")
    const comp = e.deflate ? deflateRawSync(e.data) : e.data
    const method = e.deflate ? 8 : 0, crc = crc32(e.data), flags = 0x0800 | (e.flags ?? 0), size = e.fakeSize ?? e.data.length
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(flags, 6); loc.writeUInt16LE(method, 8)
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(size, 22); loc.writeUInt16LE(name.length, 26)
    locals.push(loc, name, comp)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(flags, 8); cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42)
    centrals.push(cen, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

export async function buildXlsx(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("Export")
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * Export « façon Tiime » SYNTHÉTIQUE : en-têtes français plausibles d'un export de factures. Ce n'est PAS un export Tiime réel
 * (aucun n'a été fourni) : il valide le moteur d'association de colonnes, pas la conformité au format Tiime.
 */
export const SYNTHETIC_TIIME_CSV = [
  "Numéro;Type;Client;Date d'émission;Date d'échéance;Total HT;Total TVA;Total TTC;Statut;Facture d'origine",
  "F-2025-001;Facture;Mairie de Testville;15/01/2025;14/02/2025;1 000,00;200,00;1 200,00;Payée;",
  "F-2025-002;Facture;Client Inconnu SARL;20/01/2025;19/02/2025;500,00;100,00;600,00;En attente;",
  "AV-2025-001;Avoir;Mairie de Testville;25/01/2025;;-100,00;-20,00;-120,00;Émis;F-2025-001",
].join("\r\n")
