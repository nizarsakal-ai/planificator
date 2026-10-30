/**
 * Photos d'engins — drapeau serveur du module (SPEC-WORKSITE-PHOTOS-001 §8), désactivé par défaut.
 * Toute route, page et tâche planifiée du module vérifie ce drapeau côté serveur : une interface masquée
 * ne remplace jamais un refus serveur (404 `FEATURE_DISABLED` quand il est absent).
 */
export const WORKSITE_PHOTOS_FLAG = "PLANIFICATOR_WORKSITE_PHOTOS_ENABLED"
export const WORKSITE_PHOTOS_AGENT_FLAG = "WORKSITE_PHOTOS_AGENT_ENABLED"

export function isWorksitePhotosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKSITE_PHOTOS_FLAG]?.trim() === "true"
}

/** Kill-switch de l'API agent (Hermes) : exige aussi le drapeau du module. */
export function isWorksitePhotosAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWorksitePhotosEnabled(env) && env[WORKSITE_PHOTOS_AGENT_FLAG]?.trim() === "true"
}
