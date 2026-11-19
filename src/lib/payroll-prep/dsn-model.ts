/**
 * Lot H Planificator V2 : MODÈLE DSN — structure et contrôle de FORMAT seulement.
 *
 * Ce module ne dépose rien, ne calcule aucune cotisation, n'est branché sur aucune donnée réelle (il ne prend que
 * l'entrée qu'on lui fournit ; les tests utilisent un jeu synthétique) et force le code d'envoi « essai ». Il sert à
 * préparer la qualification réglementaire, pas à la remplacer.
 *
 * Le catalogue de rubriques ci-dessous est un SOUS-ENSEMBLE INDICATIF (identifiants « Sxx.Gxx.xx.xxx », formats
 * généraux) : libellés, codes de valeur et obligations sont À VÉRIFIER contre le cahier technique DSN en vigueur
 * (net-entreprises.fr) avant tout usage. Les contrôles de clé (SIREN, SIRET : formule de Luhn ; NIR : clé 97) sont des
 * règles publiques générales ; leur réussite ne vaut pas conformité de la déclaration.
 */
export type RubricFormat = "TEXT" | "DIGITS" | "DATE" | "AMOUNT" | "CODE" | "SIREN" | "NIC" | "NIR"
export interface RubricDef { id: string; label: string; format: RubricFormat; min: number; max: number; codes?: readonly string[] }

/** Sous-ensemble indicatif, à qualifier (voir l'en-tête). */
export const RUBRICS: readonly RubricDef[] = Object.freeze([
  { id: "S10.G00.00.001", label: "Nom du logiciel (à qualifier)", format: "TEXT", min: 1, max: 20 },
  { id: "S10.G00.00.002", label: "Nom de l'éditeur (à qualifier)", format: "TEXT", min: 1, max: 20 },
  { id: "S10.G00.00.003", label: "Version du logiciel (à qualifier)", format: "TEXT", min: 1, max: 20 },
  { id: "S10.G00.00.005", label: "Code d'envoi : essai (forcé par ce modèle ; code à qualifier)", format: "CODE", min: 2, max: 2, codes: ["01"] },
  { id: "S10.G00.01.001", label: "SIREN de l'émetteur", format: "SIREN", min: 9, max: 9 },
  { id: "S10.G00.01.002", label: "NIC de l'émetteur", format: "NIC", min: 5, max: 5 },
  { id: "S20.G00.05.001", label: "Nature de la déclaration (à qualifier)", format: "CODE", min: 2, max: 2, codes: ["01"] },
  { id: "S20.G00.05.005", label: "Mois principal déclaré (JJMMAAAA, 1er du mois)", format: "DATE", min: 8, max: 8 },
  { id: "S21.G00.06.001", label: "SIREN de l'entreprise", format: "SIREN", min: 9, max: 9 },
  { id: "S21.G00.11.001", label: "NIC de l'établissement", format: "NIC", min: 5, max: 5 },
  { id: "S21.G00.30.001", label: "NIR de l'individu", format: "NIR", min: 15, max: 15 },
  { id: "S21.G00.30.002", label: "Nom de famille", format: "TEXT", min: 1, max: 80 },
  { id: "S21.G00.30.004", label: "Prénoms", format: "TEXT", min: 1, max: 80 },
  { id: "S21.G00.30.006", label: "Date de naissance (JJMMAAAA)", format: "DATE", min: 8, max: 8 },
  { id: "S21.G00.51.001", label: "Début de la période de paie (JJMMAAAA)", format: "DATE", min: 8, max: 8 },
  { id: "S21.G00.51.002", label: "Fin de la période de paie (JJMMAAAA)", format: "DATE", min: 8, max: 8 },
  { id: "S21.G00.51.013", label: "Montant (à qualifier ; aucun calcul de paie dans ce modèle)", format: "AMOUNT", min: 4, max: 15 },
] as const satisfies readonly RubricDef[])
const BY_ID = new Map(RUBRICS.map((r) => [r.id, r]))

export interface DsnLine { id: string; value: string }
export interface DsnIssue { line: number; id: string; message: string }

/** Formule de Luhn (SIREN, SIRET). */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}
/** NIR : 13 caractères + clé sur 2 chiffres = 97 − (nombre mod 97) ; Corse : 2A → 19, 2B → 18 pour le calcul. */
export function nirValid(nir: string): boolean {
  const m = /^([12])(\d{2})(\d{2})(\d{2}|2A|2B)(\d{3})(\d{3})(\d{2})$/.exec(nir)
  if (!m) return false
  const body = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`.replace("2A", "19").replace("2B", "18")
  const key = 97 - Number(BigInt(body) % BigInt(97)) // portage 90ae644 : pas de littéral BigInt (cible ES2017)
  return key === Number(m[7])
}
function dateValid(v: string): boolean {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(v)
  if (!m) return false
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 1900 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** Contrôle d'une valeur selon sa rubrique ; message vide si conforme AU FORMAT. */
export function checkValue(r: RubricDef, v: string): string {
  // eslint-disable-next-line no-control-regex
  if (/['\u0000-\u001f\u007f]/.test(v)) return "caractère interdit (apostrophe ou caractère de contrôle)"
  if (v.length < r.min || v.length > r.max) return `longueur ${v.length} hors de ${r.min} à ${r.max}`
  switch (r.format) {
    case "DIGITS": return /^\d+$/.test(v) ? "" : "chiffres attendus"
    case "DATE": return dateValid(v) ? "" : "date JJMMAAAA invalide"
    case "AMOUNT": return /^-?\d{1,12}\.\d{2}$/.test(v) ? "" : "montant attendu avec deux décimales (ex. 1234.50)"
    case "CODE": return r.codes?.includes(v) ? "" : `code attendu parmi ${r.codes?.join(", ")}`
    case "SIREN": return /^\d{9}$/.test(v) && luhnValid(v) ? "" : "SIREN invalide (9 chiffres, clé de Luhn)"
    case "NIC": return /^\d{5}$/.test(v) ? "" : "NIC invalide (5 chiffres)"
    case "NIR": return nirValid(v) ? "" : "NIR invalide (format ou clé)"
    default: return ""
  }
}

/** Contrôle de format d'une suite de lignes : rubriques connues, valeurs conformes, SIRET (SIREN + NIC) valide. */
export function validateDsn(lines: readonly DsnLine[]): DsnIssue[] {
  const issues: DsnIssue[] = []
  lines.forEach((l, i) => {
    const r = BY_ID.get(l.id)
    if (!r) { issues.push({ line: i + 1, id: l.id, message: "rubrique hors du sous-ensemble du modèle" }); return }
    const m = checkValue(r, l.value)
    if (m) issues.push({ line: i + 1, id: l.id, message: m })
  })
  const get = (id: string) => lines.find((l) => l.id === id)?.value
  for (const [siren, nic, label] of [["S10.G00.01.001", "S10.G00.01.002", "émetteur"], ["S21.G00.06.001", "S21.G00.11.001", "établissement"]] as const) {
    const s = get(siren), n = get(nic)
    if (!s || !n) issues.push({ line: 0, id: s ? nic : siren, message: `rubrique obligatoire du modèle absente (${label})` })
    else if (/^\d{9}$/.test(s) && /^\d{5}$/.test(n) && !luhnValid(`${s}${n}`)) issues.push({ line: 0, id: nic, message: `SIRET ${label} invalide (clé de Luhn)` })
  }
  if (get("S10.G00.00.005") !== "01") issues.push({ line: 0, id: "S10.G00.00.005", message: "le modèle n'admet que l'envoi d'essai" })
  return issues
}

/** Rendu textuel « rubrique,'valeur' » une ligne par rubrique (forme générale, à qualifier). Refuse un modèle invalide. */
export function renderDsn(lines: readonly DsnLine[]): { ok: true; text: string } | { ok: false; issues: DsnIssue[] } {
  const issues = validateDsn(lines)
  if (issues.length) return { ok: false, issues }
  return { ok: true, text: `${lines.map((l) => `${l.id},'${l.value}'`).join("\n")}\n` }
}

/** Mention obligatoire de tout affichage ou export issu de ce modèle. */
export const DSN_DISCLAIMER = "Modèle DSN d'essai : contrôle de format seulement, sur sous-ensemble indicatif de rubriques à qualifier. Aucun dépôt, aucune cotisation calculée, aucune conformité réglementaire revendiquée."
