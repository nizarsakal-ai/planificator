/**
 * PLV2-DOC-RH-002 — pièces ENTIÈREMENT SYNTHÉTIQUES pour mesurer l'OCR local : personnes fictives, numéros inventés,
 * mises en page inspirées des pièces françaises sans en reproduire le graphisme. Valeurs attendues connues.
 * Aucune donnée réelle : rien n'est lu depuis le disque de l'utilisateur.
 */
import sharp from "sharp"
import { checkDigit } from "../../../src/lib/hr-documents/recognition/mrz"

export type Expected = {
  category: string
  lastName?: string
  firstNames?: string
  birthDate?: string
  sex?: "M" | "F"
  nationality?: string
  expiryDate?: string
  documentNumberEnd?: string
  period?: string
}
export type Fixture = { name: string; fileName: string; kind: "pdf" | "jpeg" | "png"; bytes: Uint8Array; expected: Expected }

const pad = (s: string, n: number) => (s + "<".repeat(n)).slice(0, n)
const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10)
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)} ${iso.slice(5, 7)} ${iso.slice(0, 4)}`
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

type Person = { last: string; first: string[]; birth: string; sex: "M" | "F"; nat: string; expiry: string; number: string }

export function td1(code: string, state: string, p: Person) {
  const l1 = pad(code + state + p.number + checkDigit(p.number), 30)
  const b = yymmdd(p.birth), e = yymmdd(p.expiry)
  const l2a = b + checkDigit(b) + p.sex + e + checkDigit(e) + p.nat + "<".repeat(11)
  const composite = l1.slice(5, 30) + l2a.slice(0, 7) + l2a.slice(8, 15) + l2a.slice(18, 29)
  const l2 = l2a + checkDigit(composite)
  const l3 = pad(p.last + "<<" + p.first.join("<"), 30)
  return [l1, l2, l3]
}
export function td3(state: string, p: Person) {
  const l1 = pad("P<" + state + p.last + "<<" + p.first.join("<"), 44)
  const b = yymmdd(p.birth), e = yymmdd(p.expiry)
  const personal = "<".repeat(14)
  const head = p.number + checkDigit(p.number) + p.nat + b + checkDigit(b) + p.sex + e + checkDigit(e) + personal + "<"
  const composite = head.slice(0, 10) + head.slice(13, 20) + head.slice(21, 43)
  return [l1, head + checkDigit(composite)]
}

const W = 1000, H = 630
const label = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" font-family="Helvetica" font-size="15" fill="#405070">${esc(t)}</text>`
const value = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" font-family="Helvetica" font-size="26" font-weight="bold" fill="#111">${esc(t)}</text>`
const mrzBlock = (lines: string[], y0: number, size: number) =>
  lines.map((l, i) => `<text x="40" y="${y0 + i * (size + 12)}" font-family="OCR-B, OCRB, Menlo, DejaVu Sans Mono, monospace" font-size="${size}" fill="#111">${esc(l)}</text>`).join("")
const photo = `<rect x="40" y="120" width="230" height="300" rx="8" fill="#c9cfd8"/><circle cx="155" cy="230" r="60" fill="#9aa3b2"/><rect x="75" y="300" width="160" height="110" rx="50" fill="#9aa3b2"/>`

function cardSvg(title: string, subtitle: string, p: Person, mrz: string[], number: boolean) {
  const x = 300
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" rx="24" fill="#eef2f7"/>
  <rect width="100%" height="90" rx="24" fill="#d6e0ee"/>
  <text x="40" y="45" font-family="Helvetica" font-size="26" font-weight="bold" fill="#1d2b4f">${esc(title)}</text>
  <text x="40" y="75" font-family="Helvetica" font-size="17" fill="#1d2b4f">${esc(subtitle)}</text>
  ${photo}
  ${label(x, 125, "NOM / Surname")}${value(x, 155, p.last)}
  ${label(x, 190, "Prénoms / Given names")}${value(x, 220, p.first.map((f) => f[0] + f.slice(1).toLowerCase()).join(", "))}
  ${label(x, 255, "Sexe / Sex")}${label(x + 140, 255, "Nationalité / Nationality")}${label(x + 400, 255, "Date de naiss. / Date of birth")}
  ${value(x, 285, p.sex)}${value(x + 140, 285, p.nat)}${value(x + 400, 285, ddmmyyyy(p.birth))}
  ${number ? label(x, 320, "N° du document / Document No") + value(x, 350, p.number) : ""}
  ${label(x + 400, 320, "Date d'expiration / Expiry date")}${value(x + 400, 350, ddmmyyyy(p.expiry))}
  <rect x="0" y="${H - 175}" width="100%" height="175" fill="#f7f9fb"/>
  ${mrzBlock(mrz, H - 125 + (mrz.length === 2 ? 20 : 0), mrz[0].length > 40 ? 27 : 34)}
</svg>`
}

function payslipSvg() {
  const rows = [["Salaire de base", "151,67 h", "1 980,00"], ["Heures supplémentaires 25 %", "8,00 h", "130,56"], ["Cotisations salariales", "", "- 462,40"]]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="90" y="140" font-family="Helvetica" font-size="44" font-weight="bold">BULLETIN DE PAIE</text>
  <text x="90" y="200" font-family="Helvetica" font-size="26">Période du 01/09/2026 au 30/09/2026</text>
  <text x="90" y="260" font-family="Helvetica" font-size="26">Employeur : SOCIÉTÉ EXEMPLE BTP</text>
  <text x="90" y="300" font-family="Helvetica" font-size="26">Salarié : ROUSSEAU Thomas</text>
  ${rows.map((r, i) => `<text x="90" y="${420 + i * 50}" font-family="Helvetica" font-size="24">${esc(r[0])}</text><text x="700" y="${420 + i * 50}" font-family="Helvetica" font-size="24">${r[1]}</text><text x="950" y="${420 + i * 50}" font-family="Helvetica" font-size="24">${r[2]}</text>`).join("")}
  <text x="90" y="700" font-family="Helvetica" font-size="30" font-weight="bold">NET A PAYER : 1 648,16 EUR</text>
</svg>`
}

/** PDF d'une page qui n'est qu'une image JPEG (DCTDecode), comme un scan de téléphone : aucune couche texte. */
export function jpegPdf(jpeg: Buffer, width: number, height: number, rotate = 0): Uint8Array {
  const pw = Math.round(width * 0.36), ph = Math.round(height * 0.36)
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`
  const objs: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Rotate ${rotate} /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"), jpeg, Buffer.from("\nendstream", "latin1")]),
  ]
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")]
  const offsets: number[] = []
  let size = parts[0].length
  objs.forEach((o, i) => {
    offsets.push(size)
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"), Buffer.from("\nendobj\n", "latin1")])
    parts.push(b); size += b.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`
  parts.push(Buffer.from(xref, "latin1"))
  return new Uint8Array(Buffer.concat(parts))
}

// Bruit de capteur et léger flou : une photo de téléphone, pas un rendu parfait.
async function photoLike(png: Buffer, opts: { noise?: number; blur?: number; rotate?: number; scale?: number; quality?: number }) {
  const meta = await sharp(png).metadata()
  const w = Math.round((meta.width ?? W) * (opts.scale ?? 1)), h = Math.round((meta.height ?? H) * (opts.scale ?? 1))
  let img = sharp(png).resize(w, h)
  if (opts.blur) img = img.blur(opts.blur)
  let buf = await img.removeAlpha().raw().toBuffer()
  if (opts.noise) {
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.max(0, Math.min(255, buf[i] + Math.round((rand() - 0.5) * 2 * opts.noise)))
  }
  let out = sharp(buf, { raw: { width: w, height: h, channels: 3 } })
  // Fond de table autour de la carte, puis rotation éventuelle (photo prise de travers ou à l'envers).
  out = sharp(await out.extend({ top: 60, bottom: 60, left: 60, right: 60, background: "#6b5a4a" }).png().toBuffer())
  if (opts.rotate) out = out.rotate(opts.rotate, { background: "#6b5a4a" })
  return out.jpeg({ quality: opts.quality ?? 85 }).toBuffer({ resolveWithObject: true })
}

const CNI: Person = { last: "MARTINEZ", first: ["CLAIRE", "ANNE"], birth: "1990-07-13", sex: "F", nat: "FRA", expiry: "2031-03-02", number: "X4RTBPFW4" }
const PASSPORT: Person = { last: "BERNARD", first: ["LUCAS", "PAUL"], birth: "1985-11-21", sex: "M", nat: "FRA", expiry: "2029-06-14", number: "19AB34567" }
const PERMIT: Person = { last: "DIALLO", first: ["AMINATA"], birth: "1996-02-29", sex: "F", nat: "SEN", expiry: "2027-10-05", number: "TS7K2M9Q1" }

const expectedOf = (category: string, p: Person): Expected => ({ category, lastName: p.last, firstNames: p.first.map((f) => f[0] + f.slice(1).toLowerCase()).join(" "),
  birthDate: p.birth, sex: p.sex, nationality: p.nat, expiryDate: p.expiry, documentNumberEnd: p.number.slice(-4) })

export async function buildFixtures(): Promise<Fixture[]> {
  const scale = 2
  const render = (svg: string) => sharp(Buffer.from(svg), { density: 72 * scale }).png().toBuffer()
  const cni = await render(cardSvg("RÉPUBLIQUE FRANÇAISE", "CARTE NATIONALE D'IDENTITÉ / IDENTITY CARD", CNI, td1("ID", "FRA", CNI), true))
  const passport = await render(cardSvg("RÉPUBLIQUE FRANÇAISE", "PASSEPORT / PASSPORT", PASSPORT, td3("FRA", PASSPORT), true))
  const permit = await render(cardSvg("RÉPUBLIQUE FRANÇAISE", "TITRE DE SÉJOUR / RESIDENCE PERMIT", PERMIT, td1("IR", "FRA", PERMIT), true))
  const payslip = await sharp(Buffer.from(payslipSvg())).png().toBuffer()
  const out: Fixture[] = []
  const add = async (name: string, fileName: string, png: Buffer, expected: Expected, o: Parameters<typeof photoLike>[1], pdf = false) => {
    const { data, info } = await photoLike(png, o)
    out.push(pdf ? { name, fileName, kind: "pdf", bytes: jpegPdf(data, info.width, info.height), expected }
      : { name, fileName, kind: "jpeg", bytes: new Uint8Array(data), expected })
  }
  out.push({ name: "CNI — PNG net", fileName: "scan.png", kind: "png", bytes: new Uint8Array(cni), expected: expectedOf("ID_CARD", CNI) })
  await add("CNI — photo JPEG bruitée", "IMG_2041.jpg", cni, expectedOf("ID_CARD", CNI), { noise: 18, blur: 0.6, quality: 80 })
  await add("CNI — photo pivotée 90°", "IMG_2042.jpg", cni, expectedOf("ID_CARD", CNI), { noise: 10, rotate: 90 })
  await add("CNI — photo à l'envers 180°", "IMG_2043.jpg", cni, expectedOf("ID_CARD", CNI), { noise: 10, rotate: 180 })
  await add("CNI — scan PDF sans couche texte", "Scan 3 nov. 2026.pdf", cni, expectedOf("ID_CARD", CNI), { noise: 12, blur: 0.5 }, true)
  await add("CNI — photo basse résolution", "IMG_2044.jpg", cni, expectedOf("ID_CARD", CNI), { noise: 8, scale: 0.42, quality: 70 })
  await add("Passeport — photo JPEG", "IMG_3001.jpg", passport, expectedOf("PASSPORT", PASSPORT), { noise: 14, blur: 0.5 })
  await add("Passeport — scan PDF", "document.pdf", passport, expectedOf("PASSPORT", PASSPORT), { noise: 10 }, true)
  await add("Titre de séjour — photo JPEG", "IMG_4001.jpg", permit, expectedOf("RESIDENCE_PERMIT", PERMIT), { noise: 14, blur: 0.5 })
  await add("Bulletin — scan PDF", "scan_0001.pdf", payslip, { category: "PAYSLIP", period: "2026-09" }, { noise: 10, blur: 0.4 }, true)
  // Illisible par construction : carte floutée au point de ne plus contenir de caractère reconnaissable.
  await add("Photo floue (illisible attendu)", "IMG_9999.jpg", cni, { category: "" }, { blur: 14, noise: 25, scale: 0.5 })
  return out
}
