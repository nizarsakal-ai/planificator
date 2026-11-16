/**
 * Coûts d'un véhicule par chantier : règle pure (aucune base, aucun réseau).
 *
 * Rattachement automatique, sans saisie :
 *   - une tournée compte pour le premier chantier de ses étapes (sinon « Hors chantier ») ;
 *   - une dépense va au chantier de la tournée du camion en cours à sa date ; à défaut, au chantier
 *     sur lequel l'équipe du camion est planifiée ce jour-là ; à défaut, « Hors chantier ».
 *
 * Carburant estimé = km des tournées × consommation × prix au litre. C'est une estimation, jamais une
 * dépense : les tickets réels restent la référence et sont affichés à part.
 */

export const DEFAULT_CONSUMPTION_L_PER_100KM = 10
export const UNASSIGNED_KEY = "__none__"

export type ExpenseCategory = "FUEL" | "MAINTENANCE" | "INSURANCE" | "OTHER"
export type ExpenseStatus = "PENDING" | "APPROVED"

export interface CostTour {
  id: string
  title: string
  /** Jours civils (AAAA-MM-JJ, fuseau de l'entreprise), bornes incluses. */
  startDay: string
  endDay: string
  estimatedKm: number | null
  worksiteId: string | null
}

export interface CostExpense {
  id: string
  /** Jour civil de la dépense. */
  day: string
  category: ExpenseCategory
  status: ExpenseStatus
  amount: number
  litres: number | null
}

export interface CostAssignment { day: string; worksiteId: string }

export type CardSpendKind = "TOLL" | "MEAL" | "HOTEL"
/** Paiement de la carte du camion relevé sur le compte bancaire (hors carburant). */
export interface CostCardSpend { day: string; kind: CardSpendKind; amount: number }

export interface FuelPrice { pricePerLitre: number; source: "TRUCK_HISTORY" | "NATIONAL_AVERAGE" }

export interface WorksiteCostRow {
  key: string
  worksiteId: string | null
  name: string
  tours: { id: string; title: string; estimatedKm: number | null }[]
  /** Km connus (tournées estimées) ; `toursWithoutKm` signale celles encore à estimer. */
  km: number
  toursWithoutKm: number
  estimatedLitres: number | null
  estimatedFuelCost: number | null
  /** Dépenses réelles rattachées, par catégorie (validées + à valider). */
  expenses: Record<ExpenseCategory, number>
  expensesTotal: number
  pendingExpenses: number
  /** Péages, repas et hôtels payés avec la carte du camion (relevé bancaire). */
  cardSpend: Record<CardSpendKind, number>
  cardSpendTotal: number
}

export interface WorksiteCostBreakdown {
  rows: WorksiteCostRow[]
  totals: { km: number; estimatedFuelCost: number | null; expensesTotal: number; cardSpendTotal: number }
  consumptionLPer100Km: number
  fuelPrice: FuelPrice | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round1 = (n: number) => Math.round(n * 10) / 10
const emptyExpenses = (): Record<ExpenseCategory, number> => ({ FUEL: 0, MAINTENANCE: 0, INSURANCE: 0, OTHER: 0 })

/** Prix moyen payé par ce camion (tickets validés avec litres) ; null si aucun ticket exploitable. */
export function truckAveragePrice(fuelTickets: readonly { amount: number; litres: number | null }[]): number | null {
  let amount = 0, litres = 0
  for (const t of fuelTickets) {
    if (!(t.litres && t.litres > 0) || !(t.amount > 0)) continue
    const price = t.amount / t.litres
    if (price < 0.5 || price > 5) continue // ticket incohérent : ignoré
    amount += t.amount
    litres += t.litres
  }
  return litres > 0 ? Math.round((amount / litres) * 1000) / 1000 : null
}

/** Chantier d'une dépense : tournée du camion ce jour-là, sinon planning de l'équipe, sinon aucun. */
export function worksiteForDay(day: string, tours: readonly CostTour[], assignments: readonly CostAssignment[]): string | null {
  const tour = tours.find((t) => t.worksiteId && t.startDay <= day && day <= t.endDay)
  if (tour) return tour.worksiteId
  return assignments.find((a) => a.day === day)?.worksiteId ?? null
}

export function computeWorksiteCosts(input: {
  tours: readonly CostTour[]
  expenses: readonly CostExpense[]
  assignments: readonly CostAssignment[]
  cardSpend?: readonly CostCardSpend[]
  worksiteNames: ReadonlyMap<string, string>
  fuelPrice: FuelPrice | null
  consumptionLPer100Km?: number
}): WorksiteCostBreakdown {
  const consumption = input.consumptionLPer100Km ?? DEFAULT_CONSUMPTION_L_PER_100KM
  const rows = new Map<string, WorksiteCostRow>()
  const row = (worksiteId: string | null): WorksiteCostRow => {
    const key = worksiteId ?? UNASSIGNED_KEY
    let r = rows.get(key)
    if (!r) {
      r = {
        key,
        worksiteId,
        name: worksiteId ? input.worksiteNames.get(worksiteId) ?? "Chantier" : "Hors chantier",
        tours: [], km: 0, toursWithoutKm: 0, estimatedLitres: null, estimatedFuelCost: null,
        expenses: emptyExpenses(), expensesTotal: 0, pendingExpenses: 0,
        cardSpend: { TOLL: 0, MEAL: 0, HOTEL: 0 }, cardSpendTotal: 0,
      }
      rows.set(key, r)
    }
    return r
  }

  for (const t of input.tours) {
    const r = row(t.worksiteId)
    r.tours.push({ id: t.id, title: t.title, estimatedKm: t.estimatedKm })
    if (t.estimatedKm !== null && Number.isFinite(t.estimatedKm) && t.estimatedKm >= 0) r.km += t.estimatedKm
    else r.toursWithoutKm++
  }
  for (const e of input.expenses) {
    if (!(e.amount >= 0)) continue
    const r = row(worksiteForDay(e.day, input.tours, input.assignments))
    r.expenses[e.category] = round2(r.expenses[e.category] + e.amount)
    r.expensesTotal = round2(r.expensesTotal + e.amount)
    if (e.status === "PENDING") r.pendingExpenses++
  }
  for (const c of input.cardSpend ?? []) {
    if (!(c.amount > 0)) continue
    const r = row(worksiteForDay(c.day, input.tours, input.assignments))
    r.cardSpend[c.kind] = round2(r.cardSpend[c.kind] + c.amount)
    r.cardSpendTotal = round2(r.cardSpendTotal + c.amount)
  }
  for (const r of rows.values()) {
    r.km = Math.round(r.km)
    if (r.km > 0) {
      r.estimatedLitres = round1((r.km * consumption) / 100)
      r.estimatedFuelCost = input.fuelPrice ? round2(r.estimatedLitres * input.fuelPrice.pricePerLitre) : null
    }
  }
  // Chantiers d'abord (par coût décroissant), « Hors chantier » en dernier.
  const ordered = [...rows.values()].sort((a, b) => {
    if (!a.worksiteId !== !b.worksiteId) return a.worksiteId ? -1 : 1
    const ca = (a.estimatedFuelCost ?? 0) + a.expensesTotal + a.cardSpendTotal, cb = (b.estimatedFuelCost ?? 0) + b.expensesTotal + b.cardSpendTotal
    return cb - ca || a.name.localeCompare(b.name, "fr")
  })
  const fuelCosts = ordered.map((r) => r.estimatedFuelCost).filter((v): v is number => v !== null)
  return {
    rows: ordered,
    totals: {
      km: ordered.reduce((s, r) => s + r.km, 0),
      estimatedFuelCost: fuelCosts.length ? round2(fuelCosts.reduce((s, v) => s + v, 0)) : null,
      expensesTotal: round2(ordered.reduce((s, r) => s + r.expensesTotal, 0)),
      cardSpendTotal: round2(ordered.reduce((s, r) => s + r.cardSpendTotal, 0)),
    },
    consumptionLPer100Km: consumption,
    fuelPrice: input.fuelPrice,
  }
}
