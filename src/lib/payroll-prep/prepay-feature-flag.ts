// Lot H Planificator V2 : pré-paie. Désactivée par défaut : sans PAYROLL_PREP_ENABLED="true", ni page, ni action, ni
// export (404). Ce module prépare des VARIABLES de paie (heures, absences, primes, frais) ; il ne calcule ni salaire,
// ni cotisation, ne produit aucun bulletin et ne dépose aucune DSN. Aucune activation de paie réelle.
type Env = Record<string, string | undefined>
export const PAYROLL_PREP_FLAG_NAME = "PAYROLL_PREP_ENABLED"
export function isPayrollPrepEnabled(env: Env = process.env): boolean {
  return env[PAYROLL_PREP_FLAG_NAME] === "true"
}
