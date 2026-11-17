import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { fixture } from "../pg/fixtures"
import { commandTour, createTour, readTours } from "../../../src/lib/vehicules/v3/tour-service"
import { recalculateTourKmNow, refreshTourAutoKm, runTourKmAutoRefresh } from "../../../src/lib/vehicules/v3/tour-km-auto-service"

const url = process.env.TOURS_DATABASE_URL
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).port !== "55433" || new URL(url).pathname !== "/v3_tours_test")
  throw new Error("Only disposable local v3_tours_test accepted")
const db = new PrismaClient({ datasources: { db: { url } } })
process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"

const DEPOT = { latitude: 48.86, longitude: 2.45 }
const SITE_A = { latitude: 43.25, longitude: 2.17 } // Alzonne
const SITE_B = { latitude: 43.13, longitude: 1.58 } // Saverdun

/** IGN simulé : géocodage du dépôt, itinéraire = distance fixe par paire de points. */
function fakeIgn(opts: { routing?: "ok" | "down"; onCall?: () => Promise<void> } = {}) {
  const calls = { geocode: 0, route: 0 }
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input))
    if (opts.onCall) await opts.onCall()
    if (u.pathname.includes("geocodage")) {
      calls.geocode++
      return Response.json({ type: "FeatureCollection", features: [{ geometry: { type: "Point", coordinates: [DEPOT.longitude, DEPOT.latitude] }, properties: { score: 0.95 } }] })
    }
    calls.route++
    if (opts.routing === "down") return new Response("unavailable", { status: 503 })
    const [start, end] = [u.searchParams.get("start")!, u.searchParams.get("end")!]
    const key = [start, end].sort().join("|")
    const a = `${SITE_A.longitude},${SITE_A.latitude}`, b = `${SITE_B.longitude},${SITE_B.latitude}`, d = `${DEPOT.longitude},${DEPOT.latitude}`
    const km = key === [d, a].sort().join("|") ? 800 : key === [a, b].sort().join("|") ? 60 : key === [d, b].sort().join("|") ? 780 : 1
    return Response.json({ distance: km, distanceUnit: "kilometer" })
  }) as typeof fetch
  return { fetchFn, calls }
}

const stop = (label: string, p: { latitude: number; longitude: number }) => ({ label, address: `${label} adresse`, latitude: p.latitude, longitude: p.longitude, addressValidated: true as const })

async function setup() {
  const f = await fixture(db)
  await db.company.update({ where: { id: f.company.id }, data: { address: "10 rue du Dépôt, 93100 Montreuil" } })
  return f
}

test("km automatiques : calculés après création, inchangés sans changement, recalculés après modification", async () => {
  const f = await setup(), deps = f.deps()
  const body = { title: "Alzonne", startsAt: "2028-03-01T07:00:00+01:00", endsAt: "2028-03-01T19:00:00+01:00", teamId: null, chauffeurId: null, estimatedKm: null, stops: [stop("Mairie d'Alzonne", SITE_A)] }
  const created = await createTour(f.truck.id, body, randomUUID(), deps)
  assert.equal(created.refreshAutoKm, true)
  let row = await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })
  assert.deepEqual([row.estimatedKmSource, row.estimatedKm], ["AUTO", null])

  const ign = fakeIgn()
  const first = await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn })
  // 800 + 800 + 10 km de midi (1 jour de calendrier, aucune affectation) = 1 610 km.
  assert.deepEqual(first, { outcome: "UPDATED", estimatedKm: 1610 })
  row = await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })
  assert.equal(row.estimatedKm, 1610)
  assert.equal(row.revision, 1, "un recalcul ne change pas la révision : aucun formulaire ouvert n'est invalidé")
  assert.ok(row.estimatedKmInputHash && !row.estimatedKmInputHash.startsWith("retry:"))
  assert.ok(row.estimatedKmComputedAt)
  assert.equal((row.estimatedKmDetail as { lines: unknown[] }).lines.length, 3)

  // Rien n'a changé : aucun appel réseau.
  const before = { ...ign.calls }
  assert.equal((await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn })).outcome, "UNCHANGED")
  assert.deepEqual(ign.calls, before)

  // Ajout d'une étape (Saverdun) : la modification garde le calcul automatique et le relance.
  const edited = await commandTour(f.truck.id, created.id, { type: "EDIT", expectedRevision: 1, title: "Alzonne + Saverdun", startsAt: body.startsAt, endsAt: body.endsAt, estimatedKm: 1610, stops: [stop("Mairie d'Alzonne", SITE_A), stop("LAURALU Saverdun", SITE_B)], reason: "Ajout de Saverdun" }, randomUUID(), deps)
  assert.equal(edited.refreshAutoKm, true)
  assert.equal((await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })).estimatedKmSource, "AUTO")
  const second = await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn })
  assert.deepEqual(second, { outcome: "UPDATED", estimatedKm: 800 + 60 + 780 + 10 })

  // Saisie manuelle : plus jamais recalculée, même forcée par le passage de nuit.
  await commandTour(f.truck.id, created.id, { type: "DETAILS", expectedRevision: 2, title: "Alzonne + Saverdun", estimatedKm: 1700, reason: "Kilométrage du chauffeur" }, randomUUID(), deps)
  assert.equal((await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn }, { force: true })).outcome, "SKIPPED")
  row = await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })
  assert.deepEqual([row.estimatedKmSource, row.estimatedKm], ["MANUAL", 1700])
  await assert.rejects(recalculateTourKmNow(f.truck.id, created.id, { db, auth: deps.auth, fetchFn: ign.fetchFn }), /TOUR_KM_MANUAL/)

  // Retour au calcul automatique depuis l'écran.
  const back = await commandTour(f.truck.id, created.id, { type: "DETAILS", expectedRevision: 3, title: "Alzonne + Saverdun", estimatedKm: null, estimatedKmAuto: true, reason: "Retour au calcul automatique des kilomètres" }, randomUUID(), deps)
  assert.equal(back.refreshAutoKm, true)
  assert.deepEqual(await recalculateTourKmNow(f.truck.id, created.id, { db, auth: deps.auth, fetchFn: ign.fetchFn }), { outcome: "UPDATED", estimatedKm: 1650 })
  // Manuel → auto par une modification qui ne change ni étapes ni dates : l'ancienne empreinte ne doit pas
  // faire passer la valeur manuelle pour un calcul à jour.
  await commandTour(f.truck.id, created.id, { type: "DETAILS", expectedRevision: 4, title: "Alzonne + Saverdun", estimatedKm: 1234, reason: "Saisie manuelle" }, randomUUID(), deps)
  const stops = (await db.vehicleTourStop.findMany({ where: { tourId: created.id }, orderBy: { position: "asc" } })).map((s) => ({ label: s.label, address: s.address, latitude: s.latitude, longitude: s.longitude, addressValidated: true as const }))
  const toAuto = await commandTour(f.truck.id, created.id, { type: "EDIT", expectedRevision: 5, title: "Alzonne + Saverdun", startsAt: body.startsAt, endsAt: body.endsAt, estimatedKm: null, estimatedKmAuto: true, stops, reason: "Retour au calcul automatique" }, randomUUID(), deps)
  assert.equal(toAuto.refreshAutoKm, true)
  assert.deepEqual(await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn }), { outcome: "UPDATED", estimatedKm: 1650 })
  await assert.rejects(recalculateTourKmNow(f.otherTruck.id, created.id, { db, auth: deps.auth, fetchFn: ign.fetchFn }), /TRUCK_NOT_FOUND/)
  await assert.rejects(recalculateTourKmNow(f.truck.id, created.id, { db, auth: async () => f.session(f.company.id, f.user.id, "TEAM_LEADER"), fetchFn: ign.fetchFn }), /FORBIDDEN/)
})

test("km automatiques : une modification pendant le calcul gagne toujours", async () => {
  const f = await setup(), deps = f.deps()
  const created = await createTour(f.truck.id, { title: "Course", startsAt: "2028-04-01T07:00:00Z", endsAt: "2028-04-01T19:00:00Z", teamId: null, chauffeurId: null, stops: [stop("Alzonne", SITE_A)] }, randomUUID(), deps)
  let edited = false
  const ign = fakeIgn({
    onCall: async () => {
      if (edited) return
      edited = true
      await commandTour(f.truck.id, created.id, { type: "DETAILS", expectedRevision: 1, title: "Course", estimatedKm: 999, reason: "Saisie pendant le calcul" }, randomUUID(), deps)
    },
  })
  assert.equal((await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: ign.fetchFn })).outcome, "SKIPPED")
  const row = await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })
  assert.deepEqual([row.estimatedKmSource, row.estimatedKm, row.estimatedKmComputedAt], ["MANUAL", 999, null])
})

test("km automatiques : itinéraire indisponible = estimation approximative reprise ; dépôt inconnu = échec enregistré", async () => {
  const f = await setup(), deps = f.deps()
  const created = await createTour(f.truck.id, { title: "Panne IGN", startsAt: "2028-05-01T07:00:00Z", endsAt: "2028-05-01T19:00:00Z", teamId: null, chauffeurId: null, stops: [stop("Alzonne", SITE_A)] }, randomUUID(), deps)
  const down = fakeIgn({ routing: "down" })
  const r = await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: down.fetchFn })
  assert.equal(r.outcome, "UPDATED")
  let row = await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })
  assert.ok(row.estimatedKmInputHash?.startsWith("retry:"), "approximatif : repris au prochain passage")
  assert.equal((row.estimatedKmDetail as { approximate: boolean }).approximate, true)
  // Prochain passage, IGN rétabli : recalcul exact (pas « inchangé »).
  assert.deepEqual(await refreshTourAutoKm({ companyId: f.company.id, tourId: created.id }, { db, fetchFn: fakeIgn().fetchFn }), { outcome: "UPDATED", estimatedKm: 1610 })

  const g = await fixture(db) // entreprise sans adresse : dépôt inconnu
  const other = await createTour(g.truck.id, { title: "Sans dépôt", startsAt: "2028-05-02T07:00:00Z", endsAt: "2028-05-02T19:00:00Z", teamId: null, chauffeurId: null, stops: [stop("Alzonne", SITE_A)] }, randomUUID(), g.deps())
  assert.deepEqual(await refreshTourAutoKm({ companyId: g.company.id, tourId: other.id }, { db, fetchFn: fakeIgn().fetchFn }), { outcome: "FAILED", errorCode: "DEPOT_UNKNOWN" })
  row = await db.vehicleTour.findUniqueOrThrow({ where: { id: other.id } })
  assert.equal(row.estimatedKm, null)
  assert.equal((row.estimatedKmDetail as { errorCode: string }).errorCode, "DEPOT_UNKNOWN")
  // Tenant : une tournée d'une autre entreprise n'est jamais lue.
  assert.equal((await refreshTourAutoKm({ companyId: f.company.id, tourId: other.id }, { db, fetchFn: fakeIgn().fetchFn })).outcome, "SKIPPED")
})

test("passage de nuit : borné, tolérant aux erreurs, tournées terminées figées", async () => {
  const f = await setup(), deps = f.deps()
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const c = await createTour(f.truck.id, { title: `Nuit ${i}`, startsAt: `2028-06-0${i + 1}T07:00:00Z`, endsAt: `2028-06-0${i + 1}T19:00:00Z`, teamId: null, chauffeurId: null, stops: [stop("Alzonne", SITE_A)] }, randomUUID(), deps)
    ids.push(c.id)
  }
  await commandTour(f.truck.id, ids[2], { type: "CANCEL", expectedRevision: 1 }, randomUUID(), deps)
  const ign = fakeIgn()
  const summary = await runTourKmAutoRefresh({ db, fetchFn: ign.fetchFn, limit: 500 })
  assert.equal(summary.errors, 0)
  for (const id of ids.slice(0, 2)) assert.equal((await db.vehicleTour.findUniqueOrThrow({ where: { id } })).estimatedKm, 1610)
  assert.equal((await db.vehicleTour.findUniqueOrThrow({ where: { id: ids[2] } })).estimatedKm, null, "tournée annulée : jamais calculée")
  const again = await runTourKmAutoRefresh({ db, fetchFn: ign.fetchFn, limit: 500 })
  assert.equal(again.updated, 0)
  // Budget de temps épuisé : arrêt propre, la suite au prochain passage.
  let t = 0
  const stopped = await runTourKmAutoRefresh({ db, fetchFn: ign.fetchFn, limit: 500, budgetMs: 10, now: () => new Date(Date.UTC(2028, 0, 1) + (t += 20)) })
  assert.equal(stopped.stoppedEarly, true)
})

test("tournée terminée : écart réel / estimé et carburant acheté pendant la tournée", async () => {
  const f = await setup(), deps = f.deps()
  const c = await createTour(f.truck.id, { title: "Alzonne", startsAt: "2028-07-01T05:00:00Z", endsAt: "2028-07-08T18:00:00Z", teamId: null, chauffeurId: null, stops: [stop("Alzonne", SITE_A)] }, randomUUID(), deps)
  await refreshTourAutoKm({ companyId: f.company.id, tourId: c.id }, { db, fetchFn: fakeIgn().fetchFn })
  const est = (await db.vehicleTour.findUniqueOrThrow({ where: { id: c.id } })).estimatedKm!
  assert.equal(est, 1680) // 800 + 800 + 8 jours × 10 km
  await commandTour(f.truck.id, c.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 100_000 }, randomUUID(), deps)
  const s = await db.vehicleTourStop.findFirstOrThrow({ where: { tourId: c.id } })
  await commandTour(f.truck.id, c.id, { type: "STOP", expectedRevision: 2, stopId: s.id }, randomUUID(), deps)
  for (const [day, litres] of [["2028-07-02", 95], ["2028-07-05", 90]] as const)
    await db.vehicleExpense.create({ data: { companyId: f.company.id, truckId: f.truck.id, category: "FUEL", occurredAt: new Date(`${day}T12:00:00Z`), amount: litres * 1.8, currency: "EUR", litres, mileageObservation: day === "2028-07-05" ? 101_200 : null, createdById: f.user.id } })
  await commandTour(f.truck.id, c.id, { type: "COMPLETE", expectedRevision: 3, expectedMileageRevision: 1, mileage: 102_400 }, randomUUID(), deps)
  // Une tournée terminée n'est plus recalculée.
  assert.equal((await refreshTourAutoKm({ companyId: f.company.id, tourId: c.id }, { db, fetchFn: fakeIgn().fetchFn }, { force: true })).outcome, "SKIPPED")
  const read = await readTours(f.truck.id, deps)
  const t = read.tours.find((x) => x.id === c.id)!
  assert.equal(t.estimatedKmSource, "AUTO")
  assert.deepEqual(t.kmComparison, { estimatedKm: 1680, actualKm: 2400, gapKm: 720, gapRatio: 0.429, alert: true })
  assert.deepEqual(t.fuel, { litres: 185, fills: 2, unknownLitres: 0, lPer100KmIndicative: 7.7 })
  assert.equal("estimatedKmInputHash" in t, false, "l'empreinte interne n'est pas exposée")
  // Le compteur du ticket (101 200) contredit le journal (arrivée à 102 400 relevée avant ce ticket) : ignoré.
  assert.equal(read.lastTicketMileage, null)
  // Ticket suivant cohérent (après l'arrivée) : proposé comme simple repère au prochain départ.
  await db.vehicleExpense.create({ data: { companyId: f.company.id, truckId: f.truck.id, category: "FUEL", occurredAt: new Date("2028-07-10T12:00:00Z"), amount: 90, currency: "EUR", litres: 50, mileageObservation: 102_650, createdById: f.user.id } })
  assert.equal((await readTours(f.truck.id, deps)).lastTicketMileage?.mileage, 102_650)
  // Un chef d'équipe ne voit ni le carburant ni le détail du calcul.
  const leaderUser = await db.user.create({ data: { email: `${randomUUID()}@example.test`, password: "unused", role: "EMPLOYEE", companyId: f.company.id } })
  const employee = await db.employee.create({ data: { companyId: f.company.id, userId: leaderUser.id, firstName: "Chef", lastName: "Test", role: "TEAM_LEADER" } })
  const team = await db.team.create({ data: { companyId: f.company.id, name: "Equipe", leaderId: employee.id } })
  await db.truck.update({ where: { id: f.truck.id }, data: { teamId: team.id, chauffeurId: employee.id } })
  const leader = await readTours(f.truck.id, f.deps(f.session(f.company.id, leaderUser.id, "TEAM_LEADER")))
  const lt = leader.tours.find((x) => x.id === c.id)!
  assert.equal(lt.fuel, null)
  assert.equal(lt.estimatedKmDetail, null)
})

test.after(async () => { await db.$disconnect() })
