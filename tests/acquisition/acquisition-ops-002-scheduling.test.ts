/**
 * PLAN-ACQ-OPS-002 — vercel.json Hobby-safe + routes + doc scheduling externe.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
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

const BOOKING_ONLY: Record<string, string> = {
  "/api/cron/chantiers": "0 5 * * *",
  "/api/cron/gmail-scan": "0 8 * * *",
}

const ACQUISITION_PATHS = [
  "/api/cron/acquisition-gmail-sync",
  "/api/cron/acquisition-attachment-download",
  "/api/cron/acquisition-attachment-recovery",
] as const

const ACQUISITION_ROUTES = [
  "src/app/api/cron/acquisition-gmail-sync/route.ts",
  "src/app/api/cron/acquisition-attachment-download/route.ts",
  "src/app/api/cron/acquisition-attachment-recovery/route.ts",
] as const

const DOC = "docs/acquisition-ops-002-scheduling.md"

describe("PLAN-ACQ-OPS-002 vercel.json (Hobby-safe)", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as VercelJson

  it("contient uniquement les deux crons Booking/chantiers existants", () => {
    assert.ok(Array.isArray(config.crons))
    assert.equal(config.crons.length, 2)
    const byPath = Object.fromEntries(config.crons.map((c) => [c.path, c.schedule]))
    for (const [path, schedule] of Object.entries(BOOKING_ONLY)) {
      assert.equal(byPath[path], schedule, `cron inchangé: ${path}`)
    }
  })

  it("ne déclare aucun path Acquisition", () => {
    const paths = config.crons.map((c) => c.path)
    for (const path of ACQUISITION_PATHS) {
      assert.equal(paths.includes(path), false, `Acquisition absent de vercel.json: ${path}`)
    }
  })

  it("n’introduit pas de doublon de path", () => {
    const paths = config.crons.map((c) => c.path)
    assert.equal(new Set(paths).size, paths.length)
  })
})

describe("PLAN-ACQ-OPS-002 routes Acquisition", () => {
  for (const rel of ACQUISITION_ROUTES) {
    it(`${rel} existe et exporte maxDuration = 300`, () => {
      const abs = join(ROOT, rel)
      assert.equal(existsSync(abs), true, `route manquante: ${rel}`)
      const src = readFileSync(abs, "utf8")
      assert.match(src, /export const maxDuration = 300\b/)
    })
  }
})

describe("PLAN-ACQ-OPS-002 documentation scheduling externe", () => {
  const doc = readFileSync(join(ROOT, DOC), "utf8")

  it("documente Vercel Hobby et les fréquences cibles externes", () => {
    assert.match(doc, /Vercel Hobby/i)
    assert.match(doc, /\*\/15 \* \* \* \*/)
    assert.match(doc, /5,20,35,50 \* \* \* \*/)
    assert.match(doc, /40 \* \* \* \*/)
    assert.match(doc, /Raspberry Pi|ordonnanceur externe/i)
  })

  it("ne présente pas le scheduler externe comme déjà configuré", () => {
    assert.doesNotMatch(doc, /scheduler externe (est|déjà) (configuré|actif|déployé)/i)
    assert.match(doc, /non configuré|pas encore|non réalisée|Aucun cron Acquisition n’est actif/i)
  })
})
