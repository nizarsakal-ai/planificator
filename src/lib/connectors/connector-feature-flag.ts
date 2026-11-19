// Lot F Planificator V2 : centre de connecteurs. Désactivé par défaut : sans CONNECTOR_CENTER_ENABLED="true", ni page
// ni action. Même activé, chaque connecteur commercial reste désactivé tant qu'un administrateur ne le passe pas en
// SIMULATION (double fictif, sans réseau). Aucun mode de connexion réelle n'existe dans ce lot.
type Env = Record<string, string | undefined>
export const CONNECTOR_CENTER_FLAG_NAME = "CONNECTOR_CENTER_ENABLED"
export function isConnectorCenterEnabled(env: Env = process.env): boolean {
  return env[CONNECTOR_CENTER_FLAG_NAME] === "true"
}
