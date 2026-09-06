/**
 * PLAN-ACQ-CONSULTATION-TEMPORAL-POLICY — tests helper classification.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  classifyWorkPeriod,
  instantToParisCalendarYmd,
} from "@/lib/acquisition/policy/work-period-classification"

function utcDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`)
}

describe("classifyWorkPeriod", () => {
  const ref = new Date("2026-09-06T12:00:00.000Z") // samedi, Europe/Paris = 06/09/2026

  it("1. start future / end future → FUTURE", () => {
    assert.equal(
      classifyWorkPeriod(utcDay("2026-10-01"), utcDay("2026-10-15"), ref),
      "FUTURE"
    )
  })

  it("2. start passée / end future → ACTIVE", () => {
    assert.equal(
      classifyWorkPeriod(utcDay("2026-09-01"), utcDay("2026-09-20"), ref),
      "ACTIVE"
    )
  })

  it("3. start aujourd’hui / end aujourd’hui → ACTIVE", () => {
    assert.equal(
      classifyWorkPeriod(utcDay("2026-09-06"), utcDay("2026-09-06"), ref),
      "ACTIVE"
    )
  })

  it("4. start passée / end hier → OBSOLETE", () => {
    assert.equal(
      classifyWorkPeriod(utcDay("2026-08-01"), utcDay("2026-09-05"), ref),
      "OBSOLETE"
    )
  })

  it("5. NULL/NULL → UNKNOWN_DATES", () => {
    assert.equal(classifyWorkPeriod(null, null, ref), "UNKNOWN_DATES")
  })

  it("6. date/NULL → INVALID", () => {
    assert.equal(classifyWorkPeriod(utcDay("2026-09-01"), null, ref), "INVALID")
  })

  it("7. NULL/date → INVALID", () => {
    assert.equal(classifyWorkPeriod(null, utcDay("2026-09-01"), ref), "INVALID")
  })

  it("8. start > end → INVALID", () => {
    assert.equal(
      classifyWorkPeriod(utcDay("2026-09-20"), utcDay("2026-09-01"), ref),
      "INVALID"
    )
  })

  it("changement de jour Europe/Paris vs UTC", () => {
    const end = utcDay("2026-09-06")
    // 06/09/2026 21:30 UTC = encore 06/09 23:30 Paris (CEST) → ACTIVE
    const stillParis6 = new Date("2026-09-06T21:30:00.000Z")
    assert.equal(instantToParisCalendarYmd(stillParis6), "2026-09-06")
    assert.equal(classifyWorkPeriod(end, end, stillParis6), "ACTIVE")

    // 06/09/2026 22:30 UTC = 07/09 00:30 Paris → OBSOLETE
    const paris7 = new Date("2026-09-06T22:30:00.000Z")
    assert.equal(instantToParisCalendarYmd(paris7), "2026-09-07")
    assert.equal(classifyWorkPeriod(end, end, paris7), "OBSOLETE")
  })

  it("frontière Europe/Paris en hiver (CET UTC+1)", () => {
    const end = utcDay("2026-01-15")
    // 15/01/2026 22:30 UTC = 15/01 23:30 Paris (CET) → ACTIVE
    const stillParis15 = new Date("2026-01-15T22:30:00.000Z")
    assert.equal(instantToParisCalendarYmd(stillParis15), "2026-01-15")
    assert.equal(classifyWorkPeriod(end, end, stillParis15), "ACTIVE")

    // 15/01/2026 23:30 UTC = 16/01 00:30 Paris → OBSOLETE
    const paris16 = new Date("2026-01-15T23:30:00.000Z")
    assert.equal(instantToParisCalendarYmd(paris16), "2026-01-16")
    assert.equal(classifyWorkPeriod(end, end, paris16), "OBSOLETE")
  })
})
