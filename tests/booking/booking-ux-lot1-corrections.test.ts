/**
 * CORR date-only + updatePendingAccommodationImpl (deps injectées).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  formatDateOnlyForInput,
  isCalendarRangeValid,
  parseStrictCalendarYmd,
} from "@/lib/booking/booking-date-only"
import {
  updatePendingAccommodationImpl,
  type UpdatePendingAccommodationDeps,
  type UpdatePendingDb,
} from "@/lib/actions/gmail-pending-update.core"

describe("booking-date-only", () => {
  it("parseStrictCalendarYmd accepte jours réels", () => {
    const d = parseStrictCalendarYmd("2026-08-15")
    assert.ok(d)
    assert.equal(d!.getUTCFullYear(), 2026)
    assert.equal(d!.getUTCMonth(), 7)
    assert.equal(d!.getUTCDate(), 15)
    assert.ok(parseStrictCalendarYmd("2026-01-15"))
    assert.ok(parseStrictCalendarYmd("2028-02-29"))
  })

  it("refuse dates calendaires impossibles", () => {
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2027-02-29",
      "26-08-15",
      "2026/08/15",
      "",
    ]) {
      assert.equal(parseStrictCalendarYmd(bad), null, bad)
    }
  })

  it("formatDateOnlyForInput : Date UTC minuit ne décale pas", () => {
    const utcMidnight = new Date(Date.UTC(2026, 7, 15))
    assert.equal(formatDateOnlyForInput(utcMidnight), "2026-08-15")
    assert.equal(formatDateOnlyForInput(new Date(Date.UTC(2026, 0, 15))), "2026-01-15")
  })

  it("formatDateOnlyForInput : string YYYY-MM-DD inchangée ; ISO UTC OK", () => {
    assert.equal(formatDateOnlyForInput("2026-08-15"), "2026-08-15")
    assert.equal(formatDateOnlyForInput("2026-08-15T00:00:00.000Z"), "2026-08-15")
    assert.equal(formatDateOnlyForInput(null), "")
  })

  it("round-trip sans édition : format → parse conserve le jour", () => {
    const stored = new Date(Date.UTC(2026, 7, 15))
    const input = formatDateOnlyForInput(stored)
    assert.equal(input, "2026-08-15")
    const again = parseStrictCalendarYmd(input)!
    assert.equal(formatDateOnlyForInput(again), "2026-08-15")
    assert.equal(again.getTime(), stored.getTime())
  })

  it("isCalendarRangeValid : même jour OK ; fin avant début KO", () => {
    const a = parseStrictCalendarYmd("2026-08-15")!
    const b = parseStrictCalendarYmd("2026-08-15")!
    const c = parseStrictCalendarYmd("2026-08-14")!
    assert.equal(isCalendarRangeValid(a, b), true)
    assert.equal(isCalendarRangeValid(a, c), false)
  })
})

function session(
  role: Role,
  companyId: string | null = "co1",
  id = "user-1"
) {
  return { user: { id, role, companyId } }
}

type PendingRow = {
  id: string
  companyId: string
  status: "PENDING" | "CONFIRMED" | "DISMISSED"
  startDate: Date | null
  endDate: Date | null
  address: string | null
  propertyName: string | null
  city?: string | null
  doorCode?: string | null
  notes?: string | null
}

function makeDb(seed: PendingRow[]) {
  const rows = seed.map((r) => ({ ...r }))
  let lastUpdateWhere: unknown = null
  let lastUpdateData: unknown = null

  const db: UpdatePendingDb & {
    rows: PendingRow[]
    getLastUpdate: () => { where: unknown; data: unknown }
  } = {
    rows,
    getLastUpdate: () => ({ where: lastUpdateWhere, data: lastUpdateData }),
    pendingAccommodation: {
      async findFirst({ where }) {
        return (
          rows.find((r) => r.id === where.id && r.companyId === where.companyId) ?? null
        )
      },
      async updateMany({ where, data }) {
        lastUpdateWhere = where
        lastUpdateData = data
        const idx = rows.findIndex(
          (r) =>
            r.id === where.id &&
            r.companyId === where.companyId &&
            r.status === where.status
        )
        if (idx < 0) return { count: 0 }
        Object.assign(rows[idx], data)
        return { count: 1 }
      },
    },
  }
  return db
}

function deps(
  over: Partial<UpdatePendingAccommodationDeps> & { db: ReturnType<typeof makeDb> }
): UpdatePendingAccommodationDeps {
  return {
    auth: async () => session("ADMIN"),
    revalidatePath: () => {},
    ...over,
    db: over.db,
  }
}

const pendingCo1: PendingRow = {
  id: "p1",
  companyId: "co1",
  status: "PENDING",
  startDate: new Date(Date.UTC(2026, 7, 15)),
  endDate: new Date(Date.UTC(2026, 7, 20)),
  address: "10 rue X",
  propertyName: "Appart",
}

describe("updatePendingAccommodationImpl — comportemental", () => {
  it("ADMIN même tenant → succès + updateMany gardé", async () => {
    const db = makeDb([pendingCo1])
    let revalidated = ""
    const r = await updatePendingAccommodationImpl(
      "p1",
      { address: "12 rue Y", city: "Lyon" },
      deps({
        db,
        auth: async () => session("ADMIN", "co1"),
        revalidatePath: (p) => {
          revalidated = p
        },
      })
    )
    assert.deepEqual(r, { success: true })
    assert.equal(db.rows[0].address, "12 rue Y")
    assert.equal(revalidated, "/logements")
    const { where } = db.getLastUpdate()
    assert.deepEqual(where, { id: "p1", companyId: "co1", status: "PENDING" })
  })

  it("SUPER_ADMIN avec companyId → succès", async () => {
    const db = makeDb([pendingCo1])
    const r = await updatePendingAccommodationImpl(
      "p1",
      { notes: "ok" },
      deps({ db, auth: async () => session("SUPER_ADMIN", "co1") })
    )
    assert.deepEqual(r, { success: true })
  })

  it("TEAM_LEADER → throw Accès refusé", async () => {
    const db = makeDb([pendingCo1])
    await assert.rejects(
      () =>
        updatePendingAccommodationImpl(
          "p1",
          { notes: "x" },
          deps({ db, auth: async () => session("TEAM_LEADER", "co1") })
        ),
      /Accès refusé/
    )
  })

  it("non authentifié → throw", async () => {
    const db = makeDb([pendingCo1])
    await assert.rejects(
      () =>
        updatePendingAccommodationImpl(
          "p1",
          { notes: "x" },
          deps({ db, auth: async () => null })
        ),
      /Non authentifié/
    )
  })

  it("autre tenant → introuvable, pas de fuite, pas d'update", async () => {
    const db = makeDb([pendingCo1])
    const r = await updatePendingAccommodationImpl(
      "p1",
      { address: "hack" },
      deps({ db, auth: async () => session("ADMIN", "co-other") })
    )
    assert.deepEqual(r, { error: "Réservation introuvable." })
    assert.equal(db.rows[0].address, "10 rue X")
    assert.equal(db.getLastUpdate().where, null)
  })

  it("CONFIRMED / DISMISSED → refus", async () => {
    const confirmed = { ...pendingCo1, id: "pc", status: "CONFIRMED" as const }
    const dismissed = { ...pendingCo1, id: "pd", status: "DISMISSED" as const }
    const db = makeDb([confirmed, dismissed])
    const r1 = await updatePendingAccommodationImpl(
      "pc",
      { address: "x" },
      deps({ db })
    )
    const r2 = await updatePendingAccommodationImpl(
      "pd",
      { address: "x" },
      deps({ db })
    )
    assert.equal("error" in r1 && r1.error.includes("déjà traitée"), true)
    assert.equal("error" in r2 && r2.error.includes("déjà traitée"), true)
  })

  it("champ protégé / inconnu (.strict) → refus validation", async () => {
    const db = makeDb([pendingCo1])
    const r = await updatePendingAccommodationImpl(
      "p1",
      { status: "CONFIRMED" } as never,
      deps({ db })
    )
    assert.equal("error" in r, true)
    assert.equal(db.rows[0].status, "PENDING")
  })

  it("chaînes vides → null ; date impossible refusée ; plage invalide refusée", async () => {
    const db = makeDb([pendingCo1])
    const empty = await updatePendingAccommodationImpl(
      "p1",
      { city: "   ", doorCode: "" },
      deps({ db })
    )
    assert.deepEqual(empty, { success: true })
    assert.equal(db.rows[0].city, null)
    assert.equal(db.rows[0].doorCode, null)

    const badDate = await updatePendingAccommodationImpl(
      "p1",
      { startDate: "2026-02-30" },
      deps({ db })
    )
    assert.equal("error" in badDate, true)

    const badRange = await updatePendingAccommodationImpl(
      "p1",
      { startDate: "2026-08-20", endDate: "2026-08-10" },
      deps({ db })
    )
    assert.equal("error" in badRange, true)
    assert.match(String((badRange as { error: string }).error), /arrivée/)
  })

  it("updateMany count=0 → erreur déjà traitée, pas de succès", async () => {
    const db = makeDb([pendingCo1])
    db.pendingAccommodation.updateMany = async () => ({ count: 0 })
    const r = await updatePendingAccommodationImpl(
      "p1",
      { notes: "race" },
      deps({ db })
    )
    assert.deepEqual(r, {
      error: "Réservation déjà traitée — modification impossible.",
    })
  })

  it("sauvegarde date sans décalage calendaire", async () => {
    const db = makeDb([pendingCo1])
    const displayed = formatDateOnlyForInput(pendingCo1.startDate)
    assert.equal(displayed, "2026-08-15")
    const r = await updatePendingAccommodationImpl(
      "p1",
      { startDate: displayed, endDate: "2026-08-20" },
      deps({ db })
    )
    assert.deepEqual(r, { success: true })
    assert.equal(formatDateOnlyForInput(db.rows[0].startDate), "2026-08-15")
    assert.equal(db.rows[0].startDate!.getUTCDate(), 15)
  })
})
