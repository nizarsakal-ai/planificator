/**
 * Coordonnées d'un chantier saisies manuellement dans le formulaire de modification (colonnes latitude/longitude
 * existantes, aucune migration). Saisie prise en compte UNIQUEMENT si la case « mode manuel » est cochée : sinon le
 * comportement historique est inchangé (géocodage de l'adresse seulement quand elle change).
 */

export const COORDINATES_MODE_FIELD = "coordinatesMode"
export const COORDINATES_MODE_MANUAL = "manual"
export const LATITUDE_FIELD = "latitude"
export const LONGITUDE_FIELD = "longitude"

export type ManualCoordinates =
  | { kind: "absent" }
  | { kind: "manual"; latitude: number; longitude: number }
  | { kind: "invalid"; message: string }

type FormLike = { getAll(name: string): FormDataEntryValue[] }

/** Nombre décimal simple : point ou virgule, sans exposant, sans « Infinity » ni « NaN ». */
const DECIMAL = /^-?\d{1,3}(?:[.,]\d{1,12})?$/

const INVALID_PAIR = "Coordonnées manuelles : latitude et longitude sont toutes deux requises (nombres décimaux)."

function readOne(form: FormLike, name: string): number | null {
  const values = form.getAll(name)
  if (values.length !== 1 || typeof values[0] !== "string") return null
  const text = values[0].trim()
  if (!DECIMAL.test(text)) return null
  const value = Number(text.replace(",", "."))
  return Number.isFinite(value) ? value : null
}

/**
 * Case non cochée (champ absent) ⇒ `absent` : les champs latitude/longitude éventuels sont ignorés, comme avant.
 * Case cochée ⇒ paire complète, numérique, finie, latitude ∈ [-90, 90], longitude ∈ [-180, 180], hors point (0, 0).
 */
export function readManualCoordinates(form: FormLike): ManualCoordinates {
  const mode = form.getAll(COORDINATES_MODE_FIELD)
  if (mode.length === 0) return { kind: "absent" }
  if (mode.length !== 1 || mode[0] !== COORDINATES_MODE_MANUAL) return { kind: "invalid", message: "Mode de coordonnées invalide." }
  const latitude = readOne(form, LATITUDE_FIELD)
  const longitude = readOne(form, LONGITUDE_FIELD)
  if (latitude === null || longitude === null) return { kind: "invalid", message: INVALID_PAIR }
  if (latitude < -90 || latitude > 90) return { kind: "invalid", message: "Latitude attendue entre -90 et 90." }
  if (longitude < -180 || longitude > 180) return { kind: "invalid", message: "Longitude attendue entre -180 et 180." }
  if (latitude === 0 && longitude === 0) return { kind: "invalid", message: "Coordonnées (0, 0) refusées : point non renseigné." }
  return { kind: "manual", latitude, longitude }
}

/**
 * Coordonnées à enregistrer. Manuelles : prises telles quelles, aucun géocodage. Sinon, règle historique exacte :
 * géocodage seulement si l'adresse change, coordonnées actuelles conservées si le géocodage échoue.
 */
export async function resolveWorksiteCoordinates(input: {
  manual: ManualCoordinates
  current: { latitude: number | null; longitude: number | null }
  previousAddress: string | null
  nextAddress: string | undefined
  geocode: (address: string) => Promise<{ latitude: number; longitude: number } | null>
}): Promise<{ latitude: number | null; longitude: number | null }> {
  if (input.manual.kind === "manual") return { latitude: input.manual.latitude, longitude: input.manual.longitude }
  let { latitude, longitude } = input.current
  if (input.nextAddress && input.nextAddress !== input.previousAddress) {
    const geo = await input.geocode(input.nextAddress)
    if (geo) { latitude = geo.latitude; longitude = geo.longitude }
  }
  return { latitude, longitude }
}
