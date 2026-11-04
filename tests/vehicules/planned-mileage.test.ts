import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PrismaClient } from "@prisma/client"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import {
  PLANNED_MILEAGE_DEPOT, crowFlightKm, isPlannedMileageEnabled, parsePlannedMonth, plannedTripKm, resolvePlannedWorksites,
  type PlannedWorksite,
} from "@/lib/vehicules/planned-mileage-domain"
import { ignGeocode, ignRouteKm } from "@/lib/vehicules/planned-mileage-ign"
import { buildPlannedMileage, cachedDistanceResolver, readPlannedMileage } from "@/lib/vehicules/planned-mileage-service"
import { GET } from "@/app/api/trucks/[id]/planned-mileage/route"

const site = (id: string, over: Partial<PlannedWorksite> = {}): PlannedWorksite =>
  ({ id, name: `Chantier ${id}`, address: `${id} rue de Lyon 69000 Lyon`, latitude: 45.764, longitude: 4.8357, ...over })
const day = (value: string) => new Date(`${value}T00:00:00Z`)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
async function rejectsCode(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (error) => error instanceof MileageDomainError && error.code === code && error.status === status)
}

describe("kilométrage prévu — règle pure", () => {
  it("prend le mois civil parisien par défaut et refuse un mois invalide", () => {
    assert.equal(parsePlannedMonth(null, new Date("2026-10-31T23:30:00Z")).month, "2026-11")
    const period = parsePlannedMonth("2026-12")
    assert.equal(period.start.toISOString(), "2026-12-01T00:00:00.000Z")
    assert.equal(period.end.toISOString(), "2027-01-01T00:00:00.000Z")
    for (const raw of ["2026-13", "2026-1", "nov", "1999-01"]) assert.throws(() => parsePlannedMonth(raw), /INVALID_MONTH|Mileage/)
  })

  it("ne compte que les jours où l'équipe avait le camion, regroupés par chantier", () => {
    const periods = [
      { teamId: "bilel", startedAt: new Date("2026-11-01T08:00:00Z"), endedAt: new Date("2026-11-10T14:00:00Z") },
      { teamId: null, startedAt: new Date("2026-11-10T14:00:00Z"), endedAt: new Date("2026-11-12T09:00:00Z") },
      { teamId: "hassen", startedAt: new Date("2026-11-12T09:00:00Z"), endedAt: null },
    ]
    const groups = resolvePlannedWorksites([
      { date: day("2026-11-03"), teamId: "bilel", worksite: site("a") },
      { date: day("2026-11-04"), teamId: "bilel", worksite: site("a") },
      { date: day("2026-11-10"), teamId: "bilel", worksite: site("b") }, // jour de réaffectation : compté
      { date: day("2026-11-11"), teamId: "bilel", worksite: site("b") }, // le camion n'est plus à Bilel
      { date: day("2026-11-11"), teamId: "hassen", worksite: site("c") }, // pas encore à Hassen
      { date: day("2026-11-20"), teamId: "hassen", worksite: site("c") },
      { date: day("2026-11-25"), teamId: "autre", worksite: site("d") },
    ], periods)
    assert.deepEqual(groups.map((g) => [g.worksite.id, g.days]), [
      ["a", ["2026-11-03", "2026-11-04"]], ["b", ["2026-11-10"]], ["c", ["2026-11-20"]],
    ])
  })

  it("double l'aller simple, arrondit au kilomètre et ajoute 200 km à chaque calcul", () => {
    assert.deepEqual(plannedTripKm(466.84), { roundTripKm: 934, marginKm: 200, totalKm: 1134 })
    assert.deepEqual(plannedTripKm(0), { roundTripKm: 0, marginKm: 200, totalKm: 200 })
    assert.throws(() => plannedTripKm(Number.NaN))
  })

  it("part du centre de Montreuil et estime le vol d'oiseau", () => {
    assert.equal(PLANNED_MILEAGE_DEPOT.label, "Siège · Montreuil centre")
    const lyon = crowFlightKm(PLANNED_MILEAGE_DEPOT, { latitude: 45.764, longitude: 4.8357 })
    assert.ok(lyon > 385 && lyon < 400, String(lyon))
  })

  it("reste désactivé sans drapeau explicite", () => {
    assert.equal(isPlannedMileageEnabled({}), false)
    assert.equal(isPlannedMileageEnabled({ PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED: "1" }), false)
    assert.equal(isPlannedMileageEnabled({ PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED: " true " }), true)
  })
})

describe("kilométrage prévu — Géoplateforme IGN", () => {
  it("demande un itinéraire voiture départ → chantier et lit la distance en km", async () => {
    let requested = ""
    const km = await ignRouteKm(PLANNED_MILEAGE_DEPOT, { latitude: 45.764, longitude: 4.8357 }, (async (url: string) => {
      requested = url
      return json({ distance: 466.8, distanceUnit: "kilometer" })
    }) as typeof fetch)
    assert.equal(km, 466.8)
    const url = new URL(requested)
    assert.equal(url.origin + url.pathname, "https://data.geopf.fr/navigation/itineraire")
    assert.equal(url.searchParams.get("resource"), "bdtopo-valhalla")
    assert.equal(url.searchParams.get("profile"), "car")
    assert.equal(url.searchParams.get("start"), "2.449364,48.863728")
    assert.equal(url.searchParams.get("end"), "4.8357,45.764")
  })

  it("refuse une distance absente ou un service saturé", async () => {
    const to = { latitude: 45.764, longitude: 4.8357 }
    await rejectsCode(ignRouteKm(PLANNED_MILEAGE_DEPOT, to, (async () => json({ distance: "466" , distanceUnit: "kilometer" })) as typeof fetch), "INVALID_ROUTE_DISTANCE", 502)
    await rejectsCode(ignRouteKm(PLANNED_MILEAGE_DEPOT, to, (async () => json({}, 429)) as typeof fetch), "ROUTING_UNAVAILABLE", 429)
    await rejectsCode(ignRouteKm(PLANNED_MILEAGE_DEPOT, to, (async () => { throw new Error("réseau") }) as typeof fetch), "ROUTING_UNAVAILABLE", 503)
  })

  it("géocode une adresse et ignore un résultat peu fiable", async () => {
    const feature = (score: number) => json({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [4.8357, 45.764] }, properties: { score } }] })
    assert.deepEqual(await ignGeocode("1 rue de Lyon 69000 Lyon", (async () => feature(0.9)) as typeof fetch), { latitude: 45.764, longitude: 4.8357 })
    assert.equal(await ignGeocode("1 rue de Lyon 69000 Lyon", (async () => feature(0.3)) as typeof fetch), null)
    assert.equal(await ignGeocode("1 rue de Lyon", (async () => json({ type: "FeatureCollection", features: [] })) as typeof fetch), null)
  })
})

/** Double minimal de PrismaClient pour le cache : SQL brut et quota. */
class CacheDb {
  cache = new Map<string, { value: unknown; ttl: string }>()
  quotaCalls = 0
  $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?")
    if (sql.includes("vehicle_import_provider_windows")) { this.quotaCalls++; return [{ count: 1 }] }
    const hit = this.cache.get(values[0] as string)
    return hit ? [{ value: hit.value }] : []
  }
  $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("INSERT INTO \"vehicle_cartography_cache\""))
      this.cache.set(values[0] as string, { value: JSON.parse(values[2] as string), ttl: values[3] as string })
    return 1
  }
  $transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(this)
  asClient() { return this as unknown as PrismaClient }
}

describe("kilométrage prévu — cache et repli", () => {
  it("met l'itinéraire en cache 30 jours puis le relit sans appel réseau", async () => {
    const db = new CacheDb()
    let calls = 0
    const fetchFn = (async () => { calls++; return json({ distance: 466.8, distanceUnit: "kilometer" }) }) as typeof fetch
    const resolve = cachedDistanceResolver(db.asClient(), "galya", fetchFn)
    assert.deepEqual(await resolve(site("a")), { oneWayKm: 466.8, source: "ROUTE" })
    assert.deepEqual(await resolve(site("a")), { oneWayKm: 466.8, source: "ROUTE" })
    assert.equal(calls, 1)
    assert.equal([...db.cache.values()][0].ttl, "30 days")
  })

  it("se replie sur le vol d'oiseau × 1,3, mis en cache une heure seulement", async () => {
    const db = new CacheDb()
    const resolve = cachedDistanceResolver(db.asClient(), "galya", (async () => json({}, 503)) as typeof fetch)
    const result = await resolve(site("a"))
    assert.ok("source" in result && result.source === "ESTIMATE")
    assert.ok("oneWayKm" in result && result.oneWayKm > 500 && result.oneWayKm < 520)
    assert.equal([...db.cache.values()][0].ttl, "1 hour")
  })

  it("géocode un chantier sans coordonnées et signale une adresse manquante", async () => {
    const db = new CacheDb()
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return url.includes("geocodage")
        ? json({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [4.8357, 45.764] }, properties: { score: 0.95 } }] })
        : json({ distance: 466.8, distanceUnit: "kilometer" })
    }) as typeof fetch
    const resolve = cachedDistanceResolver(db.asClient(), "galya", fetchFn)
    assert.deepEqual(await resolve(site("a", { latitude: null, longitude: null })), { oneWayKm: 466.8, source: "ROUTE" })
    assert.equal(urls.length, 2)
    assert.equal(db.quotaCalls, 2)
    assert.deepEqual(await resolve(site("b", { latitude: null, longitude: null, address: "  " })), { unresolved: "ADDRESS_MISSING" })
  })
})

describe("kilométrage prévu — rapport et route", () => {
  it("additionne les chantiers résolus et isole ceux sans adresse", async () => {
    const report = await buildPlannedMileage("truck-1", "2026-11", [
      { worksite: site("a"), days: ["2026-11-03", "2026-11-04"] },
      { worksite: site("b", { address: null, latitude: null, longitude: null }), days: ["2026-11-10"] },
      { worksite: site("c"), days: ["2026-11-20"] },
    ], async (w) => w.id === "b" ? { unresolved: "ADDRESS_MISSING" } : { oneWayKm: w.id === "a" ? 466.84 : 12.3, source: w.id === "a" ? "ROUTE" : "ESTIMATE" })
    assert.deepEqual(report.lines.map((l) => [l.worksiteId, l.days, l.firstDay, l.lastDay, l.roundTripKm, l.totalKm, l.source]), [
      ["a", 2, "2026-11-03", "2026-11-04", 934, 1134, "ROUTE"],
      ["c", 1, "2026-11-20", "2026-11-20", 25, 225, "ESTIMATE"],
    ])
    assert.deepEqual(report.unresolved, [{ worksiteId: "b", worksiteName: "Chantier b", days: 1, reason: "ADDRESS_MISSING" }])
    assert.equal(report.totalKm, 1359)
    assert.equal(report.depot, "Siège · Montreuil centre")
  })

  it("répond 404 drapeau éteint, sans lire la session ni la base", async () => {
    let touched = false
    const deps = { auth: async () => { touched = true; return null }, db: {} as PrismaClient, env: {} }
    await rejectsCode(readPlannedMileage("truck-1", null, deps), "FEATURE_DISABLED", 404)
    const response = await GET(new Request("https://vehicles-tests.invalid/api/trucks/truck-1/planned-mileage"), { params: Promise.resolve({ id: "truck-1" }) }, deps)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, "FEATURE_DISABLED")
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    assert.equal(touched, false)
  })

  it("exige une session autorisée drapeau allumé", async () => {
    const deps = { auth: async () => ({ user: { id: "u", role: "EMPLOYEE", companyId: "galya" } }), db: {} as PrismaClient, env: { PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED: "true" } }
    await rejectsCode(readPlannedMileage("truck-1", null, deps), "FORBIDDEN", 403)
  })
})
