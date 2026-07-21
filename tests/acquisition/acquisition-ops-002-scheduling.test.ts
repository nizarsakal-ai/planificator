/**
 * PLAN-ACQ-OPS-002 — Config scheduling Vercel + budgets route.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

interface VercelCron {
  path: string
  schedule: string
}

interface VercelJson {
  crons: VercelCron[]
}

const EXPECTED_ACQUISITION: Record<string, string> = {
  "/api/cron/acquisition-gmail-sync": "*/15 * * * *",
  "/api/cron/acquisition-attachment-download": "5,20,35,50 * * * *",
  "/api/cron/acquisition-attachment-recovery": "40 * * * *",
}

const BOOKING_UNCHANGED: Record<string, string> = {
  "/api/cron/chantiers": "0 5 * * *",
  "/api/cron/gmail-scan": "0 8 * * *",
}

describe("PLAN-ACQ-OPS-002 vercel.json scheduling", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as VercelJson

  it("contient exactement les crons Booking + Acquisition attendus", () => {
    assert.ok(Array.isArray(config.crons))
    const byPath = Object.fromEntries(config.crons.map((c) => [c.path, c.schedule]))
    for (const [path, schedule] of Object.entries(BOOKING_UNCHANGED)) {
      assert.equal(byPath[path], schedule, `Booking cron inchangé: ${path}`)
    }
    for (const [path, schedule] of Object.entries(EXPECTED_ACQUISITION)) {
      assert.equal(byPath[path], schedule, `Acquisition cron: ${path}`)
    }
    assert.equal(config.crons.length, 5)
  })

  it("n’introduit pas de doublon de path", () => {
    const paths = config.crons.map((c) => c.path)
    assert.equal(new Set(paths).size, paths.length)
  })
})

describe("PLAN-ACQ-OPS-002 route maxDuration", () => {
  const routes = [
    "src/app/api/cron/acquisition-gmail-sync/route.ts",
    "src/app/api/cron/acquisition-attachment-download/route.ts",
    "src/app/api/cron/acquisition-attachment-recovery/route.ts",
  ]

  for (const rel of routes) {
    it(`${rel} exporte maxDuration = 300`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8")
      assert.match(src, /export const maxDuration = 300\b/)
    })
  }
})
