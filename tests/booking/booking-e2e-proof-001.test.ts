/**
 * PLAN-BOOKING-E2E-PROOF-001
 * Preuves automatisées : confirm happy-path, TX/idempotence/tenant, dismiss, fixture parser.
 *
 * Niveau de preuve : fakes transactionnels en mémoire (pas de PostgreSQL réel ici).
 * Aucun appel Gmail / Anthropic / réseau.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PendingAccommodation, Role } from "@prisma/client"
import {
  confirmPendingAccommodationImpl,
  type ConfirmPendingAccommodationDeps,
  type ConfirmPendingTeam,
} from "@/lib/actions/gmail-pending-confirm.core"
import {
  dismissPendingAccommodationImpl,
  type DismissPendingAccommodationDeps,
} from "@/lib/actions/gmail-pending-dismiss.core"
import {
  extractBookingFields,
  hasUsefulBookingData,
  regexFallbackParser,
} from "@/lib/booking/extract-booking-fields"
import { htmlToPlainText } from "@/lib/text/html-to-plain-text"
import {
  formatDateOnlyForInput,
  parseStrictCalendarYmd,
} from "@/lib/booking/booking-date-only"

const ROOT = process.cwd()
const FIXTURE_PATH = join(
  ROOT,
  "tests/booking/fixtures/booking-e2e-fixture-001.html"
)
const FIXTURE_MARKER = "BOOKING-E2E-FIXTURE-001"

type AccRow = {
  id: string
  companyId: string
  teamId: string
  createdById: string
  address: string
  city: string | null
  zipCode: string | null
  doorCode: string | null
  contactName: string | null
  contactPhone: string | null
  notes: string | null
  startDate: Date
  endDate: Date
  gmailSourceMessageId: string | null
  source: string | null
}

type PendingRow = PendingAccommodation

type NotifRow = { userId: string; companyId: string; type: string }

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d))
}

function clonePending(p: PendingRow): PendingRow {
  return { ...p }
}

function cloneAcc(a: AccRow): AccRow {
  return { ...a, startDate: new Date(a.startDate), endDate: new Date(a.endDate) }
}

function session(
  role: Role,
  companyId: string | null = "co1",
  id = "admin1"
) {
  return { user: { id, role, companyId } }
}

function basePending(over: Partial<PendingRow> = {}): PendingRow {
  return {
    id: "pend1",
    companyId: "co1",
    gmailMessageId: "gmail-msg-e2e-proof-001",
    propertyName: "Résidence Fictive",
    address: "42 rue des Lilas Inventés",
    city: "Ville-Fictive-sur-Loire",
    zipCode: "42420",
    startDate: utcDate(2026, 8, 15),
    endDate: utcDate(2026, 8, 18),
    doorCode: "FX42#9",
    contactName: "Alex Fictif",
    contactPhone: "0611223344",
    notes: null,
    rawEmailSnippet: null,
    status: "PENDING",
    accommodationId: null,
    confirmedById: null,
    confirmedAt: null,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    updatedAt: new Date("2026-07-01T10:00:00Z"),
    ...over,
  }
}

function teamCo1(): ConfirmPendingTeam {
  return {
    id: "team1",
    name: "Équipe Alpha",
    leader: { userId: "leader1" },
    members: [],
  }
}

/**
 * Fake Prisma-like avec $transaction à rollback mémoire si le callback throw.
 * Preuve = fake transactionnel, PAS une vraie TX PostgreSQL.
 */
function makeConfirmWorld(opts: {
  pendings: PendingRow[]
  teams: Array<ConfirmPendingTeam & { companyId: string; active: boolean }>
  accommodations?: AccRow[]
}) {
  const state = {
    pendings: opts.pendings.map(clonePending),
    teams: opts.teams,
    accommodations: (opts.accommodations ?? []).map(cloneAcc),
    notifications: [] as NotifRow[],
    revalidated: [] as string[],
    emailsSent: 0,
    nextAccId: 1,
  }

  function buildTx() {
    return {
      accommodation: {
        async create({ data }: { data: Omit<AccRow, "id"> & { id?: string } }) {
          const dup = state.accommodations.find(
            (a) =>
              a.companyId === data.companyId &&
              a.gmailSourceMessageId != null &&
              a.gmailSourceMessageId === data.gmailSourceMessageId
          )
          if (dup) {
            throw Object.assign(new Error("Unique"), {
              code: "P2002",
              meta: { target: ["companyId", "gmailSourceMessageId"] },
            })
          }
          const row: AccRow = {
            id: data.id ?? `acc_${state.nextAccId++}`,
            companyId: data.companyId,
            teamId: data.teamId,
            createdById: data.createdById,
            address: data.address,
            city: data.city ?? null,
            zipCode: data.zipCode ?? null,
            doorCode: data.doorCode ?? null,
            contactName: data.contactName ?? null,
            contactPhone: data.contactPhone ?? null,
            notes: data.notes ?? null,
            startDate: data.startDate,
            endDate: data.endDate,
            gmailSourceMessageId: data.gmailSourceMessageId ?? null,
            source: data.source ?? null,
          }
          state.accommodations.push(row)
          return row
        },
        async findFirst({
          where,
        }: {
          where: { companyId: string; gmailSourceMessageId: string }
        }) {
          return (
            state.accommodations.find(
              (a) =>
                a.companyId === where.companyId &&
                a.gmailSourceMessageId === where.gmailSourceMessageId
            ) ?? null
          )
        },
      },
      pendingAccommodation: {
        async findFirst({
          where,
        }: {
          where: { id: string; companyId: string }
        }) {
          return (
            state.pendings.find(
              (p) => p.id === where.id && p.companyId === where.companyId
            ) ?? null
          )
        },
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; companyId: string; status: string }
          data: Partial<PendingRow>
        }) {
          const p = state.pendings.find(
            (x) =>
              x.id === where.id &&
              x.companyId === where.companyId &&
              x.status === where.status
          )
          if (!p) return { count: 0 }
          Object.assign(p, data, { updatedAt: new Date() })
          return { count: 1 }
        },
      },
      notification: {
        async createMany({ data }: { data: NotifRow[] }) {
          state.notifications.push(...data)
          return { count: data.length }
        },
      },
    }
  }

  const db = {
    pendingAccommodation: {
      async findFirst({
        where,
      }: {
        where: { id: string; companyId: string }
      }) {
        return (
          state.pendings.find(
            (p) => p.id === where.id && p.companyId === where.companyId
          ) ?? null
        )
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; companyId: string; status: string }
        data: Partial<PendingRow>
      }) {
        const p = state.pendings.find(
          (x) =>
            x.id === where.id &&
            x.companyId === where.companyId &&
            x.status === where.status
        )
        if (!p) return { count: 0 }
        Object.assign(p, data)
        return { count: 1 }
      },
    },
    team: {
      async findFirst({
        where,
      }: {
        where: { id: string; companyId: string; active: boolean }
        include: unknown
      }) {
        const t = state.teams.find(
          (x) =>
            x.id === where.id &&
            x.companyId === where.companyId &&
            x.active === where.active
        )
        if (!t) return null
        const { companyId: _c, active: _a, ...rest } = t
        return rest
      },
    },
    company: {
      async findUnique() {
        return { name: "Société Test E2E" }
      },
    },
    async $transaction(fn: (tx: ReturnType<typeof buildTx>) => Promise<unknown>) {
      const snapPendings = state.pendings.map(clonePending)
      const snapAcc = state.accommodations.map(cloneAcc)
      const snapNotif = [...state.notifications]
      try {
        return await fn(buildTx())
      } catch (err) {
        state.pendings = snapPendings
        state.accommodations = snapAcc
        state.notifications = snapNotif
        throw err
      }
    },
  }

  function deps(
    authUser: ReturnType<typeof session> | null
  ): ConfirmPendingAccommodationDeps {
    return {
      auth: async () => authUser,
      db: db as unknown as ConfirmPendingAccommodationDeps["db"],
      revalidatePath: (p) => {
        state.revalidated.push(p)
      },
      sendLogementCreatedEmail: async () => {
        state.emailsSent++
      },
    }
  }

  return { state, deps, db }
}

describe("PLAN-BOOKING-E2E-PROOF-001 — confirmPendingAccommodationImpl (fakes TX)", () => {
  it("happy path : 1 Acc + Pending CONFIRMED atomique, mapping champs", async () => {
    const pending = basePending()
    const { state, deps } = makeConfirmWorld({
      pendings: [pending],
      teams: [{ ...teamCo1(), companyId: "co1", active: true }],
    })

    const r = await confirmPendingAccommodationImpl(
      "pend1",
      "team1",
      deps(session("ADMIN"))
    )
    assert.deepEqual(r, { success: true, idempotent: false })
    assert.equal(state.accommodations.length, 1)
    const acc = state.accommodations[0]!
    assert.equal(acc.companyId, "co1")
    assert.equal(acc.teamId, "team1")
    assert.equal(acc.address, "42 rue des Lilas Inventés")
    assert.equal(acc.startDate.toISOString().slice(0, 10), "2026-08-15")
    assert.equal(acc.endDate.toISOString().slice(0, 10), "2026-08-18")
    assert.equal(acc.gmailSourceMessageId, "gmail-msg-e2e-proof-001")
    assert.equal(acc.source, "gmail-scan")
    assert.equal(acc.createdById, "admin1")

    const p = state.pendings[0]!
    assert.equal(p.status, "CONFIRMED")
    assert.equal(p.accommodationId, acc.id)
    assert.equal(p.confirmedById, "admin1")
    assert.ok(p.confirmedAt instanceof Date)
    assert.ok(state.revalidated.includes("/logements"))
    assert.ok(state.revalidated.includes("/planning/moi"))
  })

  it("échec update Pending (race) → rollback : aucun Accommodation ne subsiste", async () => {
    const pending = basePending()
    const { state, deps, db } = makeConfirmWorld({
      pendings: [pending],
      teams: [{ ...teamCo1(), companyId: "co1", active: true }],
    })

    // Force updateMany count=0 après create Acc → PENDING_CONFIRM_RACE → rollback fake
    const txOrig = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) => {
      return txOrig(async (tx) => {
        const wrapped = {
          ...tx,
          pendingAccommodation: {
            ...tx.pendingAccommodation,
            updateMany: async () => ({ count: 0 }),
          },
        }
        return fn(wrapped as never)
      })
    }

    const r = await confirmPendingAccommodationImpl(
      "pend1",
      "team1",
      deps(session("ADMIN"))
    )
    assert.equal("error" in r, true)
    assert.equal(state.accommodations.length, 0)
    assert.equal(state.pendings[0]!.status, "PENDING")
    assert.equal(state.pendings[0]!.accommodationId, null)
  })

  it("double confirmation → idempotent, un seul Accommodation", async () => {
    const { state, deps } = makeConfirmWorld({
      pendings: [basePending()],
      teams: [{ ...teamCo1(), companyId: "co1", active: true }],
    })
    const d = deps(session("ADMIN"))
    const r1 = await confirmPendingAccommodationImpl("pend1", "team1", d)
    assert.deepEqual(r1, { success: true, idempotent: false })
    const r2 = await confirmPendingAccommodationImpl("pend1", "team1", d)
    assert.deepEqual(r2, { success: true, idempotent: true })
    assert.equal(state.accommodations.length, 1)
    assert.equal(state.pendings[0]!.status, "CONFIRMED")
  })

  it("équipe autre tenant refusée ; Pending autre société non modifié", async () => {
    const foreign = basePending({
      id: "pend-other",
      companyId: "coOTHER",
      gmailMessageId: "gmail-other",
    })
    const local = basePending()
    const { state, deps } = makeConfirmWorld({
      pendings: [local, foreign],
      teams: [
        { ...teamCo1(), companyId: "co1", active: true },
        {
          id: "team-other",
          name: "Autre",
          leader: { userId: "x" },
          members: [],
          companyId: "coOTHER",
          active: true,
        },
      ],
    })

    const wrongTeam = await confirmPendingAccommodationImpl(
      "pend1",
      "team-other",
      deps(session("ADMIN", "co1"))
    )
    assert.deepEqual(wrongTeam, { error: "Équipe introuvable." })
    assert.equal(state.accommodations.length, 0)
    assert.equal(state.pendings[0]!.status, "PENDING")

    const wrongPending = await confirmPendingAccommodationImpl(
      "pend-other",
      "team1",
      deps(session("ADMIN", "co1"))
    )
    assert.deepEqual(wrongPending, { error: "Réservation introuvable." })
    assert.equal(state.pendings[1]!.status, "PENDING")
    assert.equal(state.pendings[1]!.companyId, "coOTHER")
  })

  it("SUPER_ADMIN OK ; TEAM_LEADER / non authentifié refusés", async () => {
    const { deps } = makeConfirmWorld({
      pendings: [basePending()],
      teams: [{ ...teamCo1(), companyId: "co1", active: true }],
    })
    const ok = await confirmPendingAccommodationImpl(
      "pend1",
      "team1",
      deps(session("SUPER_ADMIN"))
    )
    assert.equal("success" in ok && ok.success, true)

    await assert.rejects(
      () =>
        confirmPendingAccommodationImpl(
          "pend1",
          "team1",
          deps(session("TEAM_LEADER"))
        ),
      /Accès refusé/
    )
    await assert.rejects(
      () => confirmPendingAccommodationImpl("pend1", "team1", deps(null)),
      /Non authentifié/
    )
  })

  it("équipe inactive (active=false) refusée ; aucun Acc ; Pending inchangé", async () => {
    const { state, deps } = makeConfirmWorld({
      pendings: [basePending()],
      teams: [{ ...teamCo1(), companyId: "co1", active: false }],
    })
    const r = await confirmPendingAccommodationImpl(
      "pend1",
      "team1",
      deps(session("ADMIN"))
    )
    assert.deepEqual(r, { error: "Équipe introuvable." })
    assert.equal(state.accommodations.length, 0)
    assert.equal(state.pendings[0]!.status, "PENDING")
    assert.equal(state.pendings[0]!.accommodationId, null)
  })

  it("companyId null → Entreprise introuvable ; aucune écriture", async () => {
    const { state, deps } = makeConfirmWorld({
      pendings: [basePending()],
      teams: [{ ...teamCo1(), companyId: "co1", active: true }],
    })
    await assert.rejects(
      () =>
        confirmPendingAccommodationImpl(
          "pend1",
          "team1",
          deps(session("ADMIN", null))
        ),
      /Entreprise introuvable/
    )
    assert.equal(state.accommodations.length, 0)
    assert.equal(state.pendings[0]!.status, "PENDING")
    assert.equal(state.pendings[0]!.accommodationId, null)
  })
})

describe("PLAN-BOOKING-E2E-PROOF-001 — dismissPendingAccommodationImpl (fakes)", () => {
  function makeDismissDb(seed: PendingRow[]) {
    const pendings = seed.map(clonePending)
    const accommodations: AccRow[] = []
    const revalidated: string[] = []
    const db = {
      pendingAccommodation: {
        async findFirst({
          where,
        }: {
          where: { id: string; companyId: string }
        }) {
          return (
            pendings.find(
              (p) => p.id === where.id && p.companyId === where.companyId
            ) ?? null
          )
        },
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; companyId: string; status: string }
          data: { status: PendingRow["status"] }
        }) {
          const p = pendings.find(
            (x) =>
              x.id === where.id &&
              x.companyId === where.companyId &&
              x.status === where.status
          )
          if (!p) return { count: 0 }
          p.status = data.status
          return { count: 1 }
        },
      },
    }
    function deps(
      authUser: ReturnType<typeof session> | null
    ): DismissPendingAccommodationDeps {
      return {
        auth: async () => authUser,
        db,
        revalidatePath: (p) => {
          revalidated.push(p)
        },
      }
    }
    return { pendings, accommodations, revalidated, deps }
  }

  it("ADMIN : PENDING → DISMISSED ; aucun Accommodation créé/supprimé", async () => {
    const { pendings, accommodations, revalidated, deps } = makeDismissDb([
      basePending(),
    ])
    const r = await dismissPendingAccommodationImpl("pend1", deps(session("ADMIN")))
    assert.deepEqual(r, { success: true })
    assert.equal(pendings[0]!.status, "DISMISSED")
    assert.equal(accommodations.length, 0)
    assert.deepEqual(revalidated, ["/logements"])
  })

  it("SUPER_ADMIN OK ; TEAM_LEADER / anon refusés", async () => {
    const { deps } = makeDismissDb([basePending()])
    const ok = await dismissPendingAccommodationImpl(
      "pend1",
      deps(session("SUPER_ADMIN"))
    )
    assert.deepEqual(ok, { success: true })
    await assert.rejects(
      () =>
        dismissPendingAccommodationImpl("pend1", deps(session("TEAM_LEADER"))),
      /Accès refusé/
    )
    await assert.rejects(
      () => dismissPendingAccommodationImpl("pend1", deps(null)),
      /Non authentifié/
    )
  })

  it("CONFIRMED ne peut pas être rejeté ; autre tenant introuvable", async () => {
    const { pendings, deps } = makeDismissDb([
      basePending({ status: "CONFIRMED", accommodationId: "acc1" }),
      basePending({
        id: "pend-other",
        companyId: "coOTHER",
        gmailMessageId: "g2",
      }),
    ])
    const r1 = await dismissPendingAccommodationImpl(
      "pend1",
      deps(session("ADMIN"))
    )
    assert.deepEqual(r1, { error: "Réservation déjà traitée." })
    assert.equal(pendings[0]!.status, "CONFIRMED")

    const r2 = await dismissPendingAccommodationImpl(
      "pend-other",
      deps(session("ADMIN", "co1"))
    )
    assert.deepEqual(r2, { error: "Réservation introuvable." })
    assert.equal(pendings[1]!.status, "PENDING")
  })
})

describe("PLAN-BOOKING-E2E-PROOF-001 — fixture + extraction déterministe (sans Anthropic)", () => {
  let html: string
  let plain: string

  beforeEach(() => {
    html = readFileSync(FIXTURE_PATH, "utf8")
    plain = htmlToPlainText(html)
  })

  it("fixture anonymisée présente le marqueur et aucune donnée réelle typique", () => {
    assert.ok(html.includes(FIXTURE_MARKER))
    assert.ok(html.includes("noreply@booking.com"))
    assert.ok(!html.includes("sk-"))
    assert.ok(!/@gmail\.com/i.test(html))
    assert.match(html, /Lilas Inventés|Ville-Fictive/)
  })

  it("htmlToPlainText + regexFallback : adresse, dates, accents, déterministe", async () => {
    assert.ok(plain.includes("Adresse"))
    assert.ok(plain.includes("août") || plain.includes("aout") || plain.includes("15"))

    const parsed = regexFallbackParser(plain)
    assert.equal(parsed.address, "42 rue des Lilas Inventés")
    assert.equal(parsed.startDate, "2026-08-15")
    assert.equal(parsed.endDate, "2026-08-18")
    assert.ok(
      parsed.city === null || /Fictive|Ville/i.test(parsed.city),
      `city=${parsed.city}`
    )
    assert.ok(hasUsefulBookingData(parsed))

    const start = parseStrictCalendarYmd(parsed.startDate!)
    const end = parseStrictCalendarYmd(parsed.endDate!)
    assert.ok(start && end)
    assert.equal(formatDateOnlyForInput(start), "2026-08-15")
    assert.equal(formatDateOnlyForInput(end), "2026-08-18")

    // extractBookingFields sans client IA = regex only (aucun réseau)
    const viaExtract = await extractBookingFields(plain, "fixture-local-id", null)
    assert.equal(viaExtract.address, parsed.address)
    assert.equal(viaExtract.startDate, parsed.startDate)
    assert.equal(viaExtract.endDate, parsed.endDate)

    const again = regexFallbackParser(plain)
    assert.deepEqual(again, parsed)
  })

  it("façade gmail.actions délègue aux cores testés", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/gmail.actions.ts"), "utf8")
    assert.ok(src.includes("confirmPendingAccommodationImpl"))
    assert.ok(src.includes("dismissPendingAccommodationImpl"))
  })
})
