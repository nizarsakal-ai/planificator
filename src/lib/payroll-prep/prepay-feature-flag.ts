// Lot H Planificator V2 : pré-paie. Désactivée par défaut. Le module prépare des variables de paie
// (heures, absences, primes, frais) ; il ne calcule ni salaire,
// ni cotisation, ne produit aucun bulletin et ne dépose aucune DSN. Aucune activation de paie réelle.
// Pilote du 20/11/2026 : le module n'existe en plus que pour UNE société, désignée côté serveur par PAYROLL_PREP_COMPANY_ID
// (identifiant interne exact, sans espace, liste, joker ni slug ; absent, vide ou malformé ⇒ module fermé pour tous).
type Env = Record<string, string | undefined>
export const PAYROLL_PREP_FLAG_NAME = "PAYROLL_PREP_ENABLED"
export const PAYROLL_PREP_PILOT_FLAG_NAME = "PAYROLL_PREP_PILOT_ENABLED"
export const PAYROLL_PREP_COMPANY_ID_NAME = "PAYROLL_PREP_COMPANY_ID"
/** Forme admise d'un identifiant interne de société (même alphabet que les identifiants des routes du module). */
const PILOT_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/
export function isPayrollPrepEnabled(env: Env = process.env): boolean {
  // Le drapeau du pilote est inconnu des versions antérieures à la restriction par société.
  return env[PAYROLL_PREP_FLAG_NAME] === "true" || env[PAYROLL_PREP_PILOT_FLAG_NAME] === "true"
}
/** Société pilote du module activé, lue telle quelle. */
export function readPayrollPrepPilotCompanyId(env: Env = process.env): string | null {
  if (!isPayrollPrepEnabled(env)) return null
  const raw = env[PAYROLL_PREP_COMPANY_ID_NAME]
  return typeof raw === "string" && PILOT_COMPANY_ID.test(raw) ? raw : null
}
/** Drapeau actif et société exactement égale à la société pilote. */
export function isPayrollPrepEnabledForCompany(companyId: unknown, env: Env = process.env): boolean {
  return typeof companyId === "string" && companyId === readPayrollPrepPilotCompanyId(env)
}
