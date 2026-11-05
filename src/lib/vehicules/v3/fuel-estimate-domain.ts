/**
 * Véhicules V3 — estimation carburant d'un trajet : règles pures (aucun réseau, aucune base), partageables côté navigateur.
 * Kilomètres : compteur du trajet clos, sinon aller-retour routier siège → chantier. Stations : celles du couloir du
 * trajet, prix publics du jour (flux instantané data.economie.gouv.fr). Consommation saisie par l'opérateur.
 * Une estimation n'est jamais un montant payé : la dépense reste « À valider » et le ticket réel prime.
 */
export const FUEL_ESTIMATE_FLAG = "PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED"

export function isFuelEstimateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[FUEL_ESTIMATE_FLAG]?.trim() === "true"
}

export const FUEL_TYPES = ["GAZOLE", "E10", "SP95", "SP98", "E85", "GPLC"] as const
export type FuelType = (typeof FUEL_TYPES)[number]
export const FUEL_LABELS: Record<FuelType, string> = { GAZOLE: "Gazole", E10: "SP95-E10", SP95: "SP95", SP98: "SP98", E85: "E85 (superéthanol)", GPLC: "GPL" }

export type Point = { latitude: number; longitude: number }
export type KmSource = "ODOMETER" | "ROUTE_ROUND_TRIP" | "STAY_ROUND_TRIP"
/**
 * NO_COORDINATES : chantier sans coordonnées enregistrées. L'estimation n'envoie que des coordonnées aux services
 * publics : l'adresse du chantier n'est jamais géocodée par ce parcours.
 */
export type RouteStatus = "ROUTE" | "NO_DEPOT" | "NO_WORKSITE" | "NO_COORDINATES" | "UNAVAILABLE"
export type StationsStatus = "ROUTE_CORRIDOR" | "NEAR_WORKSITE" | "NEAR_DEPOT" | "NONE" | "UNAVAILABLE"

/** Demi-largeur du couloir, identique quelle que soit la longueur du trajet : distance à vol d'oiseau au tracé. */
export const CORRIDOR_HALF_WIDTH_KM = 2

export interface FuelStation {
  id: string
  label: string
  city: string
  /** Prix au litre en euros, tel que publié. */
  price: number
  /** Date de mise à jour du prix publiée par la station (ISO). */
  updatedAt: string
  /** Distance à vol d'oiseau au tracé, en kilomètres : proximité approximative, ni accès ni détour routier garantis. */
  offRouteKm: number
  open24h: boolean
}

/** Jours civils inclus (AAAA-MM-JJ). */
export interface DayRange { from: string; to: string; days: number }

/**
 * Séjour d'une équipe sur un chantier : suites de jours planifiés consécutifs (`runs`), reliées entre elles par des
 * coupures du planning (`gaps`) de MAX_GAP_DAYS jours au plus pendant lesquelles le camion reste à cette même équipe,
 * sans réaffectation et sans planning de l'équipe ailleurs. Une coupure n'est jamais interprétée d'office : ni retour
 * au siège, ni maintien sur place ; l'opérateur décide pour chacune (voir `stayRoundTrips`). Chaque jour planifié
 * appartient à un seul séjour : deux séjours de la liste ne comptent jamais les mêmes jours.
 */
export interface PlannedStay {
  /** `chantier~équipe~premier jour` : identifiant stable recalculé côté serveur. */
  id: string
  worksiteId: string
  worksiteName: string
  hasAddress: boolean
  /** Coordonnées enregistrées : sans elles, ni itinéraire ni couloir (aucune adresse n'est géocodée). */
  hasCoordinates: boolean
  teamId: string
  teamName: string | null
  /** Chef ACTUEL de l'équipe (aucun historique daté des chefs). */
  leaderName: string | null
  chauffeurName: string | null
  /** Jour du départ (AAAA-MM-JJ). Si `departureKnown` est faux : premier jour lu, pas un vrai départ. */
  departure: string
  /** Jour du retour (AAAA-MM-JJ). Si `returnKnown` est faux : dernier jour lu, pas un vrai retour. */
  return: string
  /** Jours effectivement planifiés (les jours des coupures ne sont jamais comptés comme travaillés). */
  days: number
  /** Jours civils du départ au retour inclus (coupures comprises) : borné à MAX_STAY_DAYS. */
  spanDays: number
  /** Suites de jours planifiés consécutifs, dans l'ordre. */
  runs: DayRange[]
  /** Coupures du planning entre deux suites, dans l'ordre : chacune demande une décision explicite. */
  gaps: DayRange[]
  departureKnown: boolean
  returnKnown: boolean
  /** `blocked === null` : bornes réelles connues, durée bornée, affectation prouvée et sans réaffectation en journée. */
  estimable: boolean
  /** Raison du refus d'estimer, sinon null (voir StayBlock). */
  blocked: StayBlock | null
  /** HISTORY : périodes du camion ; CURRENT_TEAM_FALLBACK : aucune période enregistrée, équipe actuelle supposée. */
  assignment: "HISTORY" | "CURRENT_TEAM_FALLBACK"
  /** Jours (séjour, veille ou lendemain planifiés) où le camion a changé d'équipe ou de chauffeur en cours de journée. */
  handoverDays: string[]
  /**
   * Empreinte du contexte canonique du séjour (bornes, suites, coupures avec leur fin, jours planifiés, réaffectations,
   * équipe, chauffeur au départ, blocage). Toute décision de l'opérateur est rattachée à cette empreinte : si le planning
   * ou l'affectation change, le serveur la recalcule différente et refuse les décisions prises sur l'ancien contexte.
   * Ce n'est pas un secret ni une signature : le serveur recalcule toujours le séjour, rien n'est pris du client.
   */
  context: string
}

/**
 * Séjour non estimable, sans choix métier imposé :
 * OUT_OF_RANGE : départ ou retour hors des jours lus (bornes réelles inconnues) ;
 * TOO_LONG : plus de MAX_STAY_DAYS jours civils, coupures comprises (aucun retour n'est inventé à la limite) ;
 * NO_HISTORY : aucun historique d'affectation du camion (l'équipe actuelle n'est pas une preuve pour ces jours) ;
 * HANDOVER : camion réaffecté en cours de journée pendant le séjour (ou la veille / le lendemain planifiés) : le
 * jour ne peut pas être attribué à une équipe sans convention arbitraire. Seule une déclaration explicite de
 * l'opérateur pour ces jours exacts permet d'estimer. L'estimation (GET) n'enregistre rien : la déclaration n'est
 * consignée qu'à la sauvegarde de la dépense, dans la provenance des notes que conserve le journal existant des
 * commandes de dépense (acteur, après-état). Elle ne modifie jamais l'historique d'affectation du camion.
 */
export type StayBlock = "OUT_OF_RANGE" | "TOO_LONG" | "NO_HISTORY" | "HANDOVER"

/**
 * `sampled` : au moins une requête a atteint la limite de 100 stations du fournisseur (les moins chères d'abord) :
 * la médiane porte sur un échantillon biaisé vers le bas, pas sur toutes les stations du couloir.
 */
export interface PriceStats { count: number; min: number; median: number; max: number; sampled: boolean }

export interface FuelEstimate {
  /** Trajet relevé au compteur (`TRIP`) ou séjour planifié sur un chantier (`STAY`). */
  source: "TRIP" | "STAY"
  tripId: string
  stay: PlannedStay | null
  /** Jour du départ, dans le fuseau de l'entreprise (AAAA-MM-JJ). */
  tripDate: string
  tripClosed: boolean
  worksiteName: string | null
  /** Compteur à l'arrivée (trajet clos), sinon au départ. */
  odometer: number | null
  km: number | null
  kmSource: KmSource | null
  route: { status: RouteStatus; oneWayKm: number | null }
  fuel: FuelType
  stations: FuelStation[]
  stationsStatus: StationsStatus
  /** Prix sur les stations lues du couloir (les stations listées ne sont que les moins chères). */
  priceStats: PriceStats | null
  /** Séjour : hypothèses de déplacement retenues pour ce calcul (jamais un historique), sinon null. */
  travel: StayTravel | null
  /** L'opérateur a confirmé que le siège est le vrai point de départ et de retour (exigé pour des km d'itinéraire). */
  depotConfirmed: boolean
  /** Décisions encore manquantes : tant qu'il en reste, `km` est null (aucun montant ne peut être proposé). */
  missing: EstimateDecision[]
}

// ─── Décisions de déplacement (hypothèses explicites de l'opérateur) ────────

/** ONE_ROUND_TRIP : un aller-retour pour le séjour (camion sur place) ; DAILY : un aller-retour par jour planifié. */
export const TRAVEL_MODES = ["ONE_ROUND_TRIP", "DAILY"] as const
export type TravelMode = (typeof TRAVEL_MODES)[number]
/** Coupure du planning : STAY = camion resté sur place ; RETURN = camion rentré au siège puis reparti. */
export const GAP_DECISIONS = ["STAY", "RETURN"] as const
export type GapDecision = (typeof GAP_DECISIONS)[number]
/** MODE : déplacement non choisi ; GAPS : coupure sans décision ; DEPOT : siège non confirmé comme point réel. */
export type EstimateDecision = "MODE" | "GAPS" | "DEPOT"

export interface StayTravel {
  /** Empreinte du contexte du séjour sur lequel les décisions ont été vérifiées (PlannedStay.context). */
  context: string
  mode: TravelMode | null
  /** Coupures du séjour avec la décision retenue (null : pas encore décidée, ou sans objet en mode DAILY). */
  gaps: (DayRange & { decision: GapDecision | null })[]
  plannedDays: number
  /** Allers-retours siège ↔ chantier retenus ; null tant qu'une décision manque. */
  roundTrips: number | null
  oneWayKm: number | null
  /**
   * Jours de réaffectation en journée que l'opérateur déclare attribuer à l'équipe du séjour (vide sinon). Hypothèse
   * d'estimation non enregistrée par le GET ; consignée seulement si une dépense est sauvegardée avec cette provenance.
   * Jamais un historique d'affectation du camion.
   */
  handoverDeclared: string[]
}

/**
 * Allers-retours d'un séjour selon les décisions : aucune n'est supposée.
 * ONE_ROUND_TRIP : 1, plus 1 par coupure où le camion est rentré au siège ; chaque coupure doit être décidée (clé
 * `gapKey` : premier et dernier jour, une coupure prolongée n'hérite jamais d'une décision).
 * DAILY : un par jour effectivement planifié (les jours sans planning ne sont pas des jours travaillés).
 * Exemple : 100 km aller, 3 jours planifiés consécutifs → 200 km (ONE_ROUND_TRIP) ou 600 km (DAILY).
 */
export function stayRoundTrips(stay: Pick<PlannedStay, "days" | "gaps">, decisions: { mode: TravelMode | null; gaps: Readonly<Record<string, GapDecision>> }): { roundTrips: number | null; missing: EstimateDecision[]; gaps: StayTravel["gaps"] } {
  if (decisions.mode === "DAILY") return { roundTrips: stay.days, missing: [], gaps: stay.gaps.map((g) => ({ ...g, decision: null })) }
  const gaps = stay.gaps.map((g) => ({ ...g, decision: decisions.mode === "ONE_ROUND_TRIP" ? decisions.gaps[gapKey(g)] ?? null : null }))
  const missing: EstimateDecision[] = []
  if (decisions.mode === null) missing.push("MODE")
  else if (gaps.some((g) => g.decision === null)) missing.push("GAPS")
  return { roundTrips: missing.length ? null : 1 + gaps.filter((g) => g.decision === "RETURN").length, missing, gaps }
}

// ─── Séjours planifiés ───────────────────────────────────────────────────────

export const STAY_ID = /^[A-Za-z0-9_-]{1,64}~[A-Za-z0-9_-]{1,64}~\d{4}-\d{2}-\d{2}$/

export interface StayAssignment {
  date: string; teamId: string
  worksite: { id: string; name: string; address: string | null; latitude?: number | null; longitude?: number | null }
}
/**
 * Période d'affectation du camion, en instants (ms) : intervalle semi-ouvert [startedAt, endedAt). `fallback` :
 * période supposée (aucun historique enregistré : équipe et chauffeur actuels du camion).
 */
export interface StayTruckPeriod { teamId: string | null; chauffeurId: string | null; startedAt: number; endedAt: number | null; fallback?: boolean }
/** Jours effectivement lus (inclus) : un séjour qui touche une borne n'a pas de départ ou de retour connu. */
export interface StayScan { from: string; to: string }

/** Séjour le plus long estimable (jours civils) ; au-delà, ses bornes ne sont pas reconstruites de façon identique liste/détail. */
export const MAX_STAY_DAYS = 62
/**
 * Coupure du planning la plus longue rattachée au séjour (une semaine). Une coupure plus longue sépare deux séjours
 * distincts, chacun avec ses propres allers-retours : c'est la portée retenue, affichée à l'opérateur.
 */
export const MAX_GAP_DAYS = 7
/**
 * Jours lus de chaque côté d'un séjour pour connaître ses vraies bornes : une suite plus proche que MAX_GAP_DAYS pourrait
 * encore s'y rattacher, le départ (ou le retour) n'est donc connu que si ces jours sont lus.
 */
export const STAY_EDGE_DAYS = MAX_GAP_DAYS + 1

const DAY_MS = 86_400_000
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const nextDay = (day: string) => addDays(day, 1)

/** Instant de minuit à Paris pour un jour civil (heure d'été comprise). */
export function parisDayStart(day: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`)
  const offset = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant
  }
  return utc - offset(utc - offset(utc))
}

/**
 * Convention d'attribution d'un jour à UNE seule période du camion (jamais deux équipes le même jour) :
 * la période qui détient le camion à minuit (Paris) en début de journée, intervalle semi-ouvert [début, fin) ;
 * à défaut (camion sans affectation à minuit), la première période commencée pendant la journée.
 * Une bascule à 00 h 00 le J donne donc le J à la nouvelle période ; une bascule à 10 h le J laisse le J à l'ancienne
 * et ce jour est signalé comme « jour de réaffectation ». Cette convention sert seulement à regrouper les jours de façon
 * déterministe (liste = détail) : un séjour qui contient un jour de réaffectation n'est PAS estimable (`HANDOVER`), la
 * convention n'est donc jamais présentée comme une attribution réelle. Périodes chevauchantes : la plus récente l'emporte.
 */
export function truckHolderOn(day: string, periods: readonly StayTruckPeriod[], dayStart: (day: string) => number = parisDayStart): { holder: StayTruckPeriod | null; handover: boolean } {
  const start = dayStart(day), end = dayStart(nextDay(day))
  const valid = periods.filter((p) => p.endedAt === null || p.endedAt > p.startedAt)
  let holder: StayTruckPeriod | null = null
  for (const p of valid) if (p.startedAt <= start && (p.endedAt === null || p.endedAt > start) && (!holder || p.startedAt > holder.startedAt)) holder = p
  if (!holder) for (const p of valid) if (p.startedAt > start && p.startedAt < end && (!holder || p.startedAt < holder.startedAt)) holder = p
  const handover = valid.some((p) => (p.startedAt > start && p.startedAt < end) || (p.endedAt !== null && p.endedAt > start && p.endedAt < end))
  return { holder, handover }
}

export type ResolvedStay = Omit<PlannedStay, "teamName" | "leaderName" | "chauffeurName"> & { chauffeurId: string | null }

/** FNV-1a 32 bits (deux graines) : empreinte stable côté serveur et navigateur, sans dépendance. */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}
/** Empreinte du contexte canonique (voir PlannedStay.context). */
export function stayContext(stay: Omit<ResolvedStay, "context">): string {
  const canonical = JSON.stringify(["v1", stay.id, stay.worksiteId, stay.teamId, stay.departure, stay.return, stay.days, stay.spanDays,
    stay.runs.map((r) => [r.from, r.to]), stay.gaps.map((g) => [g.from, g.to]), [...stay.handoverDays].sort(), stay.blocked,
    stay.departureKnown, stay.returnKnown, stay.assignment, stay.chauffeurId])
  return `v1-${fnv(canonical, 0x811c9dc5)}${fnv(canonical, 0x050c5d1f)}`
}
/** Clé d'une coupure : premier ET dernier jour (une nouvelle fin n'est jamais la même coupure). */
export const gapKey = (g: { from: string; to: string }) => `${g.from}..${g.to}`

/**
 * Séjours du camion sur les jours lus `scan` : jours de planning attribués (convention ci-dessus) à l'équipe planifiée,
 * regroupés par chantier et équipe, découpés en suites de jours consécutifs, puis suites reliées par une coupure de
 * MAX_GAP_DAYS jours au plus si, chaque jour de la coupure, le camion est à la même équipe (période qui le détient à
 * minuit), sans réaffectation dans la journée, et que l'équipe n'est planifiée sur aucun autre chantier. Sinon, la
 * suite suivante forme un autre séjour. Chaque jour planifié appartient ainsi à un seul séjour (pas de double compte).
 * Un séjour dont une suite pourrait encore se rattacher hors des jours lus (STAY_EDGE_DAYS) n'a pas de départ (ou de
 * retour) connu : il est signalé, jamais présenté comme un vrai départ/retour.
 * Le chauffeur est celui de la période qui détient le camion le jour du départ (pas une preuve de présence chaque jour).
 * Liste et détail appellent cette même règle avec des bornes lues assez larges : un séjour estimable a les mêmes
 * identifiant, dates, coupures et chauffeur dans les deux.
 */
export function resolveStays(assignments: readonly StayAssignment[], periods: readonly StayTruckPeriod[], scan: StayScan, dayStart: (day: string) => number = parisDayStart): ResolvedStay[] {
  const holders = new Map<string, ReturnType<typeof truckHolderOn>>()
  const holderOn = (day: string) => { let h = holders.get(day); if (!h) { h = truckHolderOn(day, periods, dayStart); holders.set(day, h) } return h }
  const groups = new Map<string, { assignment: StayAssignment; days: Set<string> }>()
  // Tous les jours planifiés (même attribués à une autre période) : une réaffectation la veille ou le lendemain d'un
  // jour planifié pour la même équipe rend le vrai départ ou retour incertain.
  const planned = new Set(assignments.map((a) => `${a.worksite.id}~${a.teamId}~${a.date}`))
  // Chantiers de chaque équipe par jour : une équipe planifiée ailleurs pendant une coupure ne la laisse pas « sur place ».
  const teamDay = new Map<string, Set<string>>()
  for (const a of assignments) { const k = `${a.teamId}~${a.date}`; const s = teamDay.get(k) ?? new Set<string>(); s.add(a.worksite.id); teamDay.set(k, s) }
  const gapLinks = (from: string, to: string, teamId: string, worksiteId: string) => {
    for (let d = from; d <= to; d = nextDay(d)) {
      const h = holderOn(d)
      if (h.holder?.teamId !== teamId || h.handover || [...(teamDay.get(`${teamId}~${d}`) ?? [])].some((w) => w !== worksiteId)) return false
    }
    return true
  }
  for (const a of assignments) {
    if (a.date < scan.from || a.date > scan.to || holderOn(a.date).holder?.teamId !== a.teamId) continue
    const key = `${a.worksite.id}~${a.teamId}`
    const group = groups.get(key) ?? { assignment: a, days: new Set<string>() }
    group.days.add(a.date)
    groups.set(key, group)
  }
  const stays: ResolvedStay[] = []
  const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
  for (const { assignment, days } of groups.values()) {
    const w = assignment.worksite
    const sorted = [...days].sort()
    // Suites de jours consécutifs.
    const runs: DayRange[] = []
    let start = 0
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === nextDay(sorted[i - 1])) continue
      runs.push({ from: sorted[start], to: sorted[i - 1], days: i - start })
      start = i
    }
    // Suites reliées par une coupure courte où le camion reste à l'équipe, sans réaffectation ni planning ailleurs.
    const stayGroups: DayRange[][] = []
    for (const run of runs) {
      const current = stayGroups.at(-1), last = current?.at(-1)
      const gap = last ? { from: nextDay(last.to), to: addDays(run.from, -1) } : null
      if (current && gap && span(gap.from, gap.to) <= MAX_GAP_DAYS && gapLinks(gap.from, gap.to, assignment.teamId, w.id)) current.push(run)
      else stayGroups.push([run])
    }
    for (const group of stayGroups) {
      const departure = group[0].from, back = group.at(-1)!.to
      const runDays = group.flatMap((r) => { const out: string[] = []; for (let d = r.from; d <= r.to; d = nextDay(d)) out.push(d); return out })
      const gaps: DayRange[] = group.slice(1).map((r, i) => { const from = nextDay(group[i].to), to = addDays(r.from, -1); return { from, to, days: span(from, to) } })
      const gapDays = gaps.flatMap((g) => { const out: string[] = []; for (let d = g.from; d <= g.to; d = nextDay(d)) out.push(d); return out })
      const holder = holderOn(departure).holder
      const departureKnown = addDays(departure, -STAY_EDGE_DAYS) >= scan.from, returnKnown = addDays(back, STAY_EDGE_DAYS) <= scan.to
      const before = addDays(departure, -1), after = addDays(back, 1)
      const edges = [before, after].filter((d) => planned.has(`${w.id}~${assignment.teamId}~${d}`))
      const handoverDays = [...runDays, ...edges].filter((d) => holderOn(d).handover).sort()
      const fallback = [...runDays, ...gapDays].some((d) => holderOn(d).holder?.fallback)
      const spanDays = span(departure, back)
      const blocked: StayBlock | null = !departureKnown || !returnKnown ? "OUT_OF_RANGE" : spanDays > MAX_STAY_DAYS ? "TOO_LONG"
        : fallback ? "NO_HISTORY" : handoverDays.length ? "HANDOVER" : null
      const resolved: Omit<ResolvedStay, "context"> = {
        id: `${w.id}~${assignment.teamId}~${departure}`, worksiteId: w.id, worksiteName: w.name,
        hasAddress: !!w.address?.trim(), hasCoordinates: Number.isFinite(w.latitude) && Number.isFinite(w.longitude),
        teamId: assignment.teamId, departure, return: back, days: runDays.length, spanDays, runs: group, gaps,
        departureKnown, returnKnown, estimable: blocked === null, blocked,
        assignment: fallback ? "CURRENT_TEAM_FALLBACK" : "HISTORY",
        handoverDays,
        chauffeurId: holder?.chauffeurId ?? null,
      }
      stays.push({ ...resolved, context: stayContext(resolved) })
    }
  }
  return stays.sort((a, b) => b.departure.localeCompare(a.departure) || a.worksiteName.localeCompare(b.worksiteName, "fr") || a.id.localeCompare(b.id))
}

/** Statistiques des prix lus ; `sampled` si le fournisseur a tronqué au moins une réponse. */
export function priceStats(stations: readonly { price: number }[], sampled = false): PriceStats | null {
  const prices = stations.map((s) => s.price).filter((p) => Number.isFinite(p)).sort((a, b) => a - b)
  if (!prices.length) return null
  const mid = prices.length / 2
  const median = prices.length % 2 ? prices[Math.floor(mid)] : (prices[mid - 1] + prices[mid]) / 2
  return { count: prices.length, min: prices[0], median: Math.round(median * 1000) / 1000, max: prices[prices.length - 1], sampled }
}

// ─── Géométrie ───────────────────────────────────────────────────────────────

const EARTH_KM = 6371
const rad = (deg: number) => deg * Math.PI / 180

export function haversineKm(a: Point, b: Point): number {
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return EARTH_KM * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}

export function polylineKm(points: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i])
  return total
}

/**
 * Points régulièrement espacés le long du tracé (départ et arrivée compris), au plus `maxSamples`, et rayon de recherche
 * autour de chacun : tout point à moins de `halfWidthKm` du tracé est à moins de `radiusKm` d'un échantillon
 * (√((espacement/2)² + demi-largeur²)). La demi-largeur du couloir ne dépend donc pas de la longueur du trajet ; seul le
 * rayon de requête grandit, puis les stations sont refiltrées sur leur distance au tracé.
 */
export function samplePolyline(points: readonly Point[], maxSamples = 160, halfWidthKm = CORRIDOR_HALF_WIDTH_KM): { samples: Point[]; radiusKm: number } {
  if (!points.length) return { samples: [], radiusKm: 1 }
  const total = polylineKm(points)
  const spacing = Math.max(2, total / Math.max(1, maxSamples - 1))
  const samples: Point[] = [points[0]]
  let carried = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const segment = haversineKm(a, b)
    let position = spacing - carried
    while (position <= segment && samples.length < maxSamples - 1) {
      const t = segment === 0 ? 0 : position / segment
      samples.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t })
      position += spacing
    }
    carried = (carried + segment) % spacing
  }
  const last = points[points.length - 1]
  if (samples.length === 1 || haversineKm(samples[samples.length - 1], last) > 0.05) samples.push(last)
  // Écart réel maximal entre deux échantillons consécutifs (le dernier peut être plus proche que l'espacement).
  let gap = 0
  for (let i = 1; i < samples.length; i++) gap = Math.max(gap, haversineKm(samples[i - 1], samples[i]))
  const radius = Math.sqrt((Math.max(gap, spacing) / 2) ** 2 + halfWidthKm ** 2) + 0.05
  return { samples, radiusKm: Math.ceil(Math.min(20, radius) * 100) / 100 }
}

/**
 * Tracé simplifié pour le cache (Douglas-Peucker) : chaque point retiré reste à moins de `toleranceKm` du tracé conservé,
 * donc la distance d'une station au tracé simplifié diffère de moins de cette tolérance (lacets et virages compris,
 * contrairement à un sous-échantillonnage par index qui coupe les lacets par une corde). Si `maxPoints` ne suffit pas,
 * la tolérance est doublée, et la tolérance effective est rendue pour élargir d'autant le filtre.
 */
export function simplifyPolyline(points: readonly Point[], maxPoints = 1_000, toleranceKm = 0.02): { line: Point[]; toleranceKm: number } {
  if (points.length <= 2) return { line: [...points], toleranceKm: 0 }
  for (let tolerance = toleranceKm; ; tolerance *= 2) {
    const keep = new Uint8Array(points.length)
    keep[0] = keep[points.length - 1] = 1
    const stack: [number, number][] = [[0, points.length - 1]]
    let kept = 2
    while (stack.length && kept <= maxPoints) {
      const [a, b] = stack.pop()!
      let worst = -1, index = -1
      for (let i = a + 1; i < b; i++) { const d = distanceToPolylineKm(points[i], [points[a], points[b]]); if (d > worst) { worst = d; index = i } }
      if (index !== -1 && worst > tolerance) { keep[index] = 1; kept++; stack.push([a, index], [index, b]) }
    }
    if (kept <= maxPoints) return { line: points.filter((_, i) => keep[i]), toleranceKm: tolerance }
  }
}

/** Distance d'un point au tracé (projection locale équirectangulaire, suffisante à l'échelle d'un trajet). */
export function distanceToPolylineKm(point: Point, line: readonly Point[]): number {
  if (!line.length) return Infinity
  if (line.length === 1) return haversineKm(point, line[0])
  const k = Math.cos(rad(point.latitude))
  const xy = (p: Point) => ({ x: rad(p.longitude) * k * EARTH_KM, y: rad(p.latitude) * EARTH_KM })
  const p = xy(point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const a = xy(line[i - 1]), b = xy(line[i])
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

/** Les stations les moins chères du couloir, puis les plus proches du trajet. */
export function rankStations(stations: readonly FuelStation[], limit = 8): FuelStation[] {
  return [...stations].sort((a, b) => a.price - b.price || a.offRouteKm - b.offRouteKm || a.id.localeCompare(b.id)).slice(0, limit)
}

// ─── Estimation ──────────────────────────────────────────────────────────────

export const CONSUMPTION_BOUNDS = { min: 1, max: 80 } as const

/** Saisie française « 9,5 » → 9.5 ; null si vide ou hors bornes. */
export function parseConsumption(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."))
  return raw.trim() && Number.isFinite(value) && value >= CONSUMPTION_BOUNDS.min && value <= CONSUMPTION_BOUNDS.max ? value : null
}

/** Litres = km × L/100 km ÷ 100 (3 décimales) ; montant = litres × prix (2 décimales). Null si une donnée manque. */
export function estimateFuel(input: { km: number | null; consumptionLPer100Km: number | null; pricePerLitre: number | null }): { litres: number; amount: number } | null {
  const { km, consumptionLPer100Km: c, pricePerLitre: price } = input
  if (km === null || c === null || price === null || !(km > 0) || km > 10_000 || !(c >= CONSUMPTION_BOUNDS.min) || c > CONSUMPTION_BOUNDS.max || !(price > 0) || price > 10) return null
  const litres = Math.round(km * c / 100 * 1000) / 1000
  return { litres, amount: Math.round(litres * price * 100) / 100 }
}

export function decimalFr(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",")
}

export const ESTIMATE_NOTE_PREFIX = "Estimation trajet :"

/** Note ajoutée à la dépense : la provenance du calcul reste lisible dans le registre. */
const dayFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Prix retenu : une station précise, ou la médiane des stations du couloir. */
export type PriceChoice = { kind: "STATION"; station: FuelStation } | { kind: "MEDIAN"; stats: PriceStats; date: string }
export const choicePrice = (choice: PriceChoice) => choice.kind === "STATION" ? choice.station.price : choice.stats.median

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`
export const roundTripsFr = (n: number) => `${n} ${n > 1 ? "allers-retours" : "aller-retour"}`

/**
 * Hypothèses de déplacement d'un séjour, en clair : mode, décision de chaque coupure, allers-retours retenus et, le
 * cas échéant, déclaration de l'opérateur pour une réaffectation en journée (distinguée d'un historique d'affectation).
 */
export function travelNote(stay: Pick<PlannedStay, "teamName">, travel: StayTravel): string {
  const parts: string[] = []
  if (travel.mode === "DAILY") parts.push(`hypothèse de l'opérateur : un aller-retour siège ↔ chantier par jour planifié (${plural(travel.plannedDays, "jour")} planifié${travel.plannedDays > 1 ? "s" : ""}, jours sans planning non comptés)`)
  if (travel.mode === "ONE_ROUND_TRIP") {
    parts.push("hypothèse de l'opérateur : un aller-retour pour le séjour")
    for (const g of travel.gaps) parts.push(`coupure du ${dayFr(g.from)} au ${dayFr(g.to)} : ${g.decision === "RETURN" ? "camion rentré au siège" : g.decision === "STAY" ? "camion resté sur place" : "non décidée"}`)
  }
  if (travel.roundTrips !== null) parts.push(`${roundTripsFr(travel.roundTrips)}${travel.oneWayKm !== null ? ` de 2 × ${decimalFr(travel.oneWayKm, 1)} km` : ""}`)
  if (travel.handoverDeclared.length) parts.push(`déclaration de l'opérateur, pas un historique d'affectation : camion attribué à l'équipe ${stay.teamName ?? "du séjour"} les jours de réaffectation ${travel.handoverDeclared.map(dayFr).join(", ")}`)
  parts.push(`contexte du planning ${travel.context}`)
  return parts.join(" ; ")
}

/** Note ajoutée à la dépense : la provenance du calcul reste lisible dans le registre. */
export function estimateNote(input: { km: number; kmSource: KmSource; extraKm?: number; consumption: number; price: PriceChoice; fuel: FuelType; stay?: PlannedStay | null; travel?: StayTravel | null; depotConfirmed?: boolean }): string {
  const depot = input.kmSource !== "ODOMETER" && input.depotConfirmed ? ", départ et retour au siège confirmés par l'opérateur" : ""
  const source = input.kmSource === "ODOMETER" ? "compteur" : `itinéraire aller-retour${depot}`
  const stay = input.stay
  const where = stay ? ` chantier ${stay.worksiteName}${stay.teamName ? `, équipe ${stay.teamName}` : ""} (départ ${dayFr(stay.departure)}, retour ${dayFr(stay.return)}, ${plural(stay.days, "jour")} planifié${stay.days > 1 ? "s" : ""}${input.travel ? ` ; ${travelNote(stay, input.travel)}` : ""})` : ""
  const extra = input.extraKm ? ` + ${input.extraKm} km sur place` : ""
  // Une médiane d'échantillon tronqué n'est jamais un prix retenu (priceChoice la refuse) : pas de libellé pour elle.
  if (input.price.kind === "MEDIAN" && input.price.stats.sampled) throw new Error("SAMPLED_MEDIAN")
  const price = input.price.kind === "STATION"
    ? `${decimalFr(input.price.station.price, 3)} €/L ${FUEL_LABELS[input.fuel]} (prix indicatif publié par ${input.price.station.label}, ${input.price.station.city}, le ${dayFr(input.price.station.updatedAt)})`
    : `${decimalFr(input.price.stats.median, 3)} €/L ${FUEL_LABELS[input.fuel]} (prix médian indicatif des ${input.price.stats.count} stations lues sur le trajet au ${dayFr(input.price.date)})`
  return `${ESTIMATE_NOTE_PREFIX}${where} ${input.km - (input.extraKm ?? 0)} km (${source})${extra} × ${decimalFr(input.consumption, 1)} L/100 km × ${price}. À remplacer par le montant du ticket.`
}
