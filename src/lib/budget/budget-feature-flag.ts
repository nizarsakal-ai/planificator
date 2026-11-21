// Lot C Planificator V2 : budgets et marges chantier. Désactivé par défaut : sans WORKSITE_BUDGET_ENABLED="true", le
// module n'existe pas (menu absent, pages et export 404, actions refusées). Indépendant des drapeaux des lots A et B :
// sans eux, les coûts correspondants sont simplement nuls (aucune donnée de stock, d'achat ou de matériel).
type Env = Record<string, string | undefined>
export const WORKSITE_BUDGET_FLAG_NAME = "WORKSITE_BUDGET_ENABLED"
export function isWorksiteBudgetEnabled(env: Env = process.env): boolean {
  return env[WORKSITE_BUDGET_FLAG_NAME] === "true"
}
