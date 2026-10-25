import { executeMileageCommand } from "../../src/lib/vehicules/mileage-service"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { fixture } from "./pg/fixtures"
import { correctMaintenance, readMaintenance, recordMaintenance, updateMaintenancePlan } from "../../src/lib/vehicules/maintenance-service"
const value = process.env.MAINTENANCE_CORRECTIONS_DATABASE_URL ?? ""
const url = new URL(value)
if (url.hostname !== "127.0.0.1" || url.port !== "55433" || url.pathname !== "/v3_reprise_20261025" || url.username !== "vehicule_test" || url.search || url.hash) throw new Error("Only the dedicated local maintenance correction database is permitted")
const db = new PrismaClient({ datasources: { db: { url: value } } })
test("maintenance corrections remain append-only and serialize concurrent edits", { timeout: 60000 }, async () => {
  try {
    const f = await fixture(db)
    await executeMileageCommand(f.truck.id, "READING", { mileage: 20000, expectedRevision: 0 }, randomUUID(), f.deps())
    const entry = { kind: "OIL_CHANGE", mileage: 10000, occurredAt: "2026-08-01T00:00:00Z", notes: "Recette synthétique" }
    await updateMaintenancePlan(f.truck.id, { intervalKm: 10000, intervalMonths: 12, expectedRevision: 0 }, f.deps())
    const original = await recordMaintenance(f.truck.id, entry, randomUUID(), f.deps())
    const before = await db.vehicleMaintenanceEntry.findUniqueOrThrow({ where: { id: original.entryId } })
    const command = { ...entry, mileage: 15000, reason: "Corriger la saisie de recette" }
    const results = await Promise.allSettled([correctMaintenance(f.truck.id, original.entryId, command, randomUUID(), f.deps()), correctMaintenance(f.truck.id, original.entryId, { ...command, mileage: 16000 }, randomUUID(), f.deps())])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /MAINTENANCE_CORRECTION_CONFLICT/)
    assert.deepEqual(await db.vehicleMaintenanceEntry.findUniqueOrThrow({ where: { id: original.entryId } }), before)
    const dto = await readMaintenance(f.truck.id, f.deps())
    assert.equal(dto.history.length, 2)
    assert.equal(dto.history.filter(item => item.isEffective).length, 1)
    assert.ok([25000, 26000].includes(dto.summary.nextMileage!))
    const effective = dto.history.find(item => item.isEffective)!
    const nextKey = randomUUID()
    const next = await correctMaintenance(f.truck.id, effective.id, { ...command, mileage: 17000 }, nextKey, f.deps())
    assert.equal((await correctMaintenance(f.truck.id, effective.id, { ...command, mileage: 17000 }, nextKey, f.deps())).replayed, true)
    assert.equal((await readMaintenance(f.truck.id, f.deps())).summary.nextMileage, 27000)
    await assert.rejects(correctMaintenance(f.otherTruck.id, next.entryId, command, randomUUID(), f.deps(f.session(f.otherCompany.id))), /MAINTENANCE_ENTRY_NOT_FOUND/)
    await assert.rejects(db.vehicleMaintenanceEntry.update({ where: { id: original.entryId }, data: { mileage: 1 } }), /IMMUTABLE/)
    await assert.rejects(db.vehicleMaintenanceEntry.create({ data: { ...before, id: randomUUID(), idempotencyKey: randomUUID(), supersedesEntryId: next.entryId, truckId: f.otherTruck.id, companyId: f.otherCompany.id, correctionReason: "Wrong tenant" } }))
    assert.equal((await db.truck.findUniqueOrThrow({ where: { id: f.truck.id } })).currentMileage, 20000)
  } finally { await db.$disconnect() }
})
