// Centre de connecteurs en simulation. L'accès exige un drapeau actif et la société pilote configurée côté serveur.
// Chaque connecteur de démonstration démarre désactivé.
import { matchesLotFPilot, readLotFPilotCompanyId } from "@/lib/lot-f/pilot-target"
type Env = Record<string, string | undefined>
export const CONNECTOR_CENTER_FLAG_NAME = "CONNECTOR_CENTER_ENABLED"
export const CONNECTOR_CENTER_PILOT_FLAG_NAME = "CONNECTOR_CENTER_PILOT_ENABLED"
export function isConnectorCenterEnabled(env: Env = process.env): boolean {
  return env[CONNECTOR_CENTER_FLAG_NAME] === "true"
}
/** Drapeau dédié du pilote, strict. */
export function isConnectorCenterPilotEnabled(env: Env = process.env): boolean {
  return env[CONNECTOR_CENTER_PILOT_FLAG_NAME] === "true"
}
/** Cible du centre (garde et menu) : drapeau pilote ou historique actif ET LOT_F_PILOT_COMPANY_ID valide ; sinon `null`. */
export function readConnectorCenterPilotCompanyId(env: Env = process.env): string | null {
  return readLotFPilotCompanyId(isConnectorCenterPilotEnabled(env) || isConnectorCenterEnabled(env), env)
}
/** Société exactement égale à la cible du centre de connecteurs. Prédicat du menu. */
export function isConnectorCenterEnabledForCompany(companyId: unknown, env: Env = process.env): boolean {
  return matchesLotFPilot(companyId, readConnectorCenterPilotCompanyId(env))
}
