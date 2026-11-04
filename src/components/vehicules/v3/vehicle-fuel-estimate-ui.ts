/**
 * Estimation carburant — logique d'affichage pure (aucun React, aucun réseau) : valeurs proposées au formulaire de
 * dépense, fusion sans écraser les saisies, messages.
 */
import {
  decimalFr, estimateFuel, estimateNote, ESTIMATE_NOTE_PREFIX,
  type FuelEstimate, type FuelStation, type RouteStatus, type StationsStatus,
} from "@/lib/vehicules/v3/fuel-estimate-domain"

/** Noms des champs du formulaire « Proposer une dépense ». */
export type ExpenseFieldName = "category" | "date" | "amount" | "litres" | "mileage" | "supplier" | "notes"
export type ExpenseFieldValues = Partial<Record<ExpenseFieldName, string>>

export function proposedExpenseValues(estimate: FuelEstimate, station: FuelStation | null, consumption: number | null): ExpenseFieldValues {
  const values: ExpenseFieldValues = { category: "FUEL", date: estimate.tripDate }
  if (estimate.odometer !== null) values.mileage = String(estimate.odometer)
  if (station) values.supplier = `${station.label}, ${station.city}`.slice(0, 200)
  const computed = estimateFuel({ km: estimate.km, consumptionLPer100Km: consumption, pricePerLitre: station?.price ?? null })
  if (computed && station && estimate.km !== null && estimate.kmSource && consumption !== null) {
    values.amount = decimalFr(computed.amount, 2)
    values.litres = decimalFr(computed.litres, 3).replace(/0+$/, "").replace(/,$/, "")
    values.notes = estimateNote({ km: estimate.km, kmSource: estimate.kmSource, consumption, station, fuel: estimate.fuel })
  }
  return values
}

/**
 * Valeurs à écrire dans le formulaire. Automatique : jamais sur un champ saisi à la main. Explicite (« Reprendre
 * l'estimation ») : tous les champs proposés. Notes : la note d'estimation précédente est remplacée, le reste conservé.
 */
export function mergeExpenseValues(current: ExpenseFieldValues, proposed: ExpenseFieldValues, touched: ReadonlySet<string>, explicit: boolean): ExpenseFieldValues {
  const out: ExpenseFieldValues = {}
  for (const [name, value] of Object.entries(proposed) as [ExpenseFieldName, string][]) {
    if (!explicit && touched.has(name)) continue
    if (name === "notes") {
      const kept = (current.notes ?? "").split("\n").filter((line) => !line.startsWith(ESTIMATE_NOTE_PREFIX)).join("\n").trim()
      out.notes = (kept ? `${kept}\n${value}` : value).slice(0, 4000)
    } else out[name] = value
  }
  return out
}

export function kmLabel(estimate: FuelEstimate): string {
  if (estimate.km === null) return estimate.tripClosed ? "Distance indisponible." : "Trajet en cours et itinéraire indisponible : distance inconnue."
  return estimate.kmSource === "ODOMETER" ? `${estimate.km} km relevés au compteur (trajet clos).`
    : `${estimate.km} km estimés : aller-retour siège → ${estimate.worksiteName ?? "chantier"} par l'itinéraire (${estimate.route.oneWayKm === null ? "—" : decimalFr(estimate.route.oneWayKm, 1)} km aller), trajet ${estimate.tripClosed ? "sans relevé exploitable" : "en cours"}.`
}

const ROUTE_REASONS: Record<RouteStatus, string | null> = {
  ROUTE: null,
  NO_DEPOT: "Point de départ de l'entreprise inconnu : itinéraire non calculé.",
  NO_WORKSITE: "Trajet sans chantier : itinéraire non calculé.",
  ADDRESS_NOT_FOUND: "Adresse du chantier introuvable : itinéraire non calculé.",
  UNAVAILABLE: "Service d'itinéraire momentanément indisponible.",
}
export const routeReason = (status: RouteStatus) => ROUTE_REASONS[status]

export function stationsLabel(status: StationsStatus, count: number): string {
  if (status === "UNAVAILABLE") return "Prix des carburants momentanément indisponibles. Saisissez le prix du ticket."
  if (status === "NONE") return "Aucune zone de recherche : ni chantier localisé ni point de départ connu."
  if (!count) return "Aucune station avec ce carburant n'a été trouvée sur la zone."
  const zone = status === "ROUTE_CORRIDOR" ? "sur le trajet" : status === "NEAR_WORKSITE" ? "à moins de 3 km du chantier" : "à moins de 3 km du siège"
  return `${count} station${count > 1 ? "s" : ""} ${zone}, de la moins chère à la plus chère. Prix publics actuels (data.economie.gouv.fr).`
}

/** Prix ancien ou trajet ancien : le prix affiché n'est pas forcément celui payé. */
export function priceWarnings(estimate: FuelEstimate, station: FuelStation | null, today: string): string[] {
  const out: string[] = []
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
  if (station && days(station.updatedAt.slice(0, 10), today) > 7) out.push("Prix de cette station non mis à jour depuis plus de 7 jours.")
  if (days(estimate.tripDate, today) > 7) out.push("Trajet de plus de 7 jours : seul le prix actuel est disponible, pas celui du jour du trajet.")
  return out
}

export function fuelEstimateError(code?: string): string {
  switch (code) {
    case "TRIP_NOT_FOUND": return "Ce trajet n'est plus accessible."
    case "FORBIDDEN": case "UNAUTHENTICATED": return "Votre rôle ne permet pas l'estimation."
    case "PROVIDER_HOURLY_QUOTA": return "Trop d'estimations cette heure-ci. Réessayez plus tard."
    default: return "Estimation indisponible. Saisissez la dépense à partir du ticket."
  }
}
