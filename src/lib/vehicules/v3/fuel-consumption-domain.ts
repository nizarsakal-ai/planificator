/**
 * Kilomètres réels contre estimés, et consommation de carburant : règles pures (aucune base, aucun réseau).
 *
 * Pourquoi ces précautions :
 *   - des litres ACHETÉS ne sont pas des litres CONSOMMÉS (niveau du réservoir inconnu au début et à la
 *     fin d'une période). La méthode « plein à plein » ramène l'erreur au plus à un réservoir sur toute la
 *     période : la consommation n'est donc donnée que sur au moins 3 pleins et 3 000 km ;
 *   - le compteur lu sur un ticket (photo ou saisie du chauffeur) est facultatif et peut être faux : il
 *     n'est utilisé que s'il est cohérent avec le journal du compteur, sinon il est ignoré (jamais bloquant).
 */

/** Période glissante de la consommation moyenne du camion. */
export const CONSUMPTION_WINDOW_DAYS = 90
export const CONSUMPTION_MIN_FILLS = 3
export const CONSUMPTION_MIN_KM = 3_000
/** Bornes de vraisemblance d'un camion (L/100 km) : en dehors, un ticket ou un compteur est faux. */
export const CONSUMPTION_PLAUSIBLE_MIN = 4
export const CONSUMPTION_PLAUSIBLE_MAX = 30
/** Hausse signalée par rapport à la période précédente. */
export const CONSUMPTION_RISE_ALERT_RATIO = 0.2
/** Écart km réels / estimés signalé au-delà de 20 % ET de 50 km. */
export const KM_GAP_ALERT_RATIO = 0.2
export const KM_GAP_ALERT_MIN_KM = 50
/** Distance réelle minimale d'une tournée pour afficher un ratio litres achetés / 100 km. */
export const TOUR_FUEL_MIN_KM = 300
/** Tolérance de lecture d'un compteur sur ticket par rapport au journal (km). */
export const TICKET_MILEAGE_TOLERANCE_KM = 30
/** Au-delà du dernier relevé connu, un compteur de ticket plus lointain est jugé incohérent. */
export const TICKET_MILEAGE_MAX_AHEAD_KM = 5_000

const round1 = (n: number) => Math.round(n * 10) / 10

export interface KmComparison {
  estimatedKm: number
  actualKm: number
  gapKm: number
  /** (réel − estimé) / estimé ; null si l'estimation vaut 0. */
  gapRatio: number | null
  alert: boolean
}

/** Écart d'une tournée terminée ; null tant que l'une des deux valeurs manque. */
export function compareTourKm(estimatedKm: number | null, actualKm: number | null): KmComparison | null {
  if (estimatedKm === null || actualKm === null || !Number.isFinite(estimatedKm) || !Number.isFinite(actualKm)) return null
  if (estimatedKm < 0 || actualKm < 0) return null
  const gapKm = Math.round(actualKm - estimatedKm)
  const gapRatio = estimatedKm > 0 ? Math.round(((actualKm - estimatedKm) / estimatedKm) * 1000) / 1000 : null
  const alert = Math.abs(gapKm) > KM_GAP_ALERT_MIN_KM && (gapRatio === null || Math.abs(gapRatio) > KM_GAP_ALERT_RATIO)
  return { estimatedKm: Math.round(estimatedKm), actualKm: Math.round(actualKm), gapKm, gapRatio, alert }
}

/** Relevé effectif du journal du compteur (instant de l'observation, valeur après corrections). */
export interface OdometerPoint { at: number; km: number }

/** Compteur interpolé à un instant, entre deux relevés du journal ; null hors de la plage connue. */
export function odometerAt(points: readonly OdometerPoint[], at: number): number | null {
  const sorted = [...points].sort((a, b) => a.at - b.at)
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    if (p.at === at) return p.km
    if (p.at > at) {
      if (i === 0) return null
      const prev = sorted[i - 1]
      if (p.km < prev.km) return null // journal non croissant : pas d'interpolation
      return prev.km + ((p.km - prev.km) * (at - prev.at)) / (p.at - prev.at)
    }
  }
  return null
}

/**
 * Compteur lu sur un ticket : cohérent s'il se place entre le relevé précédent et le suivant (à la
 * tolérance près), et pas trop loin devant le dernier relevé connu. Sans aucun relevé : accepté.
 */
export function ticketMileagePlausible(points: readonly OdometerPoint[], at: number, mileage: number): boolean {
  if (!Number.isInteger(mileage) || mileage <= 0) return false
  const before = points.filter((p) => p.at <= at).reduce<OdometerPoint | null>((m, p) => (!m || p.at > m.at ? p : m), null)
  const after = points.filter((p) => p.at > at).reduce<OdometerPoint | null>((m, p) => (!m || p.at < m.at ? p : m), null)
  if (before && mileage < before.km - TICKET_MILEAGE_TOLERANCE_KM) return false
  if (after && mileage > after.km + TICKET_MILEAGE_TOLERANCE_KM) return false
  if (!after && before && mileage > before.km + TICKET_MILEAGE_MAX_AHEAD_KM) return false
  return true
}

export interface FuelFill {
  at: number
  /** Litres du ticket ; null pour un plein du relevé bancaire encore sans ticket. */
  litres: number | null
  amount: number
  /** Compteur lu sur le ticket ou saisi par le chauffeur (facultatif). */
  ticketMileage: number | null
}

export type ConsumptionStatus = "OK" | "INSUFFICIENT_DATA" | "IMPLAUSIBLE"

export interface ConsumptionResult {
  status: ConsumptionStatus
  lPer100Km: number | null
  litres: number
  km: number
  fills: number
  /** Pleins sans litres dont les litres ont été déduits du montant et du prix moyen. */
  litresFromAmount: number
  /** Compteurs de tickets utilisés / ignorés (incohérents avec le journal). */
  ticketMileageUsed: number
  ticketMileageIgnored: number
}

/**
 * Consommation « plein à plein » : litres des pleins après le premier, jusqu'au dernier inclus, divisés
 * par la distance entre ces deux pleins. Compteur à chaque plein : celui du ticket s'il est cohérent,
 * sinon interpolé dans le journal. `pricePerLitre` sert à estimer les litres d'un plein sans ticket.
 */
export function computeConsumption(fills: readonly FuelFill[], points: readonly OdometerPoint[], pricePerLitre: number | null): ConsumptionResult {
  let ticketMileageUsed = 0, ticketMileageIgnored = 0
  const located = [...fills]
    .filter((f) => Number.isFinite(f.at) && f.amount > 0)
    .sort((a, b) => a.at - b.at)
    .map((f) => {
      let km: number | null = null
      if (f.ticketMileage !== null) {
        if (ticketMileagePlausible(points, f.at, f.ticketMileage)) { km = f.ticketMileage; ticketMileageUsed++ }
        else ticketMileageIgnored++
      }
      if (km === null) km = odometerAt(points, f.at)
      const litres = f.litres !== null && f.litres > 0 ? f.litres : pricePerLitre && pricePerLitre > 0 ? f.amount / pricePerLitre : null
      return { ...f, km, resolvedLitres: litres, fromAmount: !(f.litres !== null && f.litres > 0) }
    })
  const empty: ConsumptionResult = { status: "INSUFFICIENT_DATA", lPer100Km: null, litres: 0, km: 0, fills: 0, litresFromAmount: 0, ticketMileageUsed, ticketMileageIgnored }
  const firstIndex = located.findIndex((f) => f.km !== null)
  let lastIndex = -1
  for (let i = located.length - 1; i > firstIndex; i--) if (located[i].km !== null) { lastIndex = i; break }
  if (firstIndex < 0 || lastIndex < 0) return empty
  const window = located.slice(firstIndex + 1, lastIndex + 1)
  if (window.some((f) => f.resolvedLitres === null)) return { ...empty, fills: window.length + 1 }
  const litres = window.reduce((s, f) => s + (f.resolvedLitres as number), 0)
  const km = (located[lastIndex].km as number) - (located[firstIndex].km as number)
  const base = {
    litres: round1(litres),
    km: Math.round(km),
    fills: window.length + 1,
    litresFromAmount: window.filter((f) => f.fromAmount).length,
    ticketMileageUsed,
    ticketMileageIgnored,
  }
  if (base.fills < CONSUMPTION_MIN_FILLS || km < CONSUMPTION_MIN_KM) return { ...base, status: "INSUFFICIENT_DATA", lPer100Km: null }
  const lPer100Km = round1((litres / km) * 100)
  if (lPer100Km < CONSUMPTION_PLAUSIBLE_MIN || lPer100Km > CONSUMPTION_PLAUSIBLE_MAX) return { ...base, status: "IMPLAUSIBLE", lPer100Km }
  return { ...base, status: "OK", lPer100Km }
}

/** Hausse de consommation par rapport à la période précédente (deux mesures fiables requises). */
export function consumptionRise(current: ConsumptionResult, previous: ConsumptionResult): number | null {
  if (current.status !== "OK" || previous.status !== "OK" || !current.lPer100Km || !previous.lPer100Km) return null
  const ratio = (current.lPer100Km - previous.lPer100Km) / previous.lPer100Km
  return ratio > CONSUMPTION_RISE_ALERT_RATIO ? Math.round(ratio * 1000) / 1000 : null
}

/** Carburant acheté pendant une tournée (indicatif : dépend du niveau du réservoir au départ et à l'arrivée). */
export function tourFuelPurchases(
  tour: { startsAt: number; endsAt: number; actualKm: number | null },
  fills: readonly FuelFill[],
): { litres: number; fills: number; unknownLitres: number; lPer100KmIndicative: number | null } {
  const inside = fills.filter((f) => f.at >= tour.startsAt && f.at <= tour.endsAt)
  const litres = inside.reduce((s, f) => s + (f.litres && f.litres > 0 ? f.litres : 0), 0)
  const unknownLitres = inside.filter((f) => !(f.litres && f.litres > 0)).length
  const indicative = tour.actualKm !== null && tour.actualKm >= TOUR_FUEL_MIN_KM && litres > 0 && unknownLitres === 0
    ? round1((litres / tour.actualKm) * 100)
    : null
  return { litres: round1(litres), fills: inside.length, unknownLitres, lPer100KmIndicative: indicative }
}
