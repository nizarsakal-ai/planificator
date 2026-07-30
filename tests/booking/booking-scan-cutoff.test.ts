/**
 * PLAN-BOOKING-FINAL LOT 2B — cutoff Booking configurable.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BOOKING_SCAN_CUTOFF_DEFAULT_YMD,
  getBookingScanCutoffDate,
} from "@/lib/booking/booking-scan-cutoff"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

describe("getBookingScanCutoffDate", () => {
  const prev = process.env.BOOKING_SCAN_CUTOFF_DATE

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_SCAN_CUTOFF_DATE
    else process.env.BOOKING_SCAN_CUTOFF_DATE = prev
  })

  it("variable absente → 2026-06-17 UTC", () => {
    delete process.env.BOOKING_SCAN_CUTOFF_DATE
    const d = getBookingScanCutoffDate()
    assert.equal(d.toISOString(), "2026-06-17T00:00:00.000Z")
    assert.equal(BOOKING_SCAN_CUTOFF_DEFAULT_YMD, "2026-06-17")
  })

  it("variable vide → défaut", () => {
    process.env.BOOKING_SCAN_CUTOFF_DATE = "  "
    assert.equal(getBookingScanCutoffDate().toISOString(), "2026-06-17T00:00:00.000Z")
  })

  it("format incorrect → défaut", () => {
    for (const v of ["2026/06/17", "17-06-2026", "2026-6-17", "not-a-date", "20260617"]) {
      process.env.BOOKING_SCAN_CUTOFF_DATE = v
      assert.equal(
        getBookingScanCutoffDate().toISOString(),
        "2026-06-17T00:00:00.000Z",
        `fallback pour ${v}`
      )
    }
  })

  it("date impossible (2026-02-30) → défaut", () => {
    process.env.BOOKING_SCAN_CUTOFF_DATE = "2026-02-30"
    assert.equal(getBookingScanCutoffDate().toISOString(), "2026-06-17T00:00:00.000Z")
  })

  it("date valide → date configurée UTC déterministe", () => {
    process.env.BOOKING_SCAN_CUTOFF_DATE = "2026-07-01"
    const d = getBookingScanCutoffDate()
    assert.equal(d.toISOString(), "2026-07-01T00:00:00.000Z")
    assert.equal(d.getUTCFullYear(), 2026)
    assert.equal(d.getUTCMonth(), 6)
    assert.equal(d.getUTCDate(), 1)
  })

  it("n’altère pas process.env", () => {
    process.env.BOOKING_SCAN_CUTOFF_DATE = "bad"
    getBookingScanCutoffDate()
    assert.equal(process.env.BOOKING_SCAN_CUTOFF_DATE, "bad")
  })
})

describe("gmail-scan LOT2B wiring", () => {
  it("utilise getBookingScanCutoffDate ; plus de new Date(\"2026-06-17\")", () => {
    const src = readFileSync(join(ROOT, "src/app/api/cron/gmail-scan/route.ts"), "utf8")
    assert.match(src, /getBookingScanCutoffDate/)
    assert.equal(src.includes('new Date("2026-06-17")'), false)
    assert.equal(src.includes("new Date('2026-06-17')"), false)
  })

  it("route agent inchangée (cutoff local éventuel hors lot)", () => {
    const agent = readFileSync(join(ROOT, "src/app/api/booking/agent/route.ts"), "utf8")
    assert.equal(agent.includes("getBookingScanCutoffDate"), false)
  })
})
