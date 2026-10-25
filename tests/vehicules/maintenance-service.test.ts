import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Prisma } from "@prisma/client"
import { handleMaintenanceGet, handleMaintenancePlanPut, handleMaintenancePost } from "@/lib/vehicules/maintenance-api"
import { correctMaintenance, readMaintenance, recordMaintenance, updateMaintenancePlan, type MaintenanceServiceDeps } from "@/lib/vehicules/maintenance-service"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import { ADMIN, LEADER, NEXT_LEADER, MileageMemoryDb, SERVER_NOW, TRUCK } from "./mileage-test-db"
type Row = Record<string, unknown>
class MaintenanceDb {
  base = new MileageMemoryDb()
  entries: Row[] = []
  plans: Row[] = []
  deps(session: MileageSession | null = ADMIN): MaintenanceServiceDeps {
    return { auth: async () => session, db: { $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => {
      const entries = structuredClone(this.entries), plans = structuredClone(this.plans)
      const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v)
      const model = (rows: Row[]) => ({
        findFirst: async ({ where }: { where: Row }) => rows.find(row => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Row }) => rows.filter(row => matches(row, where)).sort((a, b) => +(b.occurredAt as Date) - +(a.occurredAt as Date)),
        create: async ({ data }: { data: Row }) => { const row = { id: `item-${rows.length}`, recordedAt: new Date("2000-01-01T00:00:00Z"), updatedAt: SERVER_NOW, ...data }; rows.push(row); return row },
        update: async ({ where, data }: { where: Row; data: Row }) => { const row = rows.find(row => matches(row, where))!; Object.assign(row, data); return row },
      })
      const result = await this.base.$transaction(tx => callback(Object.assign(tx, { vehicleMaintenanceEntry: model(entries), vehicleMaintenancePlan: model(plans) })), options)
      this.entries = entries; this.plans = plans
      return result
    } } as unknown as MaintenanceServiceDeps["db"] }
  }
}
const key = "00000000-0000-4000-8000-000000000001"
const entry = { kind: "OIL_CHANGE", mileage: 10000, occurredAt: "2026-08-01T00:00:00Z", notes: "Vidange filtre" }
const plan = { intervalKm: 10000, intervalMonths: 12, expectedRevision: 0 }
const request = (body: unknown, method = "POST") => new Request("https://test.invalid", { method, headers: { "Idempotency-Key": key }, body: JSON.stringify(body) })
describe("maintenance service and HTTP", () => {
  it("records immutable history, replays idempotently and never changes odometer", async () => {
    const db = new MaintenanceDb()
    db.base.state.trucks[0].currentMileage = 15000
    const before = structuredClone(db.base.state.trucks[0])
    const first = await recordMaintenance(TRUCK, entry, key, db.deps())
    assert.equal(first.replayed, false)
    assert.deepEqual(await recordMaintenance(TRUCK, entry, key, db.deps()), { ...first, replayed: true })
    await assert.rejects(recordMaintenance(TRUCK, { ...entry, mileage: 9999 }, key, db.deps()), /IDEMPOTENCY_CONFLICT/)
    assert.equal(db.entries.length, 1)
    assert.deepEqual(db.entries[0].recordedAt, SERVER_NOW)
    assert.deepEqual(db.base.state.trucks[0], before)
    const dto = await readMaintenance(TRUCK, db.deps())
    assert.equal(dto.history.length, 1)
    assert.equal(JSON.stringify(dto).includes("requestHash"), false)
    assert.equal(JSON.stringify(dto).includes("companyId"), false)
  })
  it("appends audited intervention corrections, projects the effective version, and rejects stale or foreign edits", async () => {
    const db = new MaintenanceDb()
    db.base.state.trucks[0].currentMileage = 20000
    await updateMaintenancePlan(TRUCK, plan, db.deps())
    const original = await recordMaintenance(TRUCK, entry, key, db.deps())
    const originalRow = structuredClone(db.entries[0])
    const correction = { ...entry, mileage: 15000, reason: "Erreur du compteur saisi" }
    const correctionKey = key.replace(/1$/, "2")
    const saved = await correctMaintenance(TRUCK, original.entryId, correction, correctionKey, db.deps())
    assert.deepEqual(db.entries[0], originalRow)
    assert.equal(db.entries.length, 2)
    assert.equal(db.entries[1].supersedesEntryId, original.entryId)
    assert.equal(db.entries[1].correctionReason, correction.reason)
    assert.equal((await readMaintenance(TRUCK, db.deps())).summary.nextMileage, 25000)
    assert.deepEqual(await correctMaintenance(TRUCK, original.entryId, correction, correctionKey, db.deps()), { ...saved, replayed: true })
    await assert.rejects(correctMaintenance(TRUCK, original.entryId, correction, key.replace(/1$/, "3"), db.deps()), /MAINTENANCE_CORRECTION_CONFLICT/)
    await assert.rejects(correctMaintenance(TRUCK, saved.entryId, correction, key.replace(/1$/, "4"), db.deps(LEADER)), /FORBIDDEN/)
    await assert.rejects(correctMaintenance(TRUCK, "foreign", correction, key.replace(/1$/, "4"), db.deps()), /MAINTENANCE_ENTRY_NOT_FOUND/)
    await assert.rejects(correctMaintenance(TRUCK, saved.entryId, { ...correction, reason: " " }, key.replace(/1$/, "4"), db.deps()), /INVALID_PAYLOAD/)
    await assert.rejects(correctMaintenance(TRUCK, saved.entryId, { ...correction, mileage: 20001 }, key.replace(/1$/, "4"), db.deps()), /MAINTENANCE_ABOVE_CURRENT_MILEAGE/)
    const dto = await readMaintenance(TRUCK, db.deps())
    assert.equal(dto.history.find(item => item.id === original.entryId)?.isEffective, false)
    assert.equal(dto.history.find(item => item.id === saved.entryId)?.isEffective, true)
  })
  it("uses current roles, team ownership, tenant boundaries, and archival rules", async () => {
    const db = new MaintenanceDb()
    await assert.rejects(recordMaintenance(TRUCK, entry, key, db.deps(LEADER)), /FORBIDDEN/)
    await assert.rejects(readMaintenance(TRUCK, db.deps(NEXT_LEADER)), /TRUCK_NOT_FOUND/)
    await assert.rejects(readMaintenance("truck-b", db.deps()), /TRUCK_NOT_FOUND/)
    await assert.rejects(readMaintenance(TRUCK, db.deps(null)), /UNAUTHENTICATED/)
    await recordMaintenance(TRUCK, entry, key, db.deps())
    db.base.state.trucks[0].active = false
    assert.equal((await recordMaintenance(TRUCK, entry, key, db.deps())).replayed, true)
    await assert.rejects(recordMaintenance(TRUCK, entry, key.replace(/1$/, "2"), db.deps()), /TRUCK_ARCHIVED/)
    await assert.rejects(updateMaintenancePlan(TRUCK, plan, db.deps()), /TRUCK_ARCHIVED/)
    assert.equal((await readMaintenance(TRUCK, db.deps())).history.length, 1)
  })
  it("rechecks actor activation and rejects invalid writes without partial history", async () => {
    const db = new MaintenanceDb()
    db.base.state.users[0].active = false
    await assert.rejects(recordMaintenance(TRUCK, entry, key, db.deps()), /UNAUTHENTICATED/)
    db.base.state.users[0].active = true
    db.base.state.users[0].role = "TEAM_LEADER"
    await assert.rejects(recordMaintenance(TRUCK, entry, key, db.deps()), /FORBIDDEN/)
    db.base.state.users[0].role = "ADMIN"
    db.base.state.trucks[0].currentMileage = 9000
    await assert.rejects(recordMaintenance(TRUCK, entry, key, db.deps()), /MAINTENANCE_ABOVE_CURRENT_MILEAGE/)
    assert.equal(db.entries.length, 0)
    assert.equal(db.plans.length, 0)
    assert.ok(db.base.calls.some(call => call.operation === "transaction.rollback"))
  })
  it("protects plan concurrency and returns computed due values", async () => {
    const db = new MaintenanceDb()
    db.base.state.trucks[0].currentMileage = 20000
    assert.equal((await updateMaintenancePlan(TRUCK, plan, db.deps()))?.revision, 1)
    assert.equal((await updateMaintenancePlan(TRUCK, plan, db.deps()))?.revision, 1)
    await assert.rejects(updateMaintenancePlan(TRUCK, { ...plan, intervalKm: 5000 }, db.deps()), /MAINTENANCE_PLAN_CONFLICT/)
    await recordMaintenance(TRUCK, entry, key, db.deps())
    const dto = await readMaintenance(TRUCK, db.deps())
    assert.equal(dto.summary.status, "DUE")
    assert.equal(dto.summary.remainingKm, 0)
    await assert.rejects(updateMaintenancePlan(TRUCK, { ...plan, expectedRevision: 1 }, db.deps(LEADER)), /FORBIDDEN/)
  })
  it("HTTP exposes safe errors and private cache headers", async () => {
    const db = new MaintenanceDb()
    const posted = await handleMaintenancePost(request(entry), TRUCK, db.deps())
    assert.equal(posted.status, 201)
    assert.equal(posted.headers.get("Idempotency-Replayed"), "false")
    assert.equal((await handleMaintenancePost(request(entry), TRUCK, db.deps())).headers.get("Idempotency-Replayed"), "true")
    const foreign = await handleMaintenanceGet("truck-b", db.deps())
    assert.equal(foreign.status, 404)
    assert.equal(foreign.headers.get("Cache-Control"), "private, no-store")
    assert.equal((await handleMaintenancePlanPut(request({ ...plan, companyId: "evil" }, "PUT"), TRUCK, db.deps())).status, 400)
    assert.equal((await handleMaintenancePost(new Request("https://test.invalid", { method: "POST", body: "{" }), TRUCK, db.deps())).status, 400)
    assert.equal(db.entries.length, 1)
  })
})
