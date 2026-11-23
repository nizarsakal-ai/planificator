// Lot D Planificator V2 : tableaux de bord commerciaux. Désactivés par défaut : sans SALES_DASHBOARD_ENABLED="true",
// la page n'existe pas (404) et le menu est absent. Lecture seule des devis et factures existants.
type Env = Record<string, string | undefined>
export const SALES_DASHBOARD_FLAG_NAME = "SALES_DASHBOARD_ENABLED"
export function isSalesDashboardEnabled(env: Env = process.env): boolean {
  return env[SALES_DASHBOARD_FLAG_NAME] === "true"
}
