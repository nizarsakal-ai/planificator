/**
 * Estimation des kilomètres d'une tournée de chantier : lecture des données (chantier,
 * logement de l'équipe du camion, jours de planning) puis distances IGN.
 *
 * Lecture seule : aucune écriture métier (seul le quota horaire des fournisseurs est compté).
 * Aucune donnée personnelle envoyée à l'IGN : uniquement des adresses de chantier, de logement
 * et du dépôt, comme le kilométrage prévu existant.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { z } from "zod"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { reserveImportProvider } from "../import-provider-quota"
import { ignGeocode, ignRouteKm } from "../planned-mileage-ign"
import {
  CROW_FLIGHT_DETOUR_FACTOR,
  PLANNED_MILEAGE_DEPOT,
  crowFlightKm,
  hasPlannedMileageDepot,
  type DistanceSource,
  type Point,
} from "../planned-mileage-domain"
import { tourFlag, TOUR_MAX_DURATION_DAYS } from "./tour-domain"
import {
  computeTourKmEstimate,
  TOUR_LUNCH_KM_PER_DAY_DEFAULT,
  TOUR_LUNCH_KM_PER_DAY_MAX,
  type TourKmEstimate,
} from "./tour-km-estimate-domain"

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const tourKmEstimateInputSchema = z
  .object({
    worksiteId: z.string().trim().min(1).max(200),
    start: day,
    end: day,
    lunchKmPerDay: z.number().finite().min(0).max(TOUR_LUNCH_KM_PER_DAY_MAX).optional(),
  })
  .strict()
  .refine((x) => x.end >= x.start)

export interface TourKmEstimateResult extends TourKmEstimate {
  workDays: number
  workDaysSource: "PLANNING" | "CALENDAR"
  /** Logement trouvé pour l'équipe ; `resolved` = adresse reconnue et distance calculée. */
  lodging: { address: string; startDate: string; endDate: string; resolved: boolean } | null
  depotLabel: string
}

export interface TourKmEstimateDeps {
  auth: () => Promise<MileageSession | null>
  db: PrismaClient
  fetchFn?: typeof fetch
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }
const utcDay = (s: string) => new Date(`${s}T00:00:00.000Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)

function calendarDays(start: string, end: string): number {
  return Math.round((utcDay(end).getTime() - utcDay(start).getTime()) / 86_400_000) + 1
}

export async function estimateWorksiteTourKm(truckId: string, rawInput: unknown, deps: TourKmEstimateDeps): Promise<TourKmEstimateResult> {
  tourFlag()
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) throw new MileageDomainError("FORBIDDEN", 403)
  const parsed = tourKmEstimateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const input = parsed.data
  if (calendarDays(input.start, input.end) > TOUR_MAX_DURATION_DAYS) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const fetchFn = deps.fetchFn ?? fetch
  const companyId = session.companyId

  // 1. Lecture sous l'autorité du camion (tenant + rôle relus en base).
  const data = await deps.db.$transaction(async (tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ")
    const worksite = await tx.worksite.findFirst({
      where: { id: input.worksiteId, companyId, archivedAt: null },
      select: { address: true, latitude: true, longitude: true },
    })
    if (!worksite) throw new MileageDomainError("WORKSITE_NOT_FOUND", 404)
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { address: true } })
    const window = { gte: utcDay(input.start), lte: utcDay(input.end) }
    const workDays = truck.teamId
      ? await tx.assignment.count({ where: { teamId: truck.teamId, worksiteId: input.worksiteId, date: window } })
      : 0
    // Logement de l'équipe qui chevauche la période (le plus long recouvrement).
    const lodgings = truck.teamId
      ? await tx.accommodation.findMany({
          where: {
            companyId, teamId: truck.teamId, status: { not: "CANCELLED" },
            startDate: { lte: utcDay(input.end) }, endDate: { gte: utcDay(input.start) },
          },
          select: { address: true, zipCode: true, city: true, startDate: true, endDate: true },
          take: 20,
        })
      : []
    const overlap = (l: { startDate: Date; endDate: Date }) =>
      Math.min(l.endDate.getTime(), utcDay(input.end).getTime()) - Math.max(l.startDate.getTime(), utcDay(input.start).getTime())
    const lodging = lodgings.sort((a, b) => overlap(b) - overlap(a))[0] ?? null
    return { worksite, companyAddress: company?.address?.trim() || null, workDays, lodging }
  }, txOptions)

  // 2. Points : dépôt, chantier, logement.
  const geocode = async (address: string): Promise<Point | null> => {
    await deps.db.$transaction((tx) => reserveImportProvider(tx, companyId, "GEOCODING"), txOptions)
    return ignGeocode(address, fetchFn)
  }
  let depot: Point | null = null
  let depotLabel = "Dépôt"
  if (hasPlannedMileageDepot(companyId)) {
    depot = PLANNED_MILEAGE_DEPOT
    depotLabel = PLANNED_MILEAGE_DEPOT.label
  } else if (data.companyAddress) {
    depot = await geocode(data.companyAddress).catch(() => null)
    depotLabel = data.companyAddress
  }
  if (!depot) throw new MileageDomainError("DEPOT_UNKNOWN", 422)

  const w = data.worksite
  const site: Point | null =
    Number.isFinite(w.latitude) && Number.isFinite(w.longitude)
      ? { latitude: w.latitude as number, longitude: w.longitude as number }
      : w.address ? await geocode(w.address).catch(() => null) : null
  if (!site) throw new MileageDomainError("WORKSITE_ADDRESS_NOT_FOUND", 422)

  const lodgingAddress = data.lodging
    ? [data.lodging.address, data.lodging.zipCode, data.lodging.city].filter((x) => x && x.trim()).join(" ")
    : null
  const lodgingPoint = lodgingAddress ? await geocode(lodgingAddress).catch(() => null) : null

  // 3. Distances routières (repli : vol d'oiseau majoré, signalé comme approximatif).
  const distance = async (from: Point, to: Point): Promise<{ km: number; source: DistanceSource }> => {
    try {
      await deps.db.$transaction((tx) => reserveImportProvider(tx, companyId, "ROUTING"), txOptions)
      return { km: await ignRouteKm(from, to, fetchFn), source: "ROUTE" }
    } catch (error) {
      if (!(error instanceof MileageDomainError)) throw error
      return { km: crowFlightKm(from, to) * CROW_FLIGHT_DETOUR_FACTOR, source: "ESTIMATE" }
    }
  }
  const depotToSite = await distance(depot, site)
  const lodgingToSite = lodgingPoint ? await distance(lodgingPoint, site) : null

  const workDaysSource = data.workDays > 0 ? "PLANNING" : "CALENDAR"
  const workDays = data.workDays > 0 ? data.workDays : calendarDays(input.start, input.end)
  const estimate = computeTourKmEstimate({
    depotToSite,
    lodgingToSite,
    workDays,
    lunchKmPerDay: input.lunchKmPerDay ?? TOUR_LUNCH_KM_PER_DAY_DEFAULT,
  })
  return {
    ...estimate,
    workDays,
    workDaysSource,
    depotLabel,
    lodging: data.lodging && lodgingAddress
      ? { address: lodgingAddress, startDate: iso(data.lodging.startDate), endDate: iso(data.lodging.endDate), resolved: lodgingToSite !== null }
      : null,
  }
}
