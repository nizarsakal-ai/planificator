/**
 * Véhicules V3 — estimation carburant d'un trajet : géométrie du couloir, calcul, sources publiques (réponses factices),
 * service (drapeau, droits, entreprise, kilomètres compteur ou itinéraire, stations, cache, quota, aucune écriture métier)
 * et fusion dans le formulaire. Données entièrement synthétiques ; aucun appel réseau réel.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { Prisma as PrismaRuntime, type Prisma } from "@prisma/client"
import { GET as estimateGet } from "@/app/api/trucks/[id]/fuel-estimate/route"
import {
  MAX_GAP_DAYS, MAX_STAY_DAYS, STAY_EDGE_DAYS, STAY_KM_CEILING, TRIP_KM_LIMIT, addDays, estimateKmLimit, distanceToPolylineKm, stayRoundTrips, estimateFuel, estimateNote, haversineKm, parisDayStart, parseConsumption, polylineKm, priceStats, rankStations, resolveStays, samplePolyline,
  simplifyPolyline, truckHolderOn,
  type FuelEstimate, type FuelStation, type PlannedStay, type Point, type ResolvedStay, type StayTruckPeriod,
} from "@/lib/vehicules/v3/fuel-estimate-domain"
import {
  applyEstimateToForm, createEstimateRequests, currencyConflict, fuelEstimateError, liveProvenance, medianLabel, notesWithProvenance, stayBlockedReason,
  type EstimateFormState, type ExpenseProposal, type FormLike,
} from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
import { ignRouteGeometry, stationsInCorridor } from "@/lib/vehicules/v3/fuel-estimate-providers"
import type { FuelEstimateDeps } from "@/lib/vehicules/v3/fuel-estimate-service"
import { executeExpenseCommand } from "@/lib/vehicules/v3/expense-service"
import { gapKey, stayContext } from "@/lib/vehicules/v3/fuel-estimate-domain"
import {
  STALE_DECISION_CODES, decisionsFor, decisionsOwner, emptyDecisions, estimateQuery, handoverConfirmLabel, kmLabel, missingDecisionsLabel, staySelectable,
} from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
import { randomUUID } from "node:crypto"
import { defaultPriceKey, medianUsable, priceChoice, priceWarnings, proposedExpense, reconcileEstimate, emptyEstimateState, stationDistanceLabel, stationsLabel, stayDetails, stayLabel, totalKm, uncomputedReason } from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import { ADMIN, LEADER, TRUCK, V3MemoryDb } from "./v3-test-db"

const MONTREUIL = { latitude: 48.863728, longitude: 2.449364 }
const PARIS = { latitude: 48.8566, longitude: 2.3522 }
const line = (from: Point, to: Point, n: number): Point[] => Array.from({ length: n + 1 }, (_, i) => ({ latitude: from.latitude + (to.latitude - from.latitude) * i / n, longitude: from.longitude + (to.longitude - from.longitude) * i / n }))
const station = (over: Partial<FuelStation> = {}): FuelStation => ({ id: "93100001", label: "1 RUE FICTIVE", city: "Exempleville", price: 2.25, updatedAt: "2026-11-04T06:00:00.000Z", offRouteKm: 0.2, open24h: false, ...over })

describe("couloir et calcul (pur)", () => {
  it("échantillonnage : départ et arrivée inclus, au plus N points, rayon qui couvre l'espacement", () => {
    const route = line(MONTREUIL, { latitude: 48.0, longitude: 1.5 }, 400)
    const { samples, radiusKm } = samplePolyline(route, 30)
    assert.ok(samples.length <= 30 && samples.length >= 20)
    assert.deepEqual(samples[0], route[0]); assert.deepEqual(samples.at(-1), route.at(-1))
    const total = polylineKm(route)
    for (let i = 1; i < samples.length; i++) assert.ok(haversineKm(samples[i - 1], samples[i]) <= total / 28 + 0.5)
    assert.ok(radiusKm >= haversineKm(samples[0], samples[1]) / 2)
    const short = samplePolyline(line(MONTREUIL, PARIS, 50))
    assert.ok(short.samples.length >= 4); assert.equal(samplePolyline([]).samples.length, 0)
  })
  it("distance au tracé : nulle sur le tracé, ≈ écart perpendiculaire à côté", () => {
    const route = line(MONTREUIL, PARIS, 10)
    assert.ok(distanceToPolylineKm(route[5], route) < 0.01)
    const beside = { latitude: route[5].latitude + 0.009, longitude: route[5].longitude }
    assert.ok(Math.abs(distanceToPolylineKm(beside, route) - 1) < 0.1)
  })
  it("estimation : litres = km × L/100 ÷ 100, montant au centime ; bornes refusées", () => {
    assert.deepEqual(estimateFuel({ km: 27, consumptionLPer100Km: 9.5, pricePerLitre: 2.25 }), { litres: 2.565, amount: 5.77 })
    for (const bad of [{ km: null, c: 9, p: 2 }, { km: 0, c: 9, p: 2 }, { km: 10, c: 0.5, p: 2 }, { km: 10, c: 90, p: 2 }, { km: 10, c: 9, p: 0 }, { km: 10, c: 9, p: null }])
      assert.equal(estimateFuel({ km: bad.km, consumptionLPer100Km: bad.c, pricePerLitre: bad.p }), null)
    assert.equal(parseConsumption("9,5"), 9.5); assert.equal(parseConsumption(""), null); assert.equal(parseConsumption("abc"), null); assert.equal(parseConsumption("120"), null)
  })
  it("classement : moins chère d'abord, puis la plus proche ; note de provenance lisible", () => {
    const ranked = rankStations([station({ id: "1", price: 2.3 }), station({ id: "2", price: 2.25, offRouteKm: 0.9 }), station({ id: "3", price: 2.25, offRouteKm: 0.1 })])
    assert.deepEqual(ranked.map((s) => s.id), ["3", "2", "1"])
    assert.equal(estimateNote({ km: 27, kmSource: "ODOMETER", consumption: 9.5, price: { kind: "STATION", station: station() }, fuel: "GAZOLE" }),
      "Estimation trajet : 27 km (compteur) × 9,5 L/100 km × 2,250 €/L Gazole (prix indicatif publié par 1 RUE FICTIVE, Exempleville, le 04/11/2026). À remplacer par le montant du ticket.")
  })
  it("R5 — séjours : coupure courte camion gardé = un séjour avec coupure à décider (jamais fusionnée d'office) ; équipe sans le camion ignorée ; chauffeur du jour du départ", () => {
    const ws = { id: "ws-1", name: "Chantier fictif", address: "1 rue Fictive", latitude: 48.8, longitude: 2.3 }
    const a = (date: string, teamId = "team-1", worksite = ws) => ({ date, teamId, worksite })
    const midnight = (day: string) => Date.parse(`${day}T00:00:00+01:00`)
    const periods = [{ teamId: "team-1", chauffeurId: "drv-1", startedAt: midnight("2026-11-01"), endedAt: midnight("2026-11-06") }, { teamId: "team-1", chauffeurId: "drv-2", startedAt: midnight("2026-11-06"), endedAt: null }]
    const scan = { from: "2026-10-01", to: "2026-12-31" }
    const stays = resolveStays([a("2026-11-04"), a("2026-11-06"), a("2026-11-05"), a("2026-11-10"), a("2026-11-04", "team-2")], periods, scan)
    assert.deepEqual(stays.map((s) => [s.id, s.departure, s.return, s.days, s.spanDays, s.chauffeurId, s.estimable]), [
      ["ws-1~team-1~2026-11-04", "2026-11-04", "2026-11-10", 4, 7, "drv-1", true],
    ])
    assert.deepEqual([stays[0].runs, stays[0].gaps], [[{ from: "2026-11-04", to: "2026-11-06", days: 3 }, { from: "2026-11-10", to: "2026-11-10", days: 1 }], [{ from: "2026-11-07", to: "2026-11-09", days: 3 }]])
    assert.equal(resolveStays([a("2026-10-30")], periods, scan).length, 0)
  })
  it("statistiques de prix : médiane paire et impaire, liste vide", () => {
    assert.deepEqual(priceStats([{ price: 2.3 }, { price: 2.1 }, { price: 2.25 }]), { count: 3, min: 2.1, median: 2.25, max: 2.3, sampled: false })
    assert.equal(priceStats([{ price: 2.1 }, { price: 2.3 }])!.median, 2.2)
    assert.equal(priceStats([]), null)
  })
})

// ─── Sources publiques (réponses factices) ───────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const routeBody = (from = MONTREUIL, to = PARIS) => ({ distance: 13.5, distanceUnit: "kilometer", geometry: { type: "LineString", coordinates: line(from, to, 40).map((p) => [p.longitude, p.latitude]) } })
const priceRow = (id: number, price: number, at: Point, over: Record<string, unknown> = {}) => ({ id, adresse: "1 RUE FICTIVE", ville: "Exempleville", geom: { lat: at.latitude, lon: at.longitude }, gazole_prix: price, gazole_maj: "2026-11-04T06:00:00+00:00", horaires_automate_24_24: "Oui", ...over })

describe("sources publiques : requêtes, contrôle des réponses", () => {
  it("itinéraire : tracé et distance contrôlés ; réponse incohérente ou service en panne refusés", async () => {
    const urls: string[] = []
    const ok = await ignRouteGeometry(MONTREUIL, PARIS, async (url) => { urls.push(String(url)); return json(routeBody()) })
    assert.equal(ok.km, 13.5); assert.equal(ok.points.length, 41)
    assert.match(urls[0], /^https:\/\/data\.geopf\.fr\/navigation\/itineraire\?/); assert.match(urls[0], /geometryFormat=geojson/)
    await assert.rejects(ignRouteGeometry(MONTREUIL, PARIS, async () => json({ distance: 13.5, distanceUnit: "kilometer", geometry: { type: "Point", coordinates: [] } })), { code: "INVALID_ROUTE" })
    await assert.rejects(ignRouteGeometry(MONTREUIL, PARIS, async () => json({}, 500)), { code: "ROUTING_UNAVAILABLE" })
    await assert.rejects(ignRouteGeometry(MONTREUIL, PARIS, async () => { throw new Error("réseau") }), { code: "ROUTING_UNAVAILABLE" })
  })
  it("prix : un seul appel par couloir (cercles en OU), lignes invalides ou hors couloir écartées", async () => {
    const route = line(MONTREUIL, PARIS, 20)
    const { samples, radiusKm } = samplePolyline(route)
    let url = ""
    const far = { latitude: route[10].latitude + 0.2, longitude: route[10].longitude }
    const { stations, truncated } = await stationsInCorridor(samples, radiusKm, route, "GAZOLE", async (u) => { url = String(u); return json({ total_count: 7, results: [
      priceRow(93100001, 2.25, route[3]), priceRow(75020002, 2.199, route[12]), priceRow(1, 2.1, route[5]), priceRow(93100003, 99, route[5]),
      priceRow(93100004, 2.2, far), priceRow(93100005, 2.2, route[6], { gazole_maj: "pas une date" }), { id: "x" },
    ] }) })
    const where = new URL(url).searchParams.get("where")!
    assert.equal((where.match(/within_distance/g) ?? []).length, samples.length)
    assert.match(where, /gazole_prix IS NOT NULL$/)
    assert.equal(new URL(url).searchParams.get("order_by"), "gazole_prix")
    assert.deepEqual(stations.map((s) => s.id).sort(), ["75020002", "93100001"])
    assert.ok(stations.every((s) => s.offRouteKm <= 0.1 && s.open24h))
    assert.equal(truncated, false)
    await assert.rejects(stationsInCorridor(samples, radiusKm, route, "GAZOLE", async () => json({ nope: true })), { code: "INVALID_FUEL_PRICES" })
    await assert.rejects(stationsInCorridor([], 1, route, "GAZOLE", async () => json({ results: [] })), { code: "INVALID_CORRIDOR" })
  })
})

// ─── Service ─────────────────────────────────────────────────────────────────

const GALYA = "cmvl0yv6q000ye4yjxs2mggy8"
const GALYA_ADMIN: MileageSession = { user: { id: "admin-g", role: "ADMIN", companyId: GALYA } }
const GALYA_TRUCK = "truck-g"
const at = (iso: string) => new Date(iso)
type Trip = { id: string; companyId: string; truckId: string; startEntryId: string; endEntryId: string | null; worksiteId: string | null; worksiteNameSnapshot: string | null }

/** Base mémoire V3 + trajets, relevés, chantiers, cache cartographique et quota horaire. */
class FuelDb {
  inner = new V3MemoryDb()
  cache = new Map<string, unknown>()
  quota: string[] = []
  quotaLimit = 60
  trips: Trip[] = []
  periods = [{ truckId: "truck-g", companyId: "cmvl0yv6q000ye4yjxs2mggy8", teamId: "team-g" as string | null, chauffeurId: "emp-driver" as string | null, startedAt: at("2026-10-01T00:00:00Z"), endedAt: null as Date | null }]
  assignments: { id?: string; date: Date; teamId: string; status: string; worksiteId: string; companyId: string }[] = ["2026-11-04", "2026-11-05", "2026-11-06"].map((d) => ({ date: at(`${d}T00:00:00Z`), teamId: "team-g", status: "PENDING", worksiteId: "ws-1", companyId: "cmvl0yv6q000ye4yjxs2mggy8" }))
  planningQueries: { from: string; to: string; take?: number }[] = []
  expenses: Record<string, unknown>[] = []
  commands: Record<string, unknown>[] = []
  teams = [{ id: "team-g", companyId: "cmvl0yv6q000ye4yjxs2mggy8", name: "BILEL A COMPO", leaderId: "emp-leader" }]
  people = [{ id: "emp-leader", companyId: "cmvl0yv6q000ye4yjxs2mggy8", firstName: "Bilel", lastName: "Exemple" }, { id: "emp-driver", companyId: "cmvl0yv6q000ye4yjxs2mggy8", firstName: "Riadh", lastName: "Exemple" }]
  entries: Record<string, unknown>[] = []
  worksites: { id: string; companyId: string; name: string; address: string | null; latitude: number | null; longitude: number | null }[] = [
    { id: "ws-1", companyId: GALYA, name: "Chantier fictif", address: "1 rue Fictive 75000 Paris", latitude: PARIS.latitude, longitude: PARIS.longitude },
    { id: "ws-2", companyId: GALYA, name: "Chantier sans coordonnées", address: "2 rue Fictive 75000 Paris", latitude: null, longitude: null }]
  constructor() {
    const s = this.inner.state
    s.companies.push({ id: GALYA, active: true })
    s.companySettings.push({ id: "settings-g", companyId: GALYA, timezone: "Europe/Paris" })
    s.users.push({ id: "admin-g", role: "ADMIN", companyId: GALYA, active: true, name: "Admin G" })
    s.trucks.push({ ...s.trucks[0], id: GALYA_TRUCK, companyId: GALYA, matricule: "GA-123-LY", teamId: null, chauffeurId: null })
    const entry = (id: string, truckId: string, companyId: string, kind: string, mileage: number, revision: number, when: string) =>
      ({ id, companyId, truckId, kind, mileage, revision, occurredAt: at(when), recordedAt: at(when), rootEntryId: null, supersedesEntryId: null, correctionReason: null })
    this.entries = [
      entry("g1", GALYA_TRUCK, GALYA, "DEPARTURE", 120_000, 1, "2026-11-03T07:00:00Z"), entry("g2", GALYA_TRUCK, GALYA, "ARRIVAL", 120_027, 2, "2026-11-03T17:00:00Z"),
      entry("g3", GALYA_TRUCK, GALYA, "DEPARTURE", 120_027, 3, "2026-11-04T07:00:00Z"),
      entry("a1", TRUCK, "company-a", "DEPARTURE", 5_000, 1, "2026-11-04T07:00:00Z"),
    ]
    this.trips = [
      { id: "trip-closed", companyId: GALYA, truckId: GALYA_TRUCK, startEntryId: "g1", endEntryId: "g2", worksiteId: "ws-1", worksiteNameSnapshot: "Chantier fictif" },
      { id: "trip-open", companyId: GALYA, truckId: GALYA_TRUCK, startEntryId: "g3", endEntryId: null, worksiteId: "ws-1", worksiteNameSnapshot: "Chantier fictif" },
      { id: "trip-geocode", companyId: GALYA, truckId: GALYA_TRUCK, startEntryId: "g3", endEntryId: null, worksiteId: "ws-2", worksiteNameSnapshot: "Chantier sans coordonnées" },
      { id: "trip-free", companyId: GALYA, truckId: GALYA_TRUCK, startEntryId: "g3", endEntryId: null, worksiteId: null, worksiteNameSnapshot: null },
      { id: "trip-a", companyId: "company-a", truckId: TRUCK, startEntryId: "a1", endEntryId: null, worksiteId: null, worksiteNameSnapshot: null },
    ]
  }
  get calls() { return this.inner.calls }
  async $transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown): Promise<T> {
    return this.inner.$transaction(async (tx) => {
      const base = tx as unknown as Record<string, unknown> & { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }
      const ext = {
        ...base,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join("?")
          if (sql.includes("vehicle_cartography_cache")) { const v = this.cache.get(values[0] as string); return v ? [{ value: structuredClone(v) }] : [] }
          if (sql.includes("vehicle_import_provider_windows")) {
            // Même contrainte que la base réelle (vehicle_import_provider_windows_provider_check).
            if (!["ROUTING", "GEOCODING"].includes(String(values[1]))) throw new Error("violates check constraint vehicle_import_provider_windows_provider_check")
            this.quota.push(String(values[1])); return this.quota.length <= this.quotaLimit ? [{ count: this.quota.length }] : []
          }
          return base.$queryRaw(strings, ...values)
        },
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join("?")
          if (sql.includes("vehicle_import_provider_windows")) return 1
          if (!sql.includes("vehicle_cartography_cache")) throw new Error("écriture inattendue")
          this.cache.set(values[0] as string, JSON.parse(values[2] as string)); return 1
        },
        mileageTrip: { findFirst: async ({ where, include }: { where: Record<string, string>; include?: unknown }) => {
          const trip = this.trips.find((t) => t.id === where.id && t.companyId === where.companyId && t.truckId === where.truckId)
          return trip ? { ...trip, ...(include ? { startEntry: this.entries.find((e) => e.id === trip.startEntryId) } : {}) } : null
        } },
        mileageEntry: { findMany: async ({ where }: { where: Record<string, string> }) => this.entries.filter((e) => e.companyId === where.companyId && e.truckId === where.truckId) },
        worksite: { findFirst: async ({ where }: { where: Record<string, string> }) => this.worksites.find((w) => w.id === where.id && w.companyId === where.companyId) ?? null },
        truckAssignment: {
          findMany: async ({ where }: { where: Record<string, string> }) => this.periods.filter((p) => p.truckId === where.truckId && p.companyId === where.companyId),
          count: async ({ where }: { where: Record<string, string> }) => this.periods.filter((p) => p.truckId === where.truckId && p.companyId === where.companyId).length,
        },
        // Même ordre et même limite que la requête réelle : (date, id) croissants, `take` lignes.
        assignment: { findMany: async ({ where, take }: { where: { teamId: { in: string[] }; date: { gte: Date; lte: Date }; status: { not: string }; team: { companyId: string }; worksite: { companyId: string; id?: string } }; take?: number }) => {
          this.planningQueries.push({ from: where.date.gte.toISOString().slice(0, 10), to: where.date.lte.toISOString().slice(0, 10), take })
          return this.assignments.map((a, i) => ({ ...a, id: (a as { id?: string }).id ?? `as-${String(i).padStart(6, "0")}` }))
            .filter((a) => where.teamId.in.includes(a.teamId) && a.date >= where.date.gte && a.date <= where.date.lte && a.status !== where.status.not && a.companyId === where.worksite.companyId
              && (this.teams.find((t) => t.id === a.teamId)?.companyId ?? a.companyId) === where.team.companyId && (!where.worksite.id || a.worksiteId === where.worksite.id))
            .sort((x, y) => x.date.getTime() - y.date.getTime() || x.id.localeCompare(y.id)).slice(0, take ?? Infinity)
            .map((a) => ({ date: a.date, teamId: a.teamId, worksite: (({ id, name, address, latitude, longitude }) => ({ id, name, address, latitude, longitude }))(this.worksites.find((w) => w.id === a.worksiteId)!) }))
        } },
        // R5 — commande de dépense EXISTANTE (executeExpenseCommand) : dépense, journal des commandes, imputations.
        // Double mémoire minimal ; il ne prouve ni contrainte ni verrou PostgreSQL.
        vehicleExpense: { create: async ({ data }: { data: Record<string, unknown> }) => {
          const now = new Date("2026-11-04T09:00:00.000Z")
          const row = { id: `expense-${this.expenses.length + 1}`, revision: 1, status: "PENDING", litres: null, mileageObservation: null, supplier: null, reference: null, receiptFingerprint: null, documentVersionId: null, maintenanceEntryId: null, notes: null, sourceExpenseReportId: null, sourceSnapshot: null,
            ...data, amount: new PrismaRuntime.Decimal(String(data.amount)), ...(data.litres ? { litres: new PrismaRuntime.Decimal(String(data.litres)) } : {}), createdAt: now, updatedAt: now }
          this.expenses.push(row); return row
        } },
        vehicleExpenseAllocation: { findMany: async () => [] },
        vehicleExpenseCommand: {
          findFirst: async ({ where }: { where: Record<string, string> }) => this.commands.find((c) => c.companyId === where.companyId && c.truckId === where.truckId && c.idempotencyKey === where.idempotencyKey) ?? null,
          create: async ({ data }: { data: Record<string, unknown> }) => { this.commands.push(structuredClone(data)); return data },
        },
        team: { findMany: async ({ where }: { where: { id: { in: string[] }; companyId: string } }) => this.teams.filter((t) => where.id.in.includes(t.id) && t.companyId === where.companyId) },
        employee: { findMany: async ({ where }: { where: { id: { in: string[] }; companyId: string } }) => this.people.filter((e) => where.id.in.includes(e.id) && e.companyId === where.companyId) },
      }
      return callback(ext as unknown as Prisma.TransactionClient)
    }, options)
  }
}

const geocodeBody = { type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [PARIS.longitude, PARIS.latitude] }, properties: { score: 0.9 } }] }
function fakeFetch(options: { prices?: "ok" | "down"; route?: "ok" | "down" } = {}) {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url)
    if (url.startsWith("https://data.geopf.fr/navigation/itineraire")) return options.route === "down" ? json({}, 503) : json(routeBody())
    if (url.startsWith("https://data.geopf.fr/geocodage/search")) return json(geocodeBody)
    if (url.startsWith("https://data.economie.gouv.fr/")) {
      if (options.prices === "down") return json({}, 503)
      const route = line(MONTREUIL, PARIS, 40)
      return json({ results: [priceRow(93100001, 2.25, route[5]), priceRow(75020002, 2.199, route[30]), priceRow(93100003, 2.309, route[20])] })
    }
    throw new Error(`URL inattendue ${url}`)
  }) as typeof fetch
  return { fn, calls }
}
const request = (truckId: string, query: Record<string, string>) => new Request(`https://vehicles-tests.invalid/api/trucks/${truckId}/fuel-estimate?${new URLSearchParams(query)}`)
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const enabled = { ...process.env, PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED: "true" }
function depsFor(db: FuelDb, session: MileageSession = GALYA_ADMIN, fetchFn = fakeFetch().fn, env: Record<string, string | undefined> = enabled): FuelEstimateDeps {
  return { auth: async () => session, db: db as unknown as FuelEstimateDeps["db"], fetchFn, env }
}
/** Empreinte du contexte d'un séjour telle que le serveur la rend (première lecture sans décision). */
async function contextOf(db: FuelDb, stayId: string, fetchFn = fakeFetch().fn, truckId = GALYA_TRUCK): Promise<string> {
  const body = await (await estimateGet(request(truckId, { stayId }), params(truckId), depsFor(db, GALYA_ADMIN, fetchFn))).json() as FuelEstimate
  return body.stay!.context
}
const businessWrites = (db: FuelDb) => db.calls.filter((c) => /\.(create|update|updateMany|upsert|delete)/.test(c.operation))

describe("service d'estimation : drapeau, droits, kilomètres, stations, cache, quota", () => {
  let saved: string | undefined
  before(() => { saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved })

  it("drapeau absent : 404 sans base ni réseau ; prototype V3 éteint : 404", async () => {
    const db = new FuelDb(), net = fakeFetch()
    const off = await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, net.fn, { ...process.env, PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED: undefined }))
    assert.equal(off.status, 404); assert.equal((await off.json()).code, "FUEL_ESTIMATE_DISABLED")
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "false"
    try { assert.equal((await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, net.fn))).status, 404) }
    finally { process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" }
    assert.equal(db.calls.length, 0); assert.equal(net.calls.length, 0)
  })
  it("trajet clos : km du compteur, tracé siège → chantier, stations du couloir triées ; en-têtes privés ; rien d'écrit hors cache", async () => {
    const db = new FuelDb(), net = fakeFetch()
    const response = await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, net.fn))
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    const body = await response.json() as FuelEstimate
    assert.deepEqual([body.km, body.kmSource, body.tripClosed, body.odometer, body.tripDate], [27, "ODOMETER", true, 120_027, "2026-11-03"])
    assert.deepEqual(body.route, { status: "ROUTE", oneWayKm: 13.5 })
    assert.equal(body.stationsStatus, "ROUTE_CORRIDOR")
    assert.deepEqual(body.stations.map((s) => [s.id, s.price]), [["75020002", 2.199], ["93100001", 2.25], ["93100003", 2.309]])
    assert.deepEqual(net.calls.map((u) => new URL(u).host), ["data.geopf.fr", "data.economie.gouv.fr"])
    assert.deepEqual(db.quota, ["ROUTING", "ROUTING"])
    assert.deepEqual(businessWrites(db), [])
    // Second appel : tracé et prix servis par le cache, aucun appel public de plus.
    await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, net.fn))
    assert.equal(net.calls.length, 2)
  })
  it("trajet en cours : aller-retour routier ; chantier sans coordonnées : jamais géocodé, aucune adresse envoyée (R2)", async () => {
    const db = new FuelDb()
    // R5 : sans confirmation du siège comme vrai point de départ, aucun kilométrage d'itinéraire.
    const unconfirmed = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-open" }), params(GALYA_TRUCK), depsFor(db))).json() as FuelEstimate
    assert.deepEqual([unconfirmed.km, unconfirmed.kmSource, unconfirmed.missing, unconfirmed.route.oneWayKm, unconfirmed.travel], [null, null, ["DEPOT"], 13.5, null])
    const open = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-open", depot: "1" }), params(GALYA_TRUCK), depsFor(db))).json() as FuelEstimate
    assert.deepEqual([open.km, open.kmSource, open.odometer, open.missing, open.depotConfirmed], [27, "ROUTE_ROUND_TRIP", 120_027, [], true])
    const net = fakeFetch(), geoDb = new FuelDb()
    const geo = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-geocode" }), params(GALYA_TRUCK), depsFor(geoDb, GALYA_ADMIN, net.fn))).json() as FuelEstimate
    assert.deepEqual([geo.route.status, geo.stationsStatus, geo.km], ["NO_COORDINATES", "NEAR_DEPOT", null])
    assert.ok(!net.calls.some((u) => u.includes("/geocodage/")))
    assert.ok(net.calls.every((u) => !/fictive|75000|rue/i.test(decodeURIComponent(u))), "aucune adresse dans les requêtes publiques")
    assert.ok(!geoDb.quota.includes("GEOCODING"))
  })
  it("trajet libre : pas d'itinéraire, stations autour du siège ; service d'itinéraire en panne : stations autour du chantier", async () => {
    const free = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-free" }), params(GALYA_TRUCK), depsFor(new FuelDb()))).json() as FuelEstimate
    assert.deepEqual([free.route.status, free.stationsStatus, free.km], ["NO_WORKSITE", "NEAR_DEPOT", null])
    const down = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-open" }), params(GALYA_TRUCK), depsFor(new FuelDb(), GALYA_ADMIN, fakeFetch({ route: "down" }).fn))).json() as FuelEstimate
    assert.deepEqual([down.route.status, down.stationsStatus, down.km], ["UNAVAILABLE", "NEAR_WORKSITE", null])
  })
  it("prix indisponibles : kilomètres rendus, stations « indisponibles » ; quota horaire atteint : aucune requête publique", async () => {
    const down = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(new FuelDb(), GALYA_ADMIN, fakeFetch({ prices: "down" }).fn))).json() as FuelEstimate
    assert.deepEqual([down.km, down.stationsStatus, down.stations.length], [27, "UNAVAILABLE", 0])
    const db = new FuelDb(); db.quotaLimit = 0
    const net = fakeFetch()
    const limited = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, net.fn))).json() as FuelEstimate
    assert.deepEqual([limited.km, limited.route.status, limited.stationsStatus], [27, "UNAVAILABLE", "UNAVAILABLE"]); assert.equal(net.calls.length, 0)
  })
  it("entreprise sans siège connu : pas d'itinéraire ni de stations depuis Montreuil", async () => {
    const db = new FuelDb(), net = fakeFetch()
    const body = await (await estimateGet(request(TRUCK, { tripId: "trip-a" }), params(TRUCK), depsFor(db, ADMIN, net.fn))).json() as FuelEstimate
    assert.deepEqual([body.route.status, body.stationsStatus, body.km], ["NO_WORKSITE", "NONE", null]); assert.equal(net.calls.length, 0)
  })
  it("séjours planifiés : chantier, départ, retour, équipe, chef et chauffeur extraits du planning", async () => {
    const { GET: staysGet } = await import("@/app/api/trucks/[id]/fuel-estimate/stays/route")
    const db = new FuelDb()
    const response = await staysGet(request(GALYA_TRUCK, {}), params(GALYA_TRUCK), { ...depsFor(db), now: () => at("2026-11-04T10:00:00Z") })
    assert.equal(response.status, 200)
    const { stays, partial } = await response.json() as { stays: PlannedStay[]; partial: boolean }
    assert.deepEqual(stays.map((s) => [s.id, s.worksiteName, s.departure, s.return, s.days, s.teamName, s.leaderName, s.chauffeurName, s.estimable, s.assignment]),
      [["ws-1~team-g~2026-11-04", "Chantier fictif", "2026-11-04", "2026-11-06", 3, "BILEL A COMPO", "Bilel Exemple", "Riadh Exemple", true, "HISTORY"]])
    assert.equal(partial, false)
    assert.deepEqual(businessWrites(db), [])
  })
  it("estimation d'un séjour : aller-retour siège → chantier, date de départ, pas de compteur ; identifiant forgé : 404", async () => {
    const db = new FuelDb()
    const context = await contextOf(db, "ws-1~team-g~2026-11-04")
    const body = await (await estimateGet(request(GALYA_TRUCK, { stayId: "ws-1~team-g~2026-11-04", mode: "ONE_ROUND_TRIP", depot: "1", context }), params(GALYA_TRUCK), depsFor(db))).json() as FuelEstimate
    assert.deepEqual([body.source, body.km, body.kmSource, body.tripDate, body.odometer, body.stay?.chauffeurName], ["STAY", 27, "STAY_ROUND_TRIP", "2026-11-04", null, "Riadh Exemple"])
    assert.equal(body.priceStats?.count, 3)
    for (const stayId of ["ws-1~team-g~2026-11-05", "ws-1~team-x~2026-11-04", "ws-2~team-g~2026-11-04"])
      assert.equal((await estimateGet(request(GALYA_TRUCK, { stayId }), params(GALYA_TRUCK), depsFor(new FuelDb()))).status, 404)
    assert.equal((await estimateGet(request(GALYA_TRUCK, { stayId: "ws-1~team-g~2026-11-04", tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(new FuelDb()))).status, 400)
  })
  it("long trajet (≈ 630 km) : couloir découpé en 4 requêtes de prix au plus, statistiques sur toutes les stations", async () => {
    const MONTAUBAN = { latitude: 43.9912, longitude: 1.3325 }
    let priceCalls = 0
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://data.geopf.fr/navigation/itineraire")) return json({ distance: 633.7, distanceUnit: "kilometer", geometry: { type: "LineString", coordinates: line(MONTREUIL, MONTAUBAN, 600).map((p) => [p.longitude, p.latitude]) } })
      const where = new URL(url).searchParams.get("where")!
      const [lon, lat] = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(where)!.slice(1).map(Number)
      priceCalls++
      return json({ results: [priceRow(93100000 + priceCalls, 2.1 + priceCalls / 100, { latitude: lat, longitude: lon })] })
    }) as typeof fetch
    const db = new FuelDb()
    db.worksites[0] = { ...db.worksites[0], latitude: MONTAUBAN.latitude, longitude: MONTAUBAN.longitude }
    const context = await contextOf(db, "ws-1~team-g~2026-11-04", fn)
    const body = await (await estimateGet(request(GALYA_TRUCK, { stayId: "ws-1~team-g~2026-11-04", mode: "ONE_ROUND_TRIP", depot: "1", context }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, fn))).json() as FuelEstimate
    assert.equal(body.km, 1267)
    assert.equal(priceCalls, 4)
    assert.deepEqual(body.priceStats, { count: 4, min: 2.11, median: 2.125, max: 2.14, sampled: false })
  })
  it("droits : chef d'équipe refusé, trajet d'une autre entreprise introuvable, paramètres invalides refusés", async () => {
    assert.equal((await estimateGet(request(TRUCK, { tripId: "trip-a" }), params(TRUCK), depsFor(new FuelDb(), LEADER))).status, 403)
    assert.equal((await estimateGet(request(TRUCK, { tripId: "trip-closed" }), params(TRUCK), depsFor(new FuelDb(), ADMIN))).status, 404)
    assert.equal((await estimateGet(request(GALYA_TRUCK, { tripId: "trip-a" }), params(GALYA_TRUCK), depsFor(new FuelDb()))).status, 404)
    for (const query of [{}, { tripId: "x'; DROP" }, { tripId: "trip-closed", fuel: "KEROSENE" }])
      assert.equal((await estimateGet(request(GALYA_TRUCK, query as Record<string, string>), params(GALYA_TRUCK), depsFor(new FuelDb()))).status, 400)
  })
})

// ─── Formulaire ──────────────────────────────────────────────────────────────

const estimate = (over: Partial<FuelEstimate> = {}): FuelEstimate => ({ source: "TRIP", stay: null, priceStats: null, tripId: "trip-closed", tripDate: "2026-11-03", tripClosed: true, worksiteName: "Chantier fictif", odometer: 120_027, km: 27, kmSource: "ODOMETER",
  route: { status: "ROUTE", oneWayKm: 13.5 }, fuel: "GAZOLE", stations: [station()], stationsStatus: "ROUTE_CORRIDOR", travel: null, depotConfirmed: false, missing: [], ...over })
const plannedStay = (over: Partial<PlannedStay> = {}): PlannedStay => ({ id: "ws-1~team-g~2026-11-04", worksiteId: "ws-1", worksiteName: "Chantier fictif", hasAddress: true, hasCoordinates: true, teamId: "team-g", teamName: "BILEL A COMPO",
  leaderName: "Bilel Exemple", chauffeurName: "Riadh Exemple", departure: "2026-11-04", return: "2026-11-06", days: 3, spanDays: 3,
  runs: [{ from: "2026-11-04", to: "2026-11-06", days: 3 }], gaps: [], departureKnown: true, returnKnown: true, estimable: true, blocked: null, assignment: "HISTORY", handoverDays: [], context: "v1-0000000000000000", ...over })
/** Séjour résolu (domaine) complété des noms affichés, comme le fait le service : fixtures typées, sans conversion forcée. */
const planned = ({ chauffeurId: _chauffeurId, ...stay }: ResolvedStay): PlannedStay => ({ ...stay, teamName: "Équipe fictive A", leaderName: null, chauffeurName: null })

describe("formulaire : préremplissage selon le trajet", () => {
  it("valeurs proposées : catégorie, date du trajet, compteur, station, litres, montant ; provenance à part (jamais dans Notes)", () => {
    const p = proposedExpense(estimate(), { kind: "STATION", station: station() }, 9.5)
    assert.deepEqual(p.values, { category: "FUEL", date: "2026-11-03", mileage: "120027", supplier: "1 RUE FICTIVE, Exempleville", amount: "5,77", litres: "2,565" })
    assert.equal(p.provenance, "Estimation trajet : 27 km (compteur) × 9,5 L/100 km × 2,250 €/L Gazole (prix indicatif publié par 1 RUE FICTIVE, Exempleville, le 04/11/2026). À remplacer par le montant du ticket.")
    const none = proposedExpense(estimate(), { kind: "STATION", station: station() }, null)
    assert.deepEqual([Object.keys(none.values).sort(), none.provenance], [["category", "date", "mileage", "supplier"], null])
    assert.equal(proposedExpense(estimate({ km: null, kmSource: null }), { kind: "STATION", station: station() }, 9.5).values.amount, undefined)
  })
  it("automatique : jamais sur un champ saisi ; explicite : tout", () => {
    const proposal = proposedExpense(estimate(), { kind: "STATION", station: station() }, 9.5)
    const base = { state: emptyEstimateState(), proposal, current: { amount: "", supplier: "Saisi" }, defaults: {}, currency: "EUR" }
    const auto = reconcileEstimate({ ...base, touched: new Set(["amount", "supplier"]), explicit: false })
    assert.equal(auto.writes.amount, undefined); assert.equal(auto.writes.supplier, undefined); assert.equal(auto.writes.litres, "2,565")
    const explicit = reconcileEstimate({ ...base, touched: new Set(["amount", "notes"]), explicit: true })
    assert.equal(explicit.writes.amount, "5,77"); assert.equal(explicit.writes.notes, undefined)
  })
  it("messages : zone de recherche, prix ancien, trajet ancien", () => {
    assert.match(stationsLabel("ROUTE_CORRIDOR", 3), /^3 stations à moins de 2 km à vol d'oiseau du tracé.*Prix publics indicatifs.*accès depuis la route et détour non vérifiés\.$/)
    // R3 : jamais « sur le tracé » (accès depuis la chaussée inconnu), même à distance nulle.
    assert.equal(stationDistanceLabel(0), "à moins de 0,1 km à vol d'oiseau du tracé (accès non vérifié)")
    assert.equal(stationDistanceLabel(1.26), "à 1,3 km à vol d'oiseau du tracé (accès non vérifié)")
    assert.match(stationsLabel("UNAVAILABLE", 0), /indisponibles/)
    assert.deepEqual(priceWarnings(estimate({ tripDate: "2026-10-01" }), station({ updatedAt: "2026-10-20T00:00:00.000Z" }), "2026-11-04").length, 2)
    assert.deepEqual(priceWarnings(estimate(), station(), "2026-11-04"), [])
    // R13 : départ à venir = information neutre (departureInfo), plus un avertissement.
    assert.deepEqual(priceWarnings(estimate({ tripDate: "2026-11-20" }), null, "2026-11-04"), [])
  })
  it("séjour : prix médian par défaut, km sur place ajoutés, note avec chantier et dates, aucun fournisseur inventé", () => {
    const stay = plannedStay({ worksiteName: "Chantier fictif Montauban" })
    const e = estimate({ source: "STAY", stay, km: 1267, kmSource: "STAY_ROUND_TRIP", odometer: null, tripDate: "2026-11-04", priceStats: { count: 123, min: 2.115, median: 2.25, max: 2.563, sampled: false } })
    assert.equal(defaultPriceKey(e), "MEDIAN")
    const { values, provenance } = proposedExpense(e, priceChoice(e, "MEDIAN", "2026-11-04"), 10, 40)
    assert.deepEqual([values.date, values.amount, values.litres, values.supplier, values.mileage], ["2026-11-04", "294,08", "130,7", undefined, undefined])
    assert.equal(provenance, "Estimation trajet : chantier Chantier fictif Montauban, équipe BILEL A COMPO (départ 04/11/2026, retour 06/11/2026, 3 jours planifiés) 1267 km (itinéraire aller-retour) + 40 km sur place × 10,0 L/100 km × 2,250 €/L Gazole (prix médian indicatif des 123 stations lues sur le trajet au 04/11/2026). À remplacer par le montant du ticket.")
    assert.match(stayLabel(stay), /^Chantier fictif Montauban — départ 04\/11\/2026, retour 06\/11\/2026 \(3 jours\) — BILEL A COMPO$/)
    // R5 : chef actuel conservé tel quel ; le chauffeur de la période au départ ne prouve pas sa présence chaque jour.
    assert.match(stayDetails(stay)[1], /chef d'équipe actuel \(aujourd'hui, pas forcément pendant le séjour\) : Bilel Exemple · chauffeur de la période du camion au départ : Riadh Exemple \(n'atteste pas sa présence chaque jour\)/)
  })
})

// ═══ R2 — contre-exemples de la revue Codex (données synthétiques) ═══════════

const paris = (day: string) => new Date(parisDayStart(day))
const period = (teamId: string | null, chauffeurId: string | null, start: Date, end: Date | null = null): StayTruckPeriod => ({ teamId, chauffeurId, startedAt: start.getTime(), endedAt: end ? end.getTime() : null })
const WS = { id: "ws-1", name: "Chantier fictif", address: "1 rue Fictive", latitude: 48.8, longitude: 2.3 }
const plan = (dates: string[], teamId = "team-a", worksite = WS) => dates.map((date) => ({ date, teamId, worksite }))
const range = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i))

describe("R2 point 8 — séjours : convention d'intervalle, bornes canoniques (pur)", () => {
  it("minuit à Paris : heure d'hiver et d'été", () => {
    assert.equal(new Date(parisDayStart("2026-11-04")).toISOString(), "2026-11-03T23:00:00.000Z")
    assert.equal(new Date(parisDayStart("2026-07-14")).toISOString(), "2026-07-13T22:00:00.000Z")
  })
  it("bascule à 00 h 00 le 04/11 : le 04/11 n'est attribué qu'à la nouvelle équipe ; aucun jour de réaffectation signalé", () => {
    const switchAt = new Date(parisDayStart("2026-11-04"))
    const periods = [period("team-old", "drv-old", paris("2026-10-01"), switchAt), period("team-new", "drv-new", switchAt)]
    assert.deepEqual([truckHolderOn("2026-11-04", periods).holder?.teamId, truckHolderOn("2026-11-04", periods).handover], ["team-new", false])
    assert.equal(truckHolderOn("2026-11-03", periods).holder?.teamId, "team-old")
    const stays = resolveStays([...plan(["2026-11-03", "2026-11-04"], "team-old"), ...plan(["2026-11-04", "2026-11-05"], "team-new")], periods, { from: "2026-10-01", to: "2026-12-31" })
    assert.deepEqual(stays.map((s) => [s.teamId, s.departure, s.return, s.chauffeurId]).sort(), [["team-new", "2026-11-04", "2026-11-05", "drv-new"], ["team-old", "2026-11-03", "2026-11-03", "drv-old"]])
  })
  it("R3 — bascule à 10 h le 04/11 : jour non attribuable ; les deux séjours qui le touchent sont non estimables (HANDOVER), jamais deux équipes", () => {
    const switchAt = new Date(parisDayStart("2026-11-04") + 10 * 3_600_000)
    const periods = [period("team-old", "drv-old", paris("2026-10-01"), switchAt), period("team-new", "drv-new", switchAt)]
    const stays = resolveStays([...plan(["2026-11-04"], "team-old"), ...plan(["2026-11-04", "2026-11-05"], "team-new")], periods, { from: "2026-10-01", to: "2026-12-31" })
    // Le séjour de team-new commence le 05 mais l'équipe était planifiée le 04 (veille) : la bascule du 04 le touche aussi.
    assert.deepEqual(stays.map((s) => [s.teamId, s.departure, s.return, s.handoverDays, s.estimable, s.blocked]).sort(),
      [["team-new", "2026-11-05", "2026-11-05", ["2026-11-04"], false, "HANDOVER"], ["team-old", "2026-11-04", "2026-11-04", ["2026-11-04"], false, "HANDOVER"]])
    assert.match(stayBlockedReason(planned(stays[0]))!, /réaffecté en cours de journée \(04\/11\/2026\) : aucune équipe n'est attribuée d'office.*seulement si vous confirmez.*l'historique d'affectation n'est pas modifié/)
    // R13 : la prévision reste possible en bordure ; libellé « affectation à vérifier ».
    assert.match(stayLabel(planned(stays[0])), /affectation à vérifier$/)
  })
  it("R3 — bascule à 10 h le 01/11, séjour planifié du 03 au 05 : aucun jour concerné, estimable", () => {
    const switchAt = new Date(parisDayStart("2026-11-01") + 10 * 3_600_000)
    const periods = [period("team-old", "drv-old", paris("2026-10-01"), switchAt), period("team-a", "drv-new", switchAt)]
    const stays = resolveStays(plan(range("2026-11-03", 3)), periods, { from: "2026-10-01", to: "2026-12-31" })
    assert.deepEqual(stays.map((s) => [s.departure, s.estimable, s.blocked, s.handoverDays]), [["2026-11-03", true, null, []]])
  })
  it("changement de chauffeur dans la même équipe : celui qui a le camion à minuit le jour du départ, quel que soit l'ordre des périodes", () => {
    const midnight = new Date(parisDayStart("2026-11-04")), midday = new Date(parisDayStart("2026-11-04") + 12 * 3_600_000)
    for (const [cut, expected] of [[midnight, "drv-new"], [midday, "drv-old"]] as const) {
      const periods = [period("team-a", "drv-new", cut), period("team-a", "drv-old", paris("2026-10-01"), cut)]
      for (const ordered of [periods, [...periods].reverse()])
        assert.equal(resolveStays(plan(["2026-11-04", "2026-11-05"]), ordered, { from: "2026-10-01", to: "2026-12-31" })[0].chauffeurId, expected)
    }
  })
  it("nouveau camion affecté à 07 h le 04/11 : le jour compte (première période commencée dans la journée)", () => {
    const periods = [period("team-a", "drv-1", new Date(parisDayStart("2026-11-04") + 7 * 3_600_000))]
    assert.deepEqual(resolveStays(plan(["2026-11-03", "2026-11-04"]), periods, { from: "2026-10-01", to: "2026-12-31" }).map((s) => [s.departure, s.days]), [["2026-11-04", 1]])
  })
  it("séjour touchant une borne lue : départ ou retour inconnu, non estimable ; séjour trop long : non estimable", () => {
    const cut = resolveStays(plan(range("2026-09-04", 3)), [period("team-a", null, paris("2026-01-01"))], { from: "2026-09-05", to: "2026-12-31" })
    assert.deepEqual(cut.map((s) => [s.departure, s.departureKnown, s.returnKnown, s.estimable]), [["2026-09-05", false, true, false]])
    const long = resolveStays(plan(range("2026-08-01", MAX_STAY_DAYS + 1)), [period("team-a", null, paris("2026-01-01"))], { from: "2026-06-01", to: "2026-12-31" })
    assert.deepEqual(long.map((s) => [s.days, s.departureKnown, s.returnKnown, s.estimable]), [[MAX_STAY_DAYS + 1, true, true, false]])
    assert.match(stayBlockedReason(planned(cut[0]))!, /hors de la période lue/)
    assert.match(stayLabel({ ...planned(cut[0]), teamName: null }), /déjà en cours le 05\/09\/2026.*non estimable$/)
  })
  it("R3/R5 — sans historique d'affectation : non estimable (NO_HISTORY), raison explicite, aucune équipe actuelle supposée, même à venir", () => {
    const periods = [{ ...period("team-a", "drv-1", new Date(-8.64e15)), fallback: true }]
    const stays = resolveStays(plan(["2026-11-04", "2026-11-06"]), periods, { from: "2026-10-01", to: "2026-12-31" })
    assert.deepEqual(stays.map((s) => [s.departure, s.days, s.assignment, s.estimable, s.blocked]), [["2026-11-04", 2, "CURRENT_TEAM_FALLBACK", false, "NO_HISTORY"]])
    // Séjour futur : même refus (pas de repli sur l'équipe actuelle pour les jours à venir).
    assert.deepEqual(resolveStays(plan(["2027-03-01", "2027-03-02"]), periods, { from: "2026-10-01", to: "2027-12-31" }).map((s) => [s.estimable, s.blocked]), [[false, "NO_HISTORY"]])
    assert.match(stayBlockedReason(planned(stays[0]))!, /Aucun historique d'affectation du camion.*ne prouve pas/)
  })
  it("R3 — séjour trop long : raison sans retour fictif ; bornes : raison « hors période »", () => {
    const long = resolveStays(plan(range("2026-08-01", MAX_STAY_DAYS + 1)), [period("team-a", null, paris("2026-01-01"))], { from: "2026-06-01", to: "2026-12-31" })
    assert.equal(long[0].blocked, "TOO_LONG")
    assert.match(stayBlockedReason(planned(long[0]))!, new RegExp(`plus de ${MAX_STAY_DAYS} jours : aucune date de retour n'est supposée`))
    const ok = resolveStays(plan(range("2026-08-01", MAX_STAY_DAYS)), [period("team-a", null, paris("2026-01-01"))], { from: "2026-06-01", to: "2026-12-31" })
    assert.deepEqual([ok[0].days, ok[0].blocked], [MAX_STAY_DAYS, null])
  })
})

describe("R2 point 8 — séjours : liste puis détail identiques (service)", () => {
  let saved: string | undefined
  before(() => { saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved })
  const NOW = () => at("2026-11-04T10:00:00Z")
  const listFor = async (db: FuelDb) => {
    const { GET: staysGet } = await import("@/app/api/trucks/[id]/fuel-estimate/stays/route")
    const response = await staysGet(request(GALYA_TRUCK, {}), params(GALYA_TRUCK), { ...depsFor(db), now: NOW })
    assert.equal(response.status, 200)
    return await response.json() as { stays: PlannedStay[]; partial: boolean }
  }
  const detail = (db: FuelDb, stayId: string) => estimateGet(request(GALYA_TRUCK, { stayId }), params(GALYA_TRUCK), { ...depsFor(db), now: NOW })
  const assign = (dates: string[], over: Partial<FuelDb["assignments"][number]> = {}) => dates.map((d) => ({ date: at(`${d}T00:00:00Z`), teamId: "team-g", status: "PENDING", worksiteId: "ws-1", companyId: GALYA, ...over }))

  it("contre-exemple R1 : séjour continu 04–06/09/2026 listé au 04/11/2026 avec ses vraies dates, puis relu à l'identique", async () => {
    const db = new FuelDb()
    db.periods[0].startedAt = at("2026-08-01T00:00:00Z")
    db.assignments = assign(["2026-09-04", "2026-09-05", "2026-09-06"])
    const { stays } = await listFor(db)
    assert.deepEqual(stays.map((s) => [s.id, s.departure, s.return, s.departureKnown, s.returnKnown, s.estimable]), [["ws-1~team-g~2026-09-04", "2026-09-04", "2026-09-06", true, true, true]])
    for (const s of stays) {
      const response = await detail(db, s.id)
      assert.equal(response.status, 200, s.id)
      assert.deepEqual((await response.json() as FuelEstimate).stay, s)
    }
  })
  it("chaque séjour estimable listé est relisible avec les mêmes dates, chauffeur et identifiant (plusieurs chantiers, bornes ±60 j)", async () => {
    const db = new FuelDb()
    db.periods = [
      { ...db.periods[0], chauffeurId: "emp-driver", startedAt: at("2026-06-01T00:00:00Z"), endedAt: new Date(parisDayStart("2026-10-20")) },
      { ...db.periods[0], chauffeurId: "emp-leader", startedAt: new Date(parisDayStart("2026-10-20")), endedAt: null },
    ]
    db.assignments = [...assign(range("2026-08-30", 10)), ...assign(range("2026-10-18", 4), { worksiteId: "ws-2" }), ...assign(range("2027-01-01", 5))]
    const { stays } = await listFor(db)
    assert.deepEqual(stays.map((s) => [s.id, s.return, s.estimable]), [["ws-1~team-g~2027-01-01", "2027-01-05", true], ["ws-2~team-g~2026-10-18", "2026-10-21", true], ["ws-1~team-g~2026-08-30", "2026-09-08", true]])
    for (const s of stays) assert.deepEqual((await (await detail(db, s.id)).json() as FuelEstimate).stay, s)
  })
  it("séjour plus long que la limite ou commencé avant la période lue : listé « non estimable », refusé au détail (409/404)", async () => {
    const db = new FuelDb()
    db.periods[0].startedAt = at("2026-01-01T00:00:00Z")
    db.assignments = [...assign(range("2026-08-01", 96)), ...assign(range("2026-06-01", 102), { worksiteId: "ws-2" })]
    const { stays } = await listFor(db)
    const long = stays.find((s) => s.worksiteId === "ws-1")!, early = stays.find((s) => s.worksiteId === "ws-2")!
    assert.deepEqual([long.departure, long.days, long.estimable], ["2026-08-01", 96, false])
    assert.deepEqual([early.departure, early.departureKnown, early.estimable], [addDays("2026-09-05", -(MAX_STAY_DAYS + STAY_EDGE_DAYS)), false, false])
    const r1 = await detail(db, long.id)
    assert.deepEqual([r1.status, (await r1.json()).code], [409, "STAY_INCOMPLETE"])
    assert.equal((await detail(db, early.id)).status, 404)
  })
  it("limite de 2000 lignes : lecture ordonnée, dernier jour incomplet écarté, liste « partielle », séjours coupés non estimables", async () => {
    const db = new FuelDb()
    db.periods[0].startedAt = at("2026-01-01T00:00:00Z")
    db.worksites.push(...Array.from({ length: 40 }, (_, i) => ({ id: `ws-b${i}`, companyId: GALYA, name: `Chantier dense ${i}`, address: null, latitude: PARIS.latitude, longitude: PARIS.longitude })))
    db.worksites.push({ id: "ws-short", companyId: GALYA, name: "Chantier court", address: null, latitude: PARIS.latitude, longitude: PARIS.longitude })
    db.assignments = [...assign(range("2026-10-01", 3), { worksiteId: "ws-short" }), ...Array.from({ length: 40 }, (_, i) => assign(range("2026-11-10", 51), { worksiteId: `ws-b${i}` })).flat()]
    const { stays, partial } = await listFor(db)
    assert.equal(partial, true)
    assert.ok(db.planningQueries.every((q) => q.take === 2001))
    const short = stays.find((s) => s.worksiteId === "ws-short")!
    assert.deepEqual([short.departure, short.return, short.estimable], ["2026-10-01", "2026-10-03", true])
    const dense = stays.filter((s) => s.worksiteId.startsWith("ws-b"))
    assert.ok(dense.length > 0 && dense.every((s) => !s.returnKnown && !s.estimable && s.return === "2026-12-28"))
    assert.deepEqual((await (await detail(db, short.id)).json() as FuelEstimate).stay, short)
  })
  it("R3 — réaffectation à 10 h pendant un séjour : listé non estimable (HANDOVER), refusé au détail 409 STAY_HANDOVER", async () => {
    const db = new FuelDb()
    const cut = new Date(parisDayStart("2026-11-05") + 10 * 3_600_000)
    db.periods = [{ ...db.periods[0], chauffeurId: "emp-driver", startedAt: at("2026-06-01T00:00:00Z"), endedAt: cut }, { ...db.periods[0], chauffeurId: "emp-leader", startedAt: cut, endedAt: null }]
    db.assignments = assign(range("2026-11-04", 3))
    const { stays } = await listFor(db)
    assert.deepEqual(stays.map((s) => [s.departure, s.estimable, s.blocked, s.handoverDays]), [["2026-11-04", false, "HANDOVER", ["2026-11-05"]]])
    const response = await detail(db, stays[0].id)
    assert.deepEqual([response.status, (await response.json()).code], [409, "STAY_HANDOVER"])
    assert.match(fuelEstimateError("STAY_HANDOVER"), /réaffecté en cours de journée/)
  })
  it("R3 — camion sans historique : séjour listé non estimable (NO_HISTORY), refusé 409 STAY_NO_HISTORY ; noms hors société jamais affichés ; identifiants forgés refusés", async () => {
    const db = new FuelDb()
    db.periods = []
    db.inner.state.trucks.find((t) => t.id === GALYA_TRUCK)!.teamId = "team-g"
    db.inner.state.trucks.find((t) => t.id === GALYA_TRUCK)!.chauffeurId = "emp-foreign"
    db.people.push({ id: "emp-foreign", companyId: "company-a", firstName: "Hors", lastName: "Societe" })
    db.teams[0].leaderId = "emp-foreign"
    const { stays } = await listFor(db)
    assert.deepEqual(stays.map((s) => [s.assignment, s.chauffeurName, s.leaderName, s.estimable, s.blocked]), [["CURRENT_TEAM_FALLBACK", null, null, false, "NO_HISTORY"]])
    const refused = await detail(db, stays[0].id)
    assert.deepEqual([refused.status, (await refused.json()).code], [409, "STAY_NO_HISTORY"])
    assert.match(fuelEstimateError("STAY_NO_HISTORY"), /Aucun historique d'affectation/)
    for (const [stayId, status] of [["ws-1~team-g~2026-02-30", 400], ["ws-1~team-g~2026-11-05", 404], ["ws-1~team-zz~2026-11-04", 404], ["ws-x~team-g~2026-11-04", 404]] as const)
      assert.equal((await detail(db, stayId)).status, status, stayId)
  })
  it("équipe d'une autre société dans l'historique du camion : son planning n'est jamais lu", async () => {
    const db = new FuelDb()
    db.periods[0].teamId = "team-foreign"
    db.teams.push({ id: "team-foreign", companyId: "company-a", name: "ÉQUIPE ÉTRANGÈRE", leaderId: "emp-leader" })
    db.assignments = assign(["2026-11-04"], { teamId: "team-foreign" })
    assert.deepEqual((await listFor(db)).stays, [])
  })
})

describe("R2 point 7 — couloir : lacets, distance fixe, trajets longs (pur et fournisseur)", () => {
  // Route en lacets : 20 virages en épingle de ±2,2 km, 600 points.
  const serpentine = (): Point[] => Array.from({ length: 600 }, (_, i) => ({ latitude: 44.9 + i * 0.0001, longitude: 6.0 + 0.028 * Math.sin(i / 600 * 20 * Math.PI) }))
  it("simplification Douglas-Peucker : chaque point retiré reste à moins de la tolérance ; un sous-échantillonnage par index coupe les lacets", () => {
    const route = serpentine()
    const { line, toleranceKm } = simplifyPolyline(route, 80)
    assert.ok(line.length <= 80 && toleranceKm > 0)
    for (const p of route) assert.ok(distanceToPolylineKm(p, line) <= toleranceKm + 1e-9)
    // Ancien procédé R1 (indices réguliers, ici 12 points) : erreur bien supérieure à la tolérance sur les sommets.
    const naive = Array.from({ length: 12 }, (_, i) => route[Math.round(i * (route.length - 1) / 11)])
    const apex = route.reduce((best, p) => distanceToPolylineKm(p, naive) > distanceToPolylineKm(best, naive) ? p : best)
    assert.ok(distanceToPolylineKm(apex, naive) > 1, "contre-exemple : sommet de lacet à plus d'1 km de la corde")
    assert.ok(distanceToPolylineKm(apex, line) <= toleranceKm + 1e-9)
  })
  it("trajet long : tout point à moins de 2 km du tracé est dans un cercle de recherche ; rayon de requête ≤ 20 km", () => {
    const MONTAUBAN = { latitude: 43.9912, longitude: 1.3325 }
    const route = line(MONTREUIL, MONTAUBAN, 600)
    const { samples, radiusKm } = samplePolyline(route, 160)
    assert.ok(samples.length <= 160 && radiusKm <= 20)
    for (let i = 0; i < route.length; i += 7) {
      const beside = { latitude: route[i].latitude + 1.95 / 111.2, longitude: route[i].longitude }
      if (distanceToPolylineKm(beside, route) > 2) continue
      assert.ok(samples.some((s) => haversineKm(s, beside) <= radiusKm), `point ${i} hors des cercles`)
    }
  })
  it("stations limites : 1,95 km gardée, 2,05 km écartée, quelle que soit la taille du cercle de requête", async () => {
    const route = line(MONTREUIL, PARIS, 20)
    const off = (km: number) => ({ latitude: route[10].latitude + km / 111.2, longitude: route[10].longitude })
    const { stations } = await stationsInCorridor([route[10]], 8, route, "GAZOLE", async () => json({ total_count: 2, results: [priceRow(93100001, 2.1, off(1.95)), priceRow(93100002, 2.0, off(2.05))] }), 2)
    assert.deepEqual(stations.map((s) => s.id), ["93100001"])
  })
  it("troncature des 100 stations : détectée par total_count (ou son absence), jamais une pagination ni une requête de plus", async () => {
    const route = line(MONTREUIL, PARIS, 20)
    const rows = (n: number, price: number) => Array.from({ length: n }, (_, i) => priceRow(93200000 + i, price, route[i % 20]))
    let calls = 0
    const respond = (body: unknown) => async () => { calls++; return json(body) }
    assert.equal((await stationsInCorridor([route[10]], 8, route, "GAZOLE", respond({ total_count: 201, results: rows(100, 1.5) }))).truncated, true)
    assert.equal((await stationsInCorridor([route[10]], 8, route, "GAZOLE", respond({ results: rows(100, 1.5) }))).truncated, true)
    assert.equal((await stationsInCorridor([route[10]], 8, route, "GAZOLE", respond({ total_count: 100, results: rows(100, 1.5) }))).truncated, false)
    assert.equal(calls, 3)
  })
})

describe("R2 point 7 — médiane d'un échantillon tronqué (service)", () => {
  let saved: string | undefined
  before(() => { saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved })
  it("R3 — 100 stations à 1,50 € renvoyées sur 201 : médiane marquée échantillon, désactivée (aucun choix, aucune note), station explicite toujours possible", async () => {
    const route = line(MONTREUIL, PARIS, 40)
    let priceCalls = 0
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://data.geopf.fr/navigation/itineraire")) return json(routeBody())
      priceCalls++
      return json({ total_count: 201, results: Array.from({ length: 100 }, (_, i) => priceRow(93300000 + i, 1.5, route[i % 40])) })
    }) as typeof fetch
    const body = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-closed" }), params(GALYA_TRUCK), depsFor(new FuelDb(), GALYA_ADMIN, fn))).json() as FuelEstimate
    assert.deepEqual(body.priceStats, { count: 100, min: 1.5, median: 1.5, max: 1.5, sampled: true })
    assert.equal(priceCalls, 1)
    assert.equal(defaultPriceKey(body), "")
    assert.equal(medianUsable(body), false)
    assert.match(medianLabel(body)!, /^médiane indisponible : .*100 stations les moins chères.*non représentatif/)
    assert.doesNotMatch(medianLabel(body)!, /1,500 €\/L ·/)
    assert.match(stationsLabel(body.stationsStatus, body.stations.length, 100, true), /Liste tronquée par le service.*aucune médiane représentative/)
    // Choix forcé (requête forgée, état périmé) : refusé ; aucune proposition chiffrée ni provenance.
    assert.equal(priceChoice(body, "MEDIAN", "2026-11-04"), null)
    const proposal = proposedExpense(body, priceChoice(body, "MEDIAN", "2026-11-04"), 9.5)
    assert.deepEqual([proposal.values.amount, proposal.provenance], [undefined, null])
    assert.throws(() => estimateNote({ km: 27, kmSource: "ODOMETER", consumption: 9.5, price: { kind: "MEDIAN", stats: body.priceStats!, date: "2026-11-04" }, fuel: "GAZOLE" }), /SAMPLED_MEDIAN/)
    const explicit = priceChoice(body, body.stations[0].id, "2026-11-04")
    assert.equal(explicit?.kind, "STATION")
    assert.match(proposedExpense(body, explicit, 9.5).provenance!, /prix indicatif publié par/)
  })
})

// ─── R2 point 5 — formulaire : valeurs périmées, provenance, devise ──────────

class FakeForm implements FormLike {
  fields = new Map<string, { value: string }>()
  constructor(initial: Record<string, string>) { for (const [k, v] of Object.entries(initial)) this.fields.set(k, { value: v }) }
  elements = { namedItem: (name: string) => this.fields.get(name) ?? null }
  get(name: string) { return this.fields.get(name)!.value }
  type(name: string, value: string, touched: Set<string>) { this.fields.get(name)!.value = value; touched.add(name) }
}
const openForm = (currency = "EUR") => new FakeForm({ category: "FUEL", date: "2026-11-04", amount: "", currency, litres: "", mileage: "", supplier: "", notes: "" })
const DEFAULTS = { category: "FUEL", date: "2026-11-04" }
/** Rejoue la séquence de l'encadré sur un formulaire : chaque proposition (ou null) suit la règle du panneau. */
function formSession(form: FakeForm) {
  const touched = new Set<string>()
  let state: EstimateFormState = emptyEstimateState()
  let withheld: string[] = []
  const apply = (proposal: ExpenseProposal | null, explicit = false) => {
    const r = applyEstimateToForm(form, { state, proposal, defaults: DEFAULTS, touched, explicit })
    state = r.state; withheld = r.withheld
    if (explicit) for (const name of Object.keys(state.owned)) touched.delete(name)
  }
  return { apply, touched, get state() { return state }, get withheld() { return withheld } }
}
const tripA = () => proposedExpense(estimate({ tripDate: "2026-11-03" }), { kind: "STATION", station: station() }, 9.5)
const tripBPartial = () => proposedExpense(estimate({ tripId: "trip-b", tripDate: "2026-11-05", km: null, kmSource: null, odometer: null, stations: [] }), null, 9.5)

describe("R2 point 5 — formulaire : champs automatiques périmés retirés, saisies gardées", () => {
  it("A valide puis B partiel (sans distance ni prix) : montant, litres, fournisseur et compteur de A retirés ; date de B", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA())
    assert.deepEqual([form.get("amount"), form.get("litres"), form.get("supplier"), form.get("mileage"), form.get("date")], ["5,77", "2,565", "1 RUE FICTIVE, Exempleville", "120027", "2026-11-03"])
    s.apply(tripBPartial())
    assert.deepEqual([form.get("amount"), form.get("litres"), form.get("supplier"), form.get("mileage"), form.get("date"), form.get("category")], ["", "", "", "", "2026-11-05", "FUEL"])
    assert.equal(s.state.provenance, null)
  })
  it("« Aucun », erreur, chargement d'une autre source ou démontage (proposition nulle) : tout ce que l'estimation avait écrit est retiré", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA()); s.apply(null)
    assert.deepEqual([form.get("amount"), form.get("litres"), form.get("supplier"), form.get("mileage"), form.get("date")], ["", "", "", "", "2026-11-04"])
    assert.deepEqual(s.state, emptyEstimateState())
  })
  it("consommation effacée ou invalide : montant et litres retirés, fournisseur et date gardés", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA())
    s.apply(proposedExpense(estimate({ tripDate: "2026-11-03" }), { kind: "STATION", station: station() }, null))
    assert.deepEqual([form.get("amount"), form.get("litres"), form.get("supplier"), form.get("date")], ["", "", "1 RUE FICTIVE, Exempleville", "2026-11-03"])
  })
  it("saisie manuelle préservée : montant du ticket tapé, puis B partiel ou nul : le montant tapé reste", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA())
    form.type("amount", "88,35", s.touched)
    s.apply(tripBPartial()); s.apply(null)
    assert.deepEqual([form.get("amount"), form.get("litres")], ["88,35", ""])
  })
  it("valeur modifiée sans événement de saisie (autre script, remplissage navigateur) : libérée, jamais réécrite ni effacée", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA())
    form.fields.get("supplier")!.value = "Station du ticket"
    s.apply(null)
    assert.equal(form.get("supplier"), "Station du ticket")
  })
  it("« Reprendre l'estimation » : réécrit même un champ saisi", () => {
    const form = openForm(), s = formSession(form)
    s.apply(tripA()); form.type("amount", "1,00", s.touched)
    s.apply(tripA(), true)
    assert.equal(form.get("amount"), "5,77")
  })
  it("note manuelle saisie : la provenance du montant estimé est conservée à part et ajoutée à l'envoi", () => {
    const form = openForm(), s = formSession(form)
    form.type("notes", "Payé en carte", s.touched)
    s.apply(tripA())
    assert.equal(form.get("notes"), "Payé en carte")
    const live = liveProvenance(s.state, { amount: form.get("amount"), litres: form.get("litres") })
    assert.equal(live, tripA().provenance)
    assert.equal(notesWithProvenance(form.get("notes"), live), `Payé en carte\n${tripA().provenance}`)
    // Montant et litres remplacés par ceux du ticket : la provenance n'accompagne plus la dépense.
    form.type("amount", "88,35", s.touched); form.type("litres", "52,31", s.touched)
    assert.equal(liveProvenance(s.state, { amount: form.get("amount"), litres: form.get("litres") }), null)
    // Notes très longues : la provenance n'est jamais tronquée, la note de l'opérateur l'est.
    const long = notesWithProvenance("x".repeat(5000), tripA().provenance)
    assert.ok(long.length <= 4000 && long.endsWith(tripA().provenance!))
  })
  it("devise USD : aucun montant estimé (euros) écrit, litres oui ; passage EUR → USD après coup : montant retiré ; envoi refusé si resté", () => {
    const usd = openForm("USD"), s = formSession(usd)
    s.apply(tripA())
    assert.deepEqual([usd.get("amount"), usd.get("litres"), s.withheld], ["", "2,565", ["amount"]])
    const eur = openForm(), t = formSession(eur)
    t.apply(tripA()); assert.equal(eur.get("amount"), "5,77")
    eur.type("currency", "USD", t.touched)
    assert.equal(currencyConflict(t.state, { amount: eur.get("amount") }, "USD"), true)
    t.apply(tripA())
    assert.deepEqual([eur.get("amount"), t.withheld], ["", ["amount"]])
    assert.equal(currencyConflict(t.state, { amount: eur.get("amount") }, "USD"), false)
  })
})

describe("R2 — rendu statique des composants modifiés (aucun réseau, aucun effet)", () => {
  it("encadré d'estimation et panneau des coûts se rendent ; drapeau absent : aucun encadré", async () => {
    const React = await import("react")
    const { renderToStaticMarkup } = await import("react-dom/server")
    ;(globalThis as { React?: unknown }).React = React
    const { VehicleFuelEstimate } = await import("@/components/vehicules/v3/VehicleFuelEstimate")
    const { VehicleCostsPanel } = await import("@/components/vehicules/v3/VehicleCostsPanel")
    const box = renderToStaticMarkup(React.createElement(VehicleFuelEstimate, { truckId: "truck-g", today: "2026-11-04", trips: [{ id: "trip-closed", label: "Trajet fictif" }], onPropose: () => {} }))
    assert.match(box, /Estimation du trajet/); assert.match(box, /estimation en euros/)
    assert.match(renderToStaticMarkup(React.createElement(VehicleCostsPanel, { truckId: "truck-g", timeZone: "Europe/Paris", fuelEstimateEnabled: true })), /Estimation du trajet/)
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(VehicleCostsPanel, { truckId: "truck-g", timeZone: "Europe/Paris" })), /Estimation du trajet/)
  })
})

describe("R2 point 5 — encadré : réponse tardive, erreur, démontage", () => {
  const deferred = () => { let resolve!: (r: Response) => void; const promise = new Promise<Response>((r) => { resolve = r }); return { promise, resolve } }
  const tick = () => new Promise((r) => setTimeout(r, 5))
  function harness() {
    const pending = new Map<string, ReturnType<typeof deferred>>()
    const events: string[] = []
    const fetchFn = ((url: string) => { const d = deferred(); pending.set(new URL(url, "https://x.invalid").searchParams.get("tripId") ?? "?", d); return d.promise }) as unknown as typeof fetch
    const requests = createEstimateRequests(fetchFn, {
      onReset: () => events.push("reset"), onLoading: (l) => events.push(`loading:${l}`),
      onResult: (e) => events.push(`result:${e.tripId}`), onError: (m) => events.push(`error:${m}`),
    })
    return { pending, events, requests }
  }
  it("A puis B, réponse A tardive : seule B est appliquée ; l'ancienne estimation est retirée dès la sélection de B", async () => {
    const h = harness()
    h.requests.select("truck-g", "trip:trip-a", "GAZOLE")
    h.requests.select("truck-g", "trip:trip-b", "GAZOLE")
    h.pending.get("trip-b")!.resolve(json(estimate({ tripId: "trip-b" })))
    await tick()
    h.pending.get("trip-a")!.resolve(json(estimate({ tripId: "trip-a" })))
    await tick()
    assert.deepEqual(h.events, ["reset", "loading:true", "reset", "loading:true", "result:trip-b", "loading:false"])
  })
  it("erreur serveur : estimation retirée, message, jamais d'ancienne valeur ; « Aucun » : retrait sans requête", async () => {
    const h = harness()
    h.requests.select("truck-g", "trip:trip-a", "GAZOLE")
    h.pending.get("trip-a")!.resolve(json({ code: "TRIP_NOT_FOUND" }, 404))
    await tick()
    h.requests.select("truck-g", "", "GAZOLE")
    assert.deepEqual(h.events, ["reset", "loading:true", `error:${fuelEstimateError("TRIP_NOT_FOUND")}`, "loading:false", "reset", "loading:false"])
  })
  it("fermeture ou démontage pendant la requête : aucune réponse appliquée ensuite", async () => {
    const h = harness()
    h.requests.select("truck-g", "trip:trip-a", "GAZOLE")
    h.requests.dispose()
    h.pending.get("trip-a")!.resolve(json(estimate({ tripId: "trip-a" })))
    await tick()
    assert.deepEqual(h.events, ["reset", "loading:true"])
  })
})

// ═══ R5 — décisions de déplacement explicites, contexte canonique, traçabilité (données synthétiques) ═══════

/** Itinéraire factice de 100 km aller (exemple de la revue) ; une station à 2,000 €/L. Aucun appel réel. */
function fetch100() {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url)
    if (url.startsWith("https://data.geopf.fr/navigation/itineraire")) return json({ distance: 100, distanceUnit: "kilometer", geometry: { type: "LineString", coordinates: line(MONTREUIL, PARIS, 40).map((p) => [p.longitude, p.latitude]) } })
    if (url.startsWith("https://data.economie.gouv.fr/")) return json({ results: [priceRow(93100001, 2.0, line(MONTREUIL, PARIS, 40)[5])] })
    throw new Error(`URL inattendue ${url}`)
  }) as typeof fetch
  return { fn, calls }
}

describe("R5 — séjours : modes, coupures, contexte, transfert, traçabilité", () => {
  let saved: string | undefined
  before(() => { saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved })
  const assignG = (dates: string[], over: Partial<FuelDb["assignments"][number]> = {}) => dates.map((d) => ({ date: at(`${d}T00:00:00Z`), teamId: "team-g", status: "PENDING", worksiteId: "ws-1", companyId: GALYA, ...over }))
  const est = async (db: FuelDb, query: Record<string, string>, fn = fetch100().fn, session: MileageSession = GALYA_ADMIN) => {
    const response = await estimateGet(request(GALYA_TRUCK, query), params(GALYA_TRUCK), depsFor(db, session, fn))
    return { status: response.status, body: await response.json() as FuelEstimate & { code?: string } }
  }
  const NOW = () => at("2026-11-04T10:00:00Z")
  const list = async (db: FuelDb) => {
    const { GET: staysGet } = await import("@/app/api/trucks/[id]/fuel-estimate/stays/route")
    return (await (await staysGet(request(GALYA_TRUCK, {}), params(GALYA_TRUCK), { ...depsFor(db), now: NOW })).json() as { stays: PlannedStay[] }).stays
  }
  // Jeudi 05, vendredi 06, lundi 09, mardi 10 novembre 2026 : 4 jours planifiés sur 6 jours civils.
  const THU_TUE = ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]
  const WEEKEND = "2026-11-07..2026-11-08"

  it("100 km aller, 3 jours consécutifs : un aller-retour = 200 km, quotidien = 600 km ; aucun kilométrage sans choix ni siège confirmé", async () => {
    const db = new FuelDb(), stayId = "ws-1~team-g~2026-11-04"
    const first = await est(db, { stayId })
    assert.equal(first.status, 200)
    assert.deepEqual([first.body.km, first.body.kmSource, first.body.missing, first.body.travel?.roundTrips, first.body.route.oneWayKm], [null, null, ["MODE", "DEPOT"], null, 100])
    const context = first.body.stay!.context
    assert.match(context, /^v1-[0-9a-f]{16}$/)
    // Aucun montant proposé tant que des décisions manquent.
    assert.equal(proposedExpense(first.body, { kind: "STATION", station: first.body.stations[0] }, 9.5).values.amount, undefined)
    const noDepot = await est(db, { stayId, mode: "ONE_ROUND_TRIP", context })
    assert.deepEqual([noDepot.body.km, noDepot.body.missing], [null, ["DEPOT"]])
    const one = await est(db, { stayId, mode: "ONE_ROUND_TRIP", context, depot: "1" })
    assert.deepEqual([one.body.km, one.body.kmSource, one.body.travel?.roundTrips, one.body.travel?.plannedDays, one.body.missing], [200, "STAY_ROUND_TRIP", 1, 3, []])
    const daily = await est(db, { stayId, mode: "DAILY", context, depot: "1" })
    assert.deepEqual([daily.body.km, daily.body.travel?.roundTrips, daily.body.travel?.mode], [600, 3, "DAILY"])
    assert.match(kmLabel(daily.body), /^600 km : 3 allers-retours siège ↔ Chantier fictif de 2 × 100,0 km \(un aller-retour par jour planifié \(3 jours/)
    const p = proposedExpense(daily.body, { kind: "STATION", station: daily.body.stations[0] }, 10)
    assert.deepEqual([p.values.amount, p.values.litres], ["120,00", "60"])
    assert.match(p.provenance!, /hypothèse de l'opérateur : un aller-retour siège ↔ chantier par jour planifié \(3 jours planifiés, jours sans planning non comptés\) ; 3 allers-retours de 2 × 100,0 km ; contexte du planning v1-[0-9a-f]{16}\) 600 km \(itinéraire aller-retour, départ et retour au siège confirmés par l'opérateur\)/)
    // Décision sans contexte : invérifiable, refusée.
    assert.equal((await est(db, { stayId, mode: "ONE_ROUND_TRIP", depot: "1" })).status, 400)
    assert.deepEqual(businessWrites(db), [])
  })

  it("jeudi-vendredi puis lundi-mardi : coupure à décider ; sur place = 200 km, retour = 400 km, quotidien = 800 km (jamais × 6)", async () => {
    const db = new FuelDb(); db.assignments = assignG(THU_TUE)
    const stays = await list(db)
    assert.deepEqual(stays.map((s) => [s.id, s.days, s.spanDays, s.gaps]), [["ws-1~team-g~2026-11-05", 4, 6, [{ from: "2026-11-07", to: "2026-11-08", days: 2 }]]])
    const stayId = stays[0].id, context = stays[0].context
    const undecided = await est(db, { stayId, mode: "ONE_ROUND_TRIP", context, depot: "1" })
    assert.deepEqual([undecided.body.km, undecided.body.missing, undecided.body.travel?.gaps.map((g) => g.decision)], [null, ["GAPS"], [null]])
    assert.equal((await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:STAY`, context, depot: "1" })).body.km, 200)
    assert.equal((await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:RETURN`, context, depot: "1" })).body.km, 400)
    const daily = await est(db, { stayId, mode: "DAILY", context, depot: "1" })
    assert.deepEqual([daily.body.km, daily.body.travel?.roundTrips], [800, 4])
    // Coupures en mode quotidien, décision mal formée ou clé partielle : refus.
    assert.equal((await est(db, { stayId, mode: "DAILY", gaps: `${WEEKEND}:STAY`, context, depot: "1" })).status, 400)
    assert.equal((await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: "2026-11-07:STAY", context, depot: "1" })).status, 400)
    assert.equal((await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:MAYBE`, context, depot: "1" })).status, 400)
    // Coupure inconnue de ce séjour (même début, autre fin) : refusée, jamais rattachée.
    const wrong = await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: "2026-11-07..2026-11-09:STAY", context, depot: "1" })
    assert.deepEqual([wrong.status, wrong.body.code], [409, "STAY_GAPS_MISMATCH"])
    // Provenance : chaque coupure et sa décision.
    const ret = (await est(db, { stayId, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:RETURN`, context, depot: "1" })).body
    assert.match(proposedExpense(ret, { kind: "STATION", station: ret.stations[0] }, 10).provenance!, /un aller-retour pour le séjour ; coupure du 07\/11\/2026 au 08\/11\/2026 : camion rentré au siège ; 2 allers-retours de 2 × 100,0 km/)
  })

  it("contexte périmé : coupure de même début mais nouvelle fin, jour planifié ajouté → 409, décisions jamais transposées", async () => {
    const db = new FuelDb(); db.assignments = assignG(THU_TUE)
    const old = (await list(db))[0]
    // Planning modifié : le lundi 09 retiré, le mercredi 11 ajouté → coupure 07..09 (même début, nouvelle fin), même séjour.
    db.assignments = assignG(["2026-11-05", "2026-11-06", "2026-11-10", "2026-11-11"])
    const fresh = (await list(db))[0]
    assert.deepEqual([fresh.id, fresh.gaps], [old.id, [{ from: "2026-11-07", to: "2026-11-09", days: 3 }]])
    assert.notEqual(fresh.context, old.context)
    const stale = await est(db, { stayId: old.id, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:STAY`, context: old.context, depot: "1" })
    assert.deepEqual([stale.status, stale.body.code], [409, "STAY_CONTEXT_CHANGED"])
    // Même avec le nouveau contexte, l'ancienne clé de coupure ne s'applique pas à la nouvelle fin.
    const oldKey = await est(db, { stayId: old.id, mode: "ONE_ROUND_TRIP", gaps: `${WEEKEND}:STAY`, context: fresh.context, depot: "1" })
    assert.deepEqual([oldKey.status, oldKey.body.code], [409, "STAY_GAPS_MISMATCH"])
    // Contre-exemple Codex (règle pure) : la décision de 07..08 ne vaut pas pour 07..09.
    assert.deepEqual(stayRoundTrips(fresh, { mode: "ONE_ROUND_TRIP", gaps: { [WEEKEND]: "STAY" } }).missing, ["GAPS"])
    // Mode quotidien : un jour planifié ajouté change le contexte, l'ancien choix est refusé.
    db.assignments = assignG([...THU_TUE, "2026-11-11"])
    const added = (await list(db))[0]
    const dailyStale = await est(db, { stayId: old.id, mode: "DAILY", context: old.context, depot: "1" })
    assert.deepEqual([dailyStale.status, dailyStale.body.code], [409, "STAY_CONTEXT_CHANGED"])
    assert.equal((await est(db, { stayId: old.id, mode: "DAILY", context: added.context, depot: "1" })).body.km, 1000)
    assert.equal(fuelEstimateError("STAY_CONTEXT_CHANGED").includes("vos choix ont été retirés"), true)
    assert.ok(STALE_DECISION_CODES.has("STAY_CONTEXT_CHANGED") && !STALE_DECISION_CODES.has("STAY_NOT_FOUND"))
  })

  it("liste et détail : planning sur un autre chantier pendant la coupure empêche le regroupement (tous chantiers lus au détail)", async () => {
    const db = new FuelDb()
    db.assignments = [...assignG(["2026-11-05", "2026-11-06", "2026-11-09"]), ...assignG(["2026-11-07"], { worksiteId: "ws-2" })]
    const stays = await list(db)
    assert.deepEqual(stays.map((s) => [s.id, s.return, s.gaps.length]).sort(), [["ws-1~team-g~2026-11-05", "2026-11-06", 0], ["ws-1~team-g~2026-11-09", "2026-11-09", 0], ["ws-2~team-g~2026-11-07", "2026-11-07", 0]])
    for (const s of stays) assert.deepEqual((await est(db, { stayId: s.id })).body.stay, s, s.id)
    // Chaque jour planifié dans un seul séjour : jours cumulés = lignes de planning (aucun double compte).
    assert.equal(stays.reduce((n, s) => n + s.days, 0), db.assignments.length)
  })

  it("regroupement (pur) : autre équipe, réaffectation, coupure de plus de 7 jours ou bornes non lues : jamais de fusion supposée", () => {
    const scan = { from: "2026-10-01", to: "2026-12-31" }
    const own = [period("team-a", "drv", paris("2026-09-01"))]
    // Coupure de 7 jours : rattachée (à décider) ; de 8 jours : deux séjours.
    assert.deepEqual(resolveStays(plan(["2026-11-02", ...range("2026-11-10", 1)]), own, scan).map((s) => s.gaps.length), [1])
    assert.equal(MAX_GAP_DAYS, 7)
    assert.equal(resolveStays(plan(["2026-11-02", "2026-11-11"]), own, scan).length, 2)
    // Camion chez une autre équipe pendant la coupure.
    const lent = [period("team-a", "drv", paris("2026-09-01"), paris("2026-11-07")), period("team-b", "drv-b", paris("2026-11-07"), paris("2026-11-08")), period("team-a", "drv", paris("2026-11-08"))]
    assert.equal(resolveStays(plan(["2026-11-06", "2026-11-09"]), lent, scan).length, 2)
    // Réaffectation en journée pendant la coupure (non planifiée) : pas de fusion.
    const cut = new Date(parisDayStart("2026-11-07") + 10 * 3_600_000)
    assert.equal(resolveStays(plan(["2026-11-06", "2026-11-09"]), [period("team-a", "drv", paris("2026-09-01"), cut), period("team-a", "drv-2", cut)], scan).length, 2)
    // Bornes : une suite rattachable pourrait précéder le premier jour lu → départ inconnu, non estimable.
    const edge = resolveStays(plan(["2026-11-05"]), own, { from: addDays("2026-11-05", -STAY_EDGE_DAYS + 1), to: "2026-12-31" })
    assert.deepEqual(edge.map((s) => [s.departureKnown, s.blocked]), [[false, "OUT_OF_RANGE"]])
    assert.deepEqual(resolveStays(plan(["2026-11-05"]), own, { from: addDays("2026-11-05", -STAY_EDGE_DAYS), to: "2026-12-31" }).map((s) => s.blocked), [null])
  })

  it("plafond de 62 jours CIVILS (coupures comprises), pas seulement des jours planifiés ; aucune fin inventée", () => {
    const own = [period("team-a", "drv", paris("2026-01-01"))], scan = { from: "2026-06-01", to: "2026-12-31" }
    const over = resolveStays(plan([...range("2026-08-01", 30), ...range("2026-09-03", 30)]), own, scan)
    assert.deepEqual(over.map((s) => [s.days, s.spanDays, s.gaps.length, s.blocked]), [[60, 63, 1, "TOO_LONG"]])
    assert.deepEqual(resolveStays(plan([...range("2026-08-01", 30), ...range("2026-09-02", 30)]), own, scan).map((s) => [s.spanDays, s.blocked]), [[62, null]])
    assert.deepEqual(resolveStays(plan([...range("2026-08-01", 30), ...range("2026-09-03", 30)]), own, scan)[0].return, "2026-10-02")
  })

  it("transfert en journée : bloqué sans déclaration ; déclaration exacte acceptée comme hypothèse, aucune écriture au GET", async () => {
    const db = new FuelDb()
    const cut = new Date(parisDayStart("2026-11-05") + 10 * 3_600_000)
    db.periods = [{ ...db.periods[0], chauffeurId: "emp-driver", startedAt: at("2026-06-01T00:00:00Z"), endedAt: cut }, { ...db.periods[0], chauffeurId: "emp-leader", startedAt: cut, endedAt: null }]
    const periodsBefore = structuredClone(db.periods)
    const [stay] = await list(db)
    assert.deepEqual([stay.blocked, stay.handoverDays, staySelectable(stay), staySelectable({ ...stay, blocked: "NO_HISTORY", estimable: false })], ["HANDOVER", ["2026-11-05"], true, false])
    const context = stay.context
    const blocked = await est(db, { stayId: stay.id, mode: "ONE_ROUND_TRIP", context, depot: "1" })
    assert.deepEqual([blocked.status, blocked.body.code], [409, "STAY_HANDOVER"])
    const mismatch = await est(db, { stayId: stay.id, mode: "ONE_ROUND_TRIP", context, depot: "1", handover: "2026-11-04" })
    assert.deepEqual([mismatch.status, mismatch.body.code], [409, "STAY_HANDOVER_MISMATCH"])
    const declared = await est(db, { stayId: stay.id, mode: "ONE_ROUND_TRIP", context, depot: "1", handover: "2026-11-05" })
    assert.deepEqual([declared.status, declared.body.km, declared.body.travel?.handoverDeclared, declared.body.stay?.blocked], [200, 200, ["2026-11-05"], "HANDOVER"])
    assert.match(handoverConfirmLabel(stay), /rien n'est enregistré maintenant.*l'historique d'affectation n'est pas modifié/)
    // Lecture seule : ni dépense, ni journal, ni affectation modifiée.
    assert.deepEqual([businessWrites(db), db.expenses.length, db.commands.length], [[], 0, 0])
    assert.deepEqual(db.periods, periodsBefore)
    // Déclaration sur un séjour sans réaffectation : refus.
    const normal = new FuelDb()
    const normalCtx = await contextOf(normal, "ws-1~team-g~2026-11-04", fetch100().fn)
    assert.equal((await est(normal, { stayId: "ws-1~team-g~2026-11-04", mode: "ONE_ROUND_TRIP", context: normalCtx, handover: "2026-11-05" })).status, 400)
  })

  it("traçabilité : la déclaration n'est consignée qu'à la sauvegarde, par la commande de dépense existante (acteur, après-état, notes)", async () => {
    const db = new FuelDb()
    const cut = new Date(parisDayStart("2026-11-05") + 10 * 3_600_000)
    db.periods = [{ ...db.periods[0], chauffeurId: "emp-driver", startedAt: at("2026-06-01T00:00:00Z"), endedAt: cut }, { ...db.periods[0], chauffeurId: "emp-leader", startedAt: cut, endedAt: null }]
    const [stay] = await list(db)
    const e = (await est(db, { stayId: stay.id, mode: "ONE_ROUND_TRIP", context: stay.context, depot: "1", handover: "2026-11-05" })).body
    const proposal = proposedExpense(e, { kind: "STATION", station: e.stations[0] }, 10)
    assert.match(proposal.provenance!, /déclaration de l'opérateur, pas un historique d'affectation : camion attribué à l'équipe BILEL A COMPO les jours de réaffectation 05\/11\/2026 ; contexte du planning v1-/)
    assert.equal(db.commands.length, 0, "rien n'est consigné avant la sauvegarde")
    const notes = notesWithProvenance("Ticket à rapprocher", proposal.provenance)
    const saved = await executeExpenseCommand(GALYA_TRUCK, { action: "CREATE", data: { category: "FUEL", occurredAt: "2026-11-04T08:00:00.000Z", amount: "40.00", currency: "EUR", litres: "20", notes } }, randomUUID(),
      { auth: async () => GALYA_ADMIN, db: db as unknown as Parameters<typeof executeExpenseCommand>[3]["db"] })
    assert.equal(saved.replayed, false)
    assert.equal(db.commands.length, 1)
    const command = db.commands[0] as { actorId: string; action: string; companyId: string; truckId: string; after: { notes: string; status: string } }
    assert.deepEqual([command.actorId, command.action, command.companyId, command.truckId, command.after.status], ["admin-g", "CREATE", GALYA, GALYA_TRUCK, "PENDING"])
    assert.ok(command.after.notes.startsWith("Ticket à rapprocher\n"))
    assert.ok(command.after.notes.includes("déclaration de l'opérateur, pas un historique d'affectation") && command.after.notes.includes(stay.context))
    // L'historique d'affectation du camion n'est pas touché par la sauvegarde.
    assert.deepEqual(db.periods.map((p) => [p.teamId, p.chauffeurId]), [["team-g", "emp-driver"], ["team-g", "emp-leader"]])
  })

  it("historique absent : refus même avec mode, contexte et déclaration ; jamais l'équipe actuelle supposée", async () => {
    const db = new FuelDb()
    db.periods = []
    db.inner.state.trucks.find((t) => t.id === GALYA_TRUCK)!.teamId = "team-g"
    const [stay] = await list(db)
    assert.equal(stay.blocked, "NO_HISTORY")
    const refused = await est(db, { stayId: stay.id, mode: "ONE_ROUND_TRIP", context: stay.context, depot: "1", handover: "2026-11-05" })
    assert.deepEqual([refused.status, refused.body.code], [409, "STAY_NO_HISTORY"])
  })

  it("droits inter-sociétés et rôle ; trajet relevé : aucun choix de séjour accepté, compteur jamais multiplié", async () => {
    const db = new FuelDb(), stayId = "ws-1~team-g~2026-11-04"
    const context = await contextOf(db, stayId, fetch100().fn)
    const foreign = await est(db, { stayId, mode: "ONE_ROUND_TRIP", context, depot: "1" }, fetch100().fn, ADMIN)
    assert.equal(foreign.status, 404)
    // Chef d'équipe (rôle sans lecture des coûts) sur un camion de sa propre société : refus 403.
    assert.equal((await estimateGet(request(TRUCK, { stayId: "ws-1~team-a~2026-11-04", mode: "ONE_ROUND_TRIP", context, depot: "1" }), params(TRUCK), depsFor(new FuelDb(), LEADER, fetch100().fn))).status, 403)
    for (const q of [{ mode: "DAILY" }, { gaps: `${WEEKEND}:STAY` }, { handover: "2026-11-05" }, { context }] as Record<string, string>[])
      assert.equal((await est(db, { tripId: "trip-closed", ...q })).status, 400, JSON.stringify(q))
    const closed = (await est(db, { tripId: "trip-closed", depot: "1" })).body
    assert.deepEqual([closed.km, closed.kmSource, closed.travel, closed.missing], [27, "ODOMETER", null, []])
    assert.equal((await est(db, { tripId: "trip-closed" })).body.km, 27, "compteur : aucune confirmation demandée")
    assert.deepEqual(businessWrites(db), [])
  })

  it("requêtes de l'encadré : rien par défaut, coupures seulement en un aller-retour, contexte joint aux décisions", () => {
    const stay = plannedStay({ id: "ws-1~team-g~2026-11-05", gaps: [{ from: "2026-11-07", to: "2026-11-08", days: 2 }], handoverDays: ["2026-11-06"], blocked: "HANDOVER", estimable: false, context: "v1-0123456789abcdef" })
    const owner = decisionsOwner("truck-g", `stay:${stay.id}`, stay.context)
    const base = emptyDecisions(owner)
    assert.deepEqual(Object.fromEntries(estimateQuery(`stay:${stay.id}`, "GAZOLE", base, stay)), { stayId: stay.id, fuel: "GAZOLE" })
    const full = { ...base, mode: "ONE_ROUND_TRIP" as const, gaps: { [gapKey(stay.gaps[0])]: "RETURN" as const, "2026-01-01..2026-01-02": "STAY" as const }, depot: true, handover: true }
    assert.deepEqual(Object.fromEntries(estimateQuery(`stay:${stay.id}`, "GAZOLE", full, stay)), { stayId: stay.id, fuel: "GAZOLE", mode: "ONE_ROUND_TRIP", gaps: "2026-11-07..2026-11-08:RETURN", handover: "2026-11-06", context: stay.context, depot: "1" })
    assert.equal(estimateQuery(`stay:${stay.id}`, "GAZOLE", { ...full, mode: "DAILY" }, stay).has("gaps"), false)
    assert.deepEqual(Object.fromEntries(estimateQuery("trip:trip-open", "GAZOLE", full, null)), { tripId: "trip-open", fuel: "GAZOLE", depot: "1" })
    // A → B → A, autre camion, contexte relu différent : décisions remises à zéro.
    assert.equal(decisionsFor(full, decisionsOwner("truck-g", "stay:autre", stay.context)).mode, null)
    assert.equal(decisionsFor(full, decisionsOwner("truck-x", `stay:${stay.id}`, stay.context)).mode, null)
    assert.equal(decisionsFor(full, decisionsOwner("truck-g", `stay:${stay.id}`, "v1-ffffffffffffffff")).mode, null)
    assert.equal(decisionsFor(full, owner).mode, "ONE_ROUND_TRIP")
    assert.deepEqual(missingDecisionsLabel(["MODE", "GAPS", "DEPOT"]).length, 3)
    assert.match(stayLabel(planned({ ...resolveStays(plan(THU_TUE, "team-a"), [period("team-a", "drv", paris("2026-09-01"))], { from: "2026-10-01", to: "2026-12-31" })[0] })), /\(4 jours planifiés, 1 coupure\)/)
    assert.equal(stayContext({ ...resolveStays(plan(THU_TUE, "team-a"), [period("team-a", "drv", paris("2026-09-01"))], { from: "2026-10-01", to: "2026-12-31" })[0] }),
      resolveStays(plan(THU_TUE, "team-a"), [period("team-a", "drv", paris("2026-09-01"))], { from: "2026-10-01", to: "2026-12-31" })[0].context)
  })

  it("réponse tardive après changement de décision : seule la dernière requête s'applique ; code d'erreur transmis", async () => {
    const pending = new Map<string, (r: Response) => void>()
    const events: string[] = []
    const fetchFn = ((url: string) => new Promise<Response>((resolve) => { pending.set(new URL(url, "https://x.invalid").searchParams.get("gaps") ?? "none", resolve) })) as unknown as typeof fetch
    const requests = createEstimateRequests(fetchFn, { onReset: () => events.push("reset"), onLoading: () => {}, onResult: (e) => events.push(`result:${e.km}`), onError: (m, code) => events.push(`error:${code}`) })
    const stay = plannedStay({ gaps: [{ from: "2026-11-07", to: "2026-11-08", days: 2 }] })
    const d = { ...emptyDecisions("o"), mode: "ONE_ROUND_TRIP" as const, depot: true }
    requests.select("truck-g", `stay:${stay.id}`, "GAZOLE", { ...d, gaps: { [WEEKEND]: "STAY" } }, stay)
    requests.select("truck-g", `stay:${stay.id}`, "GAZOLE", { ...d, gaps: { [WEEKEND]: "RETURN" } }, stay)
    pending.get(`${WEEKEND}:RETURN`)!(json(estimate({ km: 400 })))
    await new Promise((r) => setTimeout(r, 5))
    pending.get(`${WEEKEND}:STAY`)!(json(estimate({ km: 200 })))
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(events, ["reset", "reset", "result:400"])
    requests.select("truck-g", `stay:${stay.id}`, "GAZOLE", { ...d, gaps: {} }, stay)
    pending.get("none")!(json({ code: "STAY_CONTEXT_CHANGED" }, 409))
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(events.at(-1), "error:STAY_CONTEXT_CHANGED")
  })

  it("formulaire : décision retirée → montant automatique retiré ; montant saisi gardé ; devise USD ; notes manuelles + provenance", () => {
    const stay = plannedStay({ gaps: [{ from: "2026-11-07", to: "2026-11-08", days: 2 }] })
    const travel = { context: "v1-0123456789abcdef", mode: "ONE_ROUND_TRIP" as const, gaps: [{ from: "2026-11-07", to: "2026-11-08", days: 2, decision: "RETURN" as const }], plannedDays: 3, roundTrips: 2, oneWayKm: 100, handoverDeclared: [] }
    const decided = estimate({ source: "STAY", stay, km: 400, kmSource: "STAY_ROUND_TRIP", odometer: null, tripDate: "2026-11-04", travel, depotConfirmed: true })
    const undecided = estimate({ source: "STAY", stay, km: null, kmSource: null, odometer: null, tripDate: "2026-11-04", travel: { ...travel, roundTrips: null, gaps: [{ ...travel.gaps[0], decision: null }] }, missing: ["GAPS"] })
    const choice = { kind: "STATION" as const, station: station() }
    const a = proposedExpense(decided, choice, 10), b = proposedExpense(undecided, choice, 10)
    assert.equal(a.values.amount, "90,00"); assert.equal(b.values.amount, undefined)
    const first = reconcileEstimate({ state: emptyEstimateState(), proposal: a, current: {}, defaults: {}, touched: new Set(), explicit: false, currency: "EUR" })
    const second = reconcileEstimate({ state: first.state, proposal: b, current: { ...first.writes }, defaults: { amount: "" }, touched: new Set(), explicit: false, currency: "EUR" })
    assert.deepEqual([second.writes.amount, second.writes.litres, second.state.provenance], ["", "", null])
    const typed = reconcileEstimate({ state: first.state, proposal: b, current: { ...first.writes, amount: "88,10" }, defaults: { amount: "" }, touched: new Set(["amount"]), explicit: false, currency: "EUR" })
    assert.equal(typed.writes.amount, undefined)
    const usd = reconcileEstimate({ state: emptyEstimateState(), proposal: a, current: {}, defaults: {}, touched: new Set(), explicit: false, currency: "USD" })
    assert.deepEqual([usd.writes.amount, usd.withheld], [undefined, ["amount"]])
    assert.match(notesWithProvenance("Péage à part", a.provenance), /^Péage à part\nEstimation trajet : chantier Chantier fictif, équipe BILEL A COMPO .*coupure du 07\/11\/2026 au 08\/11\/2026 : camion rentré au siège ; 2 allers-retours de 2 × 100,0 km ; contexte du planning v1-0123456789abcdef\)/)
  })
})

// R11 : plafond d'un trajet (10 000 km) cohérent avec un séjour de plusieurs allers-retours. Valeurs de la recette
// ALZONNE (aller 758,9 km, 8 L/100 km et 2,25 €/L confirmés par l'opérateur) ; chantier et équipe fictifs.
describe("plafond des kilomètres : trajet et séjour cumulé", () => {
  const ALLER = 758.9
  const stayEstimate = (roundTrips: number, mode: "ONE_ROUND_TRIP" | "DAILY", oneWayKm = ALLER, kmOverride?: number) => estimate({
    source: "STAY", stay: plannedStay({ days: 9, spanDays: 9 }), odometer: null, tripDate: "2026-11-19", kmSource: "STAY_ROUND_TRIP", depotConfirmed: true,
    // Même formule que le service : arrondi(aller × 2 × allers-retours).
    km: kmOverride ?? Math.round(oneWayKm * 2 * roundTrips), route: { status: "ROUTE", oneWayKm },
    travel: { context: "v1-0000000000000000", mode, gaps: [], plannedDays: 9, roundTrips, oneWayKm, handoverDeclared: [] },
    priceStats: { count: 181, min: 2.1, median: 2.25, max: 2.4, sampled: false },
  })
  const median = (e: FuelEstimate) => priceChoice(e, "MEDIAN", "2026-11-05")!

  it("trajet : 10 000 km calculés, 10 001 refusés ; défaut et maxKm non fini = limite d'un trajet ; plafond absolu borné", () => {
    assert.deepEqual(estimateFuel({ km: 10_000, consumptionLPer100Km: 8, pricePerLitre: 2.25 }), { litres: 800, amount: 1800 })
    assert.equal(estimateFuel({ km: 10_001, consumptionLPer100Km: 8, pricePerLitre: 2.25 }), null)
    for (const maxKm of [Number.POSITIVE_INFINITY, Number.NaN]) assert.equal(estimateFuel({ km: 10_001, consumptionLPer100Km: 8, pricePerLitre: 2.25, maxKm }), null)
    assert.equal(STAY_KM_CEILING, MAX_STAY_DAYS * TRIP_KM_LIMIT)
    assert.ok(estimateFuel({ km: STAY_KM_CEILING, consumptionLPer100Km: 8, pricePerLitre: 2.25, maxKm: 1e9 }))
    assert.equal(estimateFuel({ km: STAY_KM_CEILING + 1, consumptionLPer100Km: 8, pricePerLitre: 2.25, maxKm: 1e9 }), null)
    assert.equal(estimateKmLimit(estimate()), TRIP_KM_LIMIT)
  })

  it("un aller-retour (non-régression) : 1518 km → 121,44 L, 273,24 € ; limite d'un trajet conservée", () => {
    const one = stayEstimate(1, "ONE_ROUND_TRIP")
    assert.equal(estimateKmLimit(one), TRIP_KM_LIMIT)
    const p = proposedExpense(one, median(one), 8)
    assert.deepEqual([one.km, p.values.litres, p.values.amount], [1518, "121,44", "273,24"])
  })

  it("quotidien 9 jours : 13660 km → 1092,8 L, 2458,80 € ; limite dérivée 9 × 10 000 km", () => {
    const daily = stayEstimate(9, "DAILY")
    assert.deepEqual([daily.km, estimateKmLimit(daily)], [13_660, 90_000])
    const p = proposedExpense(daily, median(daily), 8)
    assert.deepEqual([p.values.litres, p.values.amount], ["1092,8", "2458,80"])
    assert.match(p.provenance!, /13660 km \(itinéraire aller-retour/)
  })

  it("séjour à la limite : 10 000 km calculés, 10 001 refusés (un aller-retour, km sur place compris)", () => {
    const edge = stayEstimate(1, "ONE_ROUND_TRIP", 5000)
    assert.equal(proposedExpense(edge, median(edge), 8).values.amount, "1800,00")
    assert.equal(proposedExpense(edge, median(edge), 8, 1).values.amount, undefined)
    assert.match(uncomputedReason(edge, 10_001, 8, median(edge)), /^Distance hors limite : 10001 km dépassent la limite de 10000 km d'une estimation de trajet \(km sur place compris\)\./)
  })

  it("incohérences : aller-retour unitaire au-delà de 10 000 km ou km non recalculés → limite d'un trajet", () => {
    assert.equal(estimateKmLimit(stayEstimate(2, "DAILY", 6000)), TRIP_KM_LIMIT)
    assert.equal(estimateKmLimit(stayEstimate(9, "DAILY", ALLER, 50_000)), TRIP_KM_LIMIT)
    assert.equal(estimateKmLimit(stayEstimate(MAX_STAY_DAYS + 1, "DAILY", 10)), TRIP_KM_LIMIT)
    assert.equal(estimateKmLimit({ ...stayEstimate(9, "DAILY"), travel: null }), TRIP_KM_LIMIT)
  })

  it("km sur place qui franchissent la limite : aucun montant, message de limite même avec un prix choisi", () => {
    const daily = stayEstimate(9, "DAILY"), choice = median(daily)
    assert.equal(proposedExpense(daily, choice, 8, 76_340).values.amount, "16200,00")
    const over = proposedExpense(daily, choice, 8, 76_341)
    assert.deepEqual([over.values.amount, over.values.litres, over.provenance], [undefined, undefined, null])
    const reason = uncomputedReason(daily, totalKm(daily, 76_341), 8, choice)
    assert.equal(reason, "Distance hors limite : 90001 km dépassent la limite de 90000 km pour 9 allers-retours (10000 km par aller-retour, km sur place compris). Litres et montant non estimés ; saisissez le montant du ticket.")
    assert.doesNotMatch(reason, /Choisissez un prix/)
  })

  it("autres raisons inchangées : consommation, décisions, distance inconnue, prix non choisi", () => {
    const daily = stayEstimate(9, "DAILY")
    assert.equal(uncomputedReason(daily, 13_660, null, median(daily)), "Indiquez la consommation pour estimer les litres et le montant.")
    assert.equal(uncomputedReason(estimate({ km: null, kmSource: null, missing: ["MODE"] }), null, 8, null), "Décisions manquantes : litres et montant non estimés.")
    assert.equal(uncomputedReason(estimate({ km: null, kmSource: null }), null, 8, null), "Distance inconnue : litres et montant non estimés.")
    assert.equal(uncomputedReason(daily, 13_660, 8, null), "Choisissez un prix pour estimer le montant.")
  })

  it("aucune proposition périmée : passer d'un montant calculé à un total hors limite vide montant et litres", () => {
    const daily = stayEstimate(9, "DAILY"), choice = median(daily)
    const first = reconcileEstimate({ state: emptyEstimateState(), proposal: proposedExpense(daily, choice, 8), current: {}, defaults: {}, touched: new Set(), explicit: false, currency: "EUR" })
    assert.deepEqual([first.writes.amount, first.writes.litres], ["2458,80", "1092,8"])
    const second = reconcileEstimate({ state: first.state, proposal: proposedExpense(daily, choice, 8, 76_341), current: { ...first.writes }, defaults: { amount: "", litres: "" }, touched: new Set(), explicit: false, currency: "EUR" })
    assert.deepEqual([second.writes.amount, second.writes.litres, second.state.provenance], ["", "", null])
  })
})

describe("raison : distance nulle ou invalide", () => {
  it("km nul, négatif ou non fini avec prix et consommation valides : raison de distance, jamais « Prix hors bornes »", () => {
    const choice = { kind: "STATION" as const, station: station() }
    for (const km of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = estimate({ km })
      assert.equal(estimateFuel({ km, consumptionLPer100Km: 8, pricePerLitre: 2.25 }), null)
      assert.equal(uncomputedReason(e, km, 8, choice), "Distance nulle ou invalide : litres et montant non estimés.")
    }
  })
})

describe("R13 — lecture de prévision d'un séjour (API, lecture seule)", () => {
  let saved: string | undefined
  before(() => { saved = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (saved === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = saved })
  const NOW = () => at("2026-11-04T10:00:00Z")
  const listFor = async (db: FuelDb) => {
    const { GET: staysGet } = await import("@/app/api/trucks/[id]/fuel-estimate/stays/route")
    return (await (await staysGet(request(GALYA_TRUCK, {}), params(GALYA_TRUCK), { ...depsFor(db), now: NOW })).json() as { stays: PlannedStay[] }).stays
  }
  const read = (db: FuelDb, query: Record<string, string>, session: MileageSession = GALYA_ADMIN, fetchFn = fakeFetch().fn) =>
    estimateGet(request(GALYA_TRUCK, query), params(GALYA_TRUCK), { ...depsFor(db, session, fetchFn), now: NOW })
  /** Camion passé à l'équipe le 05/11 à 10 h (une autre équipe le détenait à minuit) ; équipe planifiée du 05 au 08. */
  const edgeHandover = () => {
    const db = new FuelDb()
    const cut = new Date(parisDayStart("2026-11-05") + 10 * 3_600_000)
    db.teams.push({ id: "team-x", companyId: GALYA, name: "ÉQUIPE FICTIVE X", leaderId: "emp-leader" })
    db.periods = [{ ...db.periods[0], teamId: "team-x", startedAt: at("2026-06-01T00:00:00Z"), endedAt: cut }, { ...db.periods[0], startedAt: cut, endedAt: null }]
    db.assignments = range("2026-11-05", 4).map((d) => ({ date: at(`${d}T00:00:00Z`), teamId: "team-g", status: "PENDING", worksiteId: "ws-1", companyId: GALYA }))
    return db
  }

  it("réaffectation la veille du départ : séjour 06–08 bloqué, lu en prévision sans déclaration, sans kilométrage ni attestation", async () => {
    const db = edgeHandover()
    const [stay] = await listFor(db)
    assert.deepEqual([stay.departure, stay.return, stay.blocked, stay.handoverDays], ["2026-11-06", "2026-11-08", "HANDOVER", ["2026-11-05"]])
    const declared = await read(db, { stayId: stay.id })
    assert.deepEqual([declared.status, (await declared.json()).code], [409, "STAY_HANDOVER"])
    const response = await read(db, { stayId: stay.id, forecast: "1", context: stay.context })
    assert.equal(response.status, 200)
    const body = await response.json() as FuelEstimate
    assert.deepEqual([body.km, body.kmSource, body.depotConfirmed, body.travel?.handoverDeclared, body.travel?.mode], [null, null, false, [], null])
    assert.ok(body.missing.includes("MODE") && body.missing.includes("DEPOT"))
    assert.ok(body.route.oneWayKm !== null && body.stations.length > 0)
    assert.deepEqual(body.stay, stay)
    assert.deepEqual(businessWrites(db), [])
  })
  it("paramètres stricts : contexte exigé, aucune décision mêlée, séjour seulement, valeur exacte", async () => {
    const db = edgeHandover()
    const [stay] = await listFor(db)
    const queries: Record<string, string>[] = [
      { stayId: stay.id, forecast: "1" },
      { stayId: stay.id, forecast: "1", context: stay.context, mode: "ONE_ROUND_TRIP" },
      { stayId: stay.id, forecast: "1", context: stay.context, depot: "1" },
      { stayId: stay.id, forecast: "1", context: stay.context, handover: "2026-11-05" },
      { stayId: stay.id, forecast: "true", context: stay.context },
      { tripId: "trip-open", forecast: "1", context: stay.context },
    ]
    for (const query of queries) assert.equal((await read(db, query)).status, 400, JSON.stringify(query))
  })
  it("contexte périmé refusé 409 ; session d'une autre société : refus, aucun itinéraire ni prix demandé", async () => {
    const db = edgeHandover()
    const [stay] = await listFor(db)
    const stale = await read(db, { stayId: stay.id, forecast: "1", context: "v1-0123456789abcdef" })
    assert.deepEqual([stale.status, (await stale.json()).code], [409, "STAY_CONTEXT_CHANGED"])
    const provider = fakeFetch()
    const foreign = await read(db, { stayId: stay.id, forecast: "1", context: stay.context }, ADMIN, provider.fn)
    assert.ok(foreign.status >= 400 && foreign.status < 500, String(foreign.status))
    assert.deepEqual(provider.calls, [])
  })
  it("séjour sans historique d'affectation : refusé aussi en prévision (409 STAY_NO_HISTORY)", async () => {
    const db = new FuelDb()
    db.periods = []
    db.inner.state.trucks.find((t) => t.id === GALYA_TRUCK)!.teamId = "team-g"
    const [stay] = await listFor(db)
    const response = await read(db, { stayId: stay.id, forecast: "1", context: stay.context })
    assert.deepEqual([response.status, (await response.json()).code], [409, "STAY_NO_HISTORY"])
  })
})
