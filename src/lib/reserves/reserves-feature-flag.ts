// Lot D Planificator V2 : réserves de réception et procès-verbal. Désactivé par défaut : sans
// WORKSITE_RESERVES_ENABLED="true", le module n'existe pas (menu absent, pages, PDF et fichiers en 404, actions refusées).
type Env = Record<string, string | undefined>
export const WORKSITE_RESERVES_FLAG_NAME = "WORKSITE_RESERVES_ENABLED"
export function isWorksiteReservesEnabled(env: Env = process.env): boolean {
  return env[WORKSITE_RESERVES_FLAG_NAME] === "true"
}
