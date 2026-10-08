/**
 * Routes HTTP Lot 2. La base est le double mémoire du Lot 1 : aucune connexion PostgreSQL.
 * Le troisième argument injecte les deps ; Next.js ne le passe pas.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { GET as getMileage } from "@/app/api/trucks/[id]/mileage/route"
import { POST as postReading } from "@/app/api/trucks/[id]/mileage/readings/route"
import { POST as postStart } from "@/app/api/trucks/[id]/mileage/trips/route"
import { POST as postEnd } from "@/app/api/trucks/[id]/mileage/trips/[tripId]/end/route"
import { POST as postCorrection } from "@/app/api/trucks/[id]/mileage/entries/[entryId]/corrections/route"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import { ADMIN, COMPANY, LEADER, MileageMemoryDb, NEXT_LEADER, SERVER_NOW, TRUCK } from "./mileage-test-db"

const EMPLOYEE: MileageSession = { user: { id: "employee", role: "EMPLOYEE", companyId: COMPANY } }
const CLIENT: MileageSession = { user: { id: "client", role: "CLIENT", companyId: COMPANY } }

let keySequence = 0
function key() {
  return `00000000-0000-4000-8000-${String(++keySequence).padStart(12, "0")}`
}

function reading(mileage: number, expectedRevision: number) {
  return { mileage, expectedRevision }
}

function request(body: unknown, idempotencyKey: string | null = key(), raw = false) {
  return new Request("https://vehicles-tests.invalid/api/trucks/mileage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: raw ? String(body) : JSON.stringify(body),
  })
}

function truck(id = TRUCK) {
  return { params: Promise.resolve({ id }) }
}

function arrival(tripId: string, id = TRUCK) {
  return { params: Promise.resolve({ id, tripId }) }
}

function correction(entryId: string, id = TRUCK) {
  return { params: Promise.resolve({ id, entryId }) }
}

async function payload(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

function archive(db: MileageMemoryDb) {
  Object.assign(db.state.trucks[0], {
    active: false, archivedAt: SERVER_NOW, teamId: null, chauffeurId: null,
  })
}

describe("mileage routes", () => {
  it("GET admin returns the explicit read model without internal fields", async () => {
    const db = new MileageMemoryDb()
    const created = await postReading(request(reading(100, 0)), truck(), db.deps())
    assert.equal(created.status, 201)
    assert.equal(created.headers.get("Cache-Control"), "private, no-store")
    const response = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    const body = await payload(response)
    assert.equal(body.truckId, TRUCK)
    assert.equal(body.currentMileage, 100)
    assert.equal(body.mileageRevision, 1)
    assert.equal(body.openTrip, null)
    const serialized = JSON.stringify(body)
    for (const forbidden of ["idempotencyKey", "requestHash", "companyId", "password"]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden)
    }
  })

  it("GET team leader is allowed only for the active team they currently lead", async () => {
    const db = new MileageMemoryDb()
    const allowed = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(LEADER))
    assert.equal(allowed.status, 200)
    const otherTeam = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(NEXT_LEADER))
    assert.equal(otherTeam.status, 404)
    assert.equal((await payload(otherTeam)).code, "TRUCK_NOT_FOUND")
    db.state.teams[0].active = false
    const inactive = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(LEADER))
    assert.equal(inactive.status, 404)
    assert.equal((await payload(inactive)).code, "TRUCK_NOT_FOUND")
  })

  it("GET denies employees and clients and hides another tenant", async () => {
    const db = new MileageMemoryDb()
    const employee = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(EMPLOYEE))
    assert.equal(employee.status, 403)
    assert.equal((await payload(employee)).code, "FORBIDDEN")
    const client = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(CLIENT))
    assert.equal(client.status, 403)
    assert.equal((await payload(client)).code, "FORBIDDEN")
    const foreign = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck("truck-b"), db.deps())
    assert.equal(foreign.status, 404)
    assert.equal((await payload(foreign)).code, "TRUCK_NOT_FOUND")
    assert.equal(db.state.entries.length, 0)
  })

  it("lets an admin record a reading and refuses the same command to a team leader", async () => {
    const db = new MileageMemoryDb()
    const admin = await postReading(request(reading(50, 0)), truck(), db.deps())
    assert.equal(admin.status, 201)
    assert.equal(admin.headers.get("Idempotency-Replayed"), "false")
    assert.deepEqual(Object.keys(await payload(admin)).sort(), ["acceptedRevision", "entryId"])
    const leader = await postReading(request(reading(60, 1)), truck(), db.deps(LEADER))
    assert.equal(leader.status, 403)
    assert.equal((await payload(leader)).code, "FORBIDDEN")
    assert.equal(db.state.entries.length, 1)
  })

  it("lets the assigned team leader start and end a trip using the path trip id", async () => {
    const db = new MileageMemoryDb()
    const start = await postStart(request(reading(100, 0)), truck(), db.deps(LEADER))
    assert.equal(start.status, 201)
    const started = await payload(start)
    assert.equal(typeof started.tripId, "string")
    const tripId = String(started.tripId)
    const wrongPath = await postEnd(request(reading(140, 1)), arrival("not-the-path"), db.deps(LEADER))
    assert.equal(wrongPath.status, 404)
    assert.equal((await payload(wrongPath)).code, "TRIP_NOT_FOUND")
    assert.equal(db.state.trips[0].endEntryId, null)
    const injected = await postEnd(request({ ...reading(140, 1), tripId: "body-trip" }), arrival(tripId), db.deps(LEADER))
    assert.equal(injected.status, 400)
    assert.equal((await payload(injected)).code, "INVALID_PAYLOAD")
    assert.equal(db.state.trips[0].endEntryId, null)
    const end = await postEnd(request(reading(140, 1)), arrival(tripId), db.deps(LEADER))
    assert.equal(end.status, 200)
    assert.equal(end.headers.get("Idempotency-Replayed"), "false")
    const ended = await payload(end)
    assert.equal(ended.tripId, tripId)
    assert.deepEqual(Object.keys(ended).sort(), ["acceptedRevision", "entryId", "tripId"])
    assert.equal(db.state.trips[0].endEntryId, ended.entryId)
  })

  it("takes the correction target from the path and refuses it to a team leader", async () => {
    const db = new MileageMemoryDb()
    const created = await postReading(request(reading(100, 0)), truck(), db.deps())
    const entryId = String((await payload(created)).entryId)
    const leader = await postCorrection(request({
      mileage: 110, expectedRevision: 1, expectedEffectiveEntryId: entryId, reason: "Chef",
    }), correction(entryId), db.deps(LEADER))
    assert.equal(leader.status, 403)
    assert.equal((await payload(leader)).code, "FORBIDDEN")
    const injected = await postCorrection(request({
      mileage: 110, expectedRevision: 1, expectedEffectiveEntryId: entryId, reason: "Injecté", entryId: "body-entry",
    }), correction(entryId), db.deps())
    assert.equal(injected.status, 400)
    assert.equal((await payload(injected)).code, "INVALID_PAYLOAD")
    const wrongPath = await postCorrection(request({
      mileage: 110, expectedRevision: 1, expectedEffectiveEntryId: entryId, reason: "Mauvais chemin",
    }), correction("missing-entry"), db.deps())
    assert.equal(wrongPath.status, 404)
    assert.equal((await payload(wrongPath)).code, "MILEAGE_ENTRY_NOT_FOUND")
    const corrected = await postCorrection(request({
      mileage: 110, expectedRevision: 1, expectedEffectiveEntryId: entryId, reason: "Erreur de saisie",
    }), correction(entryId), db.deps())
    assert.equal(corrected.status, 201)
    const receipt = await payload(corrected)
    assert.equal(receipt.rootEntryId, entryId)
    assert.equal(db.state.entries[0].mileage, 100)
    assert.equal(db.state.entries[0].kind, "READING")
    assert.equal(db.state.entries.length, 2)
  })

  it("follows the archived-truck contract for admin and team leader", async () => {
    const db = new MileageMemoryDb()
    const created = await postReading(request(reading(80, 0)), truck(), db.deps())
    const entryId = String((await payload(created)).entryId)
    const start = await postStart(request(reading(80, 1)), truck(), db.deps())
    const tripId = String((await payload(start)).tripId)
    archive(db)

    const adminRead = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps())
    assert.equal(adminRead.status, 200)
    const readingDenied = await postReading(request(reading(90, 2)), truck(), db.deps())
    assert.equal(readingDenied.status, 409)
    assert.equal((await payload(readingDenied)).code, "TRUCK_ARCHIVED")
    const startDenied = await postStart(request(reading(90, 2)), truck(), db.deps())
    assert.equal(startDenied.status, 409)
    assert.equal((await payload(startDenied)).code, "TRUCK_ARCHIVED")
    const endDenied = await postEnd(request(reading(90, 2)), arrival(tripId), db.deps())
    assert.equal(endDenied.status, 409)
    assert.equal((await payload(endDenied)).code, "TRUCK_ARCHIVED")
    assert.equal(db.state.trips[0].endEntryId, null)
    const corrected = await postCorrection(request({
      mileage: 80, expectedRevision: 2, expectedEffectiveEntryId: entryId, reason: "Après archivage",
    }), correction(entryId), db.deps())
    assert.equal(corrected.status, 201)

    const leaderRead = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps(LEADER))
    assert.equal(leaderRead.status, 404)
    assert.equal((await payload(leaderRead)).code, "TRUCK_NOT_FOUND")
    const leaderReading = await postReading(request(reading(90, 3)), truck(), db.deps(LEADER))
    assert.equal(leaderReading.status, 403)
    const leaderStart = await postStart(request(reading(90, 3)), truck(), db.deps(LEADER))
    assert.equal(leaderStart.status, 404)
    const leaderEnd = await postEnd(request(reading(90, 3)), arrival(tripId), db.deps(LEADER))
    assert.equal(leaderEnd.status, 404)
    const leaderCorrection = await postCorrection(request({
      mileage: 80, expectedRevision: 3, expectedEffectiveEntryId: entryId, reason: "Chef",
    }), correction(entryId), db.deps(LEADER))
    assert.equal(leaderCorrection.status, 403)
  })

  it("rejects malformed JSON, non-objects and fields the strict schemas do not accept", async () => {
    const db = new MileageMemoryDb()
    const malformed = await postReading(request("{", key(), true), truck(), db.deps())
    assert.equal(malformed.status, 400)
    assert.equal((await payload(malformed)).code, "INVALID_JSON")
    for (const body of [[], "text", 12, null]) {
      const response = await postReading(request(body), truck(), db.deps())
      assert.equal(response.status, 400)
      assert.equal((await payload(response)).code, "INVALID_PAYLOAD")
    }
    for (const extra of [
      { type: "CORRECTION" },
      { companyId: "company-b" },
      { entryId: "injected" },
      { tripId: "injected" },
      { idempotencyKey: key() },
    ]) {
      const response = await postReading(request({ ...reading(1, 0), ...extra }), truck(), db.deps())
      assert.equal(response.status, 400, JSON.stringify(extra))
      assert.equal((await payload(response)).code, "INVALID_PAYLOAD")
    }
    assert.equal(db.state.entries.length, 0)
    assert.equal(db.calls.length, 0)
  })

  it("requires a valid Idempotency-Key and the original expectedRevision", async () => {
    const db = new MileageMemoryDb()
    const missing = await postReading(request(reading(1, 0), null), truck(), db.deps())
    assert.equal(missing.status, 400)
    assert.equal((await payload(missing)).code, "INVALID_IDEMPOTENCY_KEY")
    const invalid = await postReading(request(reading(1, 0), "not-a-uuid"), truck(), db.deps())
    assert.equal(invalid.status, 400)
    assert.equal((await payload(invalid)).code, "INVALID_IDEMPOTENCY_KEY")
    const withoutRevision = await postReading(request({ mileage: 1 }), truck(), db.deps())
    assert.equal(withoutRevision.status, 400)
    assert.equal((await payload(withoutRevision)).code, "INVALID_PAYLOAD")
    assert.equal(db.state.entries.length, 0)

    const idempotencyKey = key()
    const first = await postReading(request(reading(10, 0), idempotencyKey), truck(), db.deps())
    assert.equal(first.status, 201)
    const receipt = await payload(first)
    const replay = await postReading(request(reading(10, 0), idempotencyKey), truck(), db.deps())
    assert.equal(replay.status, 201)
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true")
    assert.deepEqual(await payload(replay), receipt)
    assert.equal(db.state.entries.length, 1)
    const conflict = await postReading(request(reading(11, 0), idempotencyKey), truck(), db.deps())
    assert.equal(conflict.status, 409)
    assert.equal((await payload(conflict)).code, "IDEMPOTENCY_CONFLICT")
    assert.equal(db.state.entries.length, 1)
    const stale = await postReading(request(reading(12, 0)), truck(), db.deps())
    assert.equal(stale.status, 409)
    assert.equal((await payload(stale)).code, "MILEAGE_REVISION_CONFLICT")
  })

  it("maps future dates, regressions, low arrivals and technical failures", async () => {
    const db = new MileageMemoryDb()
    const future = await postReading(request({
      ...reading(1, 0), occurredAt: "2099-01-01T00:00:00.000Z",
    }), truck(), db.deps())
    assert.equal(future.status, 422)
    assert.equal((await payload(future)).code, "MILEAGE_FUTURE_DATE")
    await postReading(request(reading(100, 0)), truck(), db.deps())
    const regression = await postReading(request(reading(90, 1)), truck(), db.deps())
    assert.equal(regression.status, 409)
    assert.equal((await payload(regression)).code, "MILEAGE_REGRESSION")
    const start = await postStart(request(reading(100, 1)), truck(), db.deps(LEADER))
    const tripId = String((await payload(start)).tripId)
    const low = await postEnd(request(reading(90, 2)), arrival(tripId), db.deps(LEADER))
    assert.equal(low.status, 409)
    assert.equal((await payload(low)).code, "ARRIVAL_BELOW_DEPARTURE")
    assert.equal(db.state.trips[0].endEntryId, null)

    db.failOnce = { operation: "truck.findFirst", error: new Error("sensitive SQL postgresql://user:secret@db/prod") }
    const failure = await getMileage(new Request("https://vehicles-tests.invalid/mileage"), truck(), db.deps())
    assert.equal(failure.status, 500)
    assert.equal(failure.headers.get("Cache-Control"), "private, no-store")
    const body = await payload(failure)
    assert.equal(body.code, "SERVER_ERROR")
    assert.equal(body.error, "Erreur serveur")
    const serialized = JSON.stringify(body)
    for (const secret of ["sensitive", "postgresql", "secret", "prisma"]) {
      assert.equal(serialized.toLowerCase().includes(secret), false, secret)
    }
  })

  it("refuses a super admin session that has no company", async () => {
    const db = new MileageMemoryDb()
    const response = await getMileage(
      new Request("https://vehicles-tests.invalid/mileage"),
      truck(),
      db.deps({ user: { id: "super", role: "SUPER_ADMIN", companyId: null } }),
    )
    assert.equal(response.status, 403)
    assert.equal((await payload(response)).code, "NO_COMPANY")
    assert.equal(db.calls.length, 0)
  })
})
