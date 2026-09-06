/**
 * PLAN-ACQ-PROVIDENCE-DATES-004 — update NULL/NULL vs create manuel dates obligatoires.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createChantierSchema,
  updateChantierSchema,
  updateDateFieldToDb,
} from "@/lib/validations/chantier"

const baseUpdate = {
  name: "LYCEE LA PROVIDENCE 49",
  description: "Consultation devis",
  address: "33 AVENUE GUSTAVE FERRIE",
  clientId: "c1",
  dailyHours: "10",
}

describe("chantier create vs update — dates nullable", () => {
  it("1. create manuel sans dates → refusé", () => {
    const r = createChantierSchema.safeParse({
      name: "Site",
      clientId: "c1",
      startDate: "",
      endDate: "",
      dailyHours: "10",
    })
    assert.equal(r.success, false)
  })

  it("2. update null/null (\"\") → accepté", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "",
      endDate: "",
    })
    assert.equal(r.success, true)
    if (r.success) {
      assert.equal(r.data.startDate, null)
      assert.equal(r.data.endDate, null)
    }
  })

  it("3. update autre champ avec dates null/null → dates restent null", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      name: "Nom modifié",
      startDate: null,
      endDate: null,
    })
    assert.equal(r.success, true)
    if (r.success) {
      assert.equal(r.data.name, "Nom modifié")
      assert.equal(r.data.startDate, null)
      assert.equal(r.data.endDate, null)
      assert.equal(updateDateFieldToDb(r.data.startDate), null)
      assert.equal(updateDateFieldToDb(r.data.endDate), null)
    }
  })

  it("4. update DATE/NULL → refusé", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "2026-10-01",
      endDate: "",
    })
    assert.equal(r.success, false)
  })

  it("5. update NULL/DATE → refusé", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "",
      endDate: "2026-10-15",
    })
    assert.equal(r.success, false)
  })

  it("6. update start > end → refusé", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "2026-10-15",
      endDate: "2026-10-01",
    })
    assert.equal(r.success, false)
  })

  it("7. update deux dates valides → accepté", () => {
    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "2026-10-01",
      endDate: "2026-10-15",
    })
    assert.equal(r.success, true)
    if (r.success) {
      assert.equal(r.data.startDate, "2026-10-01")
      assert.equal(r.data.endDate, "2026-10-15")
      const start = updateDateFieldToDb(r.data.startDate)
      const end = updateDateFieldToDb(r.data.endDate)
      assert.ok(start instanceof Date)
      assert.ok(end instanceof Date)
      assert.equal(Number.isNaN(start!.getTime()), false)
      assert.equal(Number.isNaN(end!.getTime()), false)
    }
  })

  it("8. aucune date fallback générée depuis \"\" / null", () => {
    assert.equal(updateDateFieldToDb(null), null)

    const r = updateChantierSchema.safeParse({
      ...baseUpdate,
      startDate: "   ",
      endDate: "   ",
    })
    assert.equal(r.success, true)
    if (r.success) {
      assert.equal(r.data.startDate, null)
      assert.equal(r.data.endDate, null)
      assert.equal(updateDateFieldToDb(r.data.startDate), null)
      assert.equal(updateDateFieldToDb(r.data.endDate), null)
    }
  })
})
