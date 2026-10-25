import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { localDb } from "./local-db"
import { fixture } from "./fixtures"
import { executeMileageCommand, readMileage } from "../../../src/lib/vehicules/mileage-service"
import { readMaintenance, recordMaintenance, updateMaintenancePlan } from "../../../src/lib/vehicules/maintenance-service"

// Missing/unsafe URL fails immediately; it never silently skips a database check.
const db = localDb()
test("V2 PostgreSQL: atomic journals, concurrency, tenant roles and maintenance", { timeout: 55_000 }, async () => {
  try {
    const f = await fixture(db)
    const foreignKeys = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('mileage_entries_truckId_companyId_fkey', 'vehicle_maintenance_entries_truckId_companyId_fkey', 'vehicle_maintenance_plans_truckId_companyId_fkey')`
    assert.equal(foreignKeys.length, 3)
    assert.ok(foreignKeys.every(row => row.convalidated))
    const run = (action: "READING" | "START" | "END" | "CORRECTION", body: unknown, key = randomUUID()) => executeMileageCommand(f.truck.id, action, body, key, f.deps())
    assert.equal((await readMileage(f.truck.id, f.deps())).currentMileage, null)
    await run("READING", { mileage: 10000, expectedRevision: 0 })
    const start = await run("START", { mileage: 10000, expectedRevision: 1 })
    await run("END", { mileage: 10500, expectedRevision: 2, tripId: start.receipt.tripId })
    await run("CORRECTION", { mileage: 10100, expectedRevision: 3, entryId: start.receipt.entryId, expectedEffectiveEntryId: start.receipt.entryId, reason: "Relecture du départ" })
    const corrected = await readMileage(f.truck.id, f.deps())
    assert.equal(corrected.trips[0].distance, 400)
    assert.equal(corrected.currentMileage, 10500)
    assert.equal(corrected.mileageRevision, 4)
    const key = randomUUID(), body = { mileage: 11000, expectedRevision: 4 }
    const concurrent = await Promise.all([run("READING", body, key), run("READING", body, key)])
    assert.deepEqual(concurrent[0].receipt, concurrent[1].receipt)
    assert.deepEqual(concurrent.map(x => x.replayed).sort(), [false, true])
    assert.equal(await db.mileageEntry.count({ where: { truckId: f.truck.id } }), 5)
    await assert.rejects(run("READING", { mileage: 11001, expectedRevision: 4 }, key), /IDEMPOTENCY_CONFLICT/)

    await updateMaintenancePlan(f.truck.id, { intervalKm: 2000, intervalMonths: null, expectedRevision: 0 }, f.deps())
    const oil = { kind: "OIL_CHANGE", mileage: 10000, occurredAt: "2020-01-01T00:00:00Z", notes: "Historique importé" }
    const oilKey = randomUUID()
    const entries = await Promise.all([recordMaintenance(f.truck.id, oil, oilKey, f.deps()), recordMaintenance(f.truck.id, oil, oilKey, f.deps())])
    assert.equal(entries[0].entryId, entries[1].entryId)
    assert.deepEqual(entries.map(x => x.replayed).sort(), [false, true])
    assert.equal((await readMaintenance(f.truck.id, f.deps())).summary.status, "SOON")
    await run("READING", { mileage: 12000, expectedRevision: 5 })
    assert.equal((await readMaintenance(f.truck.id, f.deps())).summary.status, "DUE")
    const conflicts = await Promise.allSettled([
      updateMaintenancePlan(f.truck.id, { intervalKm: 3000, intervalMonths: null, expectedRevision: 1 }, f.deps()),
      updateMaintenancePlan(f.truck.id, { intervalKm: 4000, intervalMonths: null, expectedRevision: 1 }, f.deps()),
    ])
    assert.equal(conflicts.filter(x => x.status === "fulfilled").length, 1)
    assert.match(String((conflicts.find(x => x.status === "rejected") as PromiseRejectedResult).reason), /MAINTENANCE_PLAN_CONFLICT/)
    assert.equal((await readMileage(f.truck.id, f.deps())).currentMileage, 12000)

    await assert.rejects(readMileage(f.otherTruck.id, f.deps()), /TRUCK_NOT_FOUND/)
    assert.equal((await readMileage(f.otherTruck.id, f.deps(f.session(f.otherCompany.id)))).currentMileage, null)
    assert.equal((await readMileage(f.truck.id, f.deps(f.session(f.company.id, f.global.id, "SUPER_ADMIN")))).currentMileage, 12000)
    await db.employee.updateMany({ where: { userId: f.user.id, companyId: f.otherCompany.id }, data: { active: false } })
    await assert.rejects(readMileage(f.otherTruck.id, f.deps(f.session(f.otherCompany.id))), /FORBIDDEN|UNAUTHENTICATED/)

    await assert.rejects(db.$executeRaw`UPDATE "mileage_entries" SET "mileage" = "mileage" WHERE "id" = ${start.receipt.entryId}`, (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === "23514")
    await assert.rejects(db.$executeRaw`DELETE FROM "mileage_entries" WHERE "id" = ${start.receipt.entryId}`, (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === "23514")
    await assert.rejects(db.$executeRaw`UPDATE "vehicle_maintenance_entries" SET "notes" = 'changed' WHERE "id" = ${entries[0].entryId}`, (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === "23514")
    await assert.rejects(db.$executeRaw`DELETE FROM "vehicle_maintenance_entries" WHERE "id" = ${entries[0].entryId}`, (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === "23514")
    await assert.rejects(db.$executeRaw`INSERT INTO "vehicle_maintenance_entries" ("id", "companyId", "truckId", "kind", "occurredAt", "mileage", "createdById", "createdByNameSnapshot", "idempotencyKey", "requestHash") VALUES (${randomUUID()}, ${f.otherCompany.id}, ${f.truck.id}, 'OIL_CHANGE', NOW(), 100, ${f.user.id}, 'Test', ${randomUUID()}, ${"a".repeat(64)})`, (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === "23503")
    await db.truck.update({ where: { id: f.truck.id }, data: { active: false, archivedAt: new Date() } })
    await assert.rejects(run("READING", { mileage: 12001, expectedRevision: 6 }), /TRUCK_ARCHIVED/)
    await assert.rejects(recordMaintenance(f.truck.id, oil, randomUUID(), f.deps()), /TRUCK_ARCHIVED/)
    await assert.rejects(updateMaintenancePlan(f.truck.id, { intervalKm: 5000, intervalMonths: null, expectedRevision: 2 }, f.deps()), /TRUCK_ARCHIVED/)
    assert.equal((await readMileage(f.truck.id, f.deps())).history.length, 6)
  } finally { await db.$disconnect() }
})
