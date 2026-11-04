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
  /** Détail par zone : un champ n'est sûr que si SA zone est contrôlée et juste (les noms ne le sont jamais). */
  checks: { number: boolean; birth: boolean; expiry: boolean | null; composite: boolean }
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
    .map((l) => fit(fillers(l.replace(/\s+/g, "").replace(/[«‹]/g, "<"))))
    .filter((l) => /^[A-Z0-9<]{28,44}$/.test(l) && l.includes("<"))
}
/** OCR : un « < » isolé entre deux autres est souvent lu K ou L ; une fin de ligne de remplissage aussi. */
function fillers(line: string) {
  if ((line.match(/</g) ?? []).length < 2) return line
  let out = line
  for (let i = 0; i < 3; i++) out = out.replace(/<[KL]</g, "<<<")
  return out.replace(/<[<KL]*<[<KL]*$/, (run) => (/<.*</.test(run) ? "<".repeat(run.length) : run))
}
/** OCR : une ligne terminée par des « < » peut en compter un ou deux de trop ou de moins ; on la ramène à 30, 36 ou 44. */
function fit(line: string) {
  if (!line.endsWith("<")) return line
  for (const target of [30, 36, 44]) {
    const diff = line.length - target
    if (diff === 0) return line
    if (diff > 0 && diff <= 4 && line.endsWith("<".repeat(diff + 1))) return line.slice(0, target)
    if (diff < 0 && diff >= -2) return line + "<".repeat(-diff)
  }
  return line
}

// Gabarit de chaque ligne : d = chiffre (ou « < »), a = lettre (ou « < »), s = sexe, x = libre. Remettre un O lu à la
// place d'un 0 dans une zone qui n'admet que des chiffres (et l'inverse) ne fabrique rien : la norme n'autorise que ce
// caractère à cet endroit, et les chiffres de contrôle valident ensuite le résultat ou le marquent invalide.
const TD3_1 = "aa" + "a".repeat(42)
const TD3_2 = "xxxxxxxxx" + "d" + "aaa" + "dddddd" + "d" + "s" + "dddddd" + "d" + "x".repeat(14) + "d" + "d"
const TD1_1 = "aa" + "aaa" + "xxxxxxxxx" + "d" + "x".repeat(15)
const TD1_2 = "dddddd" + "d" + "s" + "dddddd" + "d" + "aaa" + "x".repeat(11) + "d"
const TD1_3 = "a".repeat(30)
const TD2_1 = "a".repeat(36)
const TD2_2 = "xxxxxxxxx" + "d" + "aaa" + "dddddd" + "d" + "s" + "dddddd" + "d" + "x".repeat(7) + "d"
const FR_1 = "aaaaa" + "a".repeat(25) + "xxxxxx"
const FR_2 = "x".repeat(12) + "d" + "a".repeat(14) + "dddddd" + "d" + "s" + "d"
const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", T: "7" }
// Code de document TD1 : seules les lettres A, C et I sont admises en tête ; l'OCR lit souvent un I comme un T.
const TD1_CODE = (l: string) => (l[0] === "T" ? "I" + l.slice(1) : l)
const TO_ALPHA: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "4": "A" }
export function shape(line: string, spec: string) {
  let out = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i], k = spec[i]
    out += k === "d" && c !== "<" && !/\d/.test(c) ? TO_DIGIT[c] ?? c
      : k === "a" && /\d/.test(c) ? TO_ALPHA[c] ?? c
      : k === "s" && c === "H" ? "M" : c
  }
  return out
}

// Structure stricte de chaque format, pour retrouver une bande dont les lignes ont été fusionnées par l'extraction
// de texte (couche texte PDF qui joint les lignes par des espaces).
const COMPACT_TD3 = /(P[A-Z0-9<]{43})([A-Z0-9<]{9}\d[A-Z<]{3}\d{7}[MF<]\d{7}[A-Z0-9<]{14}[\d<]\d)/
const COMPACT_TD1 = /([ACI][A-Z0-9<]{29})(\d{7}[MF<]\d{7}[A-Z<]{3}[A-Z0-9<]{11}\d)([A-Z<]{30})/
const COMPACT_FR = /(IDFRA[A-Z<]{25}[A-Z0-9<]{6})([A-Z0-9]{12}\d[A-Z<]{14}\d{7}[MF<]\d)/

const digits = (l: string) => (l.match(/\d/g) ?? []).length
/** Ligne des noms TD1 (aucun chiffre de contrôle) : un ou deux « < » perdus ou lus comme des chiffres en fin de ligne. */
function namesLine(l: string | undefined) {
  if (!l || l.length < 28 || l.length > 31 || digits(l) > 2 || !l.includes("<")) return null
  const fixed = l.replace(/\d+$/, (m) => "<".repeat(m.length))
  return fixed.length >= 30 ? (fixed.slice(30).replace(/</g, "") ? null : fixed.slice(0, 30)) : fixed + "<".repeat(30 - fixed.length)
}

/** Toutes les bandes plausibles du texte ; la première dont les contrôles sont justes l'emporte (OCR : une passe
 * texte libre et une passe MRZ dédiée lisent la même bande, la seconde est souvent la bonne). */
export function parseMrz(text: string, now = new Date()): MrzResult | null {
  const found: MrzResult[] = []
  const lines = mrzLines(text)
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i], b = lines[i + 1], c = lines[i + 2]
    const n3 = namesLine(c)
    // Gabarit grossier avant lecture : la ligne des dates porte au moins 10 chiffres, celle des noms presque aucun
    // (une ligne lue deux fois par deux passes ne doit pas servir de ligne des noms).
    if (a.length === 44 && b?.length === 44 && a[0] === "P" && digits(b) >= 10 && digits(a) <= 3) found.push(td3(shape(a, TD3_1), shape(b, TD3_2), now))
    else if (a.length === 30 && b?.length === 30 && n3 && /^[ACIT][A-Z<][A-Z<]{3}/.test(a) && digits(b) >= 10) found.push(td1(shape(TD1_CODE(a), TD1_1), shape(b, TD1_2), shape(n3, TD1_3), now))
    else if (a.length === 36 && b?.length === 36 && a.startsWith("IDFRA")) found.push(frLegacy(shape(a, FR_1), shape(b, FR_2), now))
    else if (a.length === 36 && b?.length === 36 && /^[ACIPV]/.test(a)) found.push(td2(shape(a, TD2_1), shape(b, TD2_2), now))
  }
  const compact = text.toUpperCase().replace(/[«‹]/g, "<").replace(/\s+/g, "")
  let m: RegExpExecArray | null
  if ((m = COMPACT_TD3.exec(compact))) found.push(td3(m[1], m[2], now))
  if ((m = COMPACT_TD1.exec(compact))) found.push(td1(m[1], m[2], m[3], now))
  if ((m = COMPACT_FR.exec(compact))) found.push(frLegacy(m[1], m[2], now))
  return found.find((r) => r.checksValid) ?? found[0] ?? null
}

function td3(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 9), birth = b.slice(13, 19), expiry = b.slice(21, 27)
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43)
  const checks = { number: ok(number, b[9]), birth: ok(birth, b[19]), expiry: ok(expiry, b[27]), composite: ok(composite, b[43]) }
  const checksValid = checks.number && checks.birth && checks.expiry && checks.composite
  return { format: "TD3", checks, documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(a.slice(5)),
    nationality: nationalityOf(b.slice(10, 13)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[20]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
function td1(a: string, b: string, c: string, now: Date): MrzResult {
  const number = a.slice(5, 14), birth = b.slice(0, 6), expiry = b.slice(8, 14)
  const composite = a.slice(5, 30) + b.slice(0, 7) + b.slice(8, 15) + b.slice(18, 29)
  const checks = { number: ok(number, a[14]), birth: ok(birth, b[6]), expiry: ok(expiry, b[14]), composite: ok(composite, b[29]) }
  const checksValid = checks.number && checks.birth && checks.expiry && checks.composite
  return { format: "TD1", checks, documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(c),
    nationality: nationalityOf(b.slice(15, 18)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[7]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
function td2(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 9), birth = b.slice(13, 19), expiry = b.slice(21, 27)
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 35)
  const checks = { number: ok(number, b[9]), birth: ok(birth, b[19]), expiry: ok(expiry, b[27]), composite: ok(composite, b[35]) }
  const checksValid = checks.number && checks.birth && checks.expiry && checks.composite
  return { format: "TD2", checks, documentCode: a.slice(0, 2).replace(/</g, ""), issuingState: a.slice(2, 5).replace(/</g, ""), ...names(a.slice(5)),
    nationality: nationalityOf(b.slice(10, 13)), birthDate: mrzDate(birth, "birth", now), sex: sexOf(b[20]),
    expiryDate: mrzDate(expiry, "expiry", now), documentNumberEnd: numberEnd(number), checksValid }
}
/** Ancienne CNI française : nom en ligne 1, numéro + prénoms + naissance en ligne 2, pas de date d'expiration. */
function frLegacy(a: string, b: string, now: Date): MrzResult {
  const number = b.slice(0, 12), birth = b.slice(27, 33)
  const checks = { number: ok(number, b[12]), birth: ok(birth, b[33]), expiry: null, composite: ok(a + b.slice(0, 35), b[35]) }
  const checksValid = checks.number && checks.birth && checks.composite
  return { format: "FR_ID_LEGACY", checks, documentCode: "ID", issuingState: "FRA", surname: clean(a.slice(5, 30)),
    givenNames: clean(b.slice(13, 27).replace(/<</g, " ")), nationality: "FRA", birthDate: mrzDate(birth, "birth", now),
    sex: sexOf(b[34]), expiryDate: null, documentNumberEnd: numberEnd(number), checksValid }
}
