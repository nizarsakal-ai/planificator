/**
 * Estimation des kilomètres d'une tournée de chantier (règle pure, sans réseau ni base).
 *
 * Modèle d'un déplacement « dépôt → chantier → logement → … → dépôt » :
 *   - aller dépôt → chantier le premier jour, retour chantier → dépôt le dernier jour ;
 *   - chaque nuit au logement : soir chantier → logement + matin logement → chantier
 *     (N jours de chantier = N − 1 nuits) ;
 *   - pause de midi : forfait par jour de chantier (restaurant non connu à l'avance).
 *
 * Les distances aller simple sont fournies par l'appelant (itinéraire IGN ou, à défaut,
 * vol d'oiseau majoré) ; la source est conservée pour être affichée.
 */
import type { DistanceSource } from "../planned-mileage-domain"

/** Forfait par défaut aller-retour du midi (chantier ↔ restaurant), modifiable dans le formulaire. */
export const TOUR_LUNCH_KM_PER_DAY_DEFAULT = 10
export const TOUR_LUNCH_KM_PER_DAY_MAX = 200
/** Autonomie indicative d'un plein (retour terrain : ~500 km par plein). */
export const TRUCK_TANK_RANGE_KM = 500

export interface TourKmEstimateInput {
  /** Dépôt → chantier, aller simple. */
  depotToSite: { km: number; source: DistanceSource }
  /** Logement → chantier, aller simple ; null si aucun logement connu pour l'équipe sur ces dates. */
  lodgingToSite: { km: number; source: DistanceSource } | null
  /** Jours de travail sur le chantier pendant la tournée (≥ 1). */
  workDays: number
  lunchKmPerDay: number
}

export interface TourKmEstimateLine {
  key: "OUTBOUND" | "RETURN" | "LODGING" | "LUNCH"
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
  const a = round1(input.depotToSite.km)
  const lines: TourKmEstimateLine[] = [
    { key: "OUTBOUND", label: "Aller dépôt → chantier", km: a, detail: sourceText(input.depotToSite.source), approximate: input.depotToSite.source !== "ROUTE" },
    { key: "RETURN", label: "Retour chantier → dépôt", km: a, detail: sourceText(input.depotToSite.source), approximate: input.depotToSite.source !== "ROUTE" },
  ]
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
