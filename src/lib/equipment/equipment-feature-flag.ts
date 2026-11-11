// Lot B Planificator V2 : matériel et location. Désactivé par défaut : sans EQUIPMENT_RENTAL_ENABLED="true", le
// module n'existe pas (menu absent, pages 404, actions refusées). Indépendant du drapeau du lot A.
type Env = Record<string, string | undefined>
export const EQUIPMENT_RENTAL_FLAG_NAME = "EQUIPMENT_RENTAL_ENABLED"
export function isEquipmentRentalEnabled(env: Env = process.env): boolean {
  return env[EQUIPMENT_RENTAL_FLAG_NAME] === "true"
}
