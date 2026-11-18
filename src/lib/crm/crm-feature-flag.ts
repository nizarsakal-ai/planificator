// Lot E Planificator V2 : opportunités commerciales. Désactivées par défaut : sans CRM_OPPORTUNITIES_ENABLED="true",
// le module n'existe pas (menu absent, pages 404, actions refusées).
type Env = Record<string, string | undefined>
export const CRM_FLAG_NAME = "CRM_OPPORTUNITIES_ENABLED"
export function isCrmEnabled(env: Env = process.env): boolean {
  return env[CRM_FLAG_NAME] === "true"
}
