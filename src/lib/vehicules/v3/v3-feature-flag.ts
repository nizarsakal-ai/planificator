/**
 * Véhicules V3 — prototype désactivé par défaut.
 * Toute route, page et tâche planifiée V3 vérifie ce drapeau côté serveur :
 * une interface masquée ne remplace jamais un refus serveur.
 */
export const VEHICLES_V3_FLAG = "PLANIFICATOR_VEHICLES_V3_ENABLED"

export function isVehiclesV3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VEHICLES_V3_FLAG]?.trim() === "true"
}
