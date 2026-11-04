/**
 * Véhicules V3 — reconnaissance des pièces : règles d'extraction pures (aucun Prisma, aucun réseau, aucun moteur OCR).
 * Le texte lu (couche texte du PDF ou OCR local) devient une PROPOSITION de champs que l'opérateur relit et corrige :
 * la pièce reste « à vérifier » jusqu'au clic humain, aucune dépense n'est créée, le compteur n'est jamais touché.
 *
 * Minimisation : seuls les champs déjà prévus par la rubrique sont proposés. L'adresse du titulaire (C.3) n'est jamais
 * lue ; le texte brut ne sort jamais de ce module. Aucune valeur n'est journalisée.
 * Partageable côté navigateur pour ses types : aucun module serveur importé.
 */
import type { VehicleDocumentCategoryCode } from "./document-view-domain"

export const VEHICLE_DOCUMENT_RECOGNITION_FLAG = "PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED"

export function isVehicleDocumentRecognitionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VEHICLE_DOCUMENT_RECOGNITION_FLAG]?.trim() === "true"
}

/** READ : valeur trouvée à côté de son libellé, format contrôlé. TO_CHECK : déduite (première ligne, première date…). */
export type RecognitionConfidence = "READ" | "TO_CHECK"
export type ProposedField<T> = { value: T; confidence: RecognitionConfidence }
export type ProposedFieldKey = "issuedOn" | "validFrom" | "validUntil" | "issuerName" | "referenceNumber" | "mileage"
export interface ProposedFields {
  issuedOn?: ProposedField<string>
  validFrom?: ProposedField<string>
  validUntil?: ProposedField<string>
  issuerName?: ProposedField<string>
  referenceNumber?: ProposedField<string>
  mileage?: ProposedField<number>
}
export type RecognitionCheck = { kind: "PLATE" | "BRAND"; outcome: "MATCH" | "MISMATCH"; read: string; expected: string | null }
export type RecognitionReadingStatus = "TEXT_LAYER" | "OCR" | "ENGINE_MISSING" | "TECHNICAL_FAILURE" | "UNREADABLE"
export interface RecognitionProposal {
  category: VehicleDocumentCategoryCode
  reading: { status: RecognitionReadingStatus; reason: string | null; pages: number; durationMs: number }
  fields: ProposedFields
  /** Lignes proposées pour « Observations » : informations sans colonne dédiée (1re immatriculation, montant, litres). */
  observations: string[]
  checks: RecognitionCheck[]
  /** Le document ressemble à une autre rubrique que celle choisie. */
  otherCategory: VehicleDocumentCategoryCode | null
}

export interface RecognitionInput {
  category: VehicleDocumentCategoryCode
  text: string
  /** Lecture OCR peu sûre : toutes les valeurs passent « à vérifier ». */
  lowConfidence?: boolean
  truck: { matricule: string; marque: string | null }
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/** Majuscules sans accents, apostrophes et espaces insécables unifiés ; une ligne par ligne lue. */
export function normalizeText(raw: string): string[] {
  return raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[’‘`´]/g, "'").replace(/[  \t]/g, " ")
    .split(/\r?\n|\f/).map((line) => line.replace(/ {2,}/g, " ").trim()).filter(Boolean)
}

const clean = (value: string, max: number) => value.replace(/^[\s:.,;\-–—|]+|[\s:.,;\-–—|]+$/g, "").replace(/\s{2,}/g, " ").slice(0, max).trim()

// ─── Dates ───────────────────────────────────────────────────────────────────

const DATE = /\b(0?[1-9]|[12]\d|3[01])\s?[./-]\s?(0?[1-9]|1[0-2])\s?[./-]\s?((?:19|20)\d{2}|\d{2})\b/g

function isoFrom(day: string, month: string, year: string): string | null {
  const y = year.length === 2 ? 2000 + Number(year) : Number(year)
  if (y < 1950 || y > 2100) return null
  const iso = `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  const parsed = new Date(`${iso}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null
}

export function datesIn(text: string): string[] {
  return [...text.matchAll(DATE)].map((m) => isoFrom(m[1], m[2], m[3])).filter((d): d is string => !!d)
}

/** Première date sur la ligne du libellé (après lui), sinon sur la ligne suivante. */
function dateAfter(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const match = label.exec(lines[i])
    if (!match) continue
    const sameLine = datesIn(lines[i].slice(match.index + match[0].length))[0]
    if (sameLine) return sameLine
    const next = lines[i + 1] ? datesIn(lines[i + 1])[0] : undefined
    if (next) return next
  }
  return null
}

/** « du JJ/MM/AAAA au JJ/MM/AAAA » (aussi « du/from … au/to … »). */
function periodIn(lines: string[]): { from: string; until: string } | null {
  const joined = lines.join(" ")
  const pattern = /\bDU(?:\s*\/\s*FROM)?\s*:?\s*([0-9]{1,2}\s?[./-]\s?[0-9]{1,2}\s?[./-]\s?[0-9]{2,4})\s*(?:\(?\s*\d{1,2}\s?H\s?\d{0,2}\s*\)?\s*)?(?:AU|JUSQU'AU)(?:\s*\/\s*TO)?\s*:?\s*([0-9]{1,2}\s?[./-]\s?[0-9]{1,2}\s?[./-]\s?[0-9]{2,4})/
  const match = pattern.exec(joined)
  if (!match) return null
  const [from, until] = [datesIn(match[1])[0], datesIn(match[2])[0]]
  return from && until && from <= until ? { from, until } : null
}

// ─── Nombres ─────────────────────────────────────────────────────────────────

const KM_LABEL = /\b(KILOMETRAGE(?:\s+(?:RELEVE|COMPTEUR|AU\s+COMPTEUR|LU))?|KM\s+COMPTEUR|COMPTEUR|KMS?)\b\s*(?:RELEVE|LU)?\s*[:.=]?\s*/
function mileageIn(lines: string[]): number | null {
  for (const line of lines) {
    const label = KM_LABEL.exec(line)
    if (!label) continue
    const rest = line.slice(label.index + label[0].length)
    const number = /^(\d{1,3}(?:[ .]\d{3}){1,2}|\d{1,7})(?!\s?[,.]\d)\s*(?:KMS?\b)?/.exec(rest)
    if (!number) continue
    const value = Number(number[1].replace(/[ .]/g, ""))
    if (Number.isSafeInteger(value) && value > 0 && value <= 9_999_999) return value
  }
  // « 123 456 KM » sans libellé devant.
  for (const line of lines) {
    const match = /\b(\d{1,3}(?:[ .]\d{3}){1,2}|\d{4,7})\s?KMS?\b(?!\s*\/\s*H)/.exec(line)
    if (match) { const value = Number(match[1].replace(/[ .]/g, "")); if (value > 0 && value <= 9_999_999) return value }
  }
  return null
}

const AMOUNT = /(\d{1,3}(?:[ .]\d{3})+|\d+)[,.](\d{2})\b/
const TOTAL_LABEL = /\b(TOTAL\s+T\.?T\.?C\.?|MONTANT\s+T\.?T\.?C\.?|NET\s+A\s+PAYER|TOTAL\s+A\s+PAYER|TOTAL\s+TTC|MONTANT\s+TOTAL|MONTANT\s+REGLE|TOTAL|MONTANT)\b/
/** Montant TTC le plus explicite : libellé fort d'abord, « TOTAL » ou « MONTANT » seuls ensuite. */
function amountIn(lines: string[]): string | null {
  let weak: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const label = TOTAL_LABEL.exec(lines[i])
    if (!label || /\bH\.?T\.?\b|\bTVA\b/.test(label[0])) continue
    const rest = lines[i].slice(label.index + label[0].length)
    const match = AMOUNT.exec(rest) ?? (lines[i + 1] ? AMOUNT.exec(lines[i + 1]) : null)
    if (!match) continue
    if (/^\s*[:.]?\s*H\.?T\.?\b/.test(rest)) continue
    const value = `${match[1].replace(/[ .]/g, "")},${match[2]}`
    if (/^TOTAL$|^MONTANT$/.test(label[1])) { weak ??= value; continue }
    return value
  }
  return weak
}
const formatAmount = (value: string) => {
  const [units, cents] = value.split(",")
  return `${units.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${cents} €`
}

function litresIn(lines: string[]): string | null {
  for (const line of lines) {
    const match = /\b(\d{1,4})[,.](\d{1,3})\s?(?:L|LITRES?|LTR)\b/.exec(line) ?? (/\b(VOLUME|QUANTITE|QTE)\b/.test(line) ? /\b(\d{1,4})[,.](\d{1,3})\b/.exec(line) : null)
    if (match && Number(match[1]) > 0 && Number(match[1]) < 2000) return `${match[1]},${match[2]}`
  }
  return null
}

// ─── Immatriculation et marque ───────────────────────────────────────────────

/** Plaque comparable : lettres et chiffres seuls. */
export function plateKey(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}
const SIV = /\b([A-HJ-NP-TV-Z]{2})\s?[- ]\s?(\d{3})\s?[- ]\s?([A-HJ-NP-TV-Z]{2})\b/
const SIV_TIGHT = /\b([A-HJ-NP-TV-Z]{2})(\d{3})([A-HJ-NP-TV-Z]{2})\b/
function platesIn(lines: string[]): string[] {
  const found: string[] = []
  for (const line of lines) for (const re of [SIV, SIV_TIGHT]) {
    const match = re.exec(line)
    if (match) found.push(`${match[1]}-${match[2]}-${match[3]}`)
  }
  return [...new Set(found)]
}

function plateCheck(lines: string[], matricule: string, preferred?: string | null): RecognitionCheck | null {
  const expected = plateKey(matricule)
  const plates = preferred ? [preferred, ...platesIn(lines)] : platesIn(lines)
  if (!plates.length) return null
  const same = plates.find((plate) => plateKey(plate) === expected)
  return same ? { kind: "PLATE", outcome: "MATCH", read: same, expected: matricule } : { kind: "PLATE", outcome: "MISMATCH", read: plates[0], expected: matricule }
}

function brandCheck(read: string | null, marque: string | null): RecognitionCheck | null {
  if (!read) return null
  const a = plateKey(read), b = plateKey(marque ?? "")
  const match = !!b && (a.startsWith(b) || b.startsWith(a))
  return { kind: "BRAND", outcome: match ? "MATCH" : "MISMATCH", read, expected: marque }
}

// ─── Rubrique probable ───────────────────────────────────────────────────────

const CATEGORY_SIGNS: [VehicleDocumentCategoryCode, RegExp][] = [
  ["REGISTRATION", /CERTIFICAT D'IMMATRICULATION|\bC\.1\b.*|CARTE GRISE/],
  ["TECHNICAL_INSPECTION", /CONTROLE TECHNIQUE|PROCES[- ]VERBAL DE CONTROLE/],
  ["INSURANCE", /ATTESTATION D'ASSURANCE|CARTE INTERNATIONALE D'ASSURANCE|CARTE VERTE|MEMO VEHICULE ASSURE|RESPONSABILITE CIVILE/],
  ["EXPENSE_RECEIPT", /\b(GAZOLE|GASOIL|DIESEL|SP95|SP98|SANS PLOMB|E10|E85|ADBLUE|CARBURANT)\b/],
  ["REPAIR_MAINTENANCE", /\b(MAIN D'OEUVRE|ORDRE DE REPARATION|VIDANGE|PLAQUETTES|PNEUMATIQUES?|REVISION|DIAGNOSTIC)\b/],
]
function probableCategory(lines: string[]): VehicleDocumentCategoryCode | null {
  const text = lines.join("\n")
  return CATEGORY_SIGNS.find(([, sign]) => sign.test(text))?.[0] ?? null
}

// ─── Émetteurs ───────────────────────────────────────────────────────────────

const INSURERS = ["AXA", "ALLIANZ", "MAAF", "MAIF", "MACIF", "MMA", "GMF", "GROUPAMA", "GENERALI", "MATMUT", "ABEILLE ASSURANCES", "AVIVA",
  "HISCOX", "COVEA", "PACIFICA", "SWISS LIFE", "SWISSLIFE", "THELEM", "AREAS", "MUTUELLE DE POITIERS", "LEOCARE", "L'OLIVIER", "DIRECT ASSURANCE",
  "AMV", "APRIL", "HELVETIA", "ZURICH", "MAPFRE", "CHUBB", "SMABTP", "MUTUELLE DES MOTARDS", "ASSU 2000", "WAKAM", "QBE", "TOKIO MARINE"]
const CT_NETWORKS = ["AUTOSUR", "DEKRA", "SECURITEST", "AUTOVISION", "NORISKO", "CONTROLE TECHNIQUE AUTO", "SGS", "VERIF'AUTO", "AUTOBILAN", "CTPL"]
const FUEL_BRANDS = ["TOTALENERGIES", "TOTAL ACCESS", "TOTAL", "ESSO", "SHELL", "BP", "AVIA", "AGIP", "ENI", "DYNEFF", "INTERMARCHE", "E.LECLERC", "LECLERC",
  "CARREFOUR", "AUCHAN", "SUPER U", "HYPER U", "SYSTEME U", "CASINO", "GEANT", "ELAN", "AS24", "DKV", "Q8", "VITO", "ARGEDIS"]

function brandIn(lines: string[], names: readonly string[]): string | null {
  for (const line of lines.slice(0, 40)) for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\']/g, (c) => `\\${c}`)
    if (new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(line)) return name
  }
  return null
}

const NOT_A_NAME = /^(FACTURE|DEVIS|TICKET|RECU|DUPLICATA|ORIGINAL|COPIE|PAGE|DATE|CLIENT|BIENVENUE|MERCI|TEL|FAX|SIRET|TVA|N°|NO\b|\d)/
/** Première ligne d'en-tête plausible comme raison sociale : à vérifier. */
function headerName(lines: string[]): string | null {
  for (const line of lines.slice(0, 8)) {
    if (NOT_A_NAME.test(line) || !/[A-Z]{3}/.test(line) || /@|WWW\.|HTTP/.test(line)) continue
    if ((line.match(/\d/g) ?? []).length > 4) continue
    const value = clean(line, 120)
    if (value.length >= 3) return value
  }
  return null
}

function labelled(lines: string[], label: RegExp, value: RegExp, max: number): string | null {
  for (let i = 0; i < lines.length; i++) {
    const match = label.exec(lines[i])
    if (!match) continue
    const rest = lines[i].slice(match.index + match[0].length).replace(/^\s*[:.°]?\s*/, "")
    const found = value.exec(rest) ?? (rest.trim() ? null : lines[i + 1] ? value.exec(lines[i + 1]) : null)
    if (found) { const v = clean(found[1] ?? found[0], max); if (v) return v }
  }
  return null
}

// ─── Règles par rubrique ─────────────────────────────────────────────────────

type Draft = { fields: ProposedFields; observations: string[]; checks: RecognitionCheck[] }
const read = <T>(value: T): ProposedField<T> => ({ value, confidence: "READ" })
const toCheck = <T>(value: T): ProposedField<T> => ({ value, confidence: "TO_CHECK" })
const formatFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Rubrique codée du certificat (« A », « B », « C.1 », « D.1 », « I ») : valeur sur la même ligne, après le code. */
function codedFields(lines: string[], code: string): string[] {
  const escaped = code.replace(".", "\\.")
  const re = new RegExp(`(?:^|\\s|\\()${escaped}\\)?\\s*[:.]?\\s+(.+)$`)
  return lines.map((line) => re.exec(line)?.[1]).filter((value): value is string => !!value)
}
const codedField = (lines: string[], code: string) => codedFields(lines, code)[0] ?? null
/** Un code d'une lettre (« B », « I ») apparaît aussi dans le texte courant : on retient la première occurrence datée. */
const codedDate = (lines: string[], code: string) => codedFields(lines, code).map((value) => datesIn(value)[0]).find(Boolean) ?? null

function registration(lines: string[], truck: RecognitionInput["truck"]): Draft {
  const draft: Draft = { fields: {}, observations: [], checks: [] }
  // « I » est souvent lu « | », « l » ou « 1 » par l'OCR : variantes admises en début de ligne, suivies d'une date.
  const issuedOn = codedDate(lines, "I") ?? lines.map((line) => /^[|L1!]\)?\s*[:.]?\s+(.+)$/.exec(line)?.[1]).map((value) => value && /^\d/.test(value) ? datesIn(value)[0] : undefined).find(Boolean) ?? null
  if (issuedOn) draft.fields.issuedOn = read(issuedOn)
  const firstOn = codedDate(lines, "B")
  if (firstOn) draft.observations.push(`1re immatriculation (B) : ${formatFr(firstOn)}`)
  // C.1 : titulaire. Coupé avant tout code suivant (C.3 = adresse, jamais lue ni renvoyée).
  const holder = codedField(lines, "C.1")
  if (holder) {
    const value = clean(holder.split(/\s(?:C\.\d|D\.\d|E|F\.\d)\s/)[0], 120)
    if (value.length >= 2 && !/^\d/.test(value)) draft.fields.issuerName = toCheck(value)
  }
  const formula = /\b((?:19|20)\d{2}\s?[A-Z]{2}\s?\d{5})\b/.exec(lines.join(" "))
  if (formula) draft.fields.referenceNumber = read(formula[1].replace(/\s/g, ""))
  const platePreferred = codedFields(lines, "A").map((value) => platesIn([value])[0]).find(Boolean) ?? null
  const plateResult = plateCheck(lines, truck.matricule, platePreferred)
  if (plateResult) draft.checks.push(plateResult)
  const brand = codedField(lines, "D.1")
  const brandValue = brand ? clean(brand.split(/\s(?:D\.\d|E|F\.\d)\s/)[0], 60) : null
  if (brandValue && /[A-Z]{2}/.test(brandValue)) {
    const result = brandCheck(brandValue, truck.marque)
    if (result) draft.checks.push(result)
    if (result?.outcome === "MISMATCH") draft.observations.push(`Marque lue (D.1) : ${brandValue}`)
  }
  return draft
}

function insurance(lines: string[], truck: RecognitionInput["truck"]): Draft {
  const draft: Draft = { fields: {}, observations: [], checks: [] }
  const period = periodIn(lines)
  if (period) { draft.fields.validFrom = read(period.from); draft.fields.validUntil = read(period.until) }
  else {
    const from = dateAfter(lines, /\b(DATE D'EFFET|EFFET|PRISE D'EFFET|DEBUT DE VALIDITE)\b/)
    const until = dateAfter(lines, /\b(DATE D'ECHEANCE|ECHEANCE|FIN DE VALIDITE|DATE D'EXPIRATION|VALABLE JUSQU'AU)\b/)
    if (from) draft.fields.validFrom = read(from)
    if (until && (!from || from <= until)) draft.fields.validUntil = read(until)
  }
  const issued = dateAfter(lines, /\b(FAIT LE|ETABLIE? LE|DATE D'EMISSION|DATE D'EDITION|EDITEE? LE|DELIVREE? LE)\b/)
  if (issued) draft.fields.issuedOn = read(issued)
  const insurer = brandIn(lines, INSURERS)
  if (insurer) draft.fields.issuerName = read(insurer)
  else {
    const named = labelled(lines, /\b(ASSUREUR|COMPAGNIE|SOCIETE D'ASSURANCES?|ENTREPRISE D'ASSURANCE)\b/, /([A-Z][A-Z0-9 '&.-]{2,80})/, 120)
    if (named) draft.fields.issuerName = toCheck(named)
  }
  const contract = labelled(lines, /\b(?:N°|NO|NUMERO|NUM\.?)\s*(?:DE\s+)?(?:CONTRAT|POLICE|SOCIETAIRE|ADHERENT)\b|\b(?:CONTRAT|POLICE)\s*(?:N°|NO)/, /([A-Z0-9][A-Z0-9/.-]{3,30}(?:\s[A-Z0-9/.-]{1,10}){0,2})/, 100)
  if (contract) draft.fields.referenceNumber = read(contract.split(/\s(?:DU|VALABLE|PERIODE)\b/)[0])
  const plate = plateCheck(lines, truck.matricule)
  if (plate) draft.checks.push(plate)
  return draft
}

function technicalInspection(lines: string[], truck: RecognitionInput["truck"]): Draft {
  const draft: Draft = { fields: {}, observations: [], checks: [] }
  const controlled = dateAfter(lines, /\b(DATE DU CONTROLE|DATE DE (?:LA )?VISITE|CONTROLE EFFECTUE LE|DATE DE L'INSPECTION|VISITE DU)\b/)
  if (controlled) draft.fields.issuedOn = read(controlled)
  const until = dateAfter(lines, /\b(DATE LIMITE(?: DE (?:VALIDITE|PRESENTATION|LA PROCHAINE VISITE))?|VALABLE JUSQU'AU|PROCHAIN CONTROLE(?: AVANT LE)?|A REPRESENTER AVANT LE|PROCHAINE VISITE)\b/)
  if (until && (!controlled || controlled <= until)) draft.fields.validUntil = read(until)
  const network = brandIn(lines, CT_NETWORKS)
  const centre = labelled(lines, /\b(CENTRE(?: DE CONTROLE)?|NOM DU CENTRE|INSTALLATION)\b/, /([A-Z][A-Z0-9 '&.-]{2,80})/, 120)
  if (centre && !/^(DE CONTROLE|AGREE)/.test(centre)) draft.fields.issuerName = toCheck(centre)
  else if (network) draft.fields.issuerName = toCheck(network)
  const pv = labelled(lines, /\b(?:N°|NO|NUMERO)\s*(?:DU\s+|DE\s+)?(?:PV|PROCES[- ]VERBAL)\b|\bPROCES[- ]VERBAL\s*(?:N°|NO)/, /([A-Z0-9][A-Z0-9/.-]{3,30})/, 100)
  if (pv) draft.fields.referenceNumber = read(pv)
  const km = mileageIn(lines)
  if (km !== null) draft.observations.push(`Kilométrage relevé au contrôle : ${km.toLocaleString("fr-FR").replace(/ /g, " ")} km`)
  const plate = plateCheck(lines, truck.matricule)
  if (plate) draft.checks.push(plate)
  return draft
}

function invoice(lines: string[], truck: RecognitionInput["truck"], kind: "REPAIR_MAINTENANCE" | "EXPENSE_RECEIPT"): Draft {
  const draft: Draft = { fields: {}, observations: [], checks: [] }
  const dated = dateAfter(lines, /\b(DATE(?: DE (?:LA )?FACTURE)?|FACTURE DU|LE)\b\s*[:]?/)
  const anyDate = datesIn(lines.join("\n"))[0]
  if (dated) draft.fields.issuedOn = read(dated)
  else if (anyDate) draft.fields.issuedOn = toCheck(anyDate)
  const brand = kind === "EXPENSE_RECEIPT" ? brandIn(lines, FUEL_BRANDS) : null
  const header = headerName(lines)
  if (brand) draft.fields.issuerName = read(brand)
  else if (header) draft.fields.issuerName = toCheck(header)
  const reference = kind === "REPAIR_MAINTENANCE"
    ? labelled(lines, /\b(?:FACTURE|AVOIR)\s*(?:N°|NO|NUMERO|#)|\b(?:N°|NO|NUMERO)\s*(?:DE\s+)?FACTURE\b/, /([A-Z0-9][A-Z0-9/._-]{2,30})/, 100)
    : labelled(lines, /\b(?:TICKET|TRANSACTION|RECU)\s*(?:N°|NO|NUMERO|#)?|\b(?:N°|NO)\s*(?:DE\s+)?(?:TICKET|TRANSACTION)\b/, /(\d[A-Z0-9/._-]{2,30})/, 100)
  if (reference) draft.fields.referenceNumber = read(reference)
  const km = mileageIn(lines)
  if (km !== null) draft.fields.mileage = toCheck(km)
  const amount = amountIn(lines)
  if (amount) draft.observations.push(`Montant TTC lu : ${formatAmount(amount)}`)
  const litres = kind === "EXPENSE_RECEIPT" ? litresIn(lines) : null
  if (litres) draft.observations.push(`Volume lu : ${litres} L`)
  const plate = plateCheck(lines, truck.matricule)
  if (plate) draft.checks.push(plate)
  return draft
}

const RULES: Record<VehicleDocumentCategoryCode, (lines: string[], truck: RecognitionInput["truck"]) => Draft> = {
  REGISTRATION: registration,
  INSURANCE: insurance,
  TECHNICAL_INSPECTION: technicalInspection,
  REPAIR_MAINTENANCE: (lines, truck) => invoice(lines, truck, "REPAIR_MAINTENANCE"),
  EXPENSE_RECEIPT: (lines, truck) => invoice(lines, truck, "EXPENSE_RECEIPT"),
}

/** Champs autorisés par rubrique, alignés sur le formulaire : rien d'autre n'est proposé. */
const ALLOWED: Record<VehicleDocumentCategoryCode, readonly ProposedFieldKey[]> = {
  REGISTRATION: ["issuedOn", "issuerName", "referenceNumber"],
  INSURANCE: ["issuedOn", "validFrom", "validUntil", "issuerName", "referenceNumber"],
  TECHNICAL_INSPECTION: ["issuedOn", "validUntil", "issuerName", "referenceNumber"],
  REPAIR_MAINTENANCE: ["issuedOn", "issuerName", "referenceNumber", "mileage"],
  EXPENSE_RECEIPT: ["issuedOn", "issuerName", "referenceNumber", "mileage"],
}

/** Proposition pour une rubrique à partir du texte lu ; ne lève jamais d'erreur sur un texte quelconque. */
export function extractVehicleDocumentFields(input: RecognitionInput): Omit<RecognitionProposal, "reading"> {
  const lines = normalizeText(input.text.slice(0, 40_000)).slice(0, 400).map((line) => line.slice(0, 300))
  const draft = lines.length ? RULES[input.category](lines, input.truck) : { fields: {}, observations: [], checks: [] }
  const fields: ProposedFields = {}
  for (const key of ALLOWED[input.category]) {
    const field = draft.fields[key] as ProposedField<never> | undefined
    if (field) (fields as Record<string, ProposedField<unknown>>)[key] = input.lowConfidence ? toCheck(field.value) : field
  }
  const probable = probableCategory(lines)
  return { category: input.category, fields, observations: draft.observations.slice(0, 6), checks: draft.checks,
    otherCategory: probable && probable !== input.category ? probable : null }
}
