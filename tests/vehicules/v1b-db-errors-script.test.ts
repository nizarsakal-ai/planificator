// VEHICLES V1B-db — mapping P2004/CHECK et script legacy (aucune connexion DB).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { classifyCheckViolation, handleTruckPatch, type TrucksApiDeps } from "@/lib/vehicules/trucks-api"

const CHRONO = "truck_assignments_v1b_chronology_check"
const p2004 = (msg: string) => Object.assign(new Error("Invalid `prisma.x()` invocation"), { code: "P2004", meta: { database_error: msg } })

function patchWith(error: unknown) {
  const logged: unknown[] = []
  const deps: TrucksApiDeps = {
    auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-a" } }),
    db: {
      truck: { findFirst: async () => ({ id: "t1" }) },
      team: { findFirst: async () => null },
      employee: { findFirst: async () => null },
      $transaction: async () => {
        throw error
      },
    } as unknown as TrucksApiDeps["db"],
    logError: (...a) => {
      logged.push(a)
    },
  }
  return { deps, logged }
}

const patch = (deps: TrucksApiDeps) =>
  handleTruckPatch(new Request("http://x", { method: "PATCH", body: JSON.stringify({ matricule: "AB-1" }) }), "t1", deps)

describe("V1B-db — mapping CHECK chronologique", () => {
  it("P2004 nommant la CHECK → PERIOD_CONFLICT 409, sans fuite technique", async () => {
    const { deps, logged } = patchWith(p2004(`new row violates check constraint "${CHRONO}"`))
    const res = await patch(deps)
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.code, "PERIOD_CONFLICT")
    assert.ok(!JSON.stringify(body).includes(CHRONO))
    assert.equal(logged.length, 0)
  })

  it("SQLSTATE 23514 (brut) nommant la CHECK → PERIOD_CONFLICT", () => {
    assert.equal(classifyCheckViolation(Object.assign(new Error(`violates check constraint "${CHRONO}"`), { code: "23514" })), "PERIOD_CONFLICT")
  })

  it("CHECK sans code Prisma : message PostgreSQL + nom de contrainte", () => {
    assert.equal(classifyCheckViolation(new Error(`new row for relation "truck_assignments" violates check constraint "${CHRONO}"`)), "PERIOD_CONFLICT")
    assert.equal(classifyCheckViolation(new Error(CHRONO)), null)
  })

  it("autres CHECK / P2004 non identifiés → pas de faux 409 (500)", async () => {
    for (const err of [
      p2004('violates check constraint "truck_assignments_v1b_reason_required_check"'),
      p2004('violates check constraint "trucks_v1a_archived_unassigned_check"'),
      p2004("autre échec"),
      Object.assign(new Error(CHRONO), { code: "P9999" }),
    ]) {
      assert.equal(classifyCheckViolation(err), null)
      const { deps, logged } = patchWith(err)
      const res = await patch(deps)
      assert.equal(res.status, 500)
      assert.equal(logged.length, 1)
    }
  })

  it("erreur inconnue reste 500", async () => {
    assert.equal((await patch(patchWith(new Error("boom")).deps)).status, 500)
  })
})

describe("V1B-db — script legacy init-truck-history", () => {
  const src = readFileSync("scripts/init-truck-history.ts", "utf8")
  it("toute période créée porte reason: BACKFILL", () => {
    const creates = src.match(/truckAssignment\.create\(\{[\s\S]*?\n    \}\)/g) ?? []
    assert.equal(creates.length, 1)
    assert.match(creates[0], /reason: "BACKFILL"/)
    assert.ok(!/truckAssignment\.(createMany|upsert)/.test(src))
  })
})
