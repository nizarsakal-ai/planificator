// Lot F Planificator V2 : cible serveur COMMUNE du pilote (assistant et centre de connecteurs), module pur sans import.
// Un seul identifiant interne de société, lu tel quel (aucun trim, liste, joker ni slug) ; absent, vide ou malformé ⇒ null.
// Chaque module décide de son propre drapeau ; ce fichier ne lit aucun drapeau et ne s'importe pas côté client.
type Env = Record<string, string | undefined>
export const LOT_F_PILOT_COMPANY_ID_NAME = "LOT_F_PILOT_COMPANY_ID"
/** Forme admise : 1 à 64 caractères alphanumériques, « _ » ou « - ». */
const PILOT_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Cible du module si son drapeau est actif ; `null` sinon ou si la valeur est absente, vide ou malformée. */
export function readLotFPilotCompanyId(enabled: boolean, env: Env = process.env): string | null {
  if (enabled !== true) return null
  const raw = env[LOT_F_PILOT_COMPANY_ID_NAME]
  return typeof raw === "string" && PILOT_COMPANY_ID.test(raw) ? raw : null
}
/** Société de session exactement égale à la cible (aucune normalisation). */
export function matchesLotFPilot(companyId: unknown, pilotCompanyId: string | null): boolean {
  return pilotCompanyId !== null && typeof companyId === "string" && companyId === pilotCompanyId
}
