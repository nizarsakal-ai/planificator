/**
 * Estimation des kilomètres d'une tournée de chantier : lecture des données (étapes,
 * logement Booking de l'équipe, jours de planning) puis distances IGN, et lien
 * d'itinéraire Google Maps (dépôt → étapes → logement → dépôt).
 *
 * Deux entrées :
 *   - `{ worksiteId, start, end }` : tournée en préparation depuis une fiche chantier ;
 *   - `{ tourId }` : tournée déjà enregistrée (étapes et dates relues en base).
 *
 * Lecture seule : aucune écriture métier (seul le quota horaire des fournisseurs est compté).
 * Aucune donnée personnelle envoyée à l'IGN : uniquement des adresses (chantiers, logement, dépôt).
 */
import { createHash } from "node:crypto"
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
  googleMapsDirectionsUrl,
  isDepotStopLabel,
  TOUR_LUNCH_KM_PER_DAY_DEFAULT,
  TOUR_LUNCH_KM_PER_DAY_MAX,
  type TourKmEstimate,
  type TourKmLeg,
} from "./tour-km-estimate-domain"

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const lunch = z.number().finite().min(0).max(TOUR_LUNCH_KM_PER_DAY_MAX).optional()
export const tourKmEstimateInputSchema = z.union([
  z.object({ worksiteId: z.string().trim().min(1).max(200), start: day, end: day, lunchKmPerDay: lunch })
    .strict().refine((x) => x.end >= x.start),
  z.object({ tourId: z.string().trim().min(1).max(200), lunchKmPerDay: lunch }).strict(),
])

export interface TourKmEstimateResult extends TourKmEstimate {
  workDays: number
  workDaysSource: "PLANNING" | "CALENDAR"
  /** Logement trouvé pour l'équipe ; `resolved` = adresse reconnue et distance calculée. */
  lodging: { address: string; startDate: string; endDate: string; resolved: boolean } | null
  depotLabel: string
  /** Étapes non reconnues (ni coordonnées ni géocodage) : exclues du calcul. */
  skippedStops: string[]
  mapsUrl: string
}

export interface TourKmEstimateDeps {
  auth: () => Promise<MileageSession | null>
  db: PrismaClient
  fetchFn?: typeof fetch
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }
const utcDay = (s: string) => new Date(`${s}T00:00:00.000Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const civilDay = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)

function calendarDays(start: string, end: string): number {
  return Math.round((utcDay(end).getTime() - utcDay(start).getTime()) / 86_400_000) + 1
}

interface StopInput { label: string; address: string; worksiteId: string | null; latitude: number | null; longitude: number | null }

/** Données lues en base pour une estimation (aucun appel réseau). */
export interface TourKmData {
  start: string
  end: string
  stops: StopInput[]
  /** Jours distincts du planning de l'équipe sur les chantiers de la tournée (0 = aucun). */
  workDays: number
  lodging: { address: string; zipCode: string | null; city: string | null; startDate: Date; endDate: Date } | null
  companyAddress: string | null
}

export type TourKmSource = { tourId: string } | { worksiteId: string; start: string; end: string }

/**
 * Lecture des données d'estimation dans la transaction de l'appelant. L'autorité (session ou tâche
 * planifiée) est vérifiée par l'appelant ; ici tout est borné à `companyId` et au camion.
 */
export async function loadTourKmData(
  tx: Prisma.TransactionClient,
  companyId: string,
  truck: { id: string; teamId: string | null },
  source: TourKmSource,
): Promise<TourKmData> {
  const settings = await tx.companySettings.findUnique({ where: { companyId }, select: { timezone: true } })
  const timeZone = settings?.timezone || "Europe/Paris"
  let start: string, end: string, teamId: string | null, stops: StopInput[]
  if ("tourId" in source) {
    const tour = await tx.vehicleTour.findFirst({
      where: { id: source.tourId, companyId, truckId: truck.id },
      include: { stops: { orderBy: { position: "asc" } } },
    })
    if (!tour) throw new MileageDomainError("TOUR_NOT_FOUND", 404)
    start = civilDay(tour.startsAt, timeZone)
    end = civilDay(tour.endsAt, timeZone)
    teamId = tour.teamId ?? truck.teamId
    stops = tour.stops
      .filter((s) => !isDepotStopLabel(s.label))
      .map((s) => ({ label: s.label, address: s.address, worksiteId: s.worksiteId, latitude: s.latitude, longitude: s.longitude }))
  } else {
    const worksite = await tx.worksite.findFirst({
      where: { id: source.worksiteId, companyId, archivedAt: null },
      select: { id: true, name: true, address: true, latitude: true, longitude: true },
    })
    if (!worksite) throw new MileageDomainError("WORKSITE_NOT_FOUND", 404)
    start = source.start
    end = source.end
    teamId = truck.teamId
    stops = [{ label: worksite.name, address: worksite.address ?? "", worksiteId: worksite.id, latitude: worksite.latitude, longitude: worksite.longitude }]
  }
  if (calendarDays(start, end) > TOUR_MAX_DURATION_DAYS + 1) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const worksiteIds = [...new Set(stops.flatMap((s) => (s.worksiteId ? [s.worksiteId] : [])))]
  const window = { gte: utcDay(start), lte: utcDay(end) }
  // Jours de chantier distincts de l'équipe sur les chantiers de la tournée.
  const assignmentDays = teamId && worksiteIds.length > 0
    ? await tx.assignment.findMany({ where: { teamId, worksiteId: { in: worksiteIds }, date: window }, select: { date: true } })
    : []
  const workDays = new Set(assignmentDays.map((a) => iso(a.date))).size
  // Logement Booking de l'équipe qui chevauche la période (le plus long recouvrement).
  const lodgings = teamId
    ? await tx.accommodation.findMany({
        where: { companyId, teamId, status: { not: "CANCELLED" }, startDate: { lte: utcDay(end) }, endDate: { gte: utcDay(start) } },
        select: { address: true, zipCode: true, city: true, startDate: true, endDate: true },
        take: 20,
      })
    : []
  const overlap = (l: { startDate: Date; endDate: Date }) =>
    Math.min(l.endDate.getTime(), utcDay(end).getTime()) - Math.max(l.startDate.getTime(), utcDay(start).getTime())
  // Départage stable (même recouvrement) : l'empreinte des données ne doit pas dépendre de l'ordre SQL.
  const lodging = lodgings.sort((a, b) => overlap(b) - overlap(a) || a.startDate.getTime() - b.startDate.getTime() || a.address.localeCompare(b.address))[0] ?? null
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { address: true } })
  return { start, end, stops, workDays, lodging, companyAddress: company?.address?.trim() || null }
}

/**
 * Empreinte des données d'entrée (jamais des distances) : un recalcul automatique n'a lieu que si
 * les étapes, les dates, le planning, le logement, le dépôt ou le forfait de midi changent.
 */
export function tourKmInputsHash(data: TourKmData, lunchKmPerDay: number): string {
  return createHash("sha256").update(JSON.stringify([
    "tour-km-v1",
    data.start, data.end, data.workDays, data.companyAddress, lunchKmPerDay,
    data.stops.map((s) => [s.label, s.address, s.worksiteId, s.latitude, s.longitude]),
    data.lodging ? [data.lodging.address, data.lodging.zipCode, data.lodging.city, iso(data.lodging.startDate), iso(data.lodging.endDate)] : null,
  ])).digest("hex")
}

/** Distances (IGN, repli vol d'oiseau majoré) et lignes de l'estimation à partir des données lues. */
export async function resolveTourKmEstimate(
  db: Pick<PrismaClient, "$transaction">,
  companyId: string,
  data: TourKmData,
  lunchKmPerDay: number,
  fetchFn: typeof fetch,
): Promise<TourKmEstimateResult> {
  // 2. Points : dépôt, étapes, logement.
  const geocode = async (address: string): Promise<Point | null> => {
    if (address.trim().length < 3) return null
    await db.$transaction((tx) => reserveImportProvider(tx, companyId, "GEOCODING"), txOptions)
    return ignGeocode(address, fetchFn)
  }
  let depot: Point | null = null
  let depotLabel = "Dépôt"
  let depotForMaps = ""
  if (hasPlannedMileageDepot(companyId)) {
    depot = PLANNED_MILEAGE_DEPOT
    depotLabel = PLANNED_MILEAGE_DEPOT.label
    depotForMaps = data.companyAddress ?? `${PLANNED_MILEAGE_DEPOT.latitude},${PLANNED_MILEAGE_DEPOT.longitude}`
  } else if (data.companyAddress) {
    depot = await geocode(data.companyAddress).catch(() => null)
    depotLabel = data.companyAddress
    depotForMaps = data.companyAddress
  }
  if (!depot) throw new MileageDomainError("DEPOT_UNKNOWN", 422)

  const resolved: Array<StopInput & { point: Point }> = []
  const skippedStops: string[] = []
  for (const s of data.stops) {
    const point = Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
      ? { latitude: s.latitude as number, longitude: s.longitude as number }
      : await geocode(s.address).catch(() => null)
    if (point) resolved.push({ ...s, point })
    else skippedStops.push(s.label)
  }
  if (resolved.length === 0) throw new MileageDomainError("WORKSITE_ADDRESS_NOT_FOUND", 422)
  const mainSite = resolved.find((s) => s.worksiteId) ?? resolved[0]

  const lodgingAddress = data.lodging
    ? [data.lodging.address, data.lodging.zipCode, data.lodging.city].filter((x) => x && x.trim()).join(" ")
    : null
  const lodgingPoint = lodgingAddress ? await geocode(lodgingAddress).catch(() => null) : null

  // 3. Distances routières (repli : vol d'oiseau majoré, signalé comme approximatif).
  const distance = async (from: Point, to: Point): Promise<{ km: number; source: DistanceSource }> => {
    try {
      await db.$transaction((tx) => reserveImportProvider(tx, companyId, "ROUTING"), txOptions)
      return { km: await ignRouteKm(from, to, fetchFn), source: "ROUTE" }
    } catch (error) {
      if (!(error instanceof MileageDomainError)) throw error
      return { km: crowFlightKm(from, to) * CROW_FLIGHT_DETOUR_FACTOR, source: "ESTIMATE" }
    }
  }
  const chain = [{ label: "Dépôt", point: depot }, ...resolved.map((s) => ({ label: s.label, point: s.point })), { label: "Dépôt", point: depot }]
  const legs: TourKmLeg[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const d = await distance(chain[i].point, chain[i + 1].point)
    legs.push({ label: `${chain[i].label} → ${chain[i + 1].label}`, ...d })
  }
  const lodgingToSite = lodgingPoint ? await distance(lodgingPoint, mainSite.point) : null

  const workDaysSource = data.workDays > 0 ? "PLANNING" : "CALENDAR"
  const workDays = data.workDays > 0 ? data.workDays : calendarDays(data.start, data.end)
  const estimate = computeTourKmEstimate({ legs, lodgingToSite, workDays, lunchKmPerDay })
  // Itinéraire Google Maps : étapes dans l'ordre, logement juste après le chantier principal.
  const mapsStops = resolved.flatMap((s) => (s === mainSite && lodgingAddress ? [s.address, lodgingAddress] : [s.address]))
  return {
    ...estimate,
    workDays,
    workDaysSource,
    depotLabel,
    skippedStops,
    mapsUrl: googleMapsDirectionsUrl({ depot: depotForMaps, stops: mapsStops }),
    lodging: data.lodging && lodgingAddress
      ? { address: lodgingAddress, startDate: iso(data.lodging.startDate), endDate: iso(data.lodging.endDate), resolved: lodgingToSite !== null }
      : null,
  }
}

export async function estimateTourKm(truckId: string, rawInput: unknown, deps: TourKmEstimateDeps): Promise<TourKmEstimateResult> {
  tourFlag()
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) throw new MileageDomainError("FORBIDDEN", 403)
  const parsed = tourKmEstimateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const input = parsed.data
  const companyId = session.companyId

  // 1. Lecture sous l'autorité du camion (tenant + rôle relus en base).
  const data = await deps.db.$transaction(async (tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ")
    const source: TourKmSource = "tourId" in input ? { tourId: input.tourId } : { worksiteId: input.worksiteId, start: input.start, end: input.end }
    return loadTourKmData(tx, companyId, { id: truckId, teamId: truck.teamId }, source)
  }, txOptions)
  return resolveTourKmEstimate(deps.db, companyId, data, input.lunchKmPerDay ?? TOUR_LUNCH_KM_PER_DAY_DEFAULT, deps.fetchFn ?? fetch)
}

/** Compatibilité : préparation depuis une fiche chantier. */
export const estimateWorksiteTourKm = estimateTourKm
