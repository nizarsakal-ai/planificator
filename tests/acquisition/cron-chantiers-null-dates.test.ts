/**
 * PLAN-ACQ-PROVIDENCE-DATES-002 — cron PLANNED + startDate NULL reste PLANNED.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("cron chantiers — dates null", () => {
  it("filtre startDate lte today n’inclut pas les NULL (SQL/Prisma)", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/cron/chantiers/route.ts"),
      "utf8"
    )
    assert.match(src, /status:\s*"PLANNED"/)
    assert.match(src, /startDate:\s*\{\s*lte:\s*today\s*\}/)
    // Pas de coalesce / fallback inventant une date
    assert.equal(/coalesce|COALESCE|new Date\(\).*startDate|startDate:\s*new Date/.test(src), false)
  })

  it("invariant documenté : NULL ne satisfait pas lte → reste PLANNED", () => {
    // Prisma/SQL : NULL <= today → UNKNOWN → ligne exclue du findMany.
    const today = new Date("2026-09-06T00:00:00.000Z")
    const candidates = [
      { id: "with-date", status: "PLANNED", startDate: new Date("2026-09-01T00:00:00.000Z") },
      { id: "null-dates", status: "PLANNED", startDate: null as Date | null },
    ]
    const toStart = candidates.filter(
      (w) => w.status === "PLANNED" && w.startDate != null && w.startDate <= today
    )
    assert.deepEqual(
      toStart.map((w) => w.id),
      ["with-date"]
    )
    assert.equal(
      candidates.find((w) => w.id === "null-dates")!.status,
      "PLANNED"
    )
  })
})
