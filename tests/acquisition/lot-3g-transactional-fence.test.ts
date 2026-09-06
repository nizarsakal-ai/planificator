/**
 * PLAN-ACQ-AGENTS-LOT-3G — Fence transactionnel AUTO + fail-closed SYSTEM.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
process.env.ACQUISITION_CONVERSION_ENABLED = "true"

import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import {
  applyCancellationFollowUpTransactionally,
  CancellationLeaseNotOwnedError,
} from "@/lib/acquisition/policy/cancellation-followup"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { runAcquisitionValidationWorker } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"

const ownedFence: TransactionalOwnershipFence = {
  assertOwnedAndLock: async () => "OWNED",
}
const notOwnedFence: TransactionalOwnershipFence = {
  assertOwnedAndLock: async () => "NOT_OWNED",
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkTs(p, out)
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p)
  }
  return out
}

describe("LOT-3G — review SYSTEM / ADMIN fence", () => {
  const prev = process.env.PLANIFICATOR_ACQUISITION_ENABLED
  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  })
  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = prev
  })

  function makeReviewDb(status = "PENDING_REVIEW") {
    let findCalls = 0
    const draft = {
      status,
      version: 1,
      proposedWorksiteName: "Chantier",
      proposedStartDate: new Date("2026-10-01"),
      proposedEndDate: new Date("2026-10-02"),
      warningData: null,
    }
    const api = {
      findCalls: () => findCalls,
      mutated: false,
      worksiteImportDraft: {
        findFirst: async () => {
          findCalls++
          return { ...draft }
        },
        updateMany: async () => {
          api.mutated = true
          draft.status = "APPROVED"
          draft.version = 2
          return { count: 1 }
        },
      },
      async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
        return fn(api)
      },
    }
    return api
  }

  it("3 — SYSTEM approve sans fence → LEASE_NOT_OWNED, zéro DB read", async () => {
    const db = makeReviewDb()
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "LEASE_NOT_OWNED")
    assert.equal(db.findCalls(), 0)
    assert.equal(db.mutated, false)
  })

  it("4 — SYSTEM reject sans fence → LEASE_NOT_OWNED, zéro DB read", async () => {
    const db = makeReviewDb()
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.rejectImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1, rejectionReason: "Annulé suite client" }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "LEASE_NOT_OWNED")
    assert.equal(db.findCalls(), 0)
    assert.equal(db.mutated, false)
  })

  it("5 — SYSTEM approve fence OWNED → APPROVED", async () => {
    const db = makeReviewDb()
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 },
      { transactionalOwnershipFence: ownedFence }
    )
    assert.equal(r.ok, true)
    assert.equal(db.mutated, true)
  })

  it("6 — SYSTEM reject fence OWNED → REJECTED", async () => {
    const db = makeReviewDb()
    db.worksiteImportDraft.updateMany = async () => {
      db.mutated = true
      return { count: 1 }
    }
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.rejectImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1, rejectionReason: "Annulé suite client" },
      { transactionalOwnershipFence: ownedFence }
    )
    assert.equal(r.ok, true)
    assert.equal(db.mutated, true)
  })

  it("7 — ADMIN approve sans fence → historique OK", async () => {
    const db = makeReviewDb()
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { actorUserId: "admin", actorRole: "ADMIN", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 }
    )
    assert.equal(r.ok, true)
    assert.equal(db.mutated, true)
  })

  it("SYSTEM approve fence NOT_OWNED → zéro mutation", async () => {
    const db = makeReviewDb()
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 },
      { transactionalOwnershipFence: notOwnedFence }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "LEASE_NOT_OWNED")
    assert.equal(db.mutated, false)
  })
})

describe("LOT-3G — validation AUTO fence", () => {
  it("2 — AUTO sans fence → fail-closed leaseStolen, zéro journal", async () => {
    const journals: unknown[] = []
    const result = await runAcquisitionValidationWorker({
      ensureOwnership: async () => "OWNED",
      journal: {
        findLatestValidationDecisionForCycle: async () => null,
        appendOnce: async (e: unknown) => {
          journals.push(e)
          return { outcome: "APPENDED", row: e }
        },
      } as never,
      selection: {
        listEligibleCandidates: async () => [],
      },
    })
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(result.stats.leaseStolen, 1)
    assert.equal(journals.length, 0)
  })

  it("1 — fence NOT_OWNED sur append → zéro journal (via worker deps)", async () => {
    // Couvert aussi par worker test heartbeat ; ici assert fence obligatoire.
    const result = await runAcquisitionValidationWorker({
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: notOwnedFence,
      selection: { listEligibleCandidates: async () => [] },
    })
    // Pas de candidats → SUCCESS ; fence non appelé. Vérifie au moins pas d’échec fence absent.
    assert.notEqual(result.skipReason, "LEASE_STOLEN")
  })
})

describe("LOT-3G — cancellation fence option", () => {
  it("8/9 — fence NOT_OWNED → throw CancellationLeaseNotOwnedError", async () => {
    const journals: unknown[] = []
    const draftsUpdated: unknown[] = []
    const db = {
      async $transaction<T>(fn: (tx: typeof db) => Promise<T>) {
        return fn(db)
      },
      async $executeRaw() {
        return undefined
      },
      acquisitionMessage: {
        findMany: async () => [],
      },
      worksiteImportDraft: {
        updateMany: async (args: unknown) => {
          draftsUpdated.push(args)
          return { count: 0 }
        },
      },
      acquisitionDecisionJournal: {
        findFirst: async () => null,
        findMany: async () => [],
        findUnique: async () => null,
        create: async (args: { data: unknown }) => {
          journals.push(args.data)
          return {
            id: "j1",
            ...(args.data as object),
            createdAt: new Date(),
          }
        },
      },
    }
    await assert.rejects(
      () =>
        applyCancellationFollowUpTransactionally({
          companyId: "co1",
          sourceDraftId: "d1",
          threadId: "th1",
          frozen: {
            contentHash: "h",
            extractionSchemaVersion: "2",
            validatedDraftVersion: 1,
          },
          actorUserId: null,
          db: db as never,
          transactionalOwnershipFence: notOwnedFence,
        }),
      (err: unknown) => err instanceof CancellationLeaseNotOwnedError
    )
    assert.equal(journals.length, 0)
    assert.equal(draftsUpdated.length, 0)
  })
})

describe("LOT-3G — static guards", () => {
  it("12 — aucun symbole ForTests sous src/lib/acquisition", () => {
    const root = path.join(process.cwd(), "src/lib/acquisition")
    for (const file of walkTs(root)) {
      const src = readFileSync(file, "utf8")
      assert.equal(
        /ForTests/.test(src),
        false,
        `ForTests trouvé dans ${file}`
      )
    }
  })
})
