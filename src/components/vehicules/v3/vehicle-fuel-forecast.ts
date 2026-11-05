/**
 * Prévision carburant d'un séjour planifié, calculée dans le navigateur à partir d'une lecture déjà reçue (distance aller
 * de l'itinéraire, stations et prix) : aucun appel en plus. C'est une PRÉVISION fondée sur des hypothèses affichées
 * (départ et retour au siège, règle d'organisation de 50 km, consommation indicative, prix d'aujourd'hui), jamais une
 * déclaration de l'opérateur ni une dépense : rien n'est enregistré, rien n'est coché.
 */
import {
  CONSUMPTION_BOUNDS, FUEL_LABELS, STAY_KM_CEILING, TRIP_KM_LIMIT, choicePrice, decimalFr, estimateFuel, parseConsumption, roundTripsFr,
  gapKey, stayRoundTrips, type FuelEstimate, type FuelStation, type GapDecision, type PlannedStay, type PriceChoice, type TravelMode,
} from "@/lib/vehicules/v3/fuel-estimate-domain"
import { medianUsable, priceChoice, recommendedTravelMode, type ExpenseProposal } from "./vehicle-fuel-estimate-ui"

/** Consommation retenue faute de préférence enregistrée pour ce véhicule : indicative, modifiable. */
export const INDICATIVE_CONSUMPTION_L_PER_100KM = 8

const dayFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const dayShort = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

export type ForecastPrice =
  | { kind: "CHOSEN"; choice: PriceChoice; label: string }
  | { kind: "MEDIAN"; choice: PriceChoice; label: string }
  | { kind: "STATION"; choice: PriceChoice; label: string }

export interface FuelForecast {
  mode: TravelMode
  /** RULE : mode de la règle d'organisation ; CHOSEN : mode choisi dans « Modifier les hypothèses » (hypothèse). */
  modeSource: "RULE" | "CHOSEN"
  /** Coupures avec retour au siège retenues comme hypothèses (un aller-retour de plus chacune). */
  returnGaps: string[]
  roundTrips: number
  oneWayKm: number
  /** Kilomètres siège ↔ chantier (même arrondi que le serveur) ; `km` ajoute les km sur place. */
  travelKm: number
  extraKm: number
  km: number
  consumption: number | null
  consumptionIndicative: boolean
  price: ForecastPrice | null
  litres: number | null
  amount: number | null
  overLimit: boolean
  /** Hypothèses, en clair, dans l'ordre d'affichage. */
  assumptions: string[]
  /** Information non bloquante (réaffectation en bordure, sans effet sur un seul aller-retour). */
  notice: string | null
}

export type ForecastResult = { ok: true; forecast: FuelForecast } | { ok: false; reason: string | null }

const validStationPrice = (s: FuelStation) => Number.isFinite(s.price) && s.price > 0 && s.price <= 10

/**
 * Prix de la prévision : choix explicite de l'opérateur d'abord ; sinon médiane d'une lecture COMPLÈTE ; sinon une
 * station réelle déjà renvoyée (la moins chère de la liste triée), désignée comme telle. Jamais de médiane d'un
 * échantillon tronqué, jamais de tarif inventé : aucune station valide → aucun prix (km et litres restent calculés).
 */
export function forecastPrice(estimate: FuelEstimate, priceKey: string, priceChosen: boolean, today: string): ForecastPrice | null {
  const chosen = priceChosen ? priceChoice(estimate, priceKey, today) : null
  if (chosen) return { kind: "CHOSEN", choice: chosen, label: priceLabel(chosen, estimate, "prix que vous avez choisi") }
  if (medianUsable(estimate)) { const choice = priceChoice(estimate, "MEDIAN", today)!; return { kind: "MEDIAN", choice, label: priceLabel(choice, estimate, "médiane de toutes les stations lues sur le trajet") } }
  const station = estimate.stations.find(validStationPrice)
  if (!station) return null
  const choice: PriceChoice = { kind: "STATION", station }
  return { kind: "STATION", choice, label: priceLabel(choice, estimate, "prix indicatif d'une station réelle, pas une moyenne") }
}

function priceLabel(choice: PriceChoice, estimate: FuelEstimate, what: string): string {
  const price = `${decimalFr(choicePrice(choice), 3)} €/L ${FUEL_LABELS[estimate.fuel]}`
  return choice.kind === "STATION"
    ? `${price} : ${what} (${choice.station.label}, ${choice.station.city}, publié le ${dayFr(choice.station.updatedAt)})`
    : `${price} : ${what} (${choice.stats.count} stations, prix d'aujourd'hui)`
}

/** Réaffectations du séjour hors de ses jours (veille du départ ou lendemain du retour) seulement. */
const handoverOnEdgesOnly = (stay: PlannedStay) => stay.handoverDays.every((d) => d < stay.departure || d > stay.return)

/**
 * Prévision d'un séjour. Mode : règle d'organisation (≤ 50 km aller : retour quotidien ; au-delà : un seul aller-retour,
 * le camion restant sur place jusqu'à la fin, coupures comprises). Réaffectation en journée :
 * - en bordure seulement et un seul aller-retour : prévision possible, avec une information « affectation à vérifier » ;
 * - pendant le séjour, ou en bordure avec retour quotidien : pas de prévision (le fait manquant est demandé).
 * Consommation : saisie (préférence) valide, sinon 8 L/100 km indicatifs ; saisie invalide : pas de litres.
 */
export function stayForecast(input: {
  stay: PlannedStay; estimate: FuelEstimate | null; consumptionInput: string; extraKm: number
  priceKey: string; priceChosen: boolean; today: string
  /** Hypothèses modifiées par l'opérateur (jamais envoyées comme déclarations) : mode et coupures du séjour. */
  modeOverride?: TravelMode | null; gapChoices?: Readonly<Record<string, GapDecision>>
}): ForecastResult {
  const { stay, estimate } = input
  // Lecture d'un autre séjour, d'un autre état du planning ou d'un trajet : rien n'est réutilisé.
  if (!estimate || estimate.source !== "STAY" || estimate.stay?.id !== stay.id || estimate.stay.context !== stay.context) return { ok: false, reason: null }
  if (!stay.estimable && stay.blocked !== "HANDOVER") return { ok: false, reason: null }
  const oneWayKm = estimate.route.oneWayKm
  const ruleMode = recommendedTravelMode(oneWayKm)
  if (!ruleMode || oneWayKm === null) return { ok: false, reason: "Distance routière inconnue : prévision impossible. Saisissez le montant du ticket." }
  const mode: TravelMode = input.modeOverride ?? ruleMode
  const modeSource = input.modeOverride ? "CHOSEN" as const : "RULE" as const
  let notice: string | null = null
  if (stay.blocked === "HANDOVER") {
    const days = stay.handoverDays.map(dayShort).join(", ")
    if (!handoverOnEdgesOnly(stay)) return { ok: false, reason: `Camion réaffecté pendant le séjour (${days}) : la prévision demande de savoir quelle équipe l'avait ces jours-là. Indiquez-le dans « Modifier les hypothèses ».` }
    if (mode === "DAILY") return { ok: false, reason: `Retour quotidien : le nombre d'allers-retours dépend du jour de réaffectation (${days}). Indiquez-le dans « Modifier les hypothèses ».` }
    notice = `Affectation du camion à vérifier : réaffecté le ${days}, juste avant ou après le séjour ; sans effet sur un seul aller-retour.`
  }
  // Coupures : sur place par défaut (hypothèse affichée) ; « retour au siège » choisi = un aller-retour de plus.
  // Mêmes bornes que le calcul du serveur (stayRoundTrips), seulement les coupures de CE séjour.
  const gaps: Record<string, GapDecision> = {}
  for (const g of stay.gaps) { const k = gapKey(g); gaps[k] = input.gapChoices?.[k] === "RETURN" ? "RETURN" : "STAY" }
  const roundTrips = stayRoundTrips(stay, { mode, gaps }).roundTrips ?? 1
  const returnGaps = mode === "ONE_ROUND_TRIP" ? stay.gaps.filter((g) => gaps[gapKey(g)] === "RETURN").map((g) => g.from === g.to ? dayShort(g.from) : `${dayShort(g.from)}–${dayShort(g.to)}`) : []
  const travelKm = Math.round(oneWayKm * 2 * roundTrips)
  const extraKm = Math.max(0, Math.round(Number.isFinite(input.extraKm) ? input.extraKm : 0))
  const km = travelKm + extraKm
  const typed = input.consumptionInput.trim()
  const consumption = typed ? parseConsumption(typed) : INDICATIVE_CONSUMPTION_L_PER_100KM
  const maxKm = Math.min(roundTrips * TRIP_KM_LIMIT, STAY_KM_CEILING)
  const overLimit = km > maxKm
  const price = forecastPrice(estimate, input.priceKey, input.priceChosen, input.today)
  // Litres sans prix : même formule et mêmes bornes que le calcul complet (prix neutre de 1 €/L, montant ignoré).
  const litresOnly = estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: 1, maxKm })
  const full = price ? estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: choicePrice(price.choice), maxKm }) : null
  const assumptions = [
    modeSource === "RULE"
      ? `Départ et retour au siège, selon la règle d'organisation : ${mode === "DAILY"
        ? `${decimalFr(oneWayKm, 1)} km aller, 50 km ou moins : retour quotidien, ${roundTripsFr(roundTrips)} (un par jour planifié)`
        : `${decimalFr(oneWayKm, 1)} km aller, plus de 50 km : séjour sur place, un seul aller-retour`}.`
      : `Départ et retour au siège ; mode choisi dans vos hypothèses : ${mode === "DAILY"
        ? `retour quotidien, ${roundTripsFr(roundTrips)} (un par jour planifié)`
        : "séjour sur place"} (${decimalFr(oneWayKm, 1)} km aller).`,
    ...(mode === "ONE_ROUND_TRIP" && stay.gaps.length ? [returnGaps.length
      ? `Retour au siège pendant la coupure du ${returnGaps.join(", ")} (votre hypothèse) : ${roundTripsFr(roundTrips)} au total ; sinon le camion reste sur place.`
      : "Le camion reste sur place jusqu'à la fin du séjour, coupures du planning comprises."] : []),
    consumption === null ? `Consommation saisie invalide (attendu entre ${CONSUMPTION_BOUNDS.min} et ${CONSUMPTION_BOUNDS.max} L/100 km) : litres non calculés.`
      : typed ? `Consommation : ${decimalFr(consumption, 1)} L/100 km (votre saisie).` : `Consommation : ${INDICATIVE_CONSUMPTION_L_PER_100KM} L/100 km, valeur indicative à remplacer si vous la connaissez.`,
    ...(extraKm ? [`Déplacements sur place : ${extraKm} km (votre saisie).`] : []),
    price ? `Prix : ${price.label}.` : "Prix : aucune station valide lue, montant non calculé.",
  ]
  return { ok: true, forecast: {
    mode, modeSource, returnGaps, roundTrips, oneWayKm, travelKm, extraKm, km, consumption, consumptionIndicative: !typed, price,
    litres: litresOnly?.litres ?? null, amount: full?.amount ?? null, overLimit, assumptions, notice,
  } }
}

const litresFr = (litres: number) => decimalFr(litres, 3).replace(/0+$/, "").replace(/,$/, "")

/** Ligne de résultat : kilomètres, litres et montant (ou leur absence, dite simplement). */
export function forecastSummary(f: FuelForecast): string {
  if (f.overLimit) return `${f.km} km : au-delà de la limite d'estimation, litres et montant non calculés.`
  const litres = f.litres !== null ? `${litresFr(f.litres)} L` : "litres non calculés"
  const amount = f.amount !== null ? `≈ ${decimalFr(f.amount, 2)} €` : "montant non calculé"
  return `${f.km} km · ${litres} · ${amount}`
}

/**
 * Provenance enregistrée avec la dépense si l'opérateur reprend la prévision : des HYPOTHÈSES, jamais une confirmation
 * ni une déclaration de sa part.
 */
export function forecastNote(stay: PlannedStay, f: FuelForecast): string {
  const where = `chantier ${stay.worksiteName}${stay.teamName ? `, équipe ${stay.teamName}` : ""} (départ ${dayFr(stay.departure)}, retour ${dayFr(stay.return)})`
  const how = f.modeSource === "RULE" ? "selon la règle d'organisation" : `mode ${f.mode === "DAILY" ? "retour quotidien" : "séjour sur place"} choisi en hypothèse`
  const gapsNote = f.mode === "ONE_ROUND_TRIP" && stay.gaps.length ? (f.returnGaps.length ? `, retour au siège supposé pendant la coupure du ${f.returnGaps.join(", ")}` : ", camion supposé sur place pendant les coupures") : ""
  const travel = `${roundTripsFr(f.roundTrips)} siège ↔ chantier de 2 × ${decimalFr(f.oneWayKm, 1)} km ${how} (départ et retour au siège supposés${gapsNote})`
  const extra = f.extraKm ? ` + ${f.extraKm} km sur place` : ""
  const consumption = f.consumption === null ? "" : ` × ${decimalFr(f.consumption, 1)} L/100 km${f.consumptionIndicative ? " (indicatif)" : ""}`
  const price = f.price ? ` × ${f.price.label}` : ""
  return `Prévision carburant (hypothèses à vérifier) : ${where} ; ${travel}${extra} = ${f.km} km${consumption}${price}. À remplacer par le montant du ticket.`
}

/** Proposition explicite « Utiliser la prévision » : montant et litres seulement s'ils sont calculés ; jamais de fournisseur. */
export function forecastProposal(stay: PlannedStay, f: FuelForecast): ExpenseProposal | null {
  if (f.overLimit || f.litres === null) return null
  const values: ExpenseProposal["values"] = { category: "FUEL", date: stay.departure, litres: litresFr(f.litres) }
  if (f.amount !== null) values.amount = decimalFr(f.amount, 2)
  return { values, provenance: forecastNote(stay, f) }
}
