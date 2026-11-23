// Lot D Planificator V2 : recherche globale. Désactivée par défaut : sans GLOBAL_SEARCH_ENABLED="true", ni palette, ni
// point d'accès (404). Chaque groupe de résultats reste en plus soumis au drapeau de SON module.
type Env = Record<string, string | undefined>
export const GLOBAL_SEARCH_FLAG_NAME = "GLOBAL_SEARCH_ENABLED"
export function isGlobalSearchEnabled(env: Env = process.env): boolean {
  return env[GLOBAL_SEARCH_FLAG_NAME] === "true"
}
