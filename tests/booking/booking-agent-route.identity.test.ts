/**
 * PLAN-BOOKING-FINAL-2 R4 — Invocation réelle du handler Agent (pending + hasAllData).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  handleBookingAgentPost,
  POST,
  type BookingAgentDb,
} from "@/app/api/booking/agent/route"

const SECRET = "booking-agent-identity-secret"

function authReq(body: unknown): Request {
  return new Request("http://localhost/api/booking/agent", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function makeFakeDb() {
  const pendings: Array<{
    id: string
    companyId: string
    idempotencyKey: string
    sourceKind: string
    externalSourceId: string | null
    gmailMessageId: string | null
  }> = []
  const accommodations: Array<{
    id: string
    companyId: string
    bookingReference: string | null
    source: string | null
    gmailSourceMessageId: string | null
  }> = []
  let nextId = 1
  const ops = {
    createPending: 0,
    updatePending: 0,
    createAcc: 0,
    upsertAcc: 0,
  }

  const db: BookingAgentDb = {
    company: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id ? { id: where.id } : null,
    },
    team: {
      findMany: async () => [],
    },
    user: {
      findFirst: async () => ({ id: "admin1" }),
      findMany: async () => [{ id: "admin1" }],
    },
    accommodation: {
      findUnique: async ({
        where,
      }: {
        where: {
          companyId_bookingReference?: {
            companyId: string
            bookingReference: string
          }
        }
      }) => {
        const key = where.companyId_bookingReference
        if (!key) return null
        return (
          accommodations.find(
            (a) =>
              a.companyId === key.companyId &&
              a.bookingReference === key.bookingReference
          ) ?? null
        )
      },
      findMany: async () => [],
      update: async () => ({}),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          companyId_bookingReference: {
            companyId: string
            bookingReference: string
          }
        }
        create: {
          companyId: string
          bookingReference?: string | null
          source?: string
          gmailSourceMessageId?: string | null
        }
        update: Record<string, unknown>
      }) => {
        ops.upsertAcc++
        const key = where.companyId_bookingReference
        const existing = accommodations.find(
          (a) =>
            a.companyId === key.companyId &&
            a.bookingReference === key.bookingReference
        )
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        ops.createAcc++
        const row = {
          id: `acc_${nextId++}`,
          companyId: create.companyId,
          bookingReference: create.bookingReference ?? null,
          source: create.source ?? null,
          gmailSourceMessageId: create.gmailSourceMessageId ?? null,
        }
        accommodations.push(row)
        return row
      },
      create: async ({
        data,
      }: {
        data: {
          companyId: string
          bookingReference?: string | null
          source?: string
          gmailSourceMessageId?: string | null
        }
      }) => {
        ops.createAcc++
        const row = {
          id: `acc_${nextId++}`,
          companyId: data.companyId,
          bookingReference: data.bookingReference ?? null,
          source: data.source ?? null,
          gmailSourceMessageId: data.gmailSourceMessageId ?? null,
        }
        accommodations.push(row)
        return row
      },
    },
    pendingAccommodation: {
      findUnique: async ({
        where,
      }: {
        where: {
          companyId_idempotencyKey: {
            companyId: string
            idempotencyKey: string
          }
        }
      }) => {
        const key = where.companyId_idempotencyKey
        return (
          pendings.find(
            (p) =>
              p.companyId === key.companyId &&
              p.idempotencyKey === key.idempotencyKey
          ) ?? null
        )
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Record<string, unknown>
      }) => {
        ops.updatePending++
        const p = pendings.find((x) => x.id === where.id)!
        Object.assign(p, data)
        return p
      },
      create: async ({
        data,
      }: {
        data: {
          companyId: string
          idempotencyKey: string
          sourceKind: string
          externalSourceId: string | null
          gmailMessageId: string | null
        }
      }) => {
        ops.createPending++
        const row = {
          id: `pend_${nextId++}`,
          companyId: data.companyId,
          idempotencyKey: data.idempotencyKey,
          sourceKind: data.sourceKind,
          externalSourceId: data.externalSourceId,
          gmailMessageId: data.gmailMessageId,
        }
        pendings.push(row)
        return row
      },
    },
    notification: {
      createMany: async () => ({}),
    },
  }

  return { db, pendings, accommodations, ops }
}

const extractPendingPath = async () => ({
  status: "confirmed",
  propertyName: "Hotel",
  address: null,
  city: null,
  zipCode: null,
  startDate: "2026-09-01",
  endDate: "2026-09-03",
  teamName: null,
  doorCode: null,
  contactName: null,
  contactPhone: null,
  bookingReference: null,
})

const extractHasAllData = async (bookingReference: string | null = null) => ({
  status: "confirmed",
  propertyName: "Hotel Complet",
  address: "12 rue Test Agent",
  city: "Paris",
  zipCode: "75001",
  startDate: "2026-09-01",
  endDate: "2026-09-03",
  teamName: "Alpha",
  doorCode: null,
  contactName: null,
  contactPhone: null,
  bookingReference,
})

describe("handler POST Agent — identité R4", () => {
  const prevSecret = process.env.CRON_SECRET
  const prevAnthropic = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevAnthropic
  })

  it("POST route : auth fail-closed sans secret", async () => {
    delete process.env.CRON_SECRET
    const res = await POST(authReq({ companyId: "co1", rawEmailText: "x" }))
    assert.equal(res.status, 401)
  })

  it("externalEventId stable : retry → même clé, un seul pending", async () => {
    const { db, pendings, ops } = makeFakeDb()
    const body = {
      companyId: "co1",
      rawEmailText: "email agent",
      externalEventId: "evt-stable-1",
    }
    const r1 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extractPendingPath,
      anthropicApiKey: null,
    })
    assert.equal(r1.status, 200)
    const j1 = await r1.json()
    assert.equal(j1.action, "pending")
    assert.equal(pendings.length, 1)
    assert.equal(pendings[0]!.idempotencyKey, "agent:evt-stable-1")
    assert.equal(pendings[0]!.externalSourceId, null)

    const r2 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extractPendingPath,
      anthropicApiKey: null,
    })
    assert.equal(r2.status, 200)
    assert.equal(pendings.length, 1)
    assert.equal(ops.createPending, 1)
    assert.equal(ops.updatePending, 1)
  })

  it("bookingReference sans externalEventId → clé agent:{ref}", async () => {
    const { db, pendings } = makeFakeDb()
    const res = await handleBookingAgentPost(
      authReq({
        companyId: "co1",
        rawEmailText: "email",
        bookingReference: "BK-REF-9",
      }),
      {
        db,
        extractFromEmail: extractPendingPath,
        anthropicApiKey: null,
      }
    )
    assert.equal(res.status, 200)
    assert.equal(pendings[0]!.idempotencyKey, "agent:BK-REF-9")
    assert.equal(pendings[0]!.externalSourceId, "BK-REF-9")
  })

  it("sans ID stable → 422, aucune écriture Pending/Accommodation", async () => {
    const { db, pendings, accommodations, ops } = makeFakeDb()
    const res = await handleBookingAgentPost(
      authReq({ companyId: "co1", rawEmailText: "email seul" }),
      {
        db,
        extractFromEmail: extractPendingPath,
        anthropicApiKey: null,
      }
    )
    assert.equal(res.status, 422)
    assert.equal(pendings.length, 0)
    assert.equal(accommodations.length, 0)
    assert.equal(ops.createPending, 0)
    assert.equal(ops.updatePending, 0)
    assert.equal(ops.createAcc, 0)
    assert.equal(ops.upsertAcc, 0)
  })

  it("A — hasAllData + bookingReference : upsert idempotent, une seule Acc", async () => {
    const { db, accommodations, pendings, ops } = makeFakeDb()
    db.team.findMany = async () => [{ id: "t1", name: "Alpha" }]
    const body = {
      companyId: "co1",
      rawEmailText: "email complet",
      bookingReference: "BK-FULL-1",
    }
    const extract = () => extractHasAllData(null)
    const r1 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    assert.equal(r1.status, 200)
    const j1 = await r1.json()
    assert.equal(j1.action, "created")
    assert.equal(accommodations.length, 1)
    assert.equal(accommodations[0]!.bookingReference, "BK-FULL-1")
    assert.equal(accommodations[0]!.source, "agent")
    assert.equal(accommodations[0]!.gmailSourceMessageId, null)
    assert.equal(pendings.length, 0)

    const r2 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    assert.equal(r2.status, 200)
    const j2 = await r2.json()
    assert.equal(j2.action, "created")
    assert.equal(j2.id, j1.id)
    assert.equal(accommodations.length, 1)
    assert.equal(ops.createAcc, 1)
    assert.equal(ops.upsertAcc, 2)
  })

  it("B — hasAllData + externalEventId sans bookingReference : pas Acc, Pending idempotent", async () => {
    const { db, accommodations, pendings, ops } = makeFakeDb()
    db.team.findMany = async () => [{ id: "t1", name: "Alpha" }]
    const body = {
      companyId: "co1",
      rawEmailText: "email complet event",
      externalEventId: "evt-only-full",
      bookingReference: null,
    }
    const extract = () => extractHasAllData(null)
    const r1 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    assert.equal(r1.status, 200)
    const j1 = await r1.json()
    assert.equal(j1.action, "pending")
    assert.equal(accommodations.length, 0)
    assert.equal(ops.createAcc, 0)
    assert.equal(ops.upsertAcc, 0)
    assert.equal(pendings.length, 1)
    assert.equal(pendings[0]!.idempotencyKey, "agent:evt-only-full")
    assert.equal(pendings[0]!.externalSourceId, null)
    assert.equal(pendings[0]!.gmailMessageId, null)

    const r2 = await handleBookingAgentPost(authReq(body), {
      db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    assert.equal(r2.status, 200)
    assert.equal(accommodations.length, 0)
    assert.equal(pendings.length, 1)
    assert.equal(ops.createPending, 1)
    assert.equal(ops.updatePending, 1)
  })

  it("C — hasAllData sans ID stable → 422, zéro écriture", async () => {
    const { db, accommodations, pendings, ops } = makeFakeDb()
    db.team.findMany = async () => [{ id: "t1", name: "Alpha" }]
    const res = await handleBookingAgentPost(
      authReq({ companyId: "co1", rawEmailText: "complet sans id" }),
      {
        db,
        extractFromEmail: () => extractHasAllData(null),
        anthropicApiKey: null,
      }
    )
    assert.equal(res.status, 422)
    assert.equal(accommodations.length, 0)
    assert.equal(pendings.length, 0)
    assert.equal(ops.createAcc, 0)
    assert.equal(ops.upsertAcc, 0)
    assert.equal(ops.createPending, 0)
  })

  it("D — deux tenants même bookingReference → deux Acc distinctes", async () => {
    const fake = makeFakeDb()
    fake.db.team.findMany = async () => [{ id: "t1", name: "Alpha" }]
    const extract = () => extractHasAllData(null)
    const bodyA = {
      companyId: "coA",
      rawEmailText: "a",
      bookingReference: "SHARED-REF",
    }
    const bodyB = {
      companyId: "coB",
      rawEmailText: "b",
      bookingReference: "SHARED-REF",
    }
    const rA = await handleBookingAgentPost(authReq(bodyA), {
      db: fake.db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    const rB = await handleBookingAgentPost(authReq(bodyB), {
      db: fake.db,
      extractFromEmail: extract,
      anthropicApiKey: null,
    })
    assert.equal(rA.status, 200)
    assert.equal(rB.status, 200)
    assert.equal(fake.accommodations.length, 2)
    assert.equal(fake.accommodations[0]!.companyId, "coA")
    assert.equal(fake.accommodations[1]!.companyId, "coB")
    assert.equal(fake.accommodations[0]!.bookingReference, "SHARED-REF")
    assert.equal(fake.accommodations[1]!.bookingReference, "SHARED-REF")
    assert.notEqual(fake.accommodations[0]!.id, fake.accommodations[1]!.id)
  })
})
