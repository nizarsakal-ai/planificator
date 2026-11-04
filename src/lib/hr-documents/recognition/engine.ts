/**
 * PLV2-DOC-RH-002 — reconnaissance locale d'un document RH. Produit une PROPOSITION que l'opérateur valide : jamais
 * de classement, de rattachement ni de création sans clic humain. Sources, de la plus sûre à la moins sûre :
 * bande MRZ (chiffres de contrôle), texte lu (couche texte PDF ou OCR local : mots-clés, libellés, dates), nom du fichier.
 * Le nom du fichier ne sert qu'à SUGGÉRER un type, une période ou un salarié existant, toujours marqué comme tel : il
 * ne remplit jamais un champ d'identité. Un champ non lu reste vide avec son motif. Aucune valeur n'est journalisée.
 */
import { categoryDefinition } from "../catalog"
import { parseMrz, type MrzResult } from "./mrz"
import type { Reading, ReadingStatus } from "./ocr"

export type Source = "MRZ" | "TEXT" | "FILENAME" | "EXTERNAL"
export type Field<T> = { value: T; confidence: number; source: Source }
export type EmployeeRef = { id: string; firstName: string; lastName: string; draft?: boolean }
export type PersonCandidate = { employeeId: string; level: "STRONG" | "PARTIAL"; draft: boolean }
export type IdentityKey = "lastName" | "firstNames" | "birthDate" | "sex" | "nationality" | "expiryDate"
/** Motif d'un champ vide : rien lu dans la pièce (et pourquoi), ou lu mais absent, ou absent du format de la pièce. */
export type MissingReason = "NO_TEXT" | "ENGINE_MISSING" | "TECHNICAL_FAILURE" | "UNREADABLE" | "NOT_FOUND" | "NOT_IN_FORMAT" | "UNCERTAIN"
export type ReadingSummary = Omit<Reading, "text">
export type IdentityProposal = {
  lastName: Field<string> | null
  firstNames: Field<string> | null
  birthDate: Field<string> | null
  sex: Field<"M" | "F"> | null
  nationality: Field<string> | null
  expiryDate: Field<string> | null
  /** 4 derniers caractères du numéro de pièce : le numéro complet n'est jamais renvoyé ni conservé. */
  documentNumberEnd: string | null
  mrzChecksValid: boolean | null
  missing: Partial<Record<IdentityKey, MissingReason>>
}
export type Proposal = {
  category: Field<string> | null
  period: Field<string> | null
  title: string | null
  candidates: PersonCandidate[]
  /** Renseigné seulement si un seul salarié correspond sans ambiguïté. */
  proposedEmployeeId: string | null
  /** D'où vient ce rapprochement : nom lu dans la pièce (MRZ, texte) ou seulement le nom du fichier. */
  personSource: Source | null
  /** Personne reconnue mais absente de la société : l'opérateur peut créer une fiche à compléter. */
  canCreateDraft: boolean
  identity: IdentityProposal | null
  sources: Source[]
  /** Faux quand rien n'a pu être lu dans le document lui-même (voir `reading` pour savoir pourquoi). */
  textFound: boolean
  reading: ReadingSummary
}

export function normalize(raw: string) {
  return raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[’'`]/g, " ").replace(/[^A-Z0-9<\n/.\- ]/g, " ")
}
const words = (s: string) => normalize(s).replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean)

type Rule = { code: string; text: RegExp[]; file: RegExp[] }
// Ordre important : le plus spécifique d'abord (un avenant parle aussi de « contrat de travail »).
const RULES: Rule[] = [
  { code: "AMENDMENT", text: [/\bAVENANT\b/], file: [/\bAVENANT\b/] },
  { code: "FINAL_SETTLEMENT", text: [/SOLDE DE TOUT COMPTE/], file: [/SOLDE DE TOUT COMPTE/, /\bSTC\b/] },
  { code: "WORK_CERTIFICATE", text: [/CERTIFICAT DE TRAVAIL/], file: [/CERTIFICAT DE TRAVAIL/] },
  { code: "EMPLOYER_CERTIFICATE", text: [/ATTESTATION (D )?EMPLOYEUR/, /FRANCE TRAVAIL/], file: [/ATTESTATION (D )?EMPLOYEUR/] },
  { code: "PAYSLIP", text: [/BULLETIN DE (PAIE|SALAIRE)/, /NET A PAYER/, /SALAIRE DE BASE/], file: [/BULLETIN/, /FICHE DE PAIE/, /\bPAIE\b/, /\bSALAIRE\b/] },
  { code: "CONTRACT", text: [/CONTRAT DE TRAVAIL/, /CONTRAT A DUREE (IN)?DETERMINEE/], file: [/\bCONTRAT\b/, /\bCDI\b/, /\bCDD\b/] },
  { code: "RESIDENCE_PERMIT", text: [/TITRE DE SEJOUR/, /CARTE DE RESIDENT/], file: [/TITRE DE SEJOUR/, /CARTE DE RESIDENT/] },
  { code: "PASSPORT", text: [/\bPASSEPORT\b/, /\bPASSPORT\b/], file: [/\bPASSEPORT\b/, /\bPASSPORT\b/] },
  { code: "DRIVING_LICENSE", text: [/PERMIS DE CONDUIRE/, /DRIVING LICEN[CS]E/], file: [/\bPERMIS\b/] },
  { code: "ID_CARD", text: [/CARTE NATIONALE D IDENTITE/, /IDENTITY CARD/], file: [/\bCNI\b/, /CARTE (NATIONALE )?D IDENTITE/, /PIECE D IDENTITE/] },
  { code: "SOCIAL_SECURITY", text: [/CARTE VITALE/, /ATTESTATION DE DROITS/, /ASSURANCE MALADIE/], file: [/\bVITALE\b/, /\bSECU\b/, /SECURITE SOCIALE/] },
  { code: "BANK_DETAILS", text: [/RELEVE D IDENTITE BANCAIRE/, /\bIBAN\b/], file: [/\bRIB\b/, /\bIBAN\b/] },
  { code: "HEALTH_INSURANCE", text: [/\bMUTUELLE\b/, /COMPLEMENTAIRE SANTE/], file: [/\bMUTUELLE\b/] },
  { code: "MEDICAL_VISIT", text: [/MEDECINE DU TRAVAIL/, /VISITE D INFORMATION ET DE PREVENTION/, /AVIS D APTITUDE/], file: [/VISITE MEDICALE/, /\bAPTITUDE\b/] },
  { code: "QUALIFICATION", text: [/\bCACES\b/, /HABILITATION ELECTRIQUE/, /\bDIPLOME\b/], file: [/\bCACES\b/, /HABILITATION/, /DIPLOME/] },
  { code: "PROOF_OF_ADDRESS", text: [/JUSTIFICATIF DE DOMICILE/, /ATTESTATION D HEBERGEMENT/], file: [/DOMICILE/, /HEBERGEMENT/] },
]
const CATEGORY_WORDS = new Set(["CNI", "CARTE", "NATIONALE", "IDENTITE", "PIECE", "PASSEPORT", "PASSPORT", "TITRE", "SEJOUR", "RESIDENT",
  "PERMIS", "CONDUIRE", "RIB", "IBAN", "BULLETIN", "FICHE", "PAIE", "SALAIRE", "CONTRAT", "CDI", "CDD", "AVENANT", "MUTUELLE", "VITALE",
  "SECU", "SECURITE", "SOCIALE", "CACES", "HABILITATION", "DIPLOME", "VISITE", "MEDICALE", "APTITUDE", "CERTIFICAT", "TRAVAIL",
  "SOLDE", "TOUT", "COMPTE", "STC", "ATTESTATION", "EMPLOYEUR", "JUSTIFICATIF", "DOMICILE", "HEBERGEMENT", "PHOTO",
  "DE", "DU", "DES", "LA", "LE", "LES", "ET", "D", "L", "SCAN", "COPIE", "RECTO", "VERSO", "DOC", "DOCUMENT", "PDF", "JPG", "JPEG", "PNG",
  "HEIC", "FINAL", "SIGNE", "MR", "MME", "M"])
const MONTHS = ["JANVIER", "FEVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOUT", "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DECEMBRE"]

export function fileNameStem(fileName: string) {
  return normalize(fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_.\-]+/g, " "))
}
/** Mots du nom de fichier qui ne sont ni un type de document, ni une date, ni un mot vide : nom de la personne. */
export function fileNameTokens(fileName: string) {
  return words(fileNameStem(fileName)).filter((w) => !CATEGORY_WORDS.has(w) && !MONTHS.includes(w) && !/\d/.test(w) && w.length > 1)
}

function categoryFromMrz(mrz: MrzResult): string | null {
  if (mrz.format === "TD3" && mrz.documentCode.startsWith("P")) return "PASSPORT"
  if (/^(IR|AR|RT|CR)/.test(mrz.documentCode) || mrz.documentCode.startsWith("A")) return "RESIDENCE_PERMIT"
  if (mrz.documentCode.startsWith("I") || mrz.documentCode.startsWith("C")) return "ID_CARD"
  return null
}
function categoryFrom(rules: "text" | "file", value: string): string | null {
  for (const rule of RULES) if (rule[rules].some((r) => r.test(value))) return rule.code
  return null
}
const monthOf = (iso: string) => iso.slice(0, 7)
function periodFromText(text: string): string | null {
  const range = /PERIODE\s+DU\s+(\d{2})[/.](\d{2})[/.](\d{4})/.exec(text)
  if (range) return `${range[3]}-${range[2]}`
  const named = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{4})\\b`).exec(text)
  if (named) return `${named[2]}-${String(MONTHS.indexOf(named[1]) + 1).padStart(2, "0")}`
  const numeric = /\b(0[1-9]|1[0-2])[/.](20\d{2})\b/.exec(text)
  return numeric ? `${numeric[2]}-${numeric[1]}` : null
}
function periodFromFileName(stem: string): string | null {
  const iso = /\b(20\d{2})\s(0[1-9]|1[0-2])\b/.exec(stem)
  if (iso) return `${iso[1]}-${iso[2]}`
  const fr = /\b(0[1-9]|1[0-2])\s(20\d{2})\b/.exec(stem)
  if (fr) return `${fr[2]}-${fr[1]}`
  const named = new RegExp(`\\b(${MONTHS.join("|")})\\s(20\\d{2})\\b`).exec(stem)
  return named ? `${named[2]}-${String(MONTHS.indexOf(named[1]) + 1).padStart(2, "0")}` : null
}

/** Rapprochement : nom complet → STRONG, nom de famille seul → PARTIAL. Homonymes : aucun salarié proposé. */
export function matchPeople(person: { lastName: string[]; firstNames: string[] } | { tokens: string[] }, employees: EmployeeRef[]): PersonCandidate[] {
  const out: PersonCandidate[] = []
  for (const e of employees) {
    const last = words(e.lastName), first = words(e.firstName)
    if (!last.length) continue
    let strong: boolean, partial: boolean
    if ("tokens" in person) {
      const set = new Set(person.tokens)
      partial = last.every((t) => set.has(t))
      strong = partial && first.length > 0 && set.has(first[0])
    } else {
      const lastSet = new Set(person.lastName), firstSet = new Set(person.firstNames)
      partial = last.every((t) => lastSet.has(t))
      strong = partial && first.length > 0 && firstSet.has(first[0])
    }
    if (strong || partial) out.push({ employeeId: e.id, level: strong ? "STRONG" : "PARTIAL", draft: !!e.draft })
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "STRONG" ? -1 : 1))
}

const title = (code: string | null, period: string | null, person: string | null) => {
  if (!code) return null
  const label = categoryDefinition(code)?.label ?? "Document RH"
  return [label, person, categoryDefinition(code)?.family === "IDENTITY" ? null : period].filter(Boolean).join(" — ").slice(0, 120)
}
const field = <T,>(value: T | null | undefined, confidence: number, source: Source): Field<T> | null =>
  value === null || value === undefined || value === "" ? null : { value, confidence, source }
const capitalize = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase())

// Libellés imprimés des pièces françaises et des passeports (texte normalisé : majuscules sans accents).
const LABELS: Record<IdentityKey, RegExp> = {
  lastName: /\b(NOM|SURNAME)\b(?!\s+D\s*USAGE)/,
  firstNames: /\b(PRENOMS?|GIVEN\s+NAMES?)\b/,
  birthDate: /\b(DATE\s+DE\s+NAISS\w*|NE\s*\(?E?\)?\s+LE|DATE\s+OF\s+BIRTH)\b/,
  sex: /\b(SEXE|SEX)\b/,
  nationality: /\b(NATIONALITE|NATIONALITY)\b/,
  expiryDate: /\b(DATE\s+D\s*EXPIR\w*|DATE\s+OF\s+EXPIRY|VALABLE\s+JUSQU\s*AU|EXPIRY)\b/,
}
const ANY_LABEL = new RegExp(Object.values(LABELS).map((r) => r.source).join("|") + "|\\b(CARTE|IDENTITE|IDENTITY|CARD|REPUBLIQUE|FRANCAISE|SIGNATURE|LIEU|PLACE|DOCUMENT|NO|N)\\b")
const DATE = /\b(0[1-9]|[12]\d|3[01])[ ./-]?(0[1-9]|1[0-2])[ ./-]?((?:19|20)\d{2})\b/
const NAME_VALUE = /^[A-Z][A-Z -]{1,60}$/

/** Valeur d'un libellé : sur la même ligne après le libellé, sinon sur la ligne suivante (mise en page en colonnes). */
function afterLabel(lines: string[], key: IdentityKey): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = LABELS[key].exec(lines[i])
    if (!m) continue
    out.push(lines[i].slice(m.index + m[0].length).replace(/^[\s/:.]+/, ""), lines[i + 1] ?? "")
  }
  return out
}
function isoDate(m: RegExpExecArray | null) {
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
  return d.getUTCDate() === Number(m[1]) ? d.toISOString().slice(0, 10) : null
}
/** Champs lus par leurs libellés imprimés (texte PDF ou OCR). Moins sûrs que la MRZ : confiance 0,65. */
export function readLabels(text: string): Partial<Record<IdentityKey, string>> {
  const lines = text.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)
  const out: Partial<Record<IdentityKey, string>> = {}
  for (const key of ["lastName", "firstNames"] as const) {
    for (const raw of afterLabel(lines, key)) {
      // Libellé bilingue (« NOM / SURNAME ») : on retire la traduction avant de lire la valeur.
      const value = raw.replace(new RegExp("^(" + LABELS[key].source + ")[\\s/:.]*"), "").replace(/[^A-Z -]/g, " ").replace(/\s+/g, " ").trim()
      if (value && NAME_VALUE.test(value) && !ANY_LABEL.test(value) && value.split(" ").length <= 4) { out[key] = value; break }
    }
  }
  for (const key of ["birthDate", "expiryDate"] as const) {
    for (const raw of afterLabel(lines, key)) { const iso = isoDate(DATE.exec(raw)); if (iso) { out[key] = iso; break } }
  }
  for (const raw of afterLabel(lines, "sex")) { const m = /(?:^|\s)([MF])(?:\s|$)/.exec(raw); if (m) { out.sex = m[1]; break } }
  for (const raw of afterLabel(lines, "nationality")) {
    if (/\bFRANCAISE\b/.test(raw)) { out.nationality = "FRA"; break }
    const m = /(?:^|\s)(?!SEX|NOM|NEE)([A-Z]{3})(?:\s|$)/.exec(raw)
    if (m) { out.nationality = m[1]; break }
  }
  return out
}

const READ_FAILURE: Partial<Record<ReadingStatus, MissingReason>> = { ENGINE_MISSING: "ENGINE_MISSING", TECHNICAL_FAILURE: "TECHNICAL_FAILURE", UNREADABLE: "UNREADABLE" }
const NAMES = new Set<IdentityKey>(["lastName", "firstNames"])
const KEYS: IdentityKey[] = ["lastName", "firstNames", "birthDate", "sex", "nationality", "expiryDate"]

/**
 * Choix par champ, du plus sûr au moins sûr. Dates : MRZ dont la zone est contrôlée, sinon libellé imprimé, sinon MRZ
 * non contrôlée (0,5). Noms, sexe, nationalité ne sont couverts par aucun chiffre de contrôle : sûrs seulement si la MRZ
 * et le libellé imprimé concordent ; en désaccord, le libellé (ce que l'opérateur voit sur la pièce) en « à vérifier ».
 * Le numéro (4 derniers caractères) n'est repris que si son chiffre de contrôle est juste.
 */
function identityFrom(mrz: MrzResult | null, labels: Partial<Record<IdentityKey, string>>, noText: MissingReason | null): IdentityProposal {
  const fromMrz: Partial<Record<IdentityKey, string | null>> = mrz
    ? { lastName: mrz.surname, firstNames: mrz.givenNames ? capitalize(mrz.givenNames) : null, birthDate: mrz.birthDate, sex: mrz.sex,
        nationality: mrz.nationality, expiryDate: mrz.expiryDate }
    : {}
  const controlled: Partial<Record<IdentityKey, boolean>> = mrz ? { birthDate: mrz.checks.birth, expiryDate: mrz.checks.expiry === true } : {}
  const id = { lastName: null, firstNames: null, birthDate: null, sex: null, nationality: null, expiryDate: null,
    documentNumberEnd: mrz?.checks.number ? mrz.documentNumberEnd : null, mrzChecksValid: mrz?.checksValid ?? null, missing: {} } as IdentityProposal
  for (const key of KEYS) {
    let m = fromMrz[key] ?? null
    // Nom réduit à des lettres isolées : ligne des noms mal lue (séparateur « << » perdu), pas une valeur à proposer.
    const uncertain = !!m && NAMES.has(key) && m.split(/\s+/).every((w) => w.length < 2)
    if (uncertain) m = null
    const l = key === "firstNames" && labels.firstNames ? capitalize(labels.firstNames) : labels[key] ?? null
    const agree = !!m && !!l && normalize(m).replace(/\s+/g, " ").trim() === normalize(l).replace(/\s+/g, " ").trim()
    let chosen: Field<string> | null
    if (key in controlled) chosen = m && controlled[key] ? field(m, 0.95, "MRZ") : l ? field(l, agree ? 0.8 : 0.65, "TEXT") : field(m, 0.5, "MRZ")
    // Les noms ne sont protégés par aucun chiffre de contrôle : sans libellé concordant, toujours « à vérifier ».
    else chosen = agree ? field(m, 0.95, "MRZ") : m && !l ? field(m, !mrz!.checksValid ? 0.5 : NAMES.has(key) ? 0.65 : 0.85, "MRZ") : l ? field(l, m ? 0.6 : 0.65, "TEXT") : null
    ;(id as Record<IdentityKey, unknown>)[key] = chosen
    if (!chosen) id.missing[key] = noText ?? (uncertain ? "UNCERTAIN" : key === "expiryDate" && mrz?.format === "FR_ID_LEGACY" ? "NOT_IN_FORMAT" : "NOT_FOUND")
  }
  return id
}

export function recognize(input: { text: string; fileName: string; employees: EmployeeRef[]; now?: Date; reading?: ReadingSummary }): Proposal {
  const text = normalize(input.text)
  const stem = fileNameStem(input.fileName)
  const mrz = parseMrz(text, input.now)
  const sources = new Set<Source>()
  const textFound = !!text.trim()
  const reading: ReadingSummary = input.reading ?? { status: textFound ? "TEXT_LAYER" : "UNREADABLE", reason: null, durationMs: 0, pages: 1,
    rotation: null, confidence: null, mrzFound: !!mrz }
  const noText: MissingReason | null = textFound ? null : READ_FAILURE[reading.status] ?? "NO_TEXT"

  let category: Field<string> | null = null
  const fromMrz = mrz ? categoryFromMrz(mrz) : null
  const fromText = textFound ? categoryFrom("text", text) : null
  const fromFile = categoryFrom("file", stem)
  if (fromMrz) category = { value: fromMrz, confidence: mrz!.checksValid ? 0.95 : 0.6, source: "MRZ" }
  else if (fromText) category = { value: fromText, confidence: fromFile === fromText ? 0.9 : 0.75, source: "TEXT" }
  else if (fromFile) category = { value: fromFile, confidence: 0.5, source: "FILENAME" }
  if (category) sources.add(category.source)
  const isIdentity = !!category && categoryDefinition(category.value)?.family === "IDENTITY"

  const labels = textFound ? readLabels(text) : {}
  const identity = mrz || isIdentity || labels.lastName ? identityFrom(mrz, labels, noText) : null
  if (mrz) sources.add("MRZ")
  if (identity && KEYS.some((k) => identity[k]?.source === "TEXT")) sources.add("TEXT")

  let candidates: PersonCandidate[] = []
  let personLabel: string | null = null
  if (identity?.lastName) {
    candidates = matchPeople({ lastName: words(identity.lastName.value), firstNames: words(identity.firstNames?.value ?? "") }, input.employees)
    personLabel = `${identity.lastName.value} ${capitalize((identity.firstNames?.value ?? "").split(" ")[0] ?? "")}`.trim()
  } else {
    // Rien lu dans la pièce : le nom du fichier peut désigner un salarié EXISTANT (suggestion marquée « nom du fichier »),
    // jamais remplir l'identité d'une nouvelle fiche.
    const tokens = fileNameTokens(input.fileName)
    if (tokens.length) {
      candidates = matchPeople({ tokens }, input.employees)
      if (candidates.length) { sources.add("FILENAME"); personLabel = tokens.join(" ") }
    }
  }

  const strong = candidates.filter((c) => c.level === "STRONG")
  const proposedEmployeeId = strong.length === 1 ? strong[0].employeeId : null
  const personSource: Source | null = proposedEmployeeId ? (identity?.lastName?.source ?? "FILENAME") : null

  let period: Field<string> | null = null
  if (identity?.expiryDate) period = { value: monthOf(identity.expiryDate.value), confidence: identity.expiryDate.confidence, source: identity.expiryDate.source }
  else {
    const p = textFound ? periodFromText(text) : null
    const f = periodFromFileName(stem)
    if (p) { period = { value: p, confidence: 0.75, source: "TEXT" }; sources.add("TEXT") }
    else if (f) period = { value: f, confidence: 0.5, source: "FILENAME" }
  }

  const named = proposedEmployeeId ? input.employees.find((e) => e.id === proposedEmployeeId) : undefined
  return {
    category, period,
    title: title(category?.value ?? null, period?.value ?? null, named ? `${named.lastName} ${named.firstName}` : personLabel),
    candidates, proposedEmployeeId, personSource,
    // Pièce d'identité sans salarié correspondant : la fiche reste possible, champs non lus à saisir par l'opérateur.
    canCreateDraft: isIdentity && strong.length === 0,
    identity, sources: [...sources], textFound, reading,
  }
}
