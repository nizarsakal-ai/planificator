import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { addMaintenanceMonths, maintenanceSummary, parseMaintenanceEntry, parseMaintenancePlan, validateMaintenanceEntry } from "@/lib/vehicules/maintenance-domain"
const now = new Date("2026-10-24T12:00:00Z")
const oil = { kind: "OIL_CHANGE", occurredAt: new Date("2026-04-24T12:00:00Z"), mileage: 10000 }
describe("maintenance domain", () => {
  it("validates strictly, refuses tenant/actor injection and impossible plans", () => {
    const key = "00000000-0000-4000-8000-000000000001"
    assert.equal(parseMaintenanceEntry({ ...oil, occurredAt: oil.occurredAt.toISOString() }, key).notes, null)
    for (const body of [{ ...oil, companyId: "other" }, { ...oil, mileage: -1 }, { ...oil, mileage: 1.5 }])
      assert.throws(() => parseMaintenanceEntry(body, key))
    assert.throws(() => parseMaintenanceEntry({}, "bad"), /INVALID_IDEMPOTENCY_KEY/)
    assert.throws(() => parseMaintenancePlan({ intervalKm: null, intervalMonths: null, expectedRevision: 0 }))
    assert.throws(() => parseMaintenancePlan({ intervalKm: 0, intervalMonths: 12, expectedRevision: 0 }))
  })
  it("supports historical insertions but checks both chronological neighbors and current odometer", () => {
    const candidate = { ...oil, occurredAt: new Date("2026-06-01Z"), mileage: 15000 }
    const later = { ...oil, occurredAt: new Date("2026-08-01Z"), mileage: 20000 }
    assert.doesNotThrow(() => validateMaintenanceEntry(candidate, [oil, later], 25000, now))
    assert.doesNotThrow(() => validateMaintenanceEntry(candidate, [], null, now))
    assert.throws(() => validateMaintenanceEntry({ ...candidate, mileage: 9999 }, [oil, later], 25000, now), /MAINTENANCE_MILEAGE_ORDER/)
    assert.throws(() => validateMaintenanceEntry({ ...candidate, mileage: 20001 }, [oil, later], 25000, now), /MAINTENANCE_MILEAGE_ORDER/)
    assert.throws(() => validateMaintenanceEntry(candidate, [], 10000, now), /MAINTENANCE_ABOVE_CURRENT_MILEAGE/)
    assert.throws(() => validateMaintenanceEntry({ ...candidate, occurredAt: new Date("2027-01-01Z") }, [], null, now), /MAINTENANCE_FUTURE_DATE/)
  })
  it("uses monotonic mileage before recording order for equal oil-change instants", () => {
    const older = { ...oil, recordedAt: new Date("2026-05-01Z") }
    const newer = { ...oil, mileage: 12000, recordedAt: new Date("2026-04-30Z") }
    assert.equal(maintenanceSummary({ intervalKm: 10000, intervalMonths: null }, [older, newer], 13000, now).nextMileage, 22000)
    assert.equal(maintenanceSummary({ intervalKm: 10000, intervalMonths: null }, [older], null, now).remainingKm, null)
  })
  it("refuses regression at equal intervention dates and allows equal/increasing mileage", () => {
    assert.throws(() => validateMaintenanceEntry({ ...oil, mileage: 9999 }, [oil], 20000, now), /MAINTENANCE_MILEAGE_ORDER/)
    assert.doesNotThrow(() => validateMaintenanceEntry({ ...oil }, [oil], 20000, now))
    assert.doesNotThrow(() => validateMaintenanceEntry({ ...oil, mileage: 11000 }, [oil], 20000, now))
  })
  it("never reports up-to-date with an unknown or contradictory odometer", () => {
    const kmOnly = { intervalKm: 10000, intervalMonths: null }
    assert.equal(maintenanceSummary(kmOnly, [oil], null, now).status, "UNKNOWN_MILEAGE")
    assert.equal(maintenanceSummary({ intervalKm: 10000, intervalMonths: 12 }, [oil], null, now).status, "UNKNOWN_MILEAGE")
    assert.equal(maintenanceSummary(kmOnly, [oil], 9999, now).status, "INCONSISTENT_MILEAGE")
    // A time deadline remains actionable even when the kilometer deadline is unknown.
    assert.equal(maintenanceSummary({ intervalKm: 10000, intervalMonths: 6 }, [oil], null, now).status, "DUE")
  })
  it("clamps calendar month ends and keeps UTC time", () => {
    assert.equal(addMaintenanceMonths(new Date("2024-01-31T10:30:00Z"), 1).toISOString(), "2024-02-29T10:30:00.000Z")
    assert.equal(addMaintenanceMonths(new Date("2023-01-31T10:30:00Z"), 1).toISOString(), "2023-02-28T10:30:00.000Z")
  })
  it("uses either due criterion and only oil changes reset the schedule", () => {
    const plan = { intervalKm: 10000, intervalMonths: 12 }
    assert.equal(maintenanceSummary(null, [], null, now).status, "NOT_CONFIGURED")
    assert.equal(maintenanceSummary(plan, [], null, now).status, "NO_HISTORY")
    assert.equal(maintenanceSummary(plan, [oil], 18000, now).status, "OK")
    assert.equal(maintenanceSummary(plan, [oil], 19000, now).status, "SOON")
    assert.equal(maintenanceSummary(plan, [oil], 20000, now).status, "DUE")
    assert.equal(maintenanceSummary({ intervalKm: null, intervalMonths: 6 }, [oil], null, now).status, "DUE")
    assert.equal(maintenanceSummary({ intervalKm: null, intervalMonths: 7 }, [oil], null, new Date("2026-10-25T12:00:00Z")).status, "SOON")
    assert.equal(maintenanceSummary(plan, [oil, { kind: "SERVICE", occurredAt: now, mileage: 20000 }], 20000, now).nextMileage, 20000)
  })
})
