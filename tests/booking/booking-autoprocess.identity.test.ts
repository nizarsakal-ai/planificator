/**
 * PLAN-BOOKING-FINAL-2 R3 — autoProcessPendingAccommodationsCore réel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PendingAccommodation } from "@prisma/client"
import {
  autoProcessPendingAccommodationsCore,
  type AutoProcessDb,
} from "@/lib/booking/booking-autoprocess.core"

function basePending(
  over: Partial<PendingAccommodation>
): PendingAccommodation {
  return {
    id: "p1",
    companyId: "co1",
    gmailMessageId: null,
    idempotencyKey: "n8n:X",
    sourceKind: "N8N",
    externalSourceId: "X",
    propertyName: null,
    address: "10 rue A",
    city: null,
    zipCode: null,
    startDate: new Date("2026-09-01"),
    endDate: new Date("2026-09-03"),
    doorCode: null,
    contactName: null,
    contactPhone: null,
    notes: null,
    rawEmailSnippet: "[n8n] Hotel — ref: X",
    status: "PENDING",
    accommodationId: null,
    confirmedById: null,
    confirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PendingAccommodation
}

function makeDb(pendings: PendingAccommodation[]) {
  const accommodations: Array<{ id: string; source: string }> = []
  const db = {
    pendingAccommodation: {
      findMany: async () => pendings.filter((p) => p.status === "PENDING"),
      updateMany: async (args: {
        where: { id: string }
        data: Partial<PendingAccommodation>
      }) => {
        const p = pendings.find((x) => x.id === args.where.id)
        if (p) Object.assign(p, args.data)
        return { count: p ? 1 : 0 }
      },
    },
    team: {
      findMany: async () => [{ id: "t1", name: "Alpha" }],
    },
    user: {
      findFirst: async () => ({ id: "admin1" }),
    },
    accommodation: {
      findMany: async () => [],
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        accommodation: {
          create: async (args: { data: { source: string } }) => {
            const row = {
              id: `acc_${accommodations.length + 1}`,
              source: args.data.source,
            }
            accommodations.push(row)
            return row
          },
        },
        pendingAccommodation: {
          updateMany: async (args: {
            where: { id: string }
            data: Partial<PendingAccommodation>
          }) => {
            const p = pendings.find((x) => x.id === args.where.id)
            if (p) Object.assign(p, args.data)
            return { count: 1 }
          },
        },
      }
      return fn(tx)
    },
  } as unknown as AutoProcessDb
  return { accommodations, db }
}

describe("autoProcessPendingAccommodationsCore — garde R3", () => {
  it("Pending N8N → aucune Accommodation, reste PENDING, skippedNonGmail++", async () => {
    const pendings = [basePending({ id: "pn", sourceKind: "N8N" })]
    const { db, accommodations } = makeDb(pendings)
    const res = await autoProcessPendingAccommodationsCore({
      companyId: "co1",
      userId: "u1",
      db,
      anthropicApiKey: "sk-test",
      fetchGmailBody: async () => ({ ok: false }),
      createAiMessage: async () => {
        throw new Error("AI ne doit pas être appelé pour N8N")
      },
    })
    assert.equal("success" in res && res.success, true)
    if ("success" in res) {
      assert.equal(res.skippedNonGmail, 1)
      assert.equal(res.processed, 0)
    }
    assert.equal(accommodations.length, 0)
    assert.equal(pendings[0]!.status, "PENDING")
  })

  it("Pending AGENT → même comportement", async () => {
    const pendings = [
      basePending({
        id: "pa",
        sourceKind: "AGENT",
        idempotencyKey: "agent:evt",
        externalSourceId: null,
        gmailMessageId: null,
        rawEmailSnippet: "email agent",
      }),
    ]
    const { db, accommodations } = makeDb(pendings)
    const res = await autoProcessPendingAccommodationsCore({
      companyId: "co1",
      userId: "u1",
      db,
      anthropicApiKey: "sk-test",
      fetchGmailBody: async () => ({ ok: false }),
      createAiMessage: async () => {
        throw new Error("AI ne doit pas être appelé pour AGENT")
      },
    })
    assert.equal("success" in res && res.success, true)
    if ("success" in res) {
      assert.equal(res.skippedNonGmail, 1)
      assert.equal(res.processed, 0)
    }
    assert.equal(accommodations.length, 0)
    assert.equal(pendings[0]!.status, "PENDING")
  })

  it("Pending GMAIL → chemin historique crée Accommodation", async () => {
    const pendings = [
      basePending({
        id: "pg",
        sourceKind: "GMAIL",
        gmailMessageId: "msg-g1",
        idempotencyKey: "gmail:msg-g1",
        externalSourceId: null,
        address: "12 rue Gmail Alpha",
        rawEmailSnippet: "Confirmation Booking.com pour Alpha équipe",
      }),
    ]
    const { db, accommodations } = makeDb(pendings)
    const res = await autoProcessPendingAccommodationsCore({
      companyId: "co1",
      userId: "u1",
      db,
      anthropicApiKey: "sk-test",
      fetchGmailBody: async () => ({ ok: false }),
      createAiMessage: async () => ({
        type: "text",
        text: JSON.stringify({
          address: "12 rue Gmail Alpha",
          city: null,
          zipCode: null,
          teamName: "Alpha",
          doorCode: null,
          contactPhone: null,
          contactName: null,
        }),
      }),
    })
    assert.equal("success" in res && res.success, true)
    if ("success" in res) {
      assert.equal(res.skippedNonGmail, 0)
      assert.equal(res.processed, 1)
      assert.equal(res.failed, 0)
    }
    assert.equal(accommodations.length, 1)
    assert.equal(accommodations[0]!.source, "gmail-scan")
    assert.equal(pendings[0]!.status, "CONFIRMED")
  })
})
