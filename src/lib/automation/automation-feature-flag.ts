// Lot E Planificator V2 : automatisations. Désactivées par défaut : sans AUTOMATIONS_ENABLED="true", ni page, ni action,
// ni exécution (la tâche planifiée répond 404). Même activé, rien ne se passe tant qu'aucune règle n'est approuvée.
type Env = Record<string, string | undefined>
export const AUTOMATIONS_FLAG_NAME = "AUTOMATIONS_ENABLED"
export function isAutomationsEnabled(env: Env = process.env): boolean {
  return env[AUTOMATIONS_FLAG_NAME] === "true"
}
