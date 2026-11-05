/**
 * Estimation carburant — logique d'affichage et de formulaire pure (aucun React) : valeurs proposées au formulaire de
 * dépense, champs « détenus » par l'estimation (réinitialisés quand l'estimation change, échoue ou disparaît, jamais
 * quand l'opérateur les a modifiés), provenance gardée hors du champ Notes, garde de devise, messages et requêtes.
 */
import {
  MAX_GAP_DAYS, MAX_STAY_DAYS, TRIP_KM_LIMIT, choicePrice, decimalFr, estimateFuel, estimateKmLimit, estimateNote, gapKey, roundTripsFr,
  type EstimateDecision, type FuelEstimate, type FuelStation, type FuelType, type GapDecision, type PlannedStay, type PriceChoice, type RouteStatus,
  type StationsStatus, type TravelMode,
} from "@/lib/vehicules/v3/fuel-estimate-domain"
import { createLatestOnly } from "./vehicle-document-recognition-ui"

/** Noms des champs du formulaire « Proposer une dépense ». */
export type ExpenseFieldName = "category" | "date" | "amount" | "litres" | "mileage" | "supplier" | "notes"
export type ExpenseFieldValues = Partial<Record<ExpenseFieldName, string>>
/** Proposition de l'estimation : valeurs de champs (jamais Notes) et provenance du calcul, conservée à part. */
export interface ExpenseProposal { values: ExpenseFieldValues; provenance: string | null }

/** Seule devise des prix publics : aucun montant estimé n'est écrit dans une dépense libellée autrement. */
export const ESTIMATE_CURRENCY = "EUR"

/**
 * Prix médian par défaut seulement s'il porte sur toutes les stations lues. Échantillon tronqué : aucun prix par défaut
 * (ni médiane, désactivée, ni station : le choix d'une station reste explicite).
 */
export function defaultPriceKey(estimate: FuelEstimate): string {
  if (estimate.priceStats && !estimate.priceStats.sampled) return "MEDIAN"
  return estimate.priceStats?.sampled ? "" : estimate.stations[0]?.id ?? ""
}

/** Médiane utilisable : jamais celle d'un échantillon tronqué par le fournisseur (non représentative). */
export const medianUsable = (estimate: FuelEstimate) => !!estimate.priceStats && !estimate.priceStats.sampled

export function priceChoice(estimate: FuelEstimate, priceKey: string, today: string): PriceChoice | null {
  if (priceKey === "MEDIAN") return medianUsable(estimate) ? { kind: "MEDIAN", stats: estimate.priceStats!, date: today } : null
  const station = estimate.stations.find((s) => s.id === priceKey)
  return station ? { kind: "STATION", station } : null
}

/** Kilomètres retenus : trajet (compteur ou aller-retour) + déplacements sur place saisis. */
export function totalKm(estimate: FuelEstimate, extraKm: number): number | null {
  return estimate.km === null ? null : estimate.km + Math.max(0, Math.round(extraKm))
}

/**
 * Raison affichée quand litres et montant ne sont pas calculés (`km` : total avec km sur place). Distingue une distance
 * au-delà de la limite d'estimation d'un prix non choisi : un prix choisi n'est jamais redemandé.
 */
export function uncomputedReason(estimate: FuelEstimate, km: number | null, consumption: number | null, choice: PriceChoice | null): string {
  if (consumption === null) return "Indiquez la consommation pour estimer les litres et le montant."
  if (estimate.km === null || km === null) return estimate.missing.length ? "Décisions manquantes : litres et montant non estimés." : "Distance inconnue : litres et montant non estimés."
  // Même refus que `estimateFuel` (km > 0, fini) : jamais attribué au prix ni à la limite.
  if (!Number.isFinite(km) || !(km > 0)) return "Distance nulle ou invalide : litres et montant non estimés."
  const limit = estimateKmLimit(estimate)
  if (km > limit) {
    const scope = limit > TRIP_KM_LIMIT ? `${limit} km pour ${roundTripsFr(limit / TRIP_KM_LIMIT)} (${TRIP_KM_LIMIT} km par aller-retour, km sur place compris)` : `${limit} km d'une estimation de trajet (km sur place compris)`
    return `Distance hors limite : ${km} km dépassent la limite de ${scope}. Litres et montant non estimés ; saisissez le montant du ticket.`
  }
  if (!choice) return "Choisissez un prix pour estimer le montant."
  return "Prix hors bornes : litres et montant non estimés."
}

/** Valeurs proposées : catégorie, date, compteur, fournisseur ; montant et litres seulement si tout le calcul est possible. */
export function proposedExpense(estimate: FuelEstimate, choice: PriceChoice | null, consumption: number | null, extraKm = 0): ExpenseProposal {
  const values: ExpenseFieldValues = { category: "FUEL", date: estimate.tripDate }
  if (estimate.odometer !== null) values.mileage = String(estimate.odometer)
  if (choice?.kind === "STATION") values.supplier = `${choice.station.label}, ${choice.station.city}`.slice(0, 200)
  const km = totalKm(estimate, extraKm)
  const computed = estimateFuel({ km, consumptionLPer100Km: consumption, pricePerLitre: choice ? choicePrice(choice) : null, maxKm: estimateKmLimit(estimate) })
  let provenance: string | null = null
  if (computed && choice && km !== null && estimate.kmSource && consumption !== null) {
    values.amount = decimalFr(computed.amount, 2)
    values.litres = decimalFr(computed.litres, 3).replace(/0+$/, "").replace(/,$/, "")
    provenance = estimateNote({ km, kmSource: estimate.kmSource, extraKm: Math.max(0, Math.round(extraKm)), consumption, price: choice, fuel: estimate.fuel, stay: estimate.stay, travel: estimate.travel, depotConfirmed: estimate.depotConfirmed })
  }
  return { values, provenance }
}

// ─── Champs détenus par l'estimation ─────────────────────────────────────────

/** Valeurs écrites par l'estimation et encore intactes (identiques au formulaire, jamais modifiées à la main). */
export type OwnedFields = Partial<Record<ExpenseFieldName, string>>
export interface EstimateFormState { owned: OwnedFields; provenance: string | null }
export const emptyEstimateState = (): EstimateFormState => ({ owned: {}, provenance: null })

const isEur = (currency: string | undefined) => (currency ?? "").trim().toUpperCase() === ESTIMATE_CURRENCY

/**
 * Nouvelle proposition (ou `null` : « Aucun », chargement, erreur, démontage) appliquée au formulaire :
 * - un champ détenu que l'opérateur a modifié (saisi, ou valeur différente de celle écrite) est libéré, jamais réécrit ;
 * - un champ détenu absent de la nouvelle proposition est remis à sa valeur d'ouverture (`defaults`) : aucune valeur
 *   d'un trajet A ne survit au choix d'un trajet B partiel, d'une erreur ou d'une consommation effacée ;
 * - automatique : jamais sur un champ saisi ; explicite (« Reprendre l'estimation ») : tous les champs proposés ;
 * - montant estimé (prix en euros) écrit seulement si la devise de la dépense est EUR ; sinon retiré et signalé ;
 * - provenance conservée tant qu'un montant ou des litres estimés restent dans le formulaire, quelle que soit la note.
 */
export function reconcileEstimate(input: {
  state: EstimateFormState; proposal: ExpenseProposal | null; current: ExpenseFieldValues; defaults: ExpenseFieldValues
  touched: ReadonlySet<string>; explicit: boolean; currency: string
}): { writes: ExpenseFieldValues; state: EstimateFormState; withheld: ExpenseFieldName[] } {
  const owned: OwnedFields = {}
  for (const [name, value] of Object.entries(input.state.owned) as [ExpenseFieldName, string][])
    if (!input.touched.has(name) && (input.current[name] ?? "") === value) owned[name] = value
  const proposed: ExpenseFieldValues = { ...(input.proposal?.values ?? {}) }
  delete proposed.notes
  const withheld: ExpenseFieldName[] = []
  if (proposed.amount !== undefined && !isEur(input.currency)) { delete proposed.amount; withheld.push("amount") }
  const writes: ExpenseFieldValues = {}
  for (const name of Object.keys(owned) as ExpenseFieldName[]) {
    if (proposed[name] !== undefined) continue
    writes[name] = input.defaults[name] ?? ""
    delete owned[name]
  }
  for (const [name, value] of Object.entries(proposed) as [ExpenseFieldName, string][]) {
    const free = owned[name] !== undefined || (!input.touched.has(name))
    if (!input.explicit && !free) continue
    if ((input.current[name] ?? "") !== value) writes[name] = value
    owned[name] = value
  }
  const provenance = input.proposal?.provenance && (owned.amount !== undefined || owned.litres !== undefined) ? input.proposal.provenance : null
  return { writes, state: { owned, provenance }, withheld }
}

/** Provenance encore valable au moment de l'envoi : montant ou litres estimés intacts. */
export function liveProvenance(state: EstimateFormState, current: ExpenseFieldValues): string | null {
  const intact = (name: ExpenseFieldName) => state.owned[name] !== undefined && (current[name] ?? "") === state.owned[name]
  return state.provenance && (intact("amount") || intact("litres")) ? state.provenance : null
}

/** Notes enregistrées : celles de l'opérateur, puis la provenance sur sa propre ligne (4 000 caractères au plus). */
export function notesWithProvenance(manual: string, provenance: string | null): string {
  const text = manual.trim()
  if (!provenance) return text.slice(0, 4000)
  const room = 4000 - provenance.length - 1
  return text ? `${text.slice(0, Math.max(0, room)).trim()}\n${provenance}` : provenance.slice(0, 4000)
}

/** Refus d'envoi : montant estimé (euros) resté dans une dépense libellée dans une autre devise. */
export function currencyConflict(state: EstimateFormState, current: ExpenseFieldValues, currency: string): boolean {
  return state.owned.amount !== undefined && (current.amount ?? "") === state.owned.amount && !isEur(currency)
}

/** Formulaire minimal (DOM réel ou double de test) : contrôles nommés avec une valeur. */
export interface FormLike { elements: { namedItem(name: string): unknown } }
const ESTIMATE_FIELDS: ExpenseFieldName[] = ["category", "date", "amount", "litres", "mileage", "supplier"]
const control = (form: FormLike, name: string) => form.elements.namedItem(name) as { value: string } | null

/** Valeurs actuelles des champs que l'estimation peut remplir, devise et notes. */
export function readExpenseForm(form: FormLike): { values: ExpenseFieldValues; currency: string; notes: string } {
  const values: ExpenseFieldValues = {}
  for (const name of ESTIMATE_FIELDS) values[name] = control(form, name)?.value ?? ""
  return { values, currency: control(form, "currency")?.value ?? "", notes: control(form, "notes")?.value ?? "" }
}

/** Applique `reconcileEstimate` au formulaire : écrit les valeurs, rend le nouvel état et les champs retenus (devise). */
export function applyEstimateToForm(form: FormLike, input: { state: EstimateFormState; proposal: ExpenseProposal | null; defaults: ExpenseFieldValues; touched: ReadonlySet<string>; explicit: boolean }) {
  const { values, currency } = readExpenseForm(form)
  const result = reconcileEstimate({ ...input, current: values, currency })
  for (const [name, value] of Object.entries(result.writes)) { const el = control(form, name); if (el) el.value = value ?? "" }
  return result
}

// ─── Décisions de l'opérateur ────────────────────────────────────────────────

/**
 * Décisions d'estimation saisies dans l'encadré, toujours rattachées à la source (camion + séjour/trajet) ET au contexte
 * du séjour affiché (empreinte) pour lesquels elles ont été prises : changer de source, de camion ou de planning les
 * remet à zéro, rien n'est présélectionné.
 */
export interface EstimateDecisions {
  owner: string
  mode: TravelMode | null
  /** Clé `gapKey` (premier..dernier jour) → décision. */
  gaps: Record<string, GapDecision>
  depot: boolean
  handover: boolean
}
export const decisionsOwner = (truckId: string, source: string, context = "") => `${truckId}|${source}|${context}`
export const emptyDecisions = (owner: string): EstimateDecisions => ({ owner, mode: null, gaps: {}, depot: false, handover: false })
/** Décisions valables pour cette source seulement ; celles d'une autre source ne sont jamais réutilisées. */
export const decisionsFor = (decisions: EstimateDecisions, owner: string): EstimateDecisions => decisions.owner === owner ? decisions : emptyDecisions(owner)

/** Séjour sélectionnable : estimable, ou réaffecté en journée (estimable seulement après déclaration explicite). */
export const staySelectable = (stay: PlannedStay) => stay.estimable || stay.blocked === "HANDOVER"

/**
 * Paramètres de la requête : seules les décisions prises sont envoyées (aucune valeur par défaut) ; coupures seulement en
 * mode « un aller-retour pour le séjour » ; jours de réaffectation seulement si l'opérateur les a déclarés.
 */
export function estimateQuery(source: string, fuel: FuelType, decisions?: EstimateDecisions | null, stay?: PlannedStay | null, options?: { forecast?: boolean }): URLSearchParams {
  const kind = source.slice(0, 5), id = source.slice(5)
  const query = new URLSearchParams({ [kind === "stay:" ? "stayId" : "tripId"]: id, fuel })
  // Prévision : lecture de l'itinéraire et des prix du séjour affiché, sans AUCUNE décision (rien n'est déclaré).
  if (options?.forecast && kind === "stay:" && stay) { query.set("forecast", "1"); query.set("context", stay.context); return query }
  if (!decisions) return query
  if (kind === "stay:") {
    if (decisions.mode) query.set("mode", decisions.mode)
    const gaps = Object.entries(decisions.gaps).filter(([key]) => !stay || stay.gaps.some((g) => gapKey(g) === key))
    if (decisions.mode === "ONE_ROUND_TRIP" && gaps.length) query.set("gaps", gaps.sort(([a], [b]) => a.localeCompare(b)).map(([key, d]) => `${key}:${d}`).join(","))
    if (decisions.handover && stay?.handoverDays.length) query.set("handover", [...stay.handoverDays].sort().join(","))
    // Contexte sur lequel les décisions ont été prises : le serveur refuse s'il a changé depuis.
    if (stay && (query.has("mode") || query.has("gaps") || query.has("handover"))) query.set("context", stay.context)
  }
  if (decisions.depot) query.set("depot", "1")
  return query
}

/**
 * Règle d'organisation interne de Galya (validée par Nizar, ce n'est pas une règle juridique) : distance ALLER routière
 * depuis le siège ≤ 50 km → retour quotidien proposé ; > 50 km → séjour sur place, un aller-retour au total, proposé.
 * Le siège n'est connu que pour cette société : ailleurs, aucune distance donc aucune proposition.
 */
export const DAILY_RETURN_MAX_ONE_WAY_KM = 50

/**
 * Mode PROPOSÉ d'après la distance aller déjà renvoyée par l'estimation (aucun appel supplémentaire). `null` si la
 * distance est inconnue, nulle, négative ou non finie : aucune proposition arbitraire. Jamais appliqué d'office : seul
 * le choix explicite de l'opérateur compte pour le calcul.
 */
export function recommendedTravelMode(oneWayKm: number | null | undefined): TravelMode | null {
  if (typeof oneWayKm !== "number" || !Number.isFinite(oneWayKm) || !(oneWayKm > 0)) return null
  return oneWayKm <= DAILY_RETURN_MAX_ONE_WAY_KM ? "DAILY" : "ONE_ROUND_TRIP"
}

/** Texte de la proposition (distance, seuil, règle interne) ; `null` sans distance exploitable. N'affirme aucun fait. */
export function travelRecommendationLabel(oneWayKm: number | null | undefined): string | null {
  const mode = recommendedTravelMode(oneWayKm)
  if (!mode) return null
  const km = decimalFr(oneWayKm as number, 1), max = DAILY_RETURN_MAX_ONE_WAY_KM
  const what = mode === "DAILY"
    ? `${km} km aller depuis le siège (${max} km ou moins) : retour quotidien au siège proposé`
    : `${km} km aller depuis le siège (plus de ${max} km) : séjour sur place, un seul aller-retour au total, proposé`
  return `Règle d’organisation Galya : ${what}. Choisissez le mode correspondant à l’organisation prévue.`
}

/** Décisions encore attendues, en clair (le montant n'est proposé qu'une fois toutes prises). */
export function missingDecisionsLabel(missing: readonly EstimateDecision[]): string[] {
  return missing.map((m) => m === "MODE" ? "Choisissez les déplacements : séjour sur place avec un seul aller-retour, ou retour quotidien au siège (un aller-retour par jour planifié)."
    : m === "GAPS" ? "Pour chaque coupure du planning, indiquez si le camion est resté sur place ou rentré au siège."
    : "Confirmez que le camion part du siège et y revient : sinon l'itinéraire ne correspond pas au trajet réel.")
}

// ─── Requêtes de l'encadré ───────────────────────────────────────────────────

export interface EstimateRequestHandlers {
  /** Avant toute requête (et sur « Aucun ») : l'ancienne estimation n'est plus valable. */
  onReset(): void
  onLoading(loading: boolean): void
  onResult(estimate: FuelEstimate): void
  /** `code` : code d'erreur du serveur (ex. STAY_CONTEXT_CHANGED : décisions à reprendre sur le planning actualisé). */
  onError(message: string, code?: string): void
}

/** Erreurs qui invalident les décisions prises : planning ou réaffectation modifiés depuis l'affichage. */
// (Pas STAY_NOT_FOUND : la requête sans décision échouerait de nouveau, la relecture n'aurait pas de fin.)
export const STALE_DECISION_CODES = new Set(["STAY_CONTEXT_CHANGED", "STAY_GAPS_MISMATCH", "STAY_HANDOVER_MISMATCH"])

/**
 * Une requête d'estimation à la fois : chaque sélection annule la précédente (réponse tardive ignorée) et invalide
 * d'abord l'estimation affichée ; `dispose` (démontage, fermeture) coupe les rappels de la requête en cours.
 */
export function createEstimateRequests(fetchFn: typeof fetch, handlers: EstimateRequestHandlers) {
  const latest = createLatestOnly()
  return {
    select(truckId: string, source: string, fuel: FuelType, decisions?: EstimateDecisions | null, stay?: PlannedStay | null, options?: { forecast?: boolean }) {
      handlers.onReset()
      if (!source) { latest.cancel(); handlers.onLoading(false); return }
      const { token, signal } = latest.start()
      handlers.onLoading(true)
      const live = () => latest.isCurrent(token)
      void fetchFn(`/api/trucks/${encodeURIComponent(truckId)}/fuel-estimate?${estimateQuery(source, fuel, decisions, stay, options)}`, { cache: "no-store", signal })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}))
          if (!live()) return
          if (!response.ok) { handlers.onError(fuelEstimateError(body.code), typeof body.code === "string" ? body.code : undefined); return }
          handlers.onResult(body as FuelEstimate)
        })
        .catch(() => { if (live()) handlers.onError(fuelEstimateError()) })
        .finally(() => { if (live()) handlers.onLoading(false) })
    },
    /** Annule la requête en cours : sa réponse ne sera jamais appliquée (une sélection ultérieure reste possible). */
    dispose() { latest.cancel() },
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

const dayFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Libellé d'un séjour dans la liste : chantier, départ → retour, équipe ; bornes inconnues dites comme telles. */
export function stayLabel(stay: PlannedStay): string {
  const from = stay.departureKnown ? `départ ${dayFr(stay.departure)}` : `déjà en cours le ${dayFr(stay.departure)}`
  const to = stay.returnKnown ? `retour ${dayFr(stay.return)}` : `toujours en cours le ${dayFr(stay.return)}`
  const cuts = stay.gaps.length ? `, ${stay.gaps.length} coupure${stay.gaps.length > 1 ? "s" : ""}` : ""
  const days = stay.departureKnown && stay.returnKnown ? ` (${stay.days} jour${stay.days > 1 ? "s" : ""}${stay.gaps.length ? " planifiés" : ""}${cuts})` : ""
  const blocked = stay.estimable ? "" : stay.blocked === "HANDOVER" ? " — affectation à vérifier" : " — non estimable"
  return `${stay.worksiteName} — ${from}, ${to}${days}${stay.teamName ? ` — ${stay.teamName}` : ""}${blocked}`
}

const gapFr = (g: { from: string; to: string; days: number }) => g.from === g.to ? `le ${dayFr(g.from)}` : `du ${dayFr(g.from)} au ${dayFr(g.to)}`
export const gapLabel = (g: { from: string; to: string; days: number }) => `Coupure ${gapFr(g)} (${g.days} jour${g.days > 1 ? "s" : ""} sans planning)`

/** Lignes d'information du séjour : dates, équipe, chef actuel, chauffeur, incertitudes ; jamais une supposition muette. */
export function stayDetails(stay: PlannedStay): string[] {
  const span = stay.gaps.length ? `${stay.days} jour${stay.days > 1 ? "s" : ""} planifiés sur ${stay.spanDays} jours civils` : `${stay.days} jour${stay.days > 1 ? "s" : ""} sur le chantier`
  return [
    `Départ le ${dayFr(stay.departure)}, retour le ${dayFr(stay.return)} (${span}).`,
    ...(stay.gaps.length ? [`${stay.gaps.map(gapLabel).join(" · ")} : le camion est resté à l'équipe ces jours-là, mais le planning ne dit pas s'il est resté sur place. Une coupure de plus de ${MAX_GAP_DAYS} jours sépare deux séjours distincts.`] : []),
    `Équipe : ${stay.teamName ?? "non renseignée"} · chef d'équipe actuel (aujourd'hui, pas forcément pendant le séjour) : ${stay.leaderName ?? "non renseigné"} · chauffeur de la période du camion au départ : ${stay.chauffeurName ?? "non renseigné"} (n'atteste pas sa présence chaque jour).`,
    ...(stay.hasCoordinates ? [] : ["Chantier non localisé (coordonnées absentes) : itinéraire non calculé ; aucune adresse n'est envoyée pour le localiser."]),
  ]
}

/** Raison d'un séjour non sélectionnable (aucune attribution ni date de retour inventées). */
export function stayBlockedReason(stay: PlannedStay): string | null {
  switch (stay.blocked) {
    case null: return null
    case "OUT_OF_RANGE": return "Début ou fin hors de la période lue : départ ou retour réel inconnu, estimation impossible."
    case "TOO_LONG": return `Séjour de plus de ${MAX_STAY_DAYS} jours : aucune date de retour n'est supposée, estimation non proposée.`
    case "NO_HISTORY": return "Aucun historique d'affectation du camion : l'équipe actuelle ne prouve pas qui l'avait ces jours-là, estimation non proposée."
    case "HANDOVER": return `Camion réaffecté en cours de journée (${stay.handoverDays.map(dayFr).join(", ")}) : aucune équipe n'est attribuée d'office ; estimation possible seulement si vous confirmez que le camion était à l'équipe du séjour ces jours-là (déclaration consignée seulement à l'enregistrement d'une dépense, l'historique d'affectation n'est pas modifié).`
  }
}

/** Texte de la déclaration de réaffectation proposée à l'opérateur (case à cocher explicite). */
export const handoverConfirmLabel = (stay: PlannedStay) =>
  `Je déclare que le camion était à l'équipe ${stay.teamName ?? "du séjour"} les jours de réaffectation ${stay.handoverDays.map(dayFr).join(", ")} (hypothèse d'estimation : rien n'est enregistré maintenant ; elle sera consignée dans la provenance de la dépense si vous l'enregistrez ; l'historique d'affectation n'est pas modifié).`

export function kmLabel(estimate: FuelEstimate): string {
  const missing = estimate.missing ?? []
  if (estimate.km === null && missing.length && estimate.route.oneWayKm !== null) return `Distance non calculée tant que les décisions ci-dessous manquent (${decimalFr(estimate.route.oneWayKm, 1)} km par trajet siège → ${estimate.worksiteName ?? "chantier"}).`
  if (estimate.km === null) return estimate.tripClosed ? "Distance indisponible." : estimate.source === "STAY" ? "Itinéraire indisponible : distance inconnue." : "Trajet en cours et itinéraire indisponible : distance inconnue."
  const oneWay = estimate.route.oneWayKm === null ? "—" : decimalFr(estimate.route.oneWayKm, 1)
  if (estimate.kmSource === "STAY_ROUND_TRIP") {
    const t = estimate.travel
    const how = t?.mode === "DAILY" ? `un aller-retour par jour planifié (${t.plannedDays} jour${t.plannedDays > 1 ? "s" : ""}, jours sans planning non comptés)`
      : `un aller-retour pour le séjour${t?.gaps.some((g) => g.decision === "RETURN") ? ", plus un par coupure avec retour au siège" : ""}`
    return `${estimate.km} km : ${roundTripsFr(t?.roundTrips ?? 1)} siège ↔ ${estimate.worksiteName ?? "chantier"} de 2 × ${oneWay} km (${how}, itinéraire le plus rapide, départ et retour au siège confirmés).`
  }
  return estimate.kmSource === "ODOMETER" ? `${estimate.km} km relevés au compteur (trajet clos).`
    : `${estimate.km} km estimés : aller-retour siège → ${estimate.worksiteName ?? "chantier"} par l'itinéraire (${oneWay} km aller, départ et retour au siège confirmés), trajet ${estimate.tripClosed ? "sans relevé exploitable" : "en cours"}.`
}

const ROUTE_REASONS: Record<RouteStatus, string | null> = {
  ROUTE: null,
  NO_DEPOT: "Point de départ de l'entreprise inconnu : itinéraire non calculé.",
  NO_WORKSITE: "Trajet sans chantier : itinéraire non calculé.",
  NO_COORDINATES: "Chantier non localisé (coordonnées absentes) : itinéraire non calculé. Seules des coordonnées sont envoyées aux services publics ; l'adresse n'est pas géocodée.",
  UNAVAILABLE: "Service d'itinéraire momentanément indisponible.",
}
export const routeReason = (status: RouteStatus) => ROUTE_REASONS[status]

export function stationsLabel(status: StationsStatus, count: number, total = count, sampled = false): string {
  if (status === "UNAVAILABLE") return "Prix des carburants momentanément indisponibles. Saisissez le prix du ticket."
  if (status === "NONE") return "Aucune zone de recherche : ni chantier localisé ni point de départ connu."
  if (!count) return "Aucune station avec ce carburant n'a été trouvée sur la zone."
  const zone = status === "ROUTE_CORRIDOR" ? "à moins de 2 km à vol d'oiseau du tracé" : status === "NEAR_WORKSITE" ? "à moins de 3 km du chantier" : "à moins de 3 km du siège"
  const shown = total > count ? `${total} stations lues ${zone} ; les ${count} moins chères` : `${count} station${count > 1 ? "s" : ""} ${zone}`
  const limit = sampled ? " Liste tronquée par le service (100 stations par zone, les moins chères) : aucune médiane représentative n'est calculable." : ""
  return `${shown}, de la moins chère à la plus chère. Prix publics indicatifs, datés par chaque station (data.economie.gouv.fr). Distance à vol d'oiseau seulement : accès depuis la route et détour non vérifiés.${limit}`
}

/** Distance d'une station : toujours « à vol d'oiseau », jamais « sur le tracé » (l'accès routier n'est pas connu). */
export function stationDistanceLabel(offRouteKm: number): string {
  return offRouteKm < 0.1 ? "à moins de 0,1 km à vol d'oiseau du tracé (accès non vérifié)" : `à ${decimalFr(offRouteKm, 1)} km à vol d'oiseau du tracé (accès non vérifié)`
}

/** Libellé du choix « prix médian » ; échantillon tronqué : libellé d'un choix désactivé, avec la raison. */
export function medianLabel(estimate: FuelEstimate): string | null {
  const s = estimate.priceStats
  if (!s) return null
  const range = `de ${decimalFr(s.min, 3)} à ${decimalFr(s.max, 3)} €/L`
  return s.sampled
    ? `médiane indisponible : le service n'a renvoyé que les ${s.count} stations les moins chères (${range}), un échantillon non représentatif. Choisissez une station ou saisissez le prix du ticket.`
    : `prix médian indicatif des ${s.count} stations lues sur le trajet (${range})`
}

/** Prix ancien ou trajet ancien : le prix affiché n'est pas forcément celui payé. */
export function priceWarnings(estimate: FuelEstimate, station: FuelStation | null, today: string): string[] {
  const out: string[] = []
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
  if (station && days(station.updatedAt.slice(0, 10), today) > 7) out.push("Prix de cette station non mis à jour depuis plus de 7 jours.")
  // Séjour à venir : simple information (departureInfo), pas un avertissement.
  if (estimate.tripDate <= today && days(estimate.tripDate, today) > 7) out.push("Trajet de plus de 7 jours : seul le prix actuel est disponible, pas celui du jour du trajet.")
  return out
}

/** Départ à venir : information neutre, sans blocage (le prix connu est celui d'aujourd'hui). */
export function departureInfo(estimate: FuelEstimate, today: string): string | null {
  return estimate.tripDate > today ? `Prix d'aujourd'hui ; départ prévu le ${dayFr(estimate.tripDate)}.` : null
}

/** Décisions saisies dans « Modifier les hypothèses » : dès qu'il y en a une, le calcul déclaré remplace la prévision. */
export const hasDecisions = (d: EstimateDecisions) => d.mode !== null || d.depot || d.handover || Object.keys(d.gaps).length > 0

export function fuelEstimateError(code?: string): string {
  switch (code) {
    case "TRIP_NOT_FOUND": return "Ce trajet n'est plus accessible."
    case "STAY_NOT_FOUND": return "Ce séjour n'est plus au planning de ce véhicule. Actualisez la page."
    case "STAY_INCOMPLETE": return "Départ ou retour réel de ce séjour inconnu : estimation impossible."
    case "STAY_HANDOVER": return "Camion réaffecté en cours de journée pendant ce séjour : estimation impossible sans votre déclaration explicite."
    case "STAY_HANDOVER_MISMATCH": return "Les jours de réaffectation ont changé depuis l'affichage : confirmez à nouveau sur le séjour actualisé."
    case "STAY_GAPS_MISMATCH": return "Les coupures de ce séjour ont changé depuis l'affichage : décidez à nouveau sur le planning actualisé."
    case "STAY_CONTEXT_CHANGED": return "Le planning ou l'affectation de ce séjour a changé depuis l'affichage : vos choix ont été retirés, décidez à nouveau sur le séjour actualisé."
    case "STAY_NO_HISTORY": return "Aucun historique d'affectation du camion pour ce séjour : estimation impossible sans supposition."
    case "FORBIDDEN": case "UNAUTHENTICATED": return "Votre rôle ne permet pas l'estimation."
    case "PROVIDER_HOURLY_QUOTA": return "Trop d'estimations cette heure-ci. Réessayez plus tard."
    default: return "Estimation indisponible. Saisissez la dépense à partir du ticket."
  }
}
