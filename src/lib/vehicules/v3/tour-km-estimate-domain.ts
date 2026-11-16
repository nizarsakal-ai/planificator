/**
 * Estimation des kilomètres d'une tournée de chantier (règle pure, sans réseau ni base).
 *
 * Modèle « dépôt → étapes de la tournée → dépôt », complété par la vie sur place :
 *   - trajets routiers enchaînés : dépôt → étape 1 → … → étape n → dépôt ;
 *   - chaque nuit au logement (Booking) : soir chantier → logement + matin logement → chantier
 *     (N jours de chantier = N − 1 nuits) ;
 *   - pause de midi : forfait par jour de chantier (restaurant non connu à l'avance).
 *
 * Les distances sont fournies par l'appelant (itinéraire IGN ou, à défaut, vol d'oiseau
 * majoré) ; la source est conservée pour être affichée.
 */
import type { DistanceSource } from "../planned-mileage-domain"

/** Forfait par défaut aller-retour du midi (chantier ↔ restaurant), modifiable dans le formulaire. */
export const TOUR_LUNCH_KM_PER_DAY_DEFAULT = 10
export const TOUR_LUNCH_KM_PER_DAY_MAX = 200
/** Autonomie indicative d'un plein (retour terrain : ~500 km par plein). */
export const TRUCK_TANK_RANGE_KM = 500
/** Limite Google Maps (URL « dir ») : 9 étapes intermédiaires au plus. */
export const GOOGLE_MAPS_MAX_WAYPOINTS = 9

export interface TourKmLeg {
  label: string
  km: number
  source: DistanceSource
}

export interface TourKmEstimateInput {
  /** Trajets enchaînés de la tournée (dépôt → étapes → dépôt), dans l'ordre. */
  legs: TourKmLeg[]
  /** Logement → chantier, aller simple ; null si aucun logement connu pour l'équipe sur ces dates. */
  lodgingToSite: { km: number; source: DistanceSource } | null
  /** Jours de travail sur le chantier pendant la tournée (≥ 1). */
  workDays: number
  lunchKmPerDay: number
}

export interface TourKmEstimateLine {
  key: "LEG" | "LODGING" | "LUNCH"
  label: string
  km: number
  detail: string
  approximate: boolean
}

export interface TourKmEstimate {
  totalKm: number
  lines: TourKmEstimateLine[]
  /** Nombre de pleins indicatif (autonomie ~500 km). */
  tanks: number
  approximate: boolean
}

const round1 = (n: number) => Math.round(n * 10) / 10
const sourceText = (s: DistanceSource) => (s === "ROUTE" ? "itinéraire routier IGN" : "vol d'oiseau majoré de 30 % (itinéraire indisponible)")

export function computeTourKmEstimate(input: TourKmEstimateInput): TourKmEstimate {
  const workDays = Math.max(1, Math.floor(input.workDays))
  const nights = workDays - 1
  const lunch = Math.min(Math.max(0, input.lunchKmPerDay), TOUR_LUNCH_KM_PER_DAY_MAX)
  const lines: TourKmEstimateLine[] = input.legs.map((leg) => ({
    key: "LEG",
    label: leg.label,
    km: round1(leg.km),
    detail: sourceText(leg.source),
    approximate: leg.source !== "ROUTE",
  }))
  if (input.lodgingToSite && nights > 0) {
    const l = round1(input.lodgingToSite.km)
    lines.push({
      key: "LODGING",
      label: "Logement ↔ chantier",
      km: round1(2 * l * nights),
      detail: `${nights} nuit${nights > 1 ? "s" : ""} × 2 trajets × ${l} km (${sourceText(input.lodgingToSite.source)})`,
      approximate: input.lodgingToSite.source !== "ROUTE",
    })
  }
  if (lunch > 0) {
    lines.push({
      key: "LUNCH",
      label: "Pause de midi",
      km: round1(lunch * workDays),
      detail: `${workDays} jour${workDays > 1 ? "s" : ""} × ${lunch} km (forfait aller-retour restaurant)`,
      approximate: true,
    })
  }
  const totalKm = Math.round(lines.reduce((sum, l) => sum + l.km, 0))
  return {
    totalKm,
    lines,
    tanks: round1(totalKm / TRUCK_TANK_RANGE_KM),
    approximate: lines.some((l) => l.approximate && l.key !== "LUNCH"),
  }
}

/**
 * Itinéraire Google Maps (sans clé API) : départ et retour au dépôt, étapes dans l'ordre.
 * Les adresses partent du navigateur de l'utilisateur vers Google au clic, jamais du serveur.
 */
export function googleMapsDirectionsUrl(input: { depot: string; stops: string[] }): string {
  const stops = input.stops.map((s) => s.trim()).filter(Boolean).slice(0, GOOGLE_MAPS_MAX_WAYPOINTS)
  const url = new URL("https://www.google.com/maps/dir/")
  url.searchParams.set("api", "1")
  url.searchParams.set("origin", input.depot)
  url.searchParams.set("destination", input.depot)
  if (stops.length > 0) url.searchParams.set("waypoints", stops.join("|"))
  url.searchParams.set("travelmode", "driving")
  return url.href
}

/** Étapes « Départ dépôt » / « Retour dépôt » ajoutées par la préparation : déjà couvertes par le dépôt. */
export function isDepotStopLabel(label: string): boolean {
  return /^(départ|retour)\s+dépôt\b/i.test(label.trim())
}
