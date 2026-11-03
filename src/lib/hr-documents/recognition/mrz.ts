/**
 * PLV2-DOC-RH-002 — lecture locale des bandes MRZ (OACI 9303) : passeport TD3 (2 × 44), carte TD1 (3 × 30 : CNI
 * française depuis 2021, titres de séjour), TD2 (2 × 36) et ancienne CNI française (2 × 36, « IDFRA »).
 * Chaque champ contrôlé par un chiffre de vérification est marqué valide ou non : un champ invalide n'est jamais
 * présenté comme sûr. Le numéro du document n'est jamais renvoyé en entier (4 derniers caractères seulement).
 */
export type MrzFormat = "TD1" | "TD2" | "TD3" | "FR_ID_LEGACY"
export type MrzResult = {
  format: MrzFormat
  documentCode: string
  issuingState: string
  surname: string
  givenNames: string
  nationality: string | null
  birthDate: string | null
  sex: "M" | "F" | null
  expiryDate: string | null
  documentNumberEnd: string | null
  /** Tous les chiffres de vérification présents sont justes. */
  checksValid: boolean
}

const WEIGHTS = [7, 3, 1]
function charValue(c: string) {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55
  return 0
}
export function checkDigit(field: string) {
  let sum = 0
  for (let i = 0; i < field.length; i++) sum += charValue(field[i]) * WEIGHTS[i % 3]
  return String(sum % 10)
}
const ok = (field: string, digit: string) => checkDigit(field) === digit

/** YYMMDD → ISO ; la naissance bascule au siècle précédent si l'année dépasse l'année en cours. */
function mrzDate(raw: string, kind: "birth" | "expiry", now = new Date()): string | null {
  if (!/^\d{6}$/.test(raw)) return null
  const yy = Number(raw.slice(0, 2)), mm = Number(raw.slice(2, 4)), dd = Number(raw.slice(4, 6))
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const current = now.getUTCFullYear() % 100
  const year = kind === "expiry" ? 2000 + yy : yy > current ? 1900 + yy : 2000 + yy
  const date = new Date(Date.UTC(year, mm - 1, dd))
  if (date.getUTCMonth() !== mm - 1) return null
  return date.toISOString().slice(0, 10)
}
const clean = (s: string) => s.replace(/<+$/g, "").replace(/</g, " ").replace(/\s+/g, " ").trim()
function names(field: string) {
  const [surname, given = ""] = field.split("<<")
  return { surname: clean(surname), givenNames: clean(given) }
}
const sexOf = (c: string) => (c === "M" || c === "F" ? c : null)
const nationalityOf = (s: string) => (/^[A-Z<]{3}$/.test(s) ? s.replace(/</g, "") || null : null)
const numberEnd = (s: string) => {
  const v = s.replace(/</g, "")
  return v ? v.slice(-4) : null
}

/** Lignes candidates : majuscules, sans espaces, alphabet MRZ uniquement. */
export function mrzLines(text: string): string[] {
  return text
    .toUpperCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, "").replace(/[«‹]/g, "<"))
    .filter((l) => /^[A-Z0-9<]{30,44}$/.test(l) && l.includes("<"))
}

// Structure stricte de chaque format, pour retrouver une bande dont les lignes ont été fusionnées par l'extraction
// de texte (couche texte PDF qui joint les lignes par des espaces).
const COMPACT_TD3 = /(P[A-Z0-9<]{43})([A-Z0-9<]{9}\d[A-Z<]{3}\d{7}[MF<]\d{7}[A-Z0-9<]{14}[\d<]\d)/
const COMPACT_TD1 = /([ACI][A-Z0-9<]{29})(\d{7}[MF<]\d{7}[A-Z<]{3}[A-Z0-9<]{11}\d)([A-Z<]{30})/
const COMPACT_FR = /(IDFRA[A-Z<]{25}[A-Z0-9<]{6})([A-Z0-9]{12}\d[A-Z<]{14}\d{7}[MF<]\d)/

export function parseMrz(text: string, now = new Date()): MrzResult | null {
  const lines = mrzLines(text)
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i], b = lines[i + 1], c = lines[i + 2]
    if (a.length === 44 && b?.length === 44 && a[0] === "P") return td3(a, b, now)
    if (a.length === 30 && b?.length === 30 && c?.length === 30 && /^[ACI]/.test(a)) return td1(a, b, c, now)
    if (a.length === 36 && b?.length === 36 && a.startsWith("IDFRA")) return frLegacy(a, b, now)
    if (a.length === 36 && b?.length === 36 && /^[ACIPV]/.test(a)) return td2(a, b, now)
  }
  const compact = text.toUpperCase().replace(/[«‹]/g, "<").replace(/\s+/g, "")
  let m: RegExpExecArray | null
  if ((m = COMPACT_TD3.exec(compact))) return td3(m[1], m[2], now)
  if ((m = COMPACT_TD1.exec(compact))) return td1(m[1], m[2], m[3], now)
  if ((m = COMPACT_FR.exec(compact))) return frLegacy(m[1], m[2], now)
  return null
}

function td3(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 9), birth = b.slice(13, 19), expiry = b.slice(21, 27)
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43)
  const checksValid = ok(number, b[9]) && ok(birth, b[19]) && ok(expiry, b[27]) && ok(composite, b[43])
  return { format: "TD3", documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(a.slice(5)),
    nationality: nationalityOf(b.slice(10, 13)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[20]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
function td1(a: string, b: string, c: string, now: Date): MrzResult {
  const number = a.slice(5, 14), birth = b.slice(0, 6), expiry = b.slice(8, 14)
  const composite = a.slice(5, 30) + b.slice(0, 7) + b.slice(8, 15) + b.slice(18, 29)
  const checksValid = ok(number, a[14]) && ok(birth, b[6]) && ok(expiry, b[14]) && ok(composite, b[29])
  return { format: "TD1", documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(c),
    nationality: nationalityOf(b.slice(15, 18)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[7]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
function td2(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 9), birth = b.slice(13, 19), expiry = b.slice(21, 27)
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 35)
  const checksValid = ok(number, b[9]) && ok(birth, b[19]) && ok(expiry, b[27]) && ok(composite, b[35])
  return { format: "TD2", documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(a.slice(5)),
    nationality: nationalityOf(b.slice(10, 13)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[20]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
/** Ancienne CNI française : nom en ligne 1, numéro + prénoms + naissance en ligne 2, pas de date d'expiration. */
function frLegacy(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 12), birth = b.slice(27, 33)
  const checksValid = ok(number, b[12]) && ok(birth, b[33]) && ok(a + b.slice(0, 35), b[35])
  return { format: "FR_ID_LEGACY", documentCode: "ID", issuingState: "FRA", surname: clean(a.slice(5, 30)),
    givenNames: clean(b.slice(13, 27).replace(/<</g, " ")), nationality: "FRA", birthDate: mrzDate(birth, "birth", now),
    sex: sexOf(b[34]), expiryDate: null, documentNumberEnd: numberEnd(number), checksValid }
}
