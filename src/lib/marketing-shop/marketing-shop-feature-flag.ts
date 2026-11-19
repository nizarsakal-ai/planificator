// Lot I Planificator V2 : marketing et boutique, LABORATOIRE INTERNE sur données fictives. Désactivé par défaut : sans
// MARKETING_SHOP_ENABLED="true", ni menu, ni page (introuvable), ni action. Aucun prestataire, aucun pixel, aucune
// campagne externe, aucun e-mail, aucun paiement, aucun webhook ; aucune facture ni devis ni mouvement de stock.
type Env = Record<string, string | undefined>
export const MARKETING_SHOP_FLAG_NAME = "MARKETING_SHOP_ENABLED"
export function isMarketingShopEnabled(env: Env = process.env): boolean {
  return env[MARKETING_SHOP_FLAG_NAME] === "true"
}
