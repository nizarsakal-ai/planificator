/**
 * Km estimés automatiques des tournées : calcul et mise à jour sans intervention.
 *
 * Une tournée « AUTO » (PLANNED ou IN_PROGRESS) voit ses km recalculés :
 *   - juste après sa création ou sa modification (après la réponse HTTP, jamais bloquant) ;
 *   - chaque nuit, si ses données d'entrée ont changé (étapes, dates, planning de l'équipe,
 *     logement Booking, adresse du dépôt) ou si le dernier calcul était approximatif ou en échec.
 *
 * Règles de sûreté :
 *   - une estimation « MANUAL » n'est jamais écrasée ; une tournée terminée ou annulée est figée ;
 *   - écriture conditionnelle (révision et source inchangées depuis la lecture) : une modification
 *     faite pendant le calcul gagne toujours, sans erreur ni conflit pour l'utilisateur ;
 *   - la révision de la tournée n'est pas incrémentée (donnée dérivée) : aucun formulaire ouvert
 *     n'est invalidé par un recalcul ;
 *   - aucun appel réseau dans une transaction ; seules des adresses partent vers l'IGN.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { tourFlag } from "./tour-domain"
import { TOUR_LUNCH_KM_PER_DAY_DEFAULT } from "./tour-km-estimate-domain"
import { loadTourKmData, resolveTourKmEstimate, tourKmInputsHash, type TourKmEstimateResult } from "./tour-km-estimate-service"

export const AUTO_KM_ACTIVE_STATUSES = ["PLANNED", "IN_PROGRESS"] as const
/** Préfixe d'empreinte d'un résultat à reprendre (approximatif) : jamais égal à une empreinte de données. */
const RETRY_PREFIX = "retry:"

export type AutoKmOutcome = "UPDATED" | "UNCHANGED" | "SKIPPED" | "FAILED"

export interface AutoKmDetail extends Partial<TourKmEstimateResult> {
  lunchKmPerDay: number
  /** Code d'échec du dernier calcul (dépôt inconnu, adresses non reconnues…), sinon absent. */
  errorCode?: string
}

export interface AutoKmDeps {
  db: Pick<PrismaClient, "$transaction">
  fetchFn?: typeof fetch
  now?: () => Date
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }

/** Recalcule les km d'une tournée « AUTO ». `force` ignore l'empreinte (bouton « Recalculer »). */
export async function refreshTourAutoKm(
  ref: { companyId: string; tourId: string },
  deps: AutoKmDeps,
  options: { force?: boolean } = {},
): Promise<{ outcome: AutoKmOutcome; estimatedKm?: number; errorCode?: string }> {
  const now = deps.now ?? (() => new Date())
  const lunchKmPerDay = TOUR_LUNCH_KM_PER_DAY_DEFAULT

  // 1. Lecture (tenant borné) ; tournée non éligible = rien à faire.
  const read = await deps.db.$transaction(async (tx) => {
    const tour = await tx.vehicleTour.findFirst({
      where: { id: ref.tourId, companyId: ref.companyId },
      select: { id: true, truckId: true, revision: true, status: true, estimatedKmSource: true, estimatedKmInputHash: true },
    })
    if (!tour || tour.estimatedKmSource !== "AUTO" || !(AUTO_KM_ACTIVE_STATUSES as readonly string[]).includes(tour.status)) return null
    const truck = await tx.truck.findFirst({ where: { id: tour.truckId, companyId: ref.companyId }, select: { id: true, teamId: true } })
    if (!truck) return null
    const data = await loadTourKmData(tx, ref.companyId, truck, { tourId: tour.id })
    return { tour, data, hash: tourKmInputsHash(data, lunchKmPerDay) }
  }, txOptions)
  if (!read) return { outcome: "SKIPPED" }
  if (!options.force && read.tour.estimatedKmInputHash === read.hash) {
    // Données inchangées : seule la date de vérification avance (rotation équitable du passage de nuit).
    await deps.db.$transaction((tx) => tx.vehicleTour.updateMany({
      where: { id: read.tour.id, companyId: ref.companyId, revision: read.tour.revision, estimatedKmSource: "AUTO", estimatedKmInputHash: read.hash },
      data: { estimatedKmComputedAt: now() },
    }), txOptions)
    return { outcome: "UNCHANGED" }
  }

  // 2. Calcul (réseau, hors transaction). Un échec métier est enregistré, jamais propagé.
  let estimate: TourKmEstimateResult | null = null
  let errorCode: string | undefined
  try {
    estimate = await resolveTourKmEstimate(deps.db, ref.companyId, read.data, lunchKmPerDay, deps.fetchFn ?? fetch)
  } catch (error) {
    if (!(error instanceof MileageDomainError)) throw error
    errorCode = error.code
  }

  // 3. Écriture conditionnelle : seulement si personne n'a touché la tournée entre-temps.
  // Résultat approximatif (itinéraire indisponible, quota) ou échec : repris au prochain passage.
  const settled = estimate !== null && !estimate.approximate
  const detail: AutoKmDetail = estimate ? { ...estimate, lunchKmPerDay } : { lunchKmPerDay, errorCode }
  const written = await deps.db.$transaction((tx) => tx.vehicleTour.updateMany({
    where: {
      id: read.tour.id,
      companyId: ref.companyId,
      revision: read.tour.revision,
      estimatedKmSource: "AUTO",
      status: { in: [...AUTO_KM_ACTIVE_STATUSES] },
    },
    data: {
      ...(estimate ? { estimatedKm: estimate.totalKm } : {}),
      estimatedKmComputedAt: now(),
      estimatedKmInputHash: settled ? read.hash : `${RETRY_PREFIX}${read.hash}`,
      estimatedKmDetail: detail as unknown as Prisma.InputJsonValue,
    },
  }), txOptions)
  if (written.count === 0) return { outcome: "SKIPPED" }
  return estimate ? { outcome: "UPDATED", estimatedKm: estimate.totalKm } : { outcome: "FAILED", errorCode }
}

export interface AutoKmRunSummary { scanned: number; updated: number; unchanged: number; skipped: number; failed: number; errors: number; stoppedEarly: boolean }

/**
 * Passage planifié (toutes entreprises) : tournées « AUTO » encore actives, les plus anciennement
 * calculées d'abord, bornées en nombre et en durée (les suivantes passent au prochain run).
 */
export async function runTourKmAutoRefresh(
  deps: AutoKmDeps & { limit?: number; budgetMs?: number },
): Promise<AutoKmRunSummary> {
  const now = deps.now ?? (() => new Date())
  const started = now().getTime()
  const budgetMs = deps.budgetMs ?? 45_000
  const tours = await deps.db.$transaction((tx) => tx.vehicleTour.findMany({
    where: {
      status: { in: [...AUTO_KM_ACTIVE_STATUSES] },
      estimatedKmSource: "AUTO",
      endsAt: { gte: new Date(started - 86_400_000) },
    },
    select: { id: true, companyId: true },
    orderBy: [{ estimatedKmComputedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: deps.limit ?? 40,
  }), txOptions)
  const summary: AutoKmRunSummary = { scanned: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: 0, stoppedEarly: false }
  for (const tour of tours) {
    if (now().getTime() - started > budgetMs) { summary.stoppedEarly = true; break }
    summary.scanned++
    try {
      const r = await refreshTourAutoKm({ companyId: tour.companyId, tourId: tour.id }, deps)
      if (r.outcome === "UPDATED") summary.updated++
      else if (r.outcome === "UNCHANGED") summary.unchanged++
      else if (r.outcome === "FAILED") summary.failed++
      else summary.skipped++
    } catch (error) {
      // Une tournée en erreur n'arrête pas les autres ; aucun détail métier dans les journaux.
      summary.errors++
      console.error("[vehicle-tours][auto-km] refresh failed", { tourId: tour.id, name: error instanceof Error ? error.name : typeof error })
    }
  }
  return summary
}

/**
 * « Recalculer maintenant » (ADMIN / SUPER_ADMIN) : recalcul immédiat d'une tournée « AUTO » encore active,
 * sans tenir compte de l'empreinte. L'autorité sur le camion est relue en base avant tout calcul.
 */
export async function recalculateTourKmNow(
  truckId: string,
  tourId: string,
  deps: AutoKmDeps & { auth: () => Promise<MileageSession | null> },
) {
  tourFlag()
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) throw new MileageDomainError("FORBIDDEN", 403)
  const tour = await deps.db.$transaction(async (tx) => {
    await authorizeVehicleLocked(tx, truckId, session, "READ")
    return tx.vehicleTour.findFirst({ where: { id: tourId, companyId: session.companyId, truckId }, select: { id: true, estimatedKmSource: true, status: true } })
  }, txOptions)
  if (!tour) throw new MileageDomainError("TOUR_NOT_FOUND", 404)
  if (tour.estimatedKmSource !== "AUTO") throw new MileageDomainError("TOUR_KM_MANUAL", 409)
  if (!(AUTO_KM_ACTIVE_STATUSES as readonly string[]).includes(tour.status)) throw new MileageDomainError("TOUR_KM_FROZEN", 409)
  return refreshTourAutoKm({ companyId: session.companyId, tourId }, deps, { force: true })
}
