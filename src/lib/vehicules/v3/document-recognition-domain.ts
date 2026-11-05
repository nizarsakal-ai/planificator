/**
 * Véhicules V3 — reconnaissance des pièces : règles d'extraction pures (aucun Prisma, aucun réseau, aucun moteur OCR).
 * Le texte lu (couche texte du PDF ou OCR local) devient une PROPOSITION de champs que l'opérateur relit et corrige :
 * la pièce reste « à vérifier » jusqu'au clic humain, aucune dépense n'est créée, le compteur n'est jamais touché.
 *
 * Minimisation : seuls les champs déjà prévus par la rubrique sont proposés. L'adresse du titulaire (C.3) n'est jamais
 * proposée : le titulaire (C.1) est coupé au code suivant quelle que soit sa ponctuation (« C.3: », « (C.3) », collé,
 * lignes fusionnées) et, s'il reste un fragment d'adresse, rien n'est proposé. Le texte brut ne sort jamais de ce module.
 * Aucune valeur n'est journalisée.
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
  /**
   * Ticket ou facture de dépense (`EXPENSE_RECEIPT`) : valeurs structurées pour préremplir une dépense, en plus des
   * observations (inchangées). Absent pour les autres rubriques. Aucune valeur n'est déduite si elle n'est pas lue.
   */
  expense?: ExpenseReading | null
}

/**
 * Valeurs d'un ticket de dépense. Montant : total TTC lu (`READ`) ou total sans mention TTC (`TO_CHECK`, `ttc` faux) ;
 * jamais un montant HT ni de TVA. Devise : lue seulement si une seule devise figure sur le ticket ; absente
 * (`UNKNOWN`) ou plusieurs (`CONFLICT`) : signalée, jamais supposée ni convertie.
 */
export interface ExpenseReading {
  amount?: ProposedField<string> & { ttc: boolean }
  /** AMBIGUOUS : symbole « $ » sans pays (USD, CAD, AUD…). */
  currency: { value: string | null; status: "READ" | "UNKNOWN" | "CONFLICT" | "AMBIGUOUS" }
  /** Le ticket nomme explicitement un carburant (gazole, SP95…) ; sinon ni catégorie Carburant ni litres. */
  fuel: boolean
  /** Avoir, remboursement, total ou volume négatif : jamais repris comme une dépense positive. */
  refund?: true
  litres?: ProposedField<string>
  date?: ProposedField<string>
  supplier?: ProposedField<string>
  reference?: ProposedField<string>
  mileage?: ProposedField<number>
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
/** Marque hors taxes ou de taxe : « HT », « H.T. », « HORS TAXES », « TVA » (« TOUTES TAXES » reste un TTC). */
const NOT_TTC = /\bH\.?\s?T\.?(?![A-Z])|\bHORS\s+TAXES?\b|\bTVA\b/
const TTC_MARK = /\bT\.?\s?T\.?\s?C\.?(?![A-Z])|\bTOUTES\s+TAXES\b|\bNET\s+A\s+PAYER\b|\bA\s+PAYER\b|\bREGLE\b/
/**
 * Montant TTC : libellé fort (TTC, net à payer…) d'abord ; « TOTAL » ou « MONTANT » seuls ensuite, qualifiés de total
 * « TTC non indiqué ». Le texte qui précède le montant retenu — sur la ligne du libellé OU sur la ligne suivante quand le
 * montant y est lu — ne doit porter aucune marque HT/TVA : « TOTAL » puis « HT 100,00 » n'est jamais un TTC.
 */
function amountIn(lines: string[]): { value: string; ttc: boolean; negative: boolean } | null {
  let weak: { value: string; negative: boolean } | null = null
  const valueOf = (m: RegExpExecArray) => `${m[1].replace(/[ .]/g, "")},${m[2]}`
  for (let i = 0; i < lines.length; i++) {
    const label = TOTAL_LABEL.exec(lines[i])
    if (!label) continue
    const before = lines[i].slice(0, label.index)
    if (NOT_TTC.test(label[0]) || NOT_TTC.test(before)) continue
    const rest = lines[i].slice(label.index + label[0].length)
    let match = AMOUNT.exec(rest)
    let prefix = match ? rest.slice(0, match.index) : rest
    let after = match ? rest.slice(match.index + match[0].length) : ""
    if (!match && lines[i + 1]) {
      // Montant de la ligne suivante : tout ce qui le précède sur cette ligne compte aussi (« HT 100,00 »).
      match = AMOUNT.exec(lines[i + 1])
      if (match) { prefix = `${rest} ${lines[i + 1].slice(0, match.index)}`; after = lines[i + 1].slice(match.index + match[0].length) }
    }
    if (!match) continue
    // « TOTAL 100,00 HT » : la marque peut suivre le montant.
    if (NOT_TTC.test(prefix) || /^\s*(?:€|EUR|EUROS?)?\s*\(?\s*(?:H\.?\s?T\.?(?![A-Z])|HORS\s+TAXES?)/.test(after)) continue
    // Signe : même préfixe que la marque HT/TTC (ligne du libellé, ou ligne suivante), terminé par « - » ou « − ».
    const negative = /[-−]\s*$/.test(prefix)
    const strong = !/^TOTAL$|^MONTANT$/.test(label[1]) || TTC_MARK.test(prefix) || /^\s*(?:€|EUR|EUROS?)?\s*\(?\s*T\.?\s?T\.?\s?C/.test(after)
    if (strong) return { value: valueOf(match), ttc: true, negative }
    weak ??= { value: valueOf(match), negative }
  }
  return weak ? { value: weak.value, ttc: false, negative: weak.negative } : null
}
/** Montant lu suivi de SA devise : « € » seulement si l'euro est lu ; sinon le code lu, ou « devise à vérifier ». */
const formatAmount = (value: string, currency: ExpenseReading["currency"]) => {
  const [units, cents] = value.split(",")
  const unit = currency.status !== "READ" ? " (devise à vérifier)" : currency.value === "EUR" ? " €" : ` ${currency.value}`
  return `${units.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${cents}${unit}`
}

/**
 * Devises écrites sur le ticket : code ou symbole sans ambiguïté. Le dollar n'est reconnu qu'avec son pays (USD, US$,
 * CAD, C$, CA$, AUD, A$, AU$) ; un « $ » seul est AMBIGU (dollar de quel pays ?). Rien n'est supposé ni converti.
 */
const CURRENCY_MARKS: [string, RegExp][] = [
  ["EUR", /€|\bEUR\b|\bEUROS?\b/], ["CHF", /\bCHF\b/], ["GBP", /£|\bGBP\b/],
  ["USD", /\bUSD\b|\bUS\$/], ["CAD", /\bCAD\b|\bCA?\$/], ["AUD", /\bAUD\b|\bAU?\$/],
]
const DOLLARS = new Set(["USD", "CAD", "AUD"])
function currencyIn(lines: string[]): ExpenseReading["currency"] {
  let text = lines.join("\n")
  const found: string[] = []
  for (const [code, mark] of CURRENCY_MARKS) {
    if (!mark.test(text)) continue
    found.push(code)
    text = text.replace(new RegExp(mark.source, "g"), " ")
  }
  // « $ » restant après retrait des dollars qualifiés : seul, ambigu ; avec un seul dollar qualifié, cohérent.
  const bareDollar = text.includes("$")
  if (bareDollar && !found.length) return { value: null, status: "AMBIGUOUS" }
  if (bareDollar && !(found.length === 1 && DOLLARS.has(found[0]))) return { value: null, status: "CONFLICT" }
  return found.length === 1 ? { value: found[0], status: "READ" } : { value: null, status: found.length ? "CONFLICT" : "UNKNOWN" }
}

/** Indice carburant explicite (jamais l'enseigne seule, ni « TOTAL TTC », ni une unité générique ; AdBlue exclu). */
const FUEL_HINT = /\b(GAZOLE|GASOIL|DIESEL|SP ?95(?:[- ]?E10)?|SP ?98|E10|E85|SANS PLOMB|SUPERCARBURANT|SUPERETHANOL|GPLC?|B7|B10|HVO|XTL|CARBURANT)\b/
const LITRES_WITH_UNIT = /\b(\d{1,4})[,.](\d{1,3})\s?(?:L|LITRES?|LTR)\b/
/**
 * Litres de CARBURANT pour une dépense : sur la ligne du carburant avec l'unité, ou sur une ligne « volume / quantité »
 * avec l'unité quand le ticket nomme un carburant. Jamais une quantité sans unité, jamais sans indice carburant.
 */
function fuelLitresIn(lines: string[]): string | null {
  if (!lines.some((line) => FUEL_HINT.test(line))) return null
  const candidates = [...lines.filter((line) => FUEL_HINT.test(line)), ...lines.filter((line) => /\b(VOLUME|QUANTITE|QTE)\b/.test(line))]
  for (const line of candidates) {
    const match = LITRES_WITH_UNIT.exec(line)
    if (match && Number(match[1]) > 0 && Number(match[1]) < 2000) return `${match[1]},${match[2]}`
  }
  return null
}

/**
 * Avoir ou remboursement : titre « AVOIR » en début de ligne, « facture d'avoir », « note de crédit », remboursement
 * (hors mentions négatives du type « pas de remboursement », « non remboursable »), ou total / volume NÉGATIF. Une
 * remise négative sur un article d'un panier au total positif n'en est pas un.
 */
const REFUND_WORD = /^(?:FACTURE D'?)?AVOIR\b|\bFACTURE D'AVOIR\b|\bNOTE DE CREDIT\b|\bREMBOURSE(?:MENT|E)?\b/
const REFUND_DENIED = /\b(?:PAS DE|AUCUN|NI|NON|SANS)\s+(?:[A-Z']+\s+){0,2}REMBOURS|\bNON REMBOURSABLES?\b/
const NEGATIVE_TOTAL = /^(?!.*\b(?:REMISE|SOUS[- ]TOTAL)\b).*\b(?:TOTAL|MONTANT|NET A PAYER)\b.*(?:^|[\s:])[-−]\s?\d/
const NEGATIVE_VOLUME = /\b(?:VOLUME|QUANTITE|QTE)\b.*[-−]\s?\d|[-−]\s?\d{1,4}[,.]\d{1,3}\s?(?:L|LITRES?|LTR)\b/
function refundIn(lines: string[]): boolean {
  return lines.some((line) => (REFUND_WORD.test(line) && !REFUND_DENIED.test(line)) || NEGATIVE_TOTAL.test(line) || NEGATIVE_VOLUME.test(line))
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

/** Ligne de somme, de taxe ou de paiement : un nom d'enseigne qui y figure (« TOTAL ») n'est pas l'émetteur. */
const SUM_LINE = /\b(TTC|T\.T\.C|HT|H\.T|TVA|A PAYER|MONTANT|SOUS[- ]TOTAL|NET|REMISE|PAIEMENT|ESPECES|RENDU)\b|\d+[,.]\d{2}\b/

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

/**
 * Début du code de rubrique suivant dans une valeur : « C.3 », « C.3: », « C.3 : », « (C.3) », « C,3 », « C3 », collé
 * (« FICTIVEC.3: ») ou après une ligne OCR fusionnée ; aussi les autres codes du certificat (D.1, E, F.1, G, J, K, P.1…).
 * L'adresse du titulaire (C.3) n'est jamais conservée : tout ce qui suit un code est écarté.
 */
const NEXT_CODE = new RegExp([
  // C.x, D.x, F.x, P.x, S.x, V.x, X.x, Y.x, Z.x avec point, virgule ou deux-points, collés ou non au mot précédent.
  String.raw`[CDFPSVXYZ]\s?[.,:]\s?\d`,
  // Mêmes codes sans ponctuation (« C3 ») : isolés.
  String.raw`(?:^|[^A-Z0-9])[CDFPSVXYZ]\d(?![A-Z0-9])`,
  // Codes d'une lettre (E, G, H, J, K, Q, U) isolés et suivis d'un séparateur de rubrique.
  String.raw`(?:^|\s|\()[EGHJKQU]\s?[).:]`,
  String.raw`(?:^|\s)[EGHJKQU](?:\s|$)`,
  // Code entre parenthèses quel qu'il soit : « (C.3) », « (C 3) ».
  String.raw`\(\s?[A-Z]\s?[.,]?\s?\d?\s?\)`,
].join("|"))
export function cutAtNextCode(value: string): string {
  const match = NEXT_CODE.exec(value)
  return match ? value.slice(0, match.index) : value
}

/** Fragment d'adresse : numéro + type de voie, code postal, boîte postale, ou type de voie seul. */
const ADDRESS = /\b\d{5}\b|\b\d{1,4}\s?(?:BIS|TER)?\s*,?\s*(?:RUE|AV|AVE|AVENUE|BD|BLVD|BOULEVARD|CHEMIN|CHE|ALLEE|IMPASSE|IMP|PLACE|PL|ROUTE|RTE|QUAI|COURS|SQUARE|PASSAGE|RESIDENCE|LOTISSEMENT|LIEU[- ]DIT|HAMEAU|ZA|ZI|ZAC)\b|\b(?:RUE|AVENUE|BOULEVARD|CHEMIN|ALLEE|IMPASSE|QUAI|LIEU[- ]DIT|BP|CEDEX|CS)\b/
export function looksLikeAddress(value: string): boolean {
  return ADDRESS.test(value)
}

/** Titulaire (C.1) proposé seulement s'il est sûr : coupé au code suivant, sans fragment d'adresse ni chiffre en tête. */
function holderName(raw: string): string | null {
  const cut = cutAtNextCode(raw)
  // Le reste après la coupe est ignoré ; si la partie conservée ressemble encore à une adresse, rien n'est proposé.
  if (looksLikeAddress(cut)) return null
  const value = clean(cut, 120)
  return value.length >= 2 && !/^\d/.test(value) && /[A-Z]{2}/.test(value) ? value : null
}
/** Un code d'une lettre (« B », « I ») apparaît aussi dans le texte courant : on retient la première occurrence datée. */
const codedDate = (lines: string[], code: string) => codedFields(lines, code).map((value) => datesIn(value)[0]).find(Boolean) ?? null

function registration(lines: string[], truck: RecognitionInput["truck"]): Draft {
  const draft: Draft = { fields: {}, observations: [], checks: [] }
  // « I » est souvent lu « | », « l » ou « 1 » par l'OCR : variantes admises en début de ligne, suivies d'une date.
  const issuedOn = codedDate(lines, "I") ?? lines.map((line) => /^[|L1!]\)?\s*[:.]?\s+(.+)$/.exec(line)?.[1]).map((value) => value && /^\d/.test(value) ? datesIn(value)[0] : undefined).find(Boolean) ?? null
  if (issuedOn) draft.fields.issuedOn = read(issuedOn)
  const firstOn = codedDate(lines, "B")
  if (firstOn) draft.observations.push(`1re immatriculation (B) : ${formatFr(firstOn)}`)
  // C.1 : titulaire. Coupé avant tout code suivant (C.3 = adresse, jamais lue ni renvoyée) ; ambigu = rien proposé.
  const holder = codedField(lines, "C.1")
  const value = holder === null ? null : holderName(holder)
  if (value) draft.fields.issuerName = toCheck(value)
  const formula = /\b((?:19|20)\d{2}\s?[A-Z]{2}\s?\d{5})\b/.exec(lines.join(" "))
  if (formula) draft.fields.referenceNumber = read(formula[1].replace(/\s/g, ""))
  const platePreferred = codedFields(lines, "A").map((value) => platesIn([value])[0]).find(Boolean) ?? null
  const plateResult = plateCheck(lines, truck.matricule, platePreferred)
  if (plateResult) draft.checks.push(plateResult)
  const brand = codedField(lines, "D.1")
  const brandCut = brand ? cutAtNextCode(brand) : null
  const brandValue = brandCut && !looksLikeAddress(brandCut) ? clean(brandCut, 60) : null
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
  // Enseigne : jamais lue sur une ligne de somme ou de taxe (« TOTAL TTC 100,00 » n'est pas l'enseigne TOTAL).
  const brand = kind === "EXPENSE_RECEIPT" ? brandIn(lines.filter((line) => !SUM_LINE.test(line)), FUEL_BRANDS) : null
  const header = headerName(lines)
  if (brand) draft.fields.issuerName = read(brand)
  else if (header) draft.fields.issuerName = toCheck(header)
  const reference = kind === "REPAIR_MAINTENANCE"
    ? labelled(lines, /\b(?:FACTURE|AVOIR)\s*(?:N°|NO|NUMERO|#)|\b(?:N°|NO|NUMERO)\s*(?:DE\s+)?FACTURE\b/, /([A-Z0-9][A-Z0-9/._-]{2,30})/, 100)
    : labelled(lines, /\b(?:TICKET|TRANSACTION|RECU)\s*(?:N°|NO|NUMERO|#)?|\b(?:N°|NO)\s*(?:DE\s+)?(?:TICKET|TRANSACTION)\b/, /(\d[A-Z0-9/._-]{2,30})/, 100)
  if (reference) draft.fields.referenceNumber = read(reference)
  const km = mileageIn(lines)
  if (km !== null) draft.fields.mileage = toCheck(km)
  const amount = amountIn(lines), currency = currencyIn(lines)
  // Avoir ou remboursement : le montant lu n'est pas une dépense ; dit comme tel, sans signe deviné.
  if (amount && (refundIn(lines) || amount.negative)) draft.observations.push(`Avoir ou remboursement, à traiter séparément : montant lu ${formatAmount(amount.value, currency)}`)
  else if (amount) draft.observations.push(amount.ttc ? `Montant TTC lu : ${formatAmount(amount.value, currency)}` : `Montant total lu (TTC non indiqué, à vérifier) : ${formatAmount(amount.value, currency)}`)
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
    otherCategory: probable && probable !== input.category ? probable : null,
    ...(input.category === "EXPENSE_RECEIPT" ? { expense: expenseReading(lines, fields, !!input.lowConfidence) } : {}) }
}

/**
 * Valeurs structurées d'un ticket : mêmes règles de lecture que les observations (montant TTC prioritaire, jamais HT ni
 * TVA ; litres) et mêmes champs que la proposition (date, fournisseur, référence, kilométrage). Lecture peu sûre :
 * tout passe « à vérifier ». Le montant n'est pas porteur de devise : celle-ci est lue à part, jamais supposée.
 */
function expenseReading(lines: string[], fields: ProposedFields, lowConfidence: boolean): ExpenseReading {
  const level = <T>(value: T, sure: boolean): ProposedField<T> => sure && !lowConfidence ? read(value) : toCheck(value)
  const fuel = lines.some((line) => FUEL_HINT.test(line))
  // Total retenu négatif (même lecture que le montant : signe collé, après « : » ou sur la ligne suivante) = avoir.
  const totalRead = lines.length ? amountIn(lines) : null
  const out: ExpenseReading = { currency: currencyIn(lines), fuel, ...(refundIn(lines) || totalRead?.negative ? { refund: true } : {}) }
  // Avoir ou remboursement : ni montant ni litres proposés (jamais une dépense positive) ; l'observation le dit.
  const amount = out.refund ? null : totalRead
  if (amount) out.amount = { ...level(amount.value, amount.ttc), ttc: amount.ttc }
  // Litres de carburant seulement (indice carburant + unité) : une quantité d'eau ou sans unité n'en est pas.
  const litres = fuel && !out.refund ? fuelLitresIn(lines) : null
  if (litres) out.litres = level(litres, true)
  if (fields.issuedOn) out.date = fields.issuedOn
  if (fields.issuerName) out.supplier = fields.issuerName
  if (fields.referenceNumber) out.reference = fields.referenceNumber
  if (fields.mileage) out.mileage = fields.mileage
  return out
}
