/**
 * Estimation carburant — logique d'affichage pure (aucun React, aucun réseau) : valeurs proposées au formulaire de
 * dépense, fusion sans écraser les saisies, messages.
 */
import {
  choicePrice, decimalFr, estimateFuel, estimateNote, ESTIMATE_NOTE_PREFIX,
  type FuelEstimate, type FuelStation, type PlannedStay, type PriceChoice, type RouteStatus, type StationsStatus,
} from "@/lib/vehicules/v3/fuel-estimate-domain"

/** Noms des champs du formulaire « Proposer une dépense ». */
export type ExpenseFieldName = "category" | "date" | "amount" | "litres" | "mileage" | "supplier" | "notes"
export type ExpenseFieldValues = Partial<Record<ExpenseFieldName, string>>

/** Prix médian par défaut dès qu'il existe (plus représentatif d'un trajet que la station la moins chère). */
export function defaultPriceKey(estimate: FuelEstimate): string {
  return estimate.priceStats ? "MEDIAN" : estimate.stations[0]?.id ?? ""
}

export function priceChoice(estimate: FuelEstimate, priceKey: string, today: string): PriceChoice | null {
  if (priceKey === "MEDIAN") return estimate.priceStats ? { kind: "MEDIAN", stats: estimate.priceStats, date: today } : null
  const station = estimate.stations.find((s) => s.id === priceKey)
  return station ? { kind: "STATION", station } : null
}

/** Kilomètres retenus : trajet (compteur ou aller-retour) + déplacements sur place saisis. */
export function totalKm(estimate: FuelEstimate, extraKm: number): number | null {
  return estimate.km === null ? null : estimate.km + Math.max(0, Math.round(extraKm))
}

export function proposedExpenseValues(estimate: FuelEstimate, choice: PriceChoice | null, consumption: number | null, extraKm = 0): ExpenseFieldValues {
  const values: ExpenseFieldValues = { category: "FUEL", date: estimate.tripDate }
  if (estimate.odometer !== null) values.mileage = String(estimate.odometer)
  if (choice?.kind === "STATION") values.supplier = `${choice.station.label}, ${choice.station.city}`.slice(0, 200)
  const km = totalKm(estimate, extraKm)
  const computed = estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: choice ? choicePrice(choice) : null })
  if (computed && choice && km !== null && estimate.kmSource && consumption !== null) {
    values.amount = decimalFr(computed.amount, 2)
    values.litres = decimalFr(computed.litres, 3).replace(/0+$/, "").replace(/,$/, "")
    values.notes = estimateNote({ km, kmSource: estimate.kmSource, extraKm: Math.max(0, Math.round(extraKm)), consumption, price: choice, fuel: estimate.fuel, stay: estimate.stay })
  }
  return values
}

const dayFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Libellé d'un séjour dans la liste : chantier, départ → retour, équipe. */
export function stayLabel(stay: PlannedStay): string {
  return `${stay.worksiteName} — départ ${dayFr(stay.departure)}, retour ${dayFr(stay.return)} (${stay.days} jour${stay.days > 1 ? "s" : ""})${stay.teamName ? ` — ${stay.teamName}` : ""}`
}

/** Lignes d'information du séjour : dates, équipe, chef, chauffeur ; « non renseigné » plutôt qu'une supposition. */
export function stayDetails(stay: PlannedStay): string[] {
  return [
    `Départ le ${dayFr(stay.departure)}, retour le ${dayFr(stay.return)} (${stay.days} jour${stay.days > 1 ? "s" : ""} sur le chantier).`,
    `Équipe : ${stay.teamName ?? "non renseignée"} · chef d'équipe : ${stay.leaderName ?? "non renseigné"} · chauffeur : ${stay.chauffeurName ?? "non renseigné sur la période du camion"}.`,
    ...(stay.hasAddress ? [] : ["Adresse du chantier absente : complétez-la dans la fiche du chantier pour calculer l'itinéraire."]),
  ]
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
  const oneWay = estimate.route.oneWayKm === null ? "—" : decimalFr(estimate.route.oneWayKm, 1)
  if (estimate.kmSource === "STAY_ROUND_TRIP") return `${estimate.km} km : aller siège → ${estimate.worksiteName ?? "chantier"} le jour du départ, retour le jour de la fin (${oneWay} km par trajet, itinéraire le plus rapide).`
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

export function stationsLabel(status: StationsStatus, count: number, total = count): string {
  if (status === "UNAVAILABLE") return "Prix des carburants momentanément indisponibles. Saisissez le prix du ticket."
  if (status === "NONE") return "Aucune zone de recherche : ni chantier localisé ni point de départ connu."
  if (!count) return "Aucune station avec ce carburant n'a été trouvée sur la zone."
  const zone = status === "ROUTE_CORRIDOR" ? "sur le trajet" : status === "NEAR_WORKSITE" ? "à moins de 3 km du chantier" : "à moins de 3 km du siège"
  const shown = total > count ? `${total} stations ${zone} ; les ${count} moins chères` : `${count} station${count > 1 ? "s" : ""} ${zone}`
  return `${shown}, de la moins chère à la plus chère. Prix publics actuels (data.economie.gouv.fr).`
}

/** Prix ancien ou trajet ancien : le prix affiché n'est pas forcément celui payé. */
export function priceWarnings(estimate: FuelEstimate, station: FuelStation | null, today: string): string[] {
  const out: string[] = []
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
  if (station && days(station.updatedAt.slice(0, 10), today) > 7) out.push("Prix de cette station non mis à jour depuis plus de 7 jours.")
  // Séjour à venir : le prix connu aujourd'hui est une projection.
  if (estimate.tripDate > today) out.push("Départ à venir : prix actuels, susceptibles d'évoluer d'ici le départ.")
  else if (days(estimate.tripDate, today) > 7) out.push("Trajet de plus de 7 jours : seul le prix actuel est disponible, pas celui du jour du trajet.")
  return out
}

export function fuelEstimateError(code?: string): string {
  switch (code) {
    case "TRIP_NOT_FOUND": return "Ce trajet n'est plus accessible."
    case "STAY_NOT_FOUND": return "Ce séjour n'est plus au planning de ce véhicule. Actualisez la page."
    case "FORBIDDEN": case "UNAUTHENTICATED": return "Votre rôle ne permet pas l'estimation."
    case "PROVIDER_HOURLY_QUOTA": return "Trop d'estimations cette heure-ci. Réessayez plus tard."
    default: return "Estimation indisponible. Saisissez la dépense à partir du ticket."
  }
}
