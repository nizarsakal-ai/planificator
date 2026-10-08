import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { handleMileageCommand, handleMileageGet } from "@/lib/vehicules/mileage-api"
import { executeMileageCommand, normalizeMileageFailure, readMileage } from "@/lib/vehicules/mileage-service"
import { MileageDomainError, rebuildMileageProjection, type MileageCommandType } from "@/lib/vehicules/mileage-domain"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import { ADMIN, COMPANY, LEADER, MileageMemoryDb, NEXT_LEADER, SERVER_NOW, SUPER_ADMIN, TRUCK } from "./mileage-test-db"

let keySequence = 0
function key() { return `00000000-0000-4000-8000-${String(++keySequence).padStart(12, "0")}` }
const run = (db: MileageMemoryDb, action: MileageCommandType, body: unknown, idempotencyKey = key(), session: MileageSession | null = ADMIN, truckId = TRUCK) =>
  executeMileageCommand(truckId, action, body, idempotencyKey, db.deps(session))
async function rejectsCode(promise: Promise<unknown>, code: string, status = 409) {
  await assert.rejects(promise, (error) => error instanceof MileageDomainError && error.code === code && error.status === status)
}
function request(body: unknown, idempotencyKey: string | null = key()) {
  return new Request("https://vehicles-tests.invalid/mileage", {
    method: "POST", headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  })
}
const reading = (mileage: number, expectedRevision: number) => ({ mileage, expectedRevision })

describe("mileage service: observations and trips (transactional double, no PostgreSQL)", () => {
  it("keeps initial mileage unknown, then accepts zero as a real first reading", async () => {
    const db = new MileageMemoryDb()
    const initial = await readMileage(TRUCK, db.deps())
    assert.equal(initial.currentMileage, null)
    assert.equal(initial.currentMileageEntryId, null)
    assert.equal(initial.mileageRevision, 0)
    assert.deepEqual(initial.history, [])
    const result = await run(db, "READING", reading(0, 0))
    assert.equal(result.status, 201)
    assert.equal(result.replayed, false)
    const current = await readMileage(TRUCK, db.deps())
    assert.equal(current.currentMileage, 0)
    assert.equal(current.currentMileageEntryId, result.receipt.entryId)
    assert.equal(current.mileageRevision, 1)
    assert.equal(current.history[0].occurredAt, SERVER_NOW.toISOString())
    assert.equal(current.history[0].recordedAt, SERVER_NOW.toISOString())
    assert.equal(db.state.entries[0].recordedAt instanceof Date, true)
  })

  it("creates a departure, refuses a second open trip and closes using arrival minus departure", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", { ...reading(83120, 0), worksiteId: "worksite-a" }, key(), LEADER)
    assert.ok(start.receipt.tripId)
    assert.equal(db.state.entries[0].kind, "DEPARTURE")
    assert.equal(db.state.trips[0].startEntryId, start.receipt.entryId)
    await rejectsCode(run(db, "START", reading(83120, 1), key(), LEADER), "TRIP_ALREADY_OPEN")
    await rejectsCode(run(db, "END", { ...reading(83119, 1), tripId: start.receipt.tripId }, key(), LEADER), "ARRIVAL_BELOW_DEPARTURE")
    assert.equal(db.state.entries.length, 1)
    const end = await run(db, "END", { ...reading(83187, 1), tripId: start.receipt.tripId }, key(), LEADER)
    assert.equal(end.status, 200)
    assert.equal(end.receipt.tripId, start.receipt.tripId)
    assert.equal(db.state.entries[1].kind, "ARRIVAL")
    const current = await readMileage(TRUCK, db.deps(LEADER))
    assert.equal(current.openTrip, null)
    assert.equal(current.trips[0].distance, 67)
    assert.equal(current.currentMileage, 83187)
    await rejectsCode(run(db, "END", { ...reading(83187, 2), tripId: start.receipt.tripId }), "TRIP_ALREADY_CLOSED")
    await rejectsCode(run(db, "END", { ...reading(83187, 2), tripId: "missing" }), "TRIP_NOT_FOUND", 404)
  })

  it("allows a standalone admin reading during a trip, with arrival respecting that newer reading", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", reading(100, 0))
    await run(db, "READING", reading(130, 1))
    assert.equal((await readMileage(TRUCK, db.deps())).openTrip?.id, start.receipt.tripId)
    await rejectsCode(run(db, "END", { ...reading(125, 2), tripId: start.receipt.tripId }), "MILEAGE_REGRESSION")
    await run(db, "END", { ...reading(150, 2), tripId: start.receipt.tripId })
    assert.equal((await readMileage(TRUCK, db.deps())).trips[0].distance, 50)
  })

  it("permits a departure without worksite, driver or team", async () => {
    const db = new MileageMemoryDb()
    Object.assign(db.state.trucks[0], { teamId: null, chauffeurId: null })
    await run(db, "START", reading(0, 0))
    assert.deepEqual(Object.fromEntries(Object.entries(db.state.trips[0]).filter(([name]) => /Snapshot$|worksiteId|teamId|chauffeurId/.test(name))), {
      teamId: null, teamNameSnapshot: null, chauffeurId: null, chauffeurNameSnapshot: null, worksiteId: null, worksiteNameSnapshot: null,
    })
  })

  it("rejects future dates, retroactive originals, regressions and invalid mileage before any write", async () => {
    const db = new MileageMemoryDb()
    const occurredAt = "2026-10-08T10:00:00.000Z"
    await run(db, "READING", { ...reading(100, 0), occurredAt })
    await rejectsCode(run(db, "READING", { ...reading(101, 1), occurredAt: "2099-01-01T00:00:00Z" }), "MILEAGE_FUTURE_DATE", 422)
    await rejectsCode(run(db, "READING", { ...reading(101, 1), occurredAt: "2026-10-08T09:00:00Z" }), "MILEAGE_OUT_OF_ORDER")
    await rejectsCode(run(db, "READING", reading(99, 1)), "MILEAGE_REGRESSION")
    for (const mileage of [-1, 0.1, 10_000_000]) await rejectsCode(run(db, "READING", reading(mileage, 1)), "INVALID_PAYLOAD", 400)
    assert.equal(db.state.entries.length, 1)
    assert.equal(db.state.trucks[0].mileageRevision, 1)
  })

  it("detects an inconsistent cached projection without silently repairing or appending", async () => {
    const db = new MileageMemoryDb()
    await run(db, "READING", reading(100, 0))
    db.state.trucks[0].currentMileage = 999
    await rejectsCode(readMileage(TRUCK, db.deps()), "MILEAGE_PROJECTION_CONFLICT", 500)
    await rejectsCode(run(db, "READING", reading(1000, 1)), "MILEAGE_PROJECTION_CONFLICT", 500)
    assert.equal(db.state.entries.length, 1)
  })

  it("refuses originals on an archived truck but permits an explicit admin correction", async () => {
    const db = new MileageMemoryDb()
    const first = await run(db, "READING", reading(100, 0))
    Object.assign(db.state.trucks[0], { active: false, archivedAt: SERVER_NOW, teamId: null, chauffeurId: null })
    await rejectsCode(run(db, "READING", reading(101, 1)), "TRUCK_ARCHIVED")
    await rejectsCode(run(db, "START", reading(101, 1)), "TRUCK_ARCHIVED")
    await run(db, "CORRECTION", {
      ...reading(99, 1), entryId: first.receipt.entryId, expectedEffectiveEntryId: first.receipt.entryId, reason: "Erreur de compteur",
    })
    assert.equal(db.state.trucks[0].currentMileage, 99)
    assert.equal(db.state.trucks[0].active, false)
  })
})

describe("mileage service: correction journal and idempotence", () => {
  it("appends corrections and corrections of corrections without rewriting originals or endpoints", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", reading(100, 0))
    const end = await run(db, "END", { ...reading(150, 1), tripId: start.receipt.tripId })
    const originals = structuredClone(db.state.entries)
    const originalTrip = structuredClone(db.state.trips[0])
    const firstCorrection = await run(db, "CORRECTION", {
      ...reading(110, 2), entryId: start.receipt.entryId, expectedEffectiveEntryId: start.receipt.entryId, reason: "Mauvais départ",
    })
    const secondCorrection = await run(db, "CORRECTION", {
      ...reading(115, 3), entryId: firstCorrection.receipt.entryId, expectedEffectiveEntryId: firstCorrection.receipt.entryId, reason: "Lecture précisée",
    })
    assert.equal(secondCorrection.receipt.rootEntryId, start.receipt.entryId)
    assert.equal(db.state.entries[3].supersedesEntryId, firstCorrection.receipt.entryId)
    assert.equal(db.state.entries[2].occurredAt, null)
    assert.deepEqual(db.state.entries.slice(0, 2), originals)
    assert.deepEqual(db.state.trips[0], originalTrip)
    const current = await readMileage(TRUCK, db.deps())
    assert.equal(current.currentMileageEntryId, end.receipt.entryId)
    assert.equal(current.currentMileage, 150)
    assert.equal(current.mileageRevision, 4)
    assert.equal(current.trips[0].distance, 35)
    assert.deepEqual(rebuildMileageProjection(db.state.entries), {
      currentMileage: 150, currentMileageEntryId: end.receipt.entryId, mileageRevision: 4,
    })
    await rejectsCode(run(db, "CORRECTION", {
      ...reading(120, 4), entryId: start.receipt.entryId, expectedEffectiveEntryId: start.receipt.entryId, reason: "Tête périmée",
    }), "MILEAGE_CORRECTION_CONFLICT")
    await rejectsCode(run(db, "CORRECTION", {
      ...reading(151, 4), entryId: start.receipt.entryId, expectedEffectiveEntryId: secondCorrection.receipt.entryId, reason: "Dépasse arrivée",
    }), "MILEAGE_REGRESSION")
    await rejectsCode(run(db, "CORRECTION", {
      ...reading(120, 4), entryId: start.receipt.entryId, expectedEffectiveEntryId: secondCorrection.receipt.entryId, reason: "  ",
    }), "INVALID_PAYLOAD", 400)
    assert.equal(db.state.entries.length, 4)
  })

  it("replays arrival using the existing entry and trip after later revisions", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", reading(100, 0))
    const arrivalKey = key()
    const arrival = { ...reading(150, 1), tripId: start.receipt.tripId }
    const first = await run(db, "END", arrival, arrivalKey)
    await run(db, "READING", reading(160, 2))
    const before = structuredClone(db.state)
    const replay = await run(db, "END", arrival, arrivalKey)
    assert.deepEqual(replay.receipt, first.receipt)
    assert.equal(replay.status, 200)
    assert.equal(replay.replayed, true)
    assert.deepEqual(db.state, before)
  })

  it("replays an omitted-time reading with the same key, but rejects a different command or actor", async () => {
    const db = new MileageMemoryDb()
    const requestKey = key()
    const command = reading(100, 0)
    const first = await run(db, "READING", command, requestKey)
    db.now = new Date(SERVER_NOW.getTime() + 60_000)
    const replay = await run(db, "READING", command, requestKey)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, first.receipt)
    assert.equal(db.state.entries[0].occurredAt?.toISOString(), SERVER_NOW.toISOString())
    await rejectsCode(run(db, "READING", reading(101, 0), requestKey), "IDEMPOTENCY_CONFLICT")
    await rejectsCode(run(db, "READING", reading(100, 1), requestKey), "IDEMPOTENCY_CONFLICT")
    await rejectsCode(run(db, "START", command, requestKey), "IDEMPOTENCY_CONFLICT")
    await rejectsCode(run(db, "READING", command, requestKey, SUPER_ADMIN), "IDEMPOTENCY_CONFLICT")
    assert.equal(db.state.entries.length, 1)
  })

  it("documents the concurrent idempotency loser: unique violation aborts, with no replay inside that transaction", async () => {
    const db = new MileageMemoryDb()
    const requestKey = key()
    const before = structuredClone(db.state)
    db.failOnce = {
      operation: "mileageEntry.create",
      error: { code: "P2002", meta: { target: ["companyId", "truckId", "idempotencyKey"] } },
    }
    await rejectsCode(run(db, "READING", reading(100, 0), requestKey), "IDEMPOTENCY_CONFLICT")
    assert.deepEqual(db.state, before)
    assert.equal(db.calls.filter((call) => call.operation === "mileageEntry.findFirst").length, 1)
    assert.equal(db.calls.filter((call) => call.operation === "mileageEntry.create").length, 1)
    assert.equal(db.calls.some((call) => call.operation === "transaction.rollback"), true)
    assert.equal(db.calls.some((call) => call.operation === "transaction.commit"), false)
  })

  it("replays a correction without creating a branch or changing its receipt", async () => {
    const db = new MileageMemoryDb()
    const first = await run(db, "READING", reading(100, 0))
    const correctionKey = key()
    const command = { ...reading(110, 1), entryId: first.receipt.entryId, expectedEffectiveEntryId: first.receipt.entryId, reason: "Erreur" }
    const corrected = await run(db, "CORRECTION", command, correctionKey)
    const replay = await run(db, "CORRECTION", command, correctionKey)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, corrected.receipt)
    assert.equal(db.state.entries.length, 2)
  })
})

describe("mileage service: scope, snapshots and authority revalidation", () => {
  it("enforces current team ownership for every command and before idempotency replay", async () => {
    const db = new MileageMemoryDb()
    const startKey = key()
    const startBody = { ...reading(100, 0), worksiteId: "worksite-a" }
    const start = await run(db, "START", startBody, startKey, LEADER)
    const captured = structuredClone(db.state.trips[0])
    db.state.trucks[0].teamId = "team-b"
    db.state.trucks[0].chauffeurId = "employee-b"
    db.state.teams[0].name = "Équipe renommée"
    db.state.employees.find((row) => row.id === "driver-a")!.lastName = "Renommé"
    db.state.worksites[0].name = "Chantier renommé"
    await rejectsCode(readMileage(TRUCK, db.deps(LEADER)), "TRUCK_NOT_FOUND", 404)
    await rejectsCode(run(db, "END", { ...reading(150, 1), tripId: start.receipt.tripId }, key(), LEADER), "TRUCK_NOT_FOUND", 404)
    const callsBeforeReplay = db.calls.length
    await rejectsCode(run(db, "START", startBody, startKey, LEADER), "TRUCK_NOT_FOUND", 404)
    assert.equal(db.calls.slice(callsBeforeReplay).some((call) => call.operation === "mileageEntry.findFirst"), false)
    assert.equal((await readMileage(TRUCK, db.deps(NEXT_LEADER))).openTrip?.teamName, "Équipe initiale")
    await run(db, "END", { ...reading(150, 1), tripId: start.receipt.tripId }, key(), NEXT_LEADER)
    const ended = db.state.trips[0]
    assert.deepEqual({ ...ended, endEntryId: null }, captured)
    assert.equal(ended.worksiteNameSnapshot, "Chantier initial")
    assert.equal(ended.chauffeurNameSnapshot, "Driver Initial")
  })

  it("denies standalone readings and corrections to the assigned team leader", async () => {
    const db = new MileageMemoryDb()
    await rejectsCode(run(db, "READING", reading(100, 0), key(), LEADER), "FORBIDDEN", 403)
    const start = await run(db, "START", reading(100, 0), key(), LEADER)
    await rejectsCode(run(db, "CORRECTION", {
      ...reading(99, 1), entryId: start.receipt.entryId, expectedEffectiveEntryId: start.receipt.entryId, reason: "Erreur",
    }, key(), LEADER), "FORBIDDEN", 403)
  })

  it("never reads or modifies a vehicle belonging to another company", async () => {
    const db = new MileageMemoryDb()
    await rejectsCode(readMileage("truck-b", db.deps()), "TRUCK_NOT_FOUND", 404)
    await rejectsCode(run(db, "READING", reading(100, 0), key(), ADMIN, "truck-b"), "TRUCK_NOT_FOUND", 404)
    assert.equal(db.state.entries.length, 0)
    assert.equal(db.calls.some((call) => /mileageEntry|mileageTrip/.test(call.operation)), false)
  })

  it("refuses tenant-mismatched site, current team and driver context", async () => {
    const db = new MileageMemoryDb()
    await rejectsCode(run(db, "START", { ...reading(100, 0), worksiteId: "worksite-b" }), "WORKSITE_NOT_FOUND", 404)
    db.state.trucks[0].teamId = "foreign-team"
    await rejectsCode(run(db, "START", reading(100, 0)), "TEAM_NOT_FOUND", 404)
    db.state.trucks[0].teamId = "team-a"
    db.state.trucks[0].chauffeurId = "driver-b"
    await rejectsCode(run(db, "START", reading(100, 0)), "DRIVER_NOT_FOUND", 404)
    assert.equal(db.state.entries.length, 0)
    assert.equal(db.state.trips.length, 0)
  })

  it("uses fresh account and team authority before replaying an already accepted request", async () => {
    const db = new MileageMemoryDb()
    const requestKey = key()
    const command = reading(100, 0)
    await run(db, "READING", command, requestKey)
    db.state.users[0].active = false
    await rejectsCode(run(db, "READING", command, requestKey), "UNAUTHENTICATED", 401)
    db.state.users[0].active = true
    db.state.users[0].role = "EMPLOYEE"
    await rejectsCode(run(db, "READING", command, requestKey), "FORBIDDEN", 403)
    assert.equal(db.state.entries.length, 1)
  })

  it("tenant scopes every SQL lookup and ORM read/write and uses separate lock then reread", async () => {
    const db = new MileageMemoryDb()
    await run(db, "START", { ...reading(100, 0), worksiteId: "worksite-a" }, key(), LEADER)
    await readMileage(TRUCK, db.deps(LEADER))
    const begins = db.calls.filter((call) => call.operation === "transaction.begin")
    for (const call of begins) assert.deepEqual(call.args, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 })
    for (const call of db.calls) {
      if (call.operation === "$queryRaw") {
        const { sql, values } = call.args as { sql: string; values: unknown[] }
        if (sql.includes("clock_timestamp")) continue
        assert.match(sql, /"companyId" = \?/)
        assert.equal(values[1], COMPANY)
        assert.match(sql, /FOR (UPDATE|SHARE)$/)
      }
      if (/^(truck|mileageEntry|mileageTrip)\.(findFirst|findMany|updateMany)$/.test(call.operation)) {
        const { where } = call.args as { where: Record<string, unknown> }
        assert.equal(where.companyId, COMPANY)
        assert.equal(call.operation.startsWith("truck.") ? where.id : where.truckId, TRUCK)
      }
      if (/^(mileageEntry|mileageTrip)\.create$/.test(call.operation)) {
        const { data } = call.args as { data: Record<string, unknown> }
        assert.equal(data.companyId, COMPANY)
        assert.equal(data.truckId, TRUCK)
      }
    }
    const firstLock = db.calls.findIndex((call) => call.operation === "$queryRaw")
    assert.equal(db.calls[firstLock + 1].operation, "truck.findFirst")
  })
})

describe("mileage service: atomicity and simulated stale-client ordering", () => {
  it("the serial mock rejects one of two requests carrying the same starting revision", async () => {
    const db = new MileageMemoryDb()
    await run(db, "READING", reading(83120, 0))
    const outcomes = await Promise.allSettled([
      run(db, "READING", reading(83150, 1)), run(db, "READING", reading(83140, 1)),
    ])
    assert.equal(outcomes[0].status, "fulfilled")
    assert.equal(outcomes[1].status, "rejected")
    if (outcomes[1].status === "rejected") assert.equal(outcomes[1].reason.code, "MILEAGE_REVISION_CONFLICT")
    assert.equal(db.state.trucks[0].currentMileage, 83150)
    assert.equal(db.state.entries.length, 2)
  })

  it("rolls back Entry and Trip creation when projection writing fails, then permits a clean retry", async () => {
    const db = new MileageMemoryDb()
    const before = structuredClone(db.state)
    const requestKey = key()
    db.failOnce = { operation: "truck.updateMany", error: new Error("simulated write failure") }
    await assert.rejects(run(db, "START", reading(100, 0), requestKey), /simulated write failure/)
    assert.deepEqual(db.state, before)
    assert.equal(db.calls.some((call) => call.operation === "mileageTrip.create"), true)
    const retried = await run(db, "START", reading(100, 0), requestKey)
    assert.equal(retried.replayed, false)
    assert.equal(retried.receipt.acceptedRevision, 1)
  })

  it("rolls back an arrival when the conditional close no longer succeeds", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", reading(100, 0))
    const before = structuredClone(db.state)
    db.zeroOnce = "mileageTrip.updateMany"
    await rejectsCode(run(db, "END", { ...reading(150, 1), tripId: start.receipt.tripId }), "TRIP_ALREADY_CLOSED")
    assert.deepEqual(db.state, before)
  })

  it("rolls back arrival and closed-trip mutation if the projection CAS fails", async () => {
    const db = new MileageMemoryDb()
    const start = await run(db, "START", reading(100, 0))
    const before = structuredClone(db.state)
    db.zeroOnce = "truck.updateMany"
    await rejectsCode(run(db, "END", { ...reading(150, 1), tripId: start.receipt.tripId }), "MILEAGE_REVISION_CONFLICT")
    assert.deepEqual(db.state, before)
  })

  it("maps only known transaction and named integrity failures", () => {
    const cases = [
      [{ code: "P2028" }, "CONCURRENT_UPDATE"],
      [{ code: "P2034" }, "CONCURRENT_UPDATE"],
      [{ code: "P2010", meta: { code: "40P01" } }, "CONCURRENT_UPDATE"],
      [{ code: "55P03" }, "CONCURRENT_UPDATE"],
      [{ code: "P2002", meta: { target: ["supersedesEntryId"] } }, "MILEAGE_CORRECTION_CONFLICT"],
      [{ code: "P2002", meta: { target: ["companyId", "truckId", "idempotencyKey"] } }, "IDEMPOTENCY_CONFLICT"],
      [{ code: "23505", message: "mileage_trips_open_truck_key" }, "TRIP_ALREADY_OPEN"],
      [{ code: "P2002", meta: { target: ["revision"] } }, "MILEAGE_REVISION_CONFLICT"],
      [{ code: "P2010", meta: { code: "23505", constraint: "mileage_entries_company_truck_idempotency_key" } }, "IDEMPOTENCY_CONFLICT"],
      [{ code: "23505", message: "mileage_entries_company_truck_revision_key" }, "MILEAGE_REVISION_CONFLICT"],
      [{ code: "23505", meta: { constraint: "mileage_entries_supersedes_truck_company_key" } }, "MILEAGE_CORRECTION_CONFLICT"],
      [{ code: "23514", message: "trucks_v2_no_open_mileage_trip_check" }, "TRUCK_HAS_OPEN_TRIP"],
    ] as const
    for (const [error, code] of cases) {
      assert.throws(() => normalizeMileageFailure(error), (found) => found instanceof MileageDomainError && found.code === code && found.status === 409)
    }
    const unknown = new Error("unknown internal failure")
    assert.throws(() => normalizeMileageFailure(unknown), (error) => error === unknown)
  })
})

describe("mileage HTTP adapters, without activated routes", () => {
  it("returns stable start/end receipts and correct replay headers/status without leaking DB objects", async () => {
    const db = new MileageMemoryDb()
    const startKey = key()
    const first = await handleMileageCommand(request(reading(100, 0), startKey), { truckId: TRUCK, action: "START" }, db.deps())
    assert.equal(first.status, 201)
    assert.equal(first.headers.get("Idempotency-Replayed"), "false")
    assert.equal(first.headers.get("Cache-Control"), "private, no-store")
    const start = await first.json()
    const replayStart = await handleMileageCommand(request(reading(100, 0), startKey), { truckId: TRUCK, action: "START" }, db.deps())
    assert.equal(replayStart.status, 201)
    assert.equal(replayStart.headers.get("Idempotency-Replayed"), "true")
    assert.deepEqual(await replayStart.json(), start)
    const endKey = key()
    const target = { truckId: TRUCK, action: "END" as const, targetId: start.tripId }
    const arrival = await handleMileageCommand(request(reading(150, 1), endKey), target, db.deps())
    assert.equal(arrival.status, 200)
    const end = await arrival.json()
    const replayEnd = await handleMileageCommand(request(reading(150, 1), endKey), target, db.deps())
    assert.equal(replayEnd.status, 200)
    assert.equal(replayEnd.headers.get("Idempotency-Replayed"), "true")
    assert.deepEqual(await replayEnd.json(), end)
    const response = await handleMileageGet(TRUCK, db.deps())
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.trips[0].distance, 50)
    for (const forbidden of ["idempotencyKey", "requestHash", "companyId", "password"]) assert.equal(JSON.stringify(result).includes(`"${forbidden}"`), false)
    assert.deepEqual(Object.keys(start).sort(), ["acceptedRevision", "entryId", "tripId"])
  })

  it("rejects malformed JSON, primitive/array bodies, invalid keys and injected target/tenant fields", async () => {
    const db = new MileageMemoryDb()
    const target = { truckId: TRUCK, action: "READING" as const }
    const malformed = await handleMileageCommand(new Request("https://vehicles-tests.invalid", { method: "POST", body: "{" }), target, db.deps())
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).code, "INVALID_JSON")
    for (const body of [null, [], "text", { ...reading(0, 0), companyId: "company-b" }, { ...reading(0, 0), tripId: "injected" }, { ...reading(0, 0), entryId: "injected" }]) {
      const response = await handleMileageCommand(request(body), target, db.deps())
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, "INVALID_PAYLOAD")
    }
    for (const invalidKey of [null, "invalid"]) {
      const response = await handleMileageCommand(request(reading(0, 0), invalidKey), target, db.deps())
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, "INVALID_IDEMPOTENCY_KEY")
    }
    assert.equal(db.calls.length, 0)
  })

  it("takes correction target exclusively from the server route context", async () => {
    const db = new MileageMemoryDb()
    const initial = await run(db, "READING", reading(100, 0))
    const response = await handleMileageCommand(request({
      ...reading(110, 1), expectedEffectiveEntryId: initial.receipt.entryId, reason: "Erreur",
    }), { truckId: TRUCK, action: "CORRECTION", targetId: initial.receipt.entryId }, db.deps())
    assert.equal(response.status, 201)
    assert.equal((await response.json()).rootEntryId, initial.receipt.entryId)
  })

  it("returns role/session/tenant errors and hides raw technical failures", async () => {
    const db = new MileageMemoryDb()
    const unauthenticated = await handleMileageGet(TRUCK, db.deps(null))
    assert.equal(unauthenticated.status, 401)
    for (const role of ["EMPLOYEE", "CLIENT"]) {
      const denied = await handleMileageGet(TRUCK, db.deps({ user: { id: role.toLowerCase(), role, companyId: COMPANY } }))
      assert.equal(denied.status, 403)
    }
    const foreign = await handleMileageGet("truck-b", db.deps())
    assert.equal(foreign.status, 404)
    db.failOnce = { operation: "truck.findFirst", error: new Error("sensitive SQL and credentials") }
    const error = await handleMileageGet(TRUCK, db.deps())
    assert.equal(error.status, 500)
    const body = await error.json()
    assert.equal(body.code, "SERVER_ERROR")
    assert.equal(JSON.stringify(body).includes("sensitive"), false)
    assert.equal(error.headers.get("Cache-Control"), "private, no-store")
  })
})
