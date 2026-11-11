// Lot A Planificator V2 : stocks multi-dépôts, commandes d'achat et réceptions. Désactivé par défaut :
// sans STOCK_PURCHASING_ENABLED="true", le module n'existe pas (menu absent, pages 404, actions refusées).
type Env = Record<string, string | undefined>
export const STOCK_PURCHASING_FLAG_NAME = "STOCK_PURCHASING_ENABLED"
export function isStockPurchasingEnabled(env: Env = process.env): boolean {
  return env[STOCK_PURCHASING_FLAG_NAME] === "true"
}
