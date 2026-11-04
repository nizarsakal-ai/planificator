/**
 * Véhicules V3 — estimation carburant d'un trajet : géométrie du couloir, calcul, sources publiques (réponses factices),
 * service (drapeau, droits, entreprise, kilomètres compteur ou itinéraire, stations, cache, quota, aucune écriture métier)
 * et fusion dans le formulaire. Données entièrement synthétiques ; aucun appel réseau réel.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import type { Prisma } from "@prisma/client"
import { GET as estimateGet } from "@/app/api/trucks/[id]/fuel-estimate/route"
import {
  distanceToPolylineKm, estimateFuel, estimateNote, haversineKm, parseConsumption, polylineKm, priceStats, rankStations, resolveStays, samplePolyline,
  type FuelEstimate, type FuelStation, type PlannedStay, type Point,
} from "@/lib/vehicules/v3/fuel-estimate-domain"
import { ignRouteGeometry, stationsInCorridor } from "@/lib/vehicules/v3/fuel-estimate-providers"
import type { FuelEstimateDeps } from "@/lib/vehicules/v3/fuel-estimate-service"
import { defaultPriceKey, mergeExpenseValues, priceChoice, priceWarnings, proposedExpenseValues, stationsLabel, stayDetails, stayLabel } from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
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
      "Estimation trajet : 27 km (compteur) × 9,5 L/100 km × 2,250 €/L Gazole (1 RUE FICTIVE, Exempleville, prix du 04/11/2026). À remplacer par le montant du ticket.")
  })
  it("séjours : jours consécutifs = un départ et un retour ; interruption = nouveau séjour ; équipe sans le camion ignorée ; chauffeur du jour du départ", () => {
    const ws = { id: "ws-1", name: "Chantier fictif", address: "1 rue Fictive" }
    const a = (date: string, teamId = "team-1", worksite = ws) => ({ date, teamId, worksite })
    const periods = [{ teamId: "team-1", chauffeurId: "drv-1", from: "2026-11-01", to: "2026-11-05" }, { teamId: "team-1", chauffeurId: "drv-2", from: "2026-11-06", to: null }]
    const stays = resolveStays([a("2026-11-04"), a("2026-11-06"), a("2026-11-05"), a("2026-11-10"), a("2026-11-04", "team-2")], periods)
    assert.deepEqual(stays.map((s) => [s.id, s.departure, s.return, s.days, s.chauffeurId]), [
      ["ws-1~team-1~2026-11-10", "2026-11-10", "2026-11-10", 1, "drv-2"],
      ["ws-1~team-1~2026-11-04", "2026-11-04", "2026-11-06", 3, "drv-1"],
    ])
    assert.equal(resolveStays([a("2026-10-30")], periods).length, 0)
  })
  it("statistiques de prix : médiane paire et impaire, liste vide", () => {
    assert.deepEqual(priceStats([{ price: 2.3 }, { price: 2.1 }, { price: 2.25 }]), { count: 3, min: 2.1, median: 2.25, max: 2.3 })
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
    const stations = await stationsInCorridor(samples, radiusKm, route, "GAZOLE", async (u) => { url = String(u); return json({ results: [
      priceRow(93100001, 2.25, route[3]), priceRow(75020002, 2.199, route[12]), priceRow(1, 2.1, route[5]), priceRow(93100003, 99, route[5]),
      priceRow(93100004, 2.2, far), priceRow(93100005, 2.2, route[6], { gazole_maj: "pas une date" }), { id: "x" },
    ] }) })
    const where = new URL(url).searchParams.get("where")!
    assert.equal((where.match(/within_distance/g) ?? []).length, samples.length)
    assert.match(where, /gazole_prix IS NOT NULL$/)
    assert.equal(new URL(url).searchParams.get("order_by"), "gazole_prix")
    assert.deepEqual(stations.map((s) => s.id).sort(), ["75020002", "93100001"])
    assert.ok(stations.every((s) => s.offRouteKm <= 0.1 && s.open24h))
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
  periods = [{ truckId: "truck-g", companyId: "cmvl0yv6q000ye4yjxs2mggy8", teamId: "team-g", chauffeurId: "emp-driver", startedAt: at("2026-10-01T00:00:00Z"), endedAt: null as Date | null }]
  assignments = ["2026-11-04", "2026-11-05", "2026-11-06"].map((d) => ({ date: at(`${d}T00:00:00Z`), teamId: "team-g", status: "PENDING", worksiteId: "ws-1", companyId: "cmvl0yv6q000ye4yjxs2mggy8" }))
  teams = [{ id: "team-g", companyId: "cmvl0yv6q000ye4yjxs2mggy8", name: "BILEL A COMPO", leaderId: "emp-leader" }]
  people = [{ id: "emp-leader", companyId: "cmvl0yv6q000ye4yjxs2mggy8", firstName: "Bilel", lastName: "Exemple" }, { id: "emp-driver", companyId: "cmvl0yv6q000ye4yjxs2mggy8", firstName: "Riadh", lastName: "Exemple" }]
  entries: Record<string, unknown>[] = []
  worksites = [{ id: "ws-1", companyId: GALYA, name: "Chantier fictif", address: "1 rue Fictive 75000 Paris", latitude: PARIS.latitude, longitude: PARIS.longitude },
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
        assignment: { findMany: async ({ where }: { where: { teamId: { in: string[] }; date: { gte: Date; lte: Date }; team: { companyId: string }; worksite: { companyId: string; id?: string } } }) =>
          this.assignments.filter((a) => where.teamId.in.includes(a.teamId) && a.date >= where.date.gte && a.date <= where.date.lte && a.companyId === where.worksite.companyId && (!where.worksite.id || a.worksiteId === where.worksite.id))
            .map((a) => ({ date: a.date, teamId: a.teamId, worksite: (({ id, name, address }) => ({ id, name, address }))(this.worksites.find((w) => w.id === a.worksiteId)!) })) },
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
  it("trajet en cours : aller-retour routier ; chantier sans coordonnées : géocodé (quota)", async () => {
    const db = new FuelDb()
    const open = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-open" }), params(GALYA_TRUCK), depsFor(db))).json() as FuelEstimate
    assert.deepEqual([open.km, open.kmSource, open.odometer], [27, "ROUTE_ROUND_TRIP", 120_027])
    const net = fakeFetch()
    const geo = await (await estimateGet(request(GALYA_TRUCK, { tripId: "trip-geocode" }), params(GALYA_TRUCK), depsFor(new FuelDb(), GALYA_ADMIN, net.fn))).json() as FuelEstimate
    assert.equal(geo.route.status, "ROUTE"); assert.ok(net.calls.some((u) => u.includes("/geocodage/")))
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
    const { stays } = await response.json() as { stays: PlannedStay[] }
    assert.deepEqual(stays.map((s) => [s.id, s.worksiteName, s.departure, s.return, s.days, s.teamName, s.leaderName, s.chauffeurName]),
      [["ws-1~team-g~2026-11-04", "Chantier fictif", "2026-11-04", "2026-11-06", 3, "BILEL A COMPO", "Bilel Exemple", "Riadh Exemple"]])
    assert.deepEqual(businessWrites(db), [])
  })
  it("estimation d'un séjour : aller-retour siège → chantier, date de départ, pas de compteur ; identifiant forgé : 404", async () => {
    const db = new FuelDb()
    const body = await (await estimateGet(request(GALYA_TRUCK, { stayId: "ws-1~team-g~2026-11-04" }), params(GALYA_TRUCK), depsFor(db))).json() as FuelEstimate
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
    const body = await (await estimateGet(request(GALYA_TRUCK, { stayId: "ws-1~team-g~2026-11-04" }), params(GALYA_TRUCK), depsFor(db, GALYA_ADMIN, fn))).json() as FuelEstimate
    assert.equal(body.km, 1267)
    assert.equal(priceCalls, 4)
    assert.deepEqual(body.priceStats, { count: 4, min: 2.11, median: 2.125, max: 2.14 })
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
  route: { status: "ROUTE", oneWayKm: 13.5 }, fuel: "GAZOLE", stations: [station()], stationsStatus: "ROUTE_CORRIDOR", ...over })

describe("formulaire : préremplissage selon le trajet", () => {
  it("valeurs proposées : catégorie, date du trajet, compteur, station, litres, montant et note", () => {
    assert.deepEqual(proposedExpenseValues(estimate(), { kind: "STATION", station: station() }, 9.5), {
      category: "FUEL", date: "2026-11-03", mileage: "120027", supplier: "1 RUE FICTIVE, Exempleville", amount: "5,77", litres: "2,565",
      notes: "Estimation trajet : 27 km (compteur) × 9,5 L/100 km × 2,250 €/L Gazole (1 RUE FICTIVE, Exempleville, prix du 04/11/2026). À remplacer par le montant du ticket.",
    })
    assert.deepEqual(Object.keys(proposedExpenseValues(estimate(), { kind: "STATION", station: station() }, null)).sort(), ["category", "date", "mileage", "supplier"])
    assert.equal(proposedExpenseValues(estimate({ km: null, kmSource: null }), { kind: "STATION", station: station() }, 9.5).amount, undefined)
  })
  it("automatique : jamais sur un champ saisi ; explicite : tout ; note d'estimation remplacée, notes de l'opérateur conservées", () => {
    const proposed = proposedExpenseValues(estimate(), { kind: "STATION", station: station() }, 9.5)
    const auto = mergeExpenseValues({ notes: "" }, proposed, new Set(["amount", "supplier"]), false)
    assert.equal(auto.amount, undefined); assert.equal(auto.supplier, undefined); assert.equal(auto.litres, "2,565")
    const explicit = mergeExpenseValues({ notes: "Payé en carte\nEstimation trajet : ancienne" }, proposed, new Set(["amount", "notes"]), true)
    assert.equal(explicit.amount, "5,77")
    assert.equal(explicit.notes, `Payé en carte\n${proposed.notes}`)
  })
  it("messages : zone de recherche, prix ancien, trajet ancien", () => {
    assert.match(stationsLabel("ROUTE_CORRIDOR", 3), /^3 stations sur le trajet/)
    assert.match(stationsLabel("UNAVAILABLE", 0), /indisponibles/)
    assert.deepEqual(priceWarnings(estimate({ tripDate: "2026-10-01" }), station({ updatedAt: "2026-10-20T00:00:00.000Z" }), "2026-11-04").length, 2)
    assert.deepEqual(priceWarnings(estimate(), station(), "2026-11-04"), [])
    assert.match(priceWarnings(estimate({ tripDate: "2026-11-20" }), null, "2026-11-04")[0], /Départ à venir/)
  })
  it("séjour : prix médian par défaut, km sur place ajoutés, note avec chantier et dates, aucun fournisseur inventé", () => {
    const stay: PlannedStay = { id: "ws-1~team-g~2026-11-04", worksiteId: "ws-1", worksiteName: "Chantier fictif Montauban", hasAddress: true, teamId: "team-g", teamName: "BILEL A COMPO",
      leaderName: "Bilel Exemple", chauffeurName: "Riadh Exemple", departure: "2026-11-04", return: "2026-11-06", days: 3 }
    const e = estimate({ source: "STAY", stay, km: 1267, kmSource: "STAY_ROUND_TRIP", odometer: null, tripDate: "2026-11-04", priceStats: { count: 123, min: 2.115, median: 2.25, max: 2.563 } })
    assert.equal(defaultPriceKey(e), "MEDIAN")
    const values = proposedExpenseValues(e, priceChoice(e, "MEDIAN", "2026-11-04"), 10, 40)
    assert.deepEqual([values.date, values.amount, values.litres, values.supplier, values.mileage], ["2026-11-04", "294,08", "130,7", undefined, undefined])
    assert.equal(values.notes, "Estimation trajet : chantier Chantier fictif Montauban (départ 04/11/2026, retour 06/11/2026) 1267 km (itinéraire aller-retour) + 40 km sur place × 10,0 L/100 km × 2,250 €/L Gazole (prix médian de 123 stations du trajet au 04/11/2026). À remplacer par le montant du ticket.")
    assert.match(stayLabel(stay), /^Chantier fictif Montauban — départ 04\/11\/2026, retour 06\/11\/2026 \(3 jours\) — BILEL A COMPO$/)
    assert.match(stayDetails(stay)[1], /chef d'équipe : Bilel Exemple · chauffeur : Riadh Exemple/)
  })
})
