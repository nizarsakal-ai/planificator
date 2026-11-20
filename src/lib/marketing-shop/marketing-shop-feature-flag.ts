// Lot I Planificator V2 : marketing et simulation de boutique internes, désactivés par défaut.
// Le pilote exige un drapeau actif et l'identifiant interne exact de la société configurée côté serveur.
type Env = Record<string, string | undefined>
export const MARKETING_SHOP_FLAG_NAME = "MARKETING_SHOP_ENABLED"
export const MARKETING_SHOP_PILOT_FLAG_NAME = "MARKETING_SHOP_PILOT_ENABLED"
export const MARKETING_SHOP_COMPANY_ID_NAME = "MARKETING_SHOP_COMPANY_ID"
/** Forme admise d'un identifiant interne de société (même alphabet que les identifiants des routes du module). */
const PILOT_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/
export function isMarketingShopEnabled(env: Env = process.env): boolean {
  return env[MARKETING_SHOP_FLAG_NAME] === "true"
}
/** Drapeau dédié du pilote (seul drapeau prévu pour la production). */
export function isMarketingShopPilotEnabled(env: Env = process.env): boolean {
  return env[MARKETING_SHOP_PILOT_FLAG_NAME] === "true"
}
/** Société pilote lue telle quelle (aucun trim) ; `null` sans drapeau actif ou si l'identifiant est absent, vide ou malformé. */
export function readMarketingShopPilotCompanyId(env: Env = process.env): string | null {
  if (!isMarketingShopPilotEnabled(env) && !isMarketingShopEnabled(env)) return null
  const raw = env[MARKETING_SHOP_COMPANY_ID_NAME]
  return typeof raw === "string" && PILOT_COMPANY_ID.test(raw) ? raw : null
}
/** Société exactement égale à la société pilote d'un module activé. Prédicat unique du menu (même cible que la garde). */
export function isMarketingShopEnabledForCompany(companyId: unknown, env: Env = process.env): boolean {
  return typeof companyId === "string" && companyId === readMarketingShopPilotCompanyId(env)
}
