/**
 * PLAN-BOOKING-FILTER-001 — gate Pending (ACCEPT / PERMANENT / RETRYABLE).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import {
  evaluatePendingCreationGate,
  type PendingCreationGateResult,
} from "@/lib/booking/booking-scan-pending-gate"
import { getBookingScanCutoffDate } from "@/lib/booking/booking-scan-cutoff"
import { createOrGetBookingScanResult } from "@/lib/booking/booking-scan-result"
import { isBookingScanPendingOnly } from "@/lib/booking/booking-scan-pending-only-flag"
import {
  permanentBookingError,
  retryableBookingError,
} from "@/lib/booking/booking-gmail-errors"
import type { PendingAccommodation, Prisma } from "@prisma/client"

const CUTOFF = new Date(Date.UTC(2026, 5, 17)) // 2026-06-17

function validParsed(
  over: Partial<{
    startDate: string | null
    endDate: string | null
    address: string | null
    teamName: string | null
  }> = {}
) {
  return {
    propertyName: "Résidence Test",
    address: "12 rue Valide",
    city: "Lyon",
    zipCode: "69001",
    startDate: "2026-08-15",
    endDate: "2026-08-18",
    doorCode: null,
    contactName: null,
    contactPhone: null,
    notes: null,
    teamName: null as string | null,
    ...over,
  }
}

/**
 * Miroir comportemental du branchement cron après evaluatePendingCreationGate :
 * aucun createOrGet sur rejet.
 */
async function applyGateOutcome(input: {
  gate: PendingCreationGateResult
  createOrGet: () => Promise<unknown>
  markPermanent: (code: string) => Promise<void>
  markFailure: (code: string) => Promise<void>
}): Promise<"persisted" | "permanent" | "retryable"> {
  const { gate, createOrGet, markPermanent, markFailure } = input
  if (gate.decision === "PERMANENT_IGNORE") {
    await markPermanent(gate.code)
    return "permanent"
  }
  if (gate.decision === "RETRYABLE_REJECT") {
    await markFailure(gate.code)
    return "retryable"
  }
  await createOrGet()
  return "persisted"
}

describe("evaluatePendingCreationGate", () => {
  it("1. startDate absente → RETRYABLE_REJECT / MISSING_START_DATE", () => {
    for (const startDate of [null, "", "  "]) {
      const r = evaluatePendingCreationGate(validParsed({ startDate }), CUTOFF)
      assert.equal(r.decision, "RETRYABLE_REJECT")
      if (r.decision === "RETRYABLE_REJECT") {
        assert.equal(r.code, "MISSING_START_DATE")
      }
    }
  })

  it("2. endDate absente → RETRYABLE_REJECT / MISSING_END_DATE", () => {
    for (const endDate of [null, "", "  "]) {
      const r = evaluatePendingCreationGate(validParsed({ endDate }), CUTOFF)
      assert.equal(r.decision, "RETRYABLE_REJECT")
      if (r.decision === "RETRYABLE_REJECT") {
        assert.equal(r.code, "MISSING_END_DATE")
      }
    }
  })

  it("3–5. adresse null / vide / espaces → MISSING_ADDRESS", () => {
    for (const address of [null, "", "   ", "\t"]) {
      const r = evaluatePendingCreationGate(validParsed({ address }), CUTOFF)
      assert.equal(r.decision, "RETRYABLE_REJECT")
      if (r.decision === "RETRYABLE_REJECT") {
        assert.equal(r.code, "MISSING_ADDRESS")
      }
    }
  })

  it("6–7. startDate non parsable / civile impossible → INVALID_START_DATE", () => {
    for (const startDate of ["nope", "2026/08/15", "2026-02-30", "2026-13-01"]) {
      const r = evaluatePendingCreationGate(validParsed({ startDate }), CUTOFF)
      assert.equal(r.decision, "RETRYABLE_REJECT", startDate)
      if (r.decision === "RETRYABLE_REJECT") {
        assert.equal(r.code, "INVALID_START_DATE", startDate)
      }
    }
  })

  it("8–9. endDate non parsable / civile impossible → INVALID_END_DATE", () => {
    for (const endDate of ["bad", "15-08-2026", "2026-04-31", "2027-02-29"]) {
      const r = evaluatePendingCreationGate(validParsed({ endDate }), CUTOFF)
      assert.equal(r.decision, "RETRYABLE_REJECT", endDate)
      if (r.decision === "RETRYABLE_REJECT") {
        assert.equal(r.code, "INVALID_END_DATE", endDate)
      }
    }
  })

  it("10. endDate < startDate → INVALID_DATE_RANGE", () => {
    const r = evaluatePendingCreationGate(
      validParsed({ startDate: "2026-08-20", endDate: "2026-08-10" }),
      CUTOFF
    )
    assert.equal(r.decision, "RETRYABLE_REJECT")
    if (r.decision === "RETRYABLE_REJECT") {
      assert.equal(r.code, "INVALID_DATE_RANGE")
    }
  })

  it("même jour start=end → ACCEPT", () => {
    const r = evaluatePendingCreationGate(
      validParsed({ startDate: "2026-08-15", endDate: "2026-08-15" }),
      CUTOFF
    )
    assert.deepEqual(r, { decision: "ACCEPT" })
  })

  it("11. startDate < cutoff → PERMANENT_IGNORE / BEFORE_CUTOFF", () => {
    const r = evaluatePendingCreationGate(
      validParsed({ startDate: "2026-06-16", endDate: "2026-06-20" }),
      CUTOFF
    )
    assert.equal(r.decision, "PERMANENT_IGNORE")
    if (r.decision === "PERMANENT_IGNORE") {
      assert.equal(r.code, "BEFORE_CUTOFF")
    }
  })

  it("12–13. startDate = / > cutoff → ACCEPT", () => {
    assert.deepEqual(
      evaluatePendingCreationGate(
        validParsed({ startDate: "2026-06-17", endDate: "2026-06-20" }),
        CUTOFF
      ),
      { decision: "ACCEPT" }
    )
    assert.deepEqual(
      evaluatePendingCreationGate(validParsed(), CUTOFF),
      { decision: "ACCEPT" }
    )
  })

  it("14. équipe absente → ACCEPT", () => {
    const r = evaluatePendingCreationGate(
      validParsed({ teamName: null }),
      CUTOFF
    )
    assert.deepEqual(r, { decision: "ACCEPT" })
  })

  it("cutoff 2026-07-30 inclus sans décalage civil", () => {
    const cutoff = getBookingScanCutoffDate({
      BOOKING_SCAN_CUTOFF_DATE: "2026-07-30",
    })
    assert.equal(cutoff.toISOString(), "2026-07-30T00:00:00.000Z")
    const r = evaluatePendingCreationGate(
      validParsed({ startDate: "2026-07-30", endDate: "2026-08-01" }),
      cutoff
    )
    assert.deepEqual(r, { decision: "ACCEPT" })
  })
})

describe("branchement gate → pas de persist sur rejet", () => {
  it("15. rejet retryable → createOrGet non appelé", async () => {
    let createCalls = 0
    let failureCodes: string[] = []
    const gate = evaluatePendingCreationGate(
      validParsed({ address: null }),
      CUTOFF
    )
    assert.equal(gate.decision, "RETRYABLE_REJECT")
    const outcome = await applyGateOutcome({
      gate,
      createOrGet: async () => {
        createCalls++
      },
      markPermanent: async () => {
        throw new Error("ne doit pas être permanent")
      },
      markFailure: async (code) => {
        failureCodes.push(code)
      },
    })
    assert.equal(outcome, "retryable")
    assert.equal(createCalls, 0)
    assert.deepEqual(failureCodes, ["MISSING_ADDRESS"])
    assert.equal(retryableBookingError("MISSING_ADDRESS", "x").kind, "RETRYABLE")
  })

  it("16. rejet permanent → createOrGet non appelé", async () => {
    let createCalls = 0
    let permanentCodes: string[] = []
    const gate = evaluatePendingCreationGate(
      validParsed({ startDate: "2026-06-01", endDate: "2026-06-10" }),
      CUTOFF
    )
    assert.equal(gate.decision, "PERMANENT_IGNORE")
    const outcome = await applyGateOutcome({
      gate,
      createOrGet: async () => {
        createCalls++
      },
      markPermanent: async (code) => {
        permanentCodes.push(code)
      },
      markFailure: async () => {
        throw new Error("ne doit pas être retryable")
      },
    })
    assert.equal(outcome, "permanent")
    assert.equal(createCalls, 0)
    assert.deepEqual(permanentCodes, ["BEFORE_CUTOFF"])
    assert.equal(permanentBookingError("BEFORE_CUTOFF", "x").kind, "PERMANENT")
  })
})

describe("17–18. cas valide pending-only → Pending ; aucun Acc sur rejet", () => {
  const prev = process.env.BOOKING_SCAN_PENDING_ONLY

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_SCAN_PENDING_ONLY
    else process.env.BOOKING_SCAN_PENDING_ONLY = prev
  })

  function makeTx() {
    const pendings: PendingAccommodation[] = []
    const accommodations: unknown[] = []
    const tx = {
      accommodation: {
        findFirst: async () => null,
        create: async (args: { data: unknown }) => {
          accommodations.push(args.data)
          return { id: `a_${accommodations.length}` }
        },
        update: async () => {
          throw new Error("no update")
        },
      },
      pendingAccommodation: {
        findFirst: async () => null,
        create: async ({
          data,
        }: {
          data: Partial<PendingAccommodation> & {
            companyId: string
            gmailMessageId: string
          }
        }) => {
          const row = {
            id: `p_${pendings.length + 1}`,
            status: "PENDING",
            accommodationId: null,
            confirmedById: null,
            confirmedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            propertyName: null,
            address: null,
            city: null,
            zipCode: null,
            startDate: null,
            endDate: null,
            doorCode: null,
            contactName: null,
            contactPhone: null,
            notes: null,
            rawEmailSnippet: null,
            ...data,
          } as PendingAccommodation
          pendings.push(row)
          return row
        },
        update: async () => {
          throw new Error("no update")
        },
      },
      user: { findMany: async () => [] },
      notification: { createMany: async () => ({ count: 0 }) },
    }
    return { tx: tx as unknown as Prisma.TransactionClient, pendings, accommodations }
  }

  it("17. valide + pending-only → exactement un Pending", async () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "true"
    assert.equal(isBookingScanPendingOnly(), true)
    const cutoff = getBookingScanCutoffDate()
    const parsed = validParsed()
    assert.deepEqual(evaluatePendingCreationGate(parsed, cutoff), {
      decision: "ACCEPT",
    })
    const { tx, pendings, accommodations } = makeTx()
    const r = await createOrGetBookingScanResult(tx, {
      companyId: "co1",
      messageId: "msg-ok",
      snippet: "x",
      emailBody: "body",
      parsed,
      matchedTeamId: null,
      adminId: "admin1",
    })
    assert.equal(r.resultType, "PENDING_ACCOMMODATION")
    assert.equal(r.createdNew, true)
    assert.equal(pendings.length, 1)
    assert.equal(accommodations.length, 0)
  })

  it("18. aucun rejet ne crée d’Accommodation (ni Pending)", async () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "true"
    const { tx, pendings, accommodations } = makeTx()
    let createOrGetCalls = 0
    const rejects: PendingCreationGateResult[] = [
      evaluatePendingCreationGate(validParsed({ startDate: null }), CUTOFF),
      evaluatePendingCreationGate(validParsed({ address: "  " }), CUTOFF),
      evaluatePendingCreationGate(
        validParsed({ startDate: "2026-02-30" }),
        CUTOFF
      ),
      evaluatePendingCreationGate(
        validParsed({ startDate: "2026-06-01", endDate: "2026-06-05" }),
        CUTOFF
      ),
    ]
    for (const gate of rejects) {
      assert.notEqual(gate.decision, "ACCEPT")
      await applyGateOutcome({
        gate,
        createOrGet: async () => {
          createOrGetCalls++
          await createOrGetBookingScanResult(tx, {
            companyId: "co1",
            messageId: `msg-${createOrGetCalls}`,
            snippet: "x",
            parsed: validParsed(),
            matchedTeamId: "team1",
            adminId: "admin1",
          })
        },
        markPermanent: async () => {},
        markFailure: async () => {},
      })
    }
    assert.equal(createOrGetCalls, 0)
    assert.equal(pendings.length, 0)
    assert.equal(accommodations.length, 0)
  })
})
