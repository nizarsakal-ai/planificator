/**
 * PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4A — clés idempotence + appendOnce.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prisma } from "@prisma/client"
import {
  AcquisitionDecisionJournalRepository,
  AUTO_DECISION_INTENT_CODES,
  buildAutoIntentIdempotencyKey,
  buildSystemActorInvalidIdempotencyKey,
  buildValidationDecisionIdempotencyKey,
  resolveValidationAttemptNumber,
  type DecisionJournalEntry,
  type JournalRow,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

const cycle = {
  contentHash: "hash-a",
  extractionSchemaVersion: "2",
  draftVersion: 3,
}

const frozen = {
  contentHash: "hash-a",
  extractionSchemaVersion: "2",
  validatedDraftVersion: 3,
}

describe("CORRECTION-4A — idempotency keys", () => {
  it("1 — validation key déterministe", () => {
    const a = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    const b = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    assert.equal(a, b)
    assert.match(a, /^v1:validation:[a-f0-9]{64}$/)
  })

  it("2 — change si companyId change", () => {
    const a = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    const b = buildValidationDecisionIdempotencyKey({
      companyId: "co2",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    assert.notEqual(a, b)
  })

  it("3 — change si draftId change", () => {
    const a = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    const b = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d2",
      cycle,
      validationAttempt: 1,
    })
    assert.notEqual(a, b)
  })

  it("4 — change si hash/schema/version change", () => {
    const base = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    assert.notEqual(
      base,
      buildValidationDecisionIdempotencyKey({
        companyId: "co1",
        draftId: "d1",
        cycle: { ...cycle, contentHash: "other" },
        validationAttempt: 1,
      })
    )
    assert.notEqual(
      base,
      buildValidationDecisionIdempotencyKey({
        companyId: "co1",
        draftId: "d1",
        cycle: { ...cycle, extractionSchemaVersion: "3" },
        validationAttempt: 1,
      })
    )
    assert.notEqual(
      base,
      buildValidationDecisionIdempotencyKey({
        companyId: "co1",
        draftId: "d1",
        cycle: { ...cycle, draftVersion: 9 },
        validationAttempt: 1,
      })
    )
  })

  it("5 — decisionCode hors clé (même tentative)", () => {
    // La clé ne prend pas decisionCode — même attempt → même key
    const k = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    assert.equal(
      k,
      buildValidationDecisionIdempotencyKey({
        companyId: "co1",
        draftId: "d1",
        cycle,
        validationAttempt: 1,
      })
    )
  })

  it("6 — tentative 1 vs 2 → keys différentes", () => {
    const a = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    const b = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 2,
    })
    assert.notEqual(a, b)
    assert.equal(resolveValidationAttemptNumber(null), 1)
    const retryRow = {
      id: "j1",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_FAIL_RETRYABLE",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: { attempt: 1, ...cycle },
      createdAt: new Date(),
    } as ValidationJournalRow
    assert.equal(resolveValidationAttemptNumber(retryRow), 2)
  })

  it("7 — auto-intent : 4 codes → même key", () => {
    const keys = AUTO_DECISION_INTENT_CODES.map(() =>
      buildAutoIntentIdempotencyKey({
        companyId: "co1",
        draftId: "d1",
        frozen,
      })
    )
    assert.equal(new Set(keys).size, 1)
    assert.match(keys[0]!, /^v1:auto-intent:[a-f0-9]{64}$/)
  })

  it("8 — frozen cycle différent → key différente", () => {
    const a = buildAutoIntentIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      frozen,
    })
    const b = buildAutoIntentIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      frozen: { ...frozen, validatedDraftVersion: 99 },
    })
    assert.notEqual(a, b)
  })

  it("9 — SYSTEM_ACTOR_INVALID même cycle → même key", () => {
    const a = buildSystemActorInvalidIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      frozen,
    })
    const b = buildSystemActorInvalidIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      frozen,
    })
    assert.equal(a, b)
    assert.match(a, /^v1:system-actor-invalid:[a-f0-9]{64}$/)
  })
})

describe("CORRECTION-4A — appendOnce repository", () => {
  function fakeDb(opts: {
    createImpl: (data: Record<string, unknown>) => Promise<JournalRow>
    findUniqueImpl: (key: string) => Promise<JournalRow | null>
  }) {
    return {
      acquisitionDecisionJournal: {
        create: async ({ data }: { data: Record<string, unknown> }) =>
          opts.createImpl(data),
        findUnique: async ({
          where,
        }: {
          where: { idempotencyKey: string }
        }) => opts.findUniqueImpl(where.idempotencyKey),
      },
    }
  }

  const baseEntry: DecisionJournalEntry = {
    companyId: "co1",
    draftId: "d1",
    decisionCode: "VALIDATION_PASS",
    reasons: ["OK"],
    scores: {},
    actorUserId: null,
    idempotencyKey: "v1:validation:abc",
    metadata: { attempt: 1 },
  }

  it("10 — create → APPENDED", async () => {
    const row: JournalRow = {
      id: "new1",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: ["OK"],
      scores: {},
      actorUserId: null,
      metadata: { attempt: 1 },
      createdAt: new Date(),
      idempotencyKey: "v1:validation:abc",
    }
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => row,
        findUniqueImpl: async () => null,
      }) as never
    )
    const r = await repo.appendOnce(baseEntry)
    assert.equal(r.outcome, "APPENDED")
    assert.equal(r.row.id, "new1")
  })

  it("11 — P2002 + row présente → ALREADY_EXISTS", async () => {
    const winner: JournalRow = {
      id: "win",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_QUARANTINE",
      reasons: ["Q"],
      scores: {},
      actorUserId: null,
      metadata: { attempt: 1 },
      createdAt: new Date(),
      idempotencyKey: "v1:validation:abc",
    }
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          })
        },
        findUniqueImpl: async () => winner,
      }) as never
    )
    const r = await repo.appendOnce(baseEntry)
    assert.equal(r.outcome, "ALREADY_EXISTS")
    assert.equal(r.row.decisionCode, "VALIDATION_QUARANTINE")
  })

  it("R1 — P2002 + même clé + même companyId/draftId → ALREADY_EXISTS", async () => {
    const winner: JournalRow = {
      id: "win-scope",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: ["OK"],
      scores: {},
      actorUserId: null,
      metadata: { attempt: 1 },
      createdAt: new Date(),
      idempotencyKey: "v1:validation:abc",
    }
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          })
        },
        findUniqueImpl: async () => winner,
      }) as never
    )
    const r = await repo.appendOnce(baseEntry)
    assert.equal(r.outcome, "ALREADY_EXISTS")
    assert.equal(r.row.companyId, "co1")
    assert.equal(r.row.draftId, "d1")
  })

  it("R1 — P2002 + même clé + companyId différent → fail-closed", async () => {
    const winner: JournalRow = {
      id: "x-tenant",
      companyId: "OTHER_CO",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: null,
      createdAt: new Date(),
      idempotencyKey: "v1:validation:abc",
    }
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          })
        },
        findUniqueImpl: async () => winner,
      }) as never
    )
    await assert.rejects(
      () => repo.appendOnce(baseEntry),
      (e: unknown) => {
        assert.ok(e instanceof Error)
        assert.equal(e.message, "DECISION_JOURNAL_IDEMPOTENCY_SCOPE_MISMATCH")
        assert.equal(e.message.includes("co1"), false)
        assert.equal(e.message.includes("d1"), false)
        assert.equal(e.message.includes("OTHER_CO"), false)
        assert.equal(e.message.includes("v1:validation:abc"), false)
        return true
      }
    )
  })

  it("R1 — P2002 + même clé + draftId différent → fail-closed", async () => {
    const winner: JournalRow = {
      id: "x-draft",
      companyId: "co1",
      draftId: "OTHER_DRAFT",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: null,
      createdAt: new Date(),
      idempotencyKey: "v1:validation:abc",
    }
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          })
        },
        findUniqueImpl: async () => winner,
      }) as never
    )
    await assert.rejects(
      () => repo.appendOnce(baseEntry),
      (e: unknown) => {
        assert.ok(e instanceof Error)
        assert.equal(e.message, "DECISION_JOURNAL_IDEMPOTENCY_SCOPE_MISMATCH")
        assert.equal(e.message.includes("co1"), false)
        assert.equal(e.message.includes("d1"), false)
        assert.equal(e.message.includes("OTHER_DRAFT"), false)
        assert.equal(e.message.includes("v1:validation:abc"), false)
        return true
      }
    )
  })

  it("12 — P2002 + row absente → rethrow", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    })
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw err
        },
        findUniqueImpl: async () => null,
      }) as never
    )
    await assert.rejects(() => repo.appendOnce(baseEntry), (e) => e === err)
  })

  it("13 — erreur non-P2002 → rethrow", async () => {
    const err = new Error("db down")
    const repo = new AcquisitionDecisionJournalRepository(
      fakeDb({
        createImpl: async () => {
          throw err
        },
        findUniqueImpl: async () => null,
      }) as never
    )
    await assert.rejects(() => repo.appendOnce(baseEntry), (e) => e === err)
  })

  it("16 — legacy append sans clé reste fonctionnel", async () => {
    let created = false
    const repo = new AcquisitionDecisionJournalRepository({
      acquisitionDecisionJournal: {
        create: async () => {
          created = true
          return { id: "x" }
        },
      },
    } as never)
    await repo.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "HUMAN_REVIEW_REQUIRED",
      reasons: [],
      scores: {},
      actorUserId: null,
    })
    assert.equal(created, true)
  })

  it("14 — deux tentatives même slot → une écriture logique", async () => {
    const store = new Map<string, JournalRow>()
    const repo = new AcquisitionDecisionJournalRepository({
      acquisitionDecisionJournal: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const key = String(data.idempotencyKey)
          if (store.has(key)) {
            throw new Prisma.PrismaClientKnownRequestError("unique", {
              code: "P2002",
              clientVersion: "test",
            })
          }
          const row: JournalRow = {
            id: `id-${store.size}`,
            companyId: String(data.companyId),
            draftId: String(data.draftId),
            decisionCode: String(data.decisionCode),
            reasons: data.reasons,
            scores: data.scores,
            actorUserId: (data.actorUserId as string | null) ?? null,
            metadata: data.metadata ?? null,
            createdAt: new Date(),
            idempotencyKey: key,
          }
          store.set(key, row)
          return row
        },
        findUnique: async ({
          where,
        }: {
          where: { idempotencyKey: string }
        }) => store.get(where.idempotencyKey) ?? null,
      },
    } as never)

    const key = buildValidationDecisionIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      cycle,
      validationAttempt: 1,
    })
    const e1: DecisionJournalEntry = {
      ...baseEntry,
      decisionCode: "VALIDATION_PASS",
      idempotencyKey: key,
    }
    const e2: DecisionJournalEntry = {
      ...baseEntry,
      decisionCode: "VALIDATION_FAIL_TERMINAL",
      idempotencyKey: key,
    }
    const [r1, r2] = await Promise.all([repo.appendOnce(e1), repo.appendOnce(e2)])
    const outcomes = [r1.outcome, r2.outcome].sort()
    assert.deepEqual(outcomes, ["ALREADY_EXISTS", "APPENDED"])
    assert.equal(store.size, 1)
    assert.equal(r1.row.id, r2.row.id)
  })

  it("15 — auto-intent contradictoire → winner DB, jamais perdant local", async () => {
    const store = new Map<string, JournalRow>()
    const repo = new AcquisitionDecisionJournalRepository({
      acquisitionDecisionJournal: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const key = String(data.idempotencyKey)
          if (store.has(key)) {
            throw new Prisma.PrismaClientKnownRequestError("unique", {
              code: "P2002",
              clientVersion: "test",
            })
          }
          const row: JournalRow = {
            id: `id-${store.size}`,
            companyId: String(data.companyId),
            draftId: String(data.draftId),
            decisionCode: String(data.decisionCode),
            reasons: data.reasons,
            scores: data.scores,
            actorUserId: null,
            metadata: data.metadata ?? null,
            createdAt: new Date(),
            idempotencyKey: key,
          }
          store.set(key, row)
          return row
        },
        findUnique: async ({
          where,
        }: {
          where: { idempotencyKey: string }
        }) => store.get(where.idempotencyKey) ?? null,
      },
    } as never)

    const key = buildAutoIntentIdempotencyKey({
      companyId: "co1",
      draftId: "d1",
      frozen,
    })
    const convert: DecisionJournalEntry = {
      companyId: "co1",
      draftId: "d1",
      decisionCode: "AUTO_APPROVE_CONVERT",
      reasons: ["C"],
      scores: {},
      actorUserId: null,
      idempotencyKey: key,
    }
    const human: DecisionJournalEntry = {
      companyId: "co1",
      draftId: "d1",
      decisionCode: "HUMAN_REVIEW_REQUIRED",
      reasons: ["H"],
      scores: {},
      actorUserId: null,
      idempotencyKey: key,
    }
    const first = await repo.appendOnce(convert)
    const second = await repo.appendOnce(human)
    assert.equal(first.outcome, "APPENDED")
    assert.equal(second.outcome, "ALREADY_EXISTS")
    assert.equal(second.row.decisionCode, "AUTO_APPROVE_CONVERT")
    assert.notEqual(second.row.decisionCode, "HUMAN_REVIEW_REQUIRED")
    assert.equal(store.size, 1)
  })
})
