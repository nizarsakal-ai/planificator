/**
 * Coûts d'un véhicule par chantier sur une période (lecture seule, aucune écriture).
 *
 * Sources déjà présentes en base, sans saisie supplémentaire : tournées du camion (km estimés et
 * chantier des étapes), dépenses du registre (validées et à valider, hors refusées et annulées) et
 * planning de l'équipe du camion. Prix du carburant : moyenne des tickets du camion, sinon moyenne
 * nationale du jour (data.economie.gouv.fr). Seule la moyenne nationale part sur le réseau, sans
 * aucune donnée de l'entreprise.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { z } from "zod"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { nationalAveragePrice } from "./fuel-estimate-providers"
import { loadCompanyCardSpend } from "./bank-fuel-service"
import { loadTruckConsumption, type TruckConsumption } from "./fuel-consumption-service"
import {
  computeWorksiteCosts,
  truckAveragePrice,
  type CostExpense,
  type CostTour,
  type FuelPrice,
  type WorksiteCostBreakdown,
} from "./worksite-costs-domain"

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const worksiteCostsQuerySchema = z
  .object({ from: day, to: day })
  .strict()
  .refine((q) => q.to >= q.from && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366)

export interface WorksiteCostsDeps {
  auth: () => Promise<MileageSession | null>
  db: PrismaClient
  fetchFn?: typeof fetch
}

export interface WorksiteCostsResult extends WorksiteCostBreakdown {
  from: string
  to: string
  currency: "EUR"
  /** Dépenses dans une autre devise : non additionnées. */
  otherCurrencyExpenses: number
  /** Consommation mesurée du camion (90 jours glissants jusqu'à la fin de la période). */
  consumption: TruckConsumption
  /** MEASURED : consommation mesurée du camion utilisée ; DEFAULT : forfait (données insuffisantes). */
  consumptionSource: "MEASURED" | "DEFAULT"
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 }
const civilDay = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
/** Bornes larges (± 1 jour) pour la requête ; le filtrage exact se fait sur le jour civil. */
const widen = (s: string, days: number) => new Date(Date.parse(`${s}T00:00:00.000Z`) + days * 86_400_000)

export async function readWorksiteCosts(truckId: string, rawQuery: unknown, deps: WorksiteCostsDeps): Promise<WorksiteCostsResult> {
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) throw new MileageDomainError("FORBIDDEN", 403)
  const parsed = worksiteCostsQuerySchema.safeParse(rawQuery)
  if (!parsed.success) throw new MileageDomainError("INVALID_PERIOD", 400)
  const { from, to } = parsed.data
  const companyId = session.companyId

  const data = await deps.db.$transaction(async (tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ")
    const settings = await tx.companySettings.findUnique({ where: { companyId }, select: { timezone: true } })
    const timeZone = settings?.timezone || "Europe/Paris"
    const lo = widen(from, -1), hi = widen(to, 2)

    const tours = await tx.vehicleTour.findMany({
      where: { companyId, truckId, status: { not: "CANCELLED" }, startsAt: { lt: hi }, endsAt: { gt: lo } },
      include: { stops: { orderBy: { position: "asc" }, select: { worksiteId: true } } },
      orderBy: { startsAt: "asc" },
      take: 200,
    })
    const expenses = await tx.vehicleExpense.findMany({
      where: { companyId, truckId, status: { in: ["PENDING", "APPROVED"] }, occurredAt: { gte: lo, lt: hi } },
      select: { id: true, occurredAt: true, category: true, status: true, amount: true, currency: true, litres: true },
      take: 2_000,
    })
    const assignments = truck.teamId
      ? await tx.assignment.findMany({
          where: { teamId: truck.teamId, date: { gte: widen(from, 0), lte: widen(to, 0) }, status: { not: "REFUSED" }, worksite: { companyId } },
          select: { date: true, worksiteId: true },
          orderBy: { date: "asc" },
          take: 1_000,
        })
      : []
    // Prix payé par ce camion sur les 6 derniers mois (tickets validés avec litres).
    const fuelTickets = await tx.vehicleExpense.findMany({
      where: { companyId, truckId, category: "FUEL", status: "APPROVED", currency: "EUR", litres: { not: null }, occurredAt: { gte: new Date(Date.now() - 183 * 86_400_000) } },
      select: { amount: true, litres: true },
      take: 500,
    })

    const costTours: CostTour[] = tours
      .map((t) => ({
        id: t.id,
        title: t.title,
        startDay: civilDay(t.startsAt, timeZone),
        endDay: civilDay(new Date(t.endsAt.getTime() - 1), timeZone),
        estimatedKm: t.estimatedKm,
        worksiteId: t.stops.find((s) => s.worksiteId)?.worksiteId ?? null,
      }))
      .filter((t) => t.startDay <= to && t.endDay >= from)
    let otherCurrencyExpenses = 0
    const costExpenses: CostExpense[] = []
    for (const e of expenses) {
      const d = civilDay(e.occurredAt, timeZone)
      if (d < from || d > to) continue
      if (e.currency !== "EUR") { otherCurrencyExpenses++; continue }
      costExpenses.push({
        id: e.id,
        day: d,
        category: e.category as CostExpense["category"],
        status: e.status as CostExpense["status"],
        amount: Number(e.amount),
        litres: e.litres === null ? null : Number(e.litres),
      })
    }
    const costAssignments = assignments.map((a) => ({ day: a.date.toISOString().slice(0, 10), worksiteId: a.worksiteId }))
    const worksiteIds = [...new Set([...costTours.map((t) => t.worksiteId), ...costAssignments.map((a) => a.worksiteId)].filter((x): x is string => !!x))]
    const worksites = worksiteIds.length
      ? await tx.worksite.findMany({ where: { companyId, id: { in: worksiteIds } }, select: { id: true, name: true } })
      : []
    // Péages, repas, hôtels payés avec la carte de ce camion (relevés bancaires importés).
    const { otherSpend } = await loadCompanyCardSpend(tx, companyId, timeZone, from, to)
    const cardSpend = otherSpend
      .filter((c) => c.truckId === truckId)
      .map((c) => ({ day: c.day, kind: c.category, amount: -c.amountCents / 100 }))
    // Consommation réelle du camion (plein à plein), à la place du forfait quand elle est fiable.
    const consumption = await loadTruckConsumption(tx, companyId, truckId, widen(to, 1))
    return {
      consumption,
      cardSpend,
      costTours,
      costExpenses,
      costAssignments,
      otherCurrencyExpenses,
      worksiteNames: new Map(worksites.map((w) => [w.id, w.name])),
      truckPrice: truckAveragePrice(fuelTickets.map((t) => ({ amount: Number(t.amount), litres: t.litres === null ? null : Number(t.litres) }))),
    }
  }, txOptions)

  let fuelPrice: FuelPrice | null = data.truckPrice ? { pricePerLitre: data.truckPrice, source: "TRUCK_HISTORY" } : null
  const needsPrice = data.costTours.some((t) => (t.estimatedKm ?? 0) > 0)
  if (!fuelPrice && needsPrice) {
    try {
      fuelPrice = { pricePerLitre: await nationalAveragePrice("GAZOLE", deps.fetchFn ?? fetch), source: "NATIONAL_AVERAGE" }
    } catch (error) {
      if (!(error instanceof MileageDomainError)) throw error
      fuelPrice = null // service public indisponible : litres affichés, montant non calculé
    }
  }

  const measured = data.consumption.current.status === "OK" ? data.consumption.current.lPer100Km : null
  return {
    ...computeWorksiteCosts({
      tours: data.costTours,
      expenses: data.costExpenses,
      assignments: data.costAssignments,
      cardSpend: data.cardSpend,
      worksiteNames: data.worksiteNames,
      fuelPrice,
      ...(measured ? { consumptionLPer100Km: measured } : {}),
    }),
    consumption: data.consumption,
    consumptionSource: measured ? "MEASURED" : "DEFAULT",
    from,
    to,
    currency: "EUR",
    otherCurrencyExpenses: data.otherCurrencyExpenses,
  }
}
