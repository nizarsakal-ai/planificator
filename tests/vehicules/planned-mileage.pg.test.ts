/**
 * Kilométrage prévu sur un vrai PostgreSQL jetable (migrations appliquées), réseau IGN simulé.
 * PLANNED_MILEAGE_TEST_DATABASE_URL=postgresql://pm_test:…@127.0.0.1:55441/planned_mileage_test
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { MileageDomainError } from "../../src/lib/vehicules/mileage-domain"
import { readPlannedMileage } from "../../src/lib/vehicules/planned-mileage-service"

function databaseUrl() {
  const value = process.env.PLANNED_MILEAGE_TEST_DATABASE_URL
  if (!value) throw new Error("PLANNED_MILEAGE_TEST_DATABASE_URL required")
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55441"
    || url.pathname !== "/planned_mileage_test" || url.username !== "pm_test" || url.search || url.hash)
    throw new Error("Only the disposable local planned-mileage database is permitted")
  return value
}

const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } })
after(() => db.$disconnect())
const GALYA = "cmvl0yv6q000ye4yjxs2mggy8"
const env = { PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED: "true" }
const day = (value: string) => new Date(`${value}T00:00:00Z`)
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })

async function seed() {
  const run = randomUUID().slice(0, 8)
  // Relançable : les distances d'un passage précédent ne doivent pas masquer les appels réseau.
  await db.$executeRaw`DELETE FROM "vehicle_cartography_cache" WHERE "companyId" = ${GALYA}`
  await db.company.upsert({ where: { id: GALYA }, update: {}, create: { id: GALYA, name: "GALYA EVENTS (test local)", slug: `galya-test-${run}` } })
  const other = await db.company.create({ data: { name: `Autre ${run}`, slug: `autre-${run}` } })
  const person = async (label: string, role: "ADMIN" | "TEAM_LEADER") => {
    const user = await db.user.create({ data: { email: `${label}-${run}@example.test`, password: "local-test-unused", role: "EMPLOYEE", companyId: GALYA, name: label } })
    const employee = await db.employee.create({ data: { userId: user.id, companyId: GALYA, role, firstName: label, lastName: run } })
    return { user, employee }
  }
  const admin = await person("admin", "ADMIN")
  const bilel = await person("bilel", "TEAM_LEADER")
  const hassen = await person("hassen", "TEAM_LEADER")
  const teamBilel = await db.team.create({ data: { name: `BILEL ${run}`, companyId: GALYA, leaderId: bilel.employee.id } })
  const teamHassen = await db.team.create({ data: { name: `HASSEN ${run}`, companyId: GALYA, leaderId: hassen.employee.id } })
  const client = await db.client.create({ data: { name: `Client ${run}`, companyId: GALYA } })
  const worksite = (name: string, data: { address?: string; latitude?: number; longitude?: number }) =>
    db.worksite.create({ data: { name, companyId: GALYA, clientId: client.id, createdById: admin.user.id, ...data } })
  const lyon = await worksite("Salon Lyon", { address: "Place Bellecour 69002 Lyon", latitude: 45.757597, longitude: 4.831662 })
  const marseille = await worksite("Foire Marseille", { address: "Parc Chanot 13008 Marseille" })
  const noAddress = await worksite("Chantier sans adresse", {})
  const old = await worksite("Ancien chantier", { latitude: 48.8, longitude: 2.3 })
  const truck = await db.truck.create({ data: { companyId: GALYA, matricule: `FL-${run}`, teamId: teamHassen.id } })
  await db.truckAssignment.create({ data: { truckId: truck.id, companyId: GALYA, teamId: teamBilel.id, reason: "CREATED", startedAt: new Date("2026-11-01T07:00:00Z"), endedAt: new Date("2026-11-10T13:00:00Z") } })
  await db.truckAssignment.create({ data: { truckId: truck.id, companyId: GALYA, teamId: teamHassen.id, reason: "REASSIGNED", startedAt: new Date("2026-11-10T13:00:00Z") } })
  const plan = (teamId: string, worksiteId: string, date: string, status: "CONFIRMED" | "PENDING" | "REFUSED" = "CONFIRMED") =>
    db.assignment.create({ data: { teamId, worksiteId, date: day(date), status, ...(status === "REFUSED" ? { refusalReason: "test" } : {}) } })
  await plan(teamBilel.id, lyon.id, "2026-11-03")
  await plan(teamBilel.id, lyon.id, "2026-11-04", "PENDING")
  await plan(teamBilel.id, marseille.id, "2026-11-10")
  await plan(teamBilel.id, lyon.id, "2026-11-12") // le camion est passé à Hassen
  await plan(teamHassen.id, noAddress.id, "2026-11-20")
  await plan(teamHassen.id, lyon.id, "2026-11-21", "REFUSED")
  await plan(teamHassen.id, old.id, "2026-09-15") // avant la création du camion
  const session = (id: string, role: string, companyId = GALYA) => async () => ({ user: { id, role, companyId } })
  return { truck, admin, bilel, hassen, other, lyon, marseille, session }
}

describe("kilométrage prévu — PostgreSQL local", () => {
  it("lit le planning réel, met les distances en cache et respecte les droits", async () => {
    const s = await seed()
    const requests: string[] = []
    const fetchFn = (async (raw: string) => {
      requests.push(raw)
      const url = new URL(raw)
      if (url.pathname.includes("geocodage"))
        return json({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [5.3936, 43.2681] }, properties: { score: 0.93 } }] })
      return json({ distance: url.searchParams.get("end")!.startsWith("4.83") ? 468.8 : 775.2, distanceUnit: "kilometer" })
    }) as typeof fetch
    const deps = { db, env, fetchFn, auth: s.session(s.admin.user.id, "ADMIN") }

    const report = await readPlannedMileage(s.truck.id, "2026-11", deps)
    assert.deepEqual(report.lines.map((l) => [l.worksiteName, l.days, l.firstDay, l.lastDay, l.roundTripKm, l.totalKm, l.source]), [
      ["Salon Lyon", 2, "2026-11-03", "2026-11-04", 938, 1138, "ROUTE"],
      ["Foire Marseille", 1, "2026-11-10", "2026-11-10", 1550, 1750, "ROUTE"],
    ])
    assert.deepEqual(report.unresolved.map((u) => [u.worksiteName, u.reason]), [["Chantier sans adresse", "ADDRESS_MISSING"]])
    assert.equal(report.totalKm, 2888)
    assert.equal(requests.length, 3) // itinéraire Lyon, géocodage + itinéraire Marseille

    const cached = await db.$queryRaw<{ ttl: boolean }[]>`
      SELECT "expiresAt" > clock_timestamp() + interval '29 days' AS ttl FROM "vehicle_cartography_cache" WHERE "companyId" = ${GALYA} AND "value"->>'source' = 'ROUTE'`
    assert.ok(cached.length >= 2 && cached.every((row) => row.ttl))
    const again = await readPlannedMileage(s.truck.id, "2026-11", deps)
    assert.equal(again.totalKm, 2888)
    assert.equal(requests.length, 3, "deuxième lecture servie par le cache")

    // Le camion n'existait pas en septembre : pas de repli sur l'équipe actuelle.
    assert.deepEqual((await readPlannedMileage(s.truck.id, "2026-09", deps)).lines, [])

    // Chef de l'équipe actuelle : lecture permise ; ancien chef : véhicule invisible.
    assert.equal((await readPlannedMileage(s.truck.id, "2026-11", { ...deps, auth: s.session(s.hassen.user.id, "TEAM_LEADER") })).totalKm, 2888)
    await assert.rejects(readPlannedMileage(s.truck.id, "2026-11", { ...deps, auth: s.session(s.bilel.user.id, "TEAM_LEADER") }),
      (e) => e instanceof MileageDomainError && e.code === "TRUCK_NOT_FOUND")
    // Autre société : refus avant toute lecture.
    await assert.rejects(readPlannedMileage(s.truck.id, "2026-11", { ...deps, auth: s.session(s.admin.user.id, "ADMIN", s.other.id) }),
      (e) => e instanceof MileageDomainError && e.code === "DEPOT_NOT_CONFIGURED")
  })
})
