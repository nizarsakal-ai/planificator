/**
 * PLV2-DOC-RH-002 — reconnaissance locale d'un document RH. Produit une PROPOSITION que l'opérateur valide : jamais
 * de classement, de rattachement ni de création sans clic humain. Sources, de la plus sûre à la moins sûre :
 * bande MRZ (chiffres de contrôle), texte du PDF (mots-clés, dates), nom du fichier. Aucune valeur n'est journalisée.
 */
import { categoryDefinition } from "../catalog"
import { parseMrz, type MrzResult } from "./mrz"

export type Source = "MRZ" | "TEXT" | "FILENAME" | "EXTERNAL"
export type Field<T> = { value: T; confidence: number; source: Source }
export type EmployeeRef = { id: string; firstName: string; lastName: string; draft?: boolean }
export type PersonCandidate = { employeeId: string; level: "STRONG" | "PARTIAL"; draft: boolean }
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
}
export type Proposal = {
  category: Field<string> | null
  period: Field<string> | null
  title: string | null
  candidates: PersonCandidate[]
  /** Renseigné seulement si un seul salarié correspond sans ambiguïté. */
  proposedEmployeeId: string | null
  /** Personne reconnue mais absente de la société : l'opérateur peut créer une fiche à compléter. */
  canCreateDraft: boolean
  identity: IdentityProposal | null
  sources: Source[]
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

export function recognize(input: { text: string; fileName: string; employees: EmployeeRef[]; now?: Date }): Proposal {
  const text = normalize(input.text)
  const stem = fileNameStem(input.fileName)
  const mrz = parseMrz(text, input.now)
  const sources = new Set<Source>()

  let category: Field<string> | null = null
  const fromMrz = mrz ? categoryFromMrz(mrz) : null
  const fromText = text.trim() ? categoryFrom("text", text) : null
  const fromFile = categoryFrom("file", stem)
  if (fromMrz) category = { value: fromMrz, confidence: mrz!.checksValid ? 0.95 : 0.6, source: "MRZ" }
  else if (fromText) category = { value: fromText, confidence: fromFile === fromText ? 0.9 : 0.75, source: "TEXT" }
  else if (fromFile) category = { value: fromFile, confidence: 0.5, source: "FILENAME" }
  if (category) sources.add(category.source)

  let identity: IdentityProposal | null = null
  let candidates: PersonCandidate[] = []
  let personLabel: string | null = null
  if (mrz) {
    const c = mrz.checksValid ? 0.95 : 0.5
    identity = { lastName: field(mrz.surname, c, "MRZ"), firstNames: field(capitalize(mrz.givenNames), c, "MRZ"),
      birthDate: field(mrz.birthDate, c, "MRZ"), sex: field(mrz.sex, c, "MRZ"), nationality: field(mrz.nationality, c, "MRZ"),
      expiryDate: field(mrz.expiryDate, c, "MRZ"), documentNumberEnd: mrz.documentNumberEnd, mrzChecksValid: mrz.checksValid }
    candidates = matchPeople({ lastName: words(mrz.surname), firstNames: words(mrz.givenNames) }, input.employees)
    personLabel = `${mrz.surname} ${capitalize(mrz.givenNames.split(" ")[0] ?? "")}`.trim()
    sources.add("MRZ")
  } else {
    const tokens = fileNameTokens(input.fileName)
    if (tokens.length) {
      candidates = matchPeople({ tokens }, input.employees)
      if (candidates.length) sources.add("FILENAME")
      // Nom lu dans le fichier seulement : proposition faible, utile pour créer une fiche à compléter.
      if (category && categoryDefinition(category.value)?.family === "IDENTITY" && tokens.length >= 2) {
        const known = candidates.find((c) => c.level === "STRONG")
        const e = known ? input.employees.find((x) => x.id === known.employeeId) : undefined
        identity = e
          ? { lastName: field(e.lastName, 0.5, "FILENAME"), firstNames: field(e.firstName, 0.5, "FILENAME"), birthDate: null, sex: null,
              nationality: null, expiryDate: null, documentNumberEnd: null, mrzChecksValid: null }
          : { lastName: field(tokens[tokens.length - 1], 0.3, "FILENAME"), firstNames: field(capitalize(tokens.slice(0, -1).join(" ")), 0.3, "FILENAME"),
              birthDate: null, sex: null, nationality: null, expiryDate: null, documentNumberEnd: null, mrzChecksValid: null }
      }
      personLabel = tokens.join(" ")
    }
  }

  const strong = candidates.filter((c) => c.level === "STRONG")
  const proposedEmployeeId = strong.length === 1 ? strong[0].employeeId : null
  const isIdentity = !!category && categoryDefinition(category.value)?.family === "IDENTITY"

  let period: Field<string> | null = null
  if (identity?.expiryDate) period = { value: monthOf(identity.expiryDate.value), confidence: identity.expiryDate.confidence, source: identity.expiryDate.source }
  else {
    const p = text.trim() ? periodFromText(text) : null
    const f = periodFromFileName(stem)
    if (p) { period = { value: p, confidence: 0.75, source: "TEXT" }; sources.add("TEXT") }
    else if (f) period = { value: f, confidence: 0.5, source: "FILENAME" }
  }

  const named = proposedEmployeeId ? input.employees.find((e) => e.id === proposedEmployeeId) : undefined
  return {
    category, period,
    title: title(category?.value ?? null, period?.value ?? null, named ? `${named.lastName} ${named.firstName}` : personLabel),
    candidates, proposedEmployeeId,
    canCreateDraft: isIdentity && !!identity?.lastName && !!identity?.firstNames && strong.length === 0,
    identity, sources: [...sources],
  }
}
