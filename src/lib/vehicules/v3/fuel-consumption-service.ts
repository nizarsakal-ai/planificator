/**
 * Lecture des données de consommation d'un camion (journal du compteur et pleins), dans la transaction
 * de l'appelant, après sa vérification d'autorité. Lecture seule, aucun appel réseau.
 */
import type { Prisma } from "@prisma/client"
import { resolveMileageHistory, type ResolvedMileageHistory } from "../mileage-domain"
import {
  CONSUMPTION_WINDOW_DAYS,
  computeConsumption,
  consumptionRise,
  type ConsumptionResult,
  type FuelFill,
  type OdometerPoint,
} from "./fuel-consumption-domain"
import { truckAveragePrice } from "./worksite-costs-domain"

const DAY_MS = 86_400_000

/** Relevés effectifs (après corrections) du journal, à l'instant de l'observation d'origine. */
export function odometerPointsFromHistory(history: ResolvedMileageHistory): OdometerPoint[] {
  return history.originals.map((o) => ({ at: o.original.occurredAt.getTime(), km: o.effective.mileage }))
}

export async function loadOdometerHistory(tx: Prisma.TransactionClient, companyId: string, truckId: string): Promise<ResolvedMileageHistory> {
  const entries = await tx.mileageEntry.findMany({ where: { companyId, truckId }, orderBy: { revision: "asc" } })
  return resolveMileageHistory(entries)
}

/** Pleins (validés et à valider, en euros) d'un camion sur une période. */
export async function loadFuelFills(tx: Prisma.TransactionClient, companyId: string, truckId: string, from: Date, to: Date): Promise<FuelFill[]> {
  const rows = await tx.vehicleExpense.findMany({
    where: { companyId, truckId, category: "FUEL", status: { in: ["PENDING", "APPROVED"] }, currency: "EUR", occurredAt: { gte: from, lte: to } },
    select: { occurredAt: true, litres: true, amount: true, mileageObservation: true },
    orderBy: { occurredAt: "asc" },
    take: 2_000,
  })
  return rows.map((r) => ({
    at: r.occurredAt.getTime(),
    litres: r.litres === null ? null : Number(r.litres),
    amount: Number(r.amount),
    ticketMileage: r.mileageObservation,
  }))
}

export interface TruckConsumption {
  current: ConsumptionResult
  previous: ConsumptionResult
  /** Hausse > 20 % par rapport aux 90 jours précédents, sinon null. */
  riseRatio: number | null
  windowDays: number
  pricePerLitre: number | null
}

/** Consommation moyenne sur 90 jours glissants jusqu'à `end`, comparée aux 90 jours précédents. */
export async function loadTruckConsumption(tx: Prisma.TransactionClient, companyId: string, truckId: string, end: Date): Promise<TruckConsumption> {
  const windowMs = CONSUMPTION_WINDOW_DAYS * DAY_MS
  const from = new Date(end.getTime() - 2 * windowMs)
  const [fills, history, approvedTickets] = [
    await loadFuelFills(tx, companyId, truckId, from, end),
    await loadOdometerHistory(tx, companyId, truckId),
    await tx.vehicleExpense.findMany({
      where: { companyId, truckId, category: "FUEL", status: "APPROVED", currency: "EUR", litres: { not: null }, occurredAt: { gte: new Date(end.getTime() - 183 * DAY_MS), lte: end } },
      select: { amount: true, litres: true },
      take: 500,
    }),
  ]
  const points = odometerPointsFromHistory(history)
  const pricePerLitre = truckAveragePrice(approvedTickets.map((t) => ({ amount: Number(t.amount), litres: t.litres === null ? null : Number(t.litres) })))
  const split = end.getTime() - windowMs
  const current = computeConsumption(fills.filter((f) => f.at > split), points, pricePerLitre)
  const previous = computeConsumption(fills.filter((f) => f.at <= split), points, pricePerLitre)
  return { current, previous, riseRatio: consumptionRise(current, previous), windowDays: CONSUMPTION_WINDOW_DAYS, pricePerLitre }
}
