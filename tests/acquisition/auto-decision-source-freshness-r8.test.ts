/**
 * PLAN-ACQ-DETECTION-001-R8 — Fraîcheur contenu source avant auto-décision.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { gateAutoDecisionByDetectionProof } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import {
  assertAutoDecisionSourceFreshInTransaction,
  evaluateAutoDecisionSourceFreshness,
} from "@/lib/acquisition/policy/auto-decision-source-freshness"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import {
  applyCancellationFollowUpTransactionally,
  CancellationSourceContentStaleError,
} from "@/lib/acquisition/policy/cancellation-followup"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import type { DecisionJournalEntry } from "@/lib/acquisition/policy/decision-journal.repository"
import { readFileSync } from "node:fs"
import path from "node:path"

const HASH_A = "content-hash-A"
const HASH_B = "content-hash-B"

function decision(code: string) {
  return { code, reasons: ["OK"], scores: {} }
}

describe("R8 auto-decision source freshness", () => {
  it("1. A/A/A + CONSULTATION → AUTO autorisé", () => {
    const freshness = evaluateAutoDecisionSourceFreshness({
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_A,
    })
    assert.equal(freshness.ok, true)

    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_APPROVE_CONVERT"),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_A,
    })
    assert.equal(gated.code, "AUTO_APPROVE_CONVERT")
  })

  it("2. detection A / extraction A / source B → aucune approve/conversion", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_APPROVE_CONVERT"),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_B,
    })
    assert.equal(gated.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(gated.reasons.includes("SOURCE_CONTENT_STALE"))
    assert.ok(gated.reasons.includes("SOURCE_HASH_STALE"))
  })

  it("3. detection A / extraction B / source B → bloqué", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_APPROVE_ONLY"),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_B,
      currentSourceContentHash: HASH_B,
    })
    assert.equal(gated.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(gated.reasons.includes("DETECTION_EXTRACTION_MISMATCH"))
  })

  it("4. source content absent → bloqué", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_APPROVE_CONVERT"),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: null,
    })
    assert.equal(gated.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(gated.reasons.includes("SOURCE_CONTENT_MISSING"))
  })

  it("5. CANCELLATION A/A/A → cancellation path autorisé", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_REJECT_CANCELLED"),
      detectionClassification: "CANCELLATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_A,
    })
    assert.equal(gated.code, "AUTO_REJECT_CANCELLED")
  })

  it("6. CANCELLATION A/A/B → aucun reject/follow-up (pas d’exception fraîcheur)", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: decision("AUTO_REJECT_CANCELLED"),
      detectionClassification: "CANCELLATION",
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_B,
    })
    assert.equal(gated.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(gated.reasons.includes("SOURCE_CONTENT_STALE"))
  })

  it("7. changement source après 1ère lecture / avant mutation TX → bloqué", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    let sourceHash = HASH_A
    const db = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn(db)
      },
      worksiteImportDraft: {
        findFirst: async () => ({
          id: "d1",
          status: "PENDING_REVIEW",
          version: 1,
          proposedWorksiteName: "Site",
          proposedStartDate: new Date("2026-08-01"),
          proposedEndDate: new Date("2026-08-05"),
          warningData: [],
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
        updateMany: async () => {
          throw new Error("MUST_NOT_MUTATE_WHEN_STALE")
        },
      },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: sourceHash }),
      },
      $queryRaw: async () => [{ contentHash: sourceHash }],
    }

    const fence: TransactionalOwnershipFence = {
      assertOwnedAndLock: async () => {
        // Race : contenu bascule après fence, avant assert freshness.
        sourceHash = HASH_B
        return "OWNED"
      },
    }

    const review = new ImportDraftReviewService({ db: db as never, log: () => {} })
    const result = await review.approveImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 },
      {
        transactionalOwnershipFence: fence,
        requireSourceContentHash: HASH_A,
      }
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, "SOURCE_CONTENT_STALE")
  })

  it("8. perte de lease → aucune mutation", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    let mutated = false
    const db = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn(db)
      },
      worksiteImportDraft: {
        findFirst: async () => ({
          id: "d1",
          status: "PENDING_REVIEW",
          version: 1,
          proposedWorksiteName: "Site",
          proposedStartDate: new Date("2026-08-01"),
          proposedEndDate: new Date("2026-08-05"),
          warningData: [],
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
        updateMany: async () => {
          mutated = true
          return { count: 1 }
        },
      },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: HASH_A }),
      },
      $queryRaw: async () => [{ contentHash: HASH_A }],
    }
    const fence: TransactionalOwnershipFence = {
      assertOwnedAndLock: async () => "NOT_OWNED",
    }
    const review = new ImportDraftReviewService({ db: db as never, log: () => {} })
    const result = await review.approveImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId: "co1" },
      { draftId: "d1", expectedVersion: 1 },
      {
        transactionalOwnershipFence: fence,
        requireSourceContentHash: HASH_A,
      }
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, "LEASE_NOT_OWNED")
    assert.equal(mutated, false)
  })

  it("9. legacy gate + assert TX appliquent la même freshness policy", async () => {
    const pure = evaluateAutoDecisionSourceFreshness({
      detectionContentHash: HASH_A,
      contentHashAtExtraction: HASH_A,
      currentSourceContentHash: HASH_B,
    })
    assert.equal(pure.ok, false)

    const tx = {
      worksiteImportDraft: {
        findFirst: async () => ({
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
      },
      $queryRaw: async () => [{ contentHash: HASH_B }],
    }
    const txResult = await assertAutoDecisionSourceFreshInTransaction(tx as never, {
      companyId: "co1",
      draftId: "d1",
      expectedContentHash: HASH_A,
    })
    assert.equal(txResult, "STALE")

    const legacySrc = readFileSync(
      path.join(process.cwd(), "src/lib/acquisition/policy/auto-decision.service.ts"),
      "utf8"
    )
    assert.match(legacySrc, /loadCurrentAcquisitionContentHash/)
    assert.match(legacySrc, /currentSourceContentHash/)
    assert.match(legacySrc, /requireSourceContentHash/)
  })

  it("10. cancellation follow-up TX refuse source stale", async () => {
    const db = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn(db)
      },
      worksiteImportDraft: {
        findFirst: async () => ({
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
        updateMany: async () => {
          throw new Error("MUST_NOT_REJECT_LINKED")
        },
      },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: HASH_B }),
      },
      acquisitionDecisionJournal: {
        create: async () => {
          throw new Error("MUST_NOT_JOURNAL")
        },
      },
      $queryRaw: async () => [{ contentHash: HASH_B }],
      $executeRaw: async () => 0,
    }
    const fence: TransactionalOwnershipFence = {
      assertOwnedAndLock: async () => "OWNED",
    }
    await assert.rejects(
      () =>
        applyCancellationFollowUpTransactionally({
          companyId: "co1",
          sourceDraftId: "d1",
          threadId: null,
          frozen: {
            contentHash: HASH_A,
            extractionSchemaVersion: "2",
            validatedDraftVersion: 1,
          },
          actorUserId: "sys1",
          db: db as never,
          transactionalOwnershipFence: fence,
          requireSourceContentHash: HASH_A,
        }),
      (err: unknown) => err instanceof CancellationSourceContentStaleError
    )
  })

  it("wiring — worker exige requireSourceContentHash + gate CANCEL", () => {
    const workerSrc = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/orchestrator/acquisition-auto-decision.worker.ts"
      ),
      "utf8"
    )
    assert.match(workerSrc, /loadCurrentAcquisitionContentHash/)
    assert.match(workerSrc, /requireSourceContentHash:\s*frozenForWork\.contentHash/)
    assert.match(workerSrc, /CancellationSourceContentStaleError/)
    assert.match(workerSrc, /SOURCE_CONTENT_STALE/)
    // CANCEL decision puis gate (même bloc NEEDS_DECISION) — pas seulement l’import.
    const needsDecision = workerSrc.indexOf('if (phase === "NEEDS_DECISION")')
    const cancelInBlock = workerSrc.indexOf(
      'code: "AUTO_REJECT_CANCELLED"',
      needsDecision
    )
    const gateInBlock = workerSrc.indexOf(
      "gateAutoDecisionByDetectionProof",
      needsDecision
    )
    assert.ok(needsDecision > 0)
    assert.ok(cancelInBlock > needsDecision)
    assert.ok(gateInBlock > cancelInBlock)

    // R8-C2 — fraîcheur dans la TX intent (après fence, avant append)
    const intentTx = workerSrc.indexOf("appendOnceInTransaction(entry)")
    const freshBeforeAppend = workerSrc.lastIndexOf(
      "assertAutoDecisionSourceFreshInTransaction",
      intentTx
    )
    assert.ok(intentTx > 0)
    assert.ok(freshBeforeAppend > 0 && freshBeforeAppend < intentTx)
  })

  it("C2.1 source A au gate, B avant TX intent → aucun AUTO intent", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    let sourceHash = HASH_A
    let intentCreated = false
    const draft = {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version: 7,
      contentHashAtExtraction: HASH_A,
      extractionSchemaVersion: "2",
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      acquisitionMessageId: "msg1",
      proposedWorksiteName: "Site",
      proposedClientName: "Client",
      proposedAddress: "1 rue",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-10T00:00:00.000Z"),
      proposedEndDate: new Date("2026-10-12T00:00:00.000Z"),
      proposedClientId: "c1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: { requestClassification: "CONSULTATION", clientEmail: "a@b.fr" },
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "b.fr",
        threadId: null,
      },
    }
    const entries: Array<{ decisionCode: string }> = []
    const journal = {
      entries,
      async append() {},
      async appendOnce() {
        throw new Error("appendOnce bypass forbidden")
      },
      async findLatestValidationDecisionForCycle() {
        return {
          id: "v1",
          companyId: "co1",
          draftId: "d1",
          decisionCode: "VALIDATION_PASS" as const,
          reasons: [],
          scores: {},
          actorUserId: null,
          metadata: {
            contentHash: HASH_A,
            extractionSchemaVersion: "2",
            draftVersion: 7,
          },
          createdAt: new Date(),
        }
      },
      async findLatestAutoIntentForCycle() {
        return null
      },
      async findLatestCancellationFollowUpForCycle() {
        return null
      },
      async findLatestSystemActorInvalidForCycle() {
        return null
      },
      async findLatestAutoRejectIntentAny() {
        return null
      },
    }
    const db = {
      worksiteImportDraft: {
        findFirst: async () => draft,
      },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: sourceHash }),
      },
      $queryRaw: async () => [{ contentHash: sourceHash }],
      acquisitionDecisionJournal: {
        findUnique: async () => null,
        create: async () => {
          intentCreated = true
          throw new Error("MUST_NOT_CREATE_INTENT")
        },
      },
      async $transaction(fn: (tx: typeof db) => Promise<unknown>) {
        // Race : contenu bascule au moment de la TX intent (après gate A/A/A).
        sourceHash = HASH_B
        return fn(db)
      },
    }
    const { runAcquisitionAutoDecisionWorker } = await import(
      "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
    )
    const result = await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: HASH_A,
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS" as const,
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => true,
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          throw new Error("no approve")
        },
        rejectImportDraft: async () => {
          throw new Error("no reject")
        },
      } as never,
      evaluationDeps: {
        db: db as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "EMAIL" as const,
        }),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            autoApproveEnabled: true,
            autoConvertEnabled: true,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "c1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: db as never,
    })
    assert.equal(intentCreated, false)
    assert.equal(result.stats.stale, 1)
    assert.equal(result.stats.intentAppended, 0)
    assert.equal(
      entries.some((e) => String(e.decisionCode).startsWith("AUTO_")),
      false
    )
  })

  it("C2.2 A reste A → intent écrit normalement", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    const draft = {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version: 7,
      contentHashAtExtraction: HASH_A,
      extractionSchemaVersion: "2",
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      acquisitionMessageId: "msg1",
      proposedWorksiteName: "Site",
      proposedClientName: "Client",
      proposedAddress: "1 rue",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-10T00:00:00.000Z"),
      proposedEndDate: new Date("2026-10-12T00:00:00.000Z"),
      proposedClientId: "c1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: { requestClassification: "CONSULTATION", clientEmail: "a@b.fr" },
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "b.fr",
        threadId: null,
      },
    }
    const entries: DecisionJournalEntry[] = []
    const journal = {
      entries,
      async append(e: DecisionJournalEntry) {
        entries.push(e)
      },
      async appendOnce(e: DecisionJournalEntry) {
        entries.push(e)
        return {
          outcome: "APPENDED" as const,
          row: {
            id: "i1",
            companyId: e.companyId,
            draftId: e.draftId,
            decisionCode: e.decisionCode,
            reasons: e.reasons,
            scores: e.scores,
            actorUserId: e.actorUserId,
            metadata: e.metadata ?? null,
            createdAt: new Date(),
          },
        }
      },
      async findLatestValidationDecisionForCycle() {
        return {
          id: "v1",
          companyId: "co1",
          draftId: "d1",
          decisionCode: "VALIDATION_PASS" as const,
          reasons: [],
          scores: {},
          actorUserId: null,
          metadata: {
            contentHash: HASH_A,
            extractionSchemaVersion: "2",
            draftVersion: 7,
          },
          createdAt: new Date(),
        }
      },
      async findLatestAutoIntentForCycle() {
        return null
      },
      async findLatestCancellationFollowUpForCycle() {
        return null
      },
      async findLatestSystemActorInvalidForCycle() {
        return null
      },
      async findLatestAutoRejectIntentAny() {
        return null
      },
    }
    type J = typeof journal
    const db = {
      worksiteImportDraft: { findFirst: async () => draft },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: HASH_A }),
      },
      $queryRaw: async () => [{ contentHash: HASH_A }],
      acquisitionDecisionJournal: {
        findUnique: async () => null,
        create: async (args: { data: DecisionJournalEntry & { idempotencyKey: string } }) => {
          const r = await journal.appendOnce({
            ...args.data,
            reasons: args.data.reasons as string[],
            scores: args.data.scores as Record<string, number>,
          })
          return { ...r.row, idempotencyKey: args.data.idempotencyKey }
        },
      },
      async $transaction<T>(fn: (tx: typeof db) => Promise<T>) {
        return fn(db)
      },
    }
    const { runAcquisitionAutoDecisionWorker } = await import(
      "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
    )
    let approveCalls = 0
    const result = await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: HASH_A,
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS" as const,
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => false,
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          approveCalls++
          draft.status = "APPROVED"
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: {
        db: db as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "EMAIL" as const,
        }),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            autoApproveEnabled: true,
            autoConvertEnabled: false,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "c1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: db as never,
    })
    assert.equal(result.stats.stale, 0)
    assert.equal(result.stats.intentAppended, 1)
    assert.equal(approveCalls, 1)
    assert.ok(entries.some((e) => String(e.decisionCode).startsWith("AUTO_APPROVE")))
    void 0 as J
  })

  it("C2.3 lease perdue → aucun intent", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    const draft = {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version: 7,
      contentHashAtExtraction: HASH_A,
      extractionSchemaVersion: "2",
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      acquisitionMessageId: "msg1",
      proposedWorksiteName: "Site",
      proposedClientName: "Client",
      proposedAddress: "1 rue",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-10T00:00:00.000Z"),
      proposedEndDate: new Date("2026-10-12T00:00:00.000Z"),
      proposedClientId: "c1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: { requestClassification: "CONSULTATION", clientEmail: "a@b.fr" },
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "b.fr",
        threadId: null,
      },
    }
    let intentCreated = false
    const journal = {
      entries: [] as Array<{ decisionCode: string }>,
      async append() {},
      async appendOnce() {
        throw new Error("no")
      },
      async findLatestValidationDecisionForCycle() {
        return {
          id: "v1",
          companyId: "co1",
          draftId: "d1",
          decisionCode: "VALIDATION_PASS" as const,
          reasons: [],
          scores: {},
          actorUserId: null,
          metadata: {
            contentHash: HASH_A,
            extractionSchemaVersion: "2",
            draftVersion: 7,
          },
          createdAt: new Date(),
        }
      },
      async findLatestAutoIntentForCycle() {
        return null
      },
      async findLatestCancellationFollowUpForCycle() {
        return null
      },
      async findLatestSystemActorInvalidForCycle() {
        return null
      },
      async findLatestAutoRejectIntentAny() {
        return null
      },
    }
    const db = {
      worksiteImportDraft: { findFirst: async () => draft },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: HASH_A }),
      },
      $queryRaw: async () => [{ contentHash: HASH_A }],
      acquisitionDecisionJournal: {
        findUnique: async () => null,
        create: async () => {
          intentCreated = true
          throw new Error("MUST_NOT")
        },
      },
      async $transaction(fn: (tx: typeof db) => Promise<unknown>) {
        return fn(db)
      },
    }
    const { runAcquisitionAutoDecisionWorker } = await import(
      "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
    )
    const result = await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: HASH_A,
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS" as const,
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "NOT_OWNED",
      },
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => ({ ok: false }),
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: {
        db: db as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "EMAIL" as const,
        }),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            autoApproveEnabled: true,
            autoConvertEnabled: false,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "c1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: db as never,
    })
    assert.equal(intentCreated, false)
    assert.equal(result.skipReason, "LEASE_STOLEN")
  })

  it("C2.4 legacy fenced A→B avant journal → aucun journal AUTO", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "sys1"
    let sourceHash = HASH_A
    const journalEntries: DecisionJournalEntry[] = []
    const draft = {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version: 1,
      proposedWorksiteName: "Site Alpha",
      proposedClientName: "Client SA",
      proposedAddress: "10 rue Test",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-01"),
      proposedEndDate: new Date("2026-10-05"),
      proposedContactEmail: "c@example.com",
      proposedClientId: "c1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: {},
      contentHashAtExtraction: HASH_A,
      extractionSchemaVersion: "3",
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      acquisitionMessageId: "msg1",
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "partner.fr",
        threadId: null,
      },
    }
    const dbApi = {
      worksiteImportDraft: {
        findFirst: async () => draft,
      },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: sourceHash }),
      },
      $queryRaw: async () => [{ contentHash: sourceHash }],
      acquisitionDecisionJournal: {
        create: async (args: { data: DecisionJournalEntry }) => {
          journalEntries.push(args.data)
          return { id: "j1", ...args.data, createdAt: new Date() }
        },
      },
      async $transaction<T>(fn: (tx: typeof dbApi) => Promise<T>) {
        sourceHash = HASH_B
        return fn(dbApi)
      },
    }
    const { maybeRunAutoDecisionAfterExtraction } = await import(
      "@/lib/acquisition/policy/auto-decision.service"
    )
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
      deps: {
        referenceInstant: new Date("2026-09-15T12:00:00.000Z"),
        db: dbApi as never,
        journal: {
          append: async (e: DecisionJournalEntry) => {
            journalEntries.push(e)
          },
        } as never,
        review: {
          approveImportDraft: async () => {
            throw new Error("no approve")
          },
        } as never,
        conversion: {
          convertImportDraft: async () => {
            throw new Error("no convert")
          },
        } as never,
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            companyId: "co1",
            name: "P",
            code: "partner",
            connector: "GMAIL",
            pipeline: "consultations",
            active: true,
            priority: 100,
            requireExactEmail: false,
            autoApproveEnabled: true,
            autoConvertEnabled: true,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "c1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          findPartnerByDomain: async () => null,
          findPartnerByCode: async () => null,
          findPartnerByEmail: async () => null,
          findDomain: async () => null,
          listPartners: async () => [],
          listDomains: async () => [],
          listEmails: async () => [],
          partnerExists: async () => false,
          domainExists: async () => false,
        },
        resolveSystemActor: async () =>
          ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID" as const,
          ambiguous: false,
        }),
        log: () => {},
      },
    })
    assert.equal(
      journalEntries.some((j) => String(j.decisionCode).startsWith("AUTO_")),
      false
    )
  })

  it("C2.5 legacy A/A/A → journal AUTO + chemin valide", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "sys1"
    const journalEntries: DecisionJournalEntry[] = []
    let approveCalls = 0
    const draft = {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version: 1,
      proposedWorksiteName: "Site Alpha",
      proposedClientName: "Client SA",
      proposedAddress: "10 rue Test",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-01"),
      proposedEndDate: new Date("2026-10-05"),
      proposedContactEmail: "c@example.com",
      proposedClientId: "c1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: {},
      contentHashAtExtraction: HASH_A,
      extractionSchemaVersion: "3",
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH_A,
      acquisitionMessageId: "msg1",
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "partner.fr",
        threadId: null,
      },
    }
    const dbApi = {
      worksiteImportDraft: { findFirst: async () => draft },
      acquisitionMessageContent: {
        findFirst: async () => ({ contentHash: HASH_A }),
      },
      $queryRaw: async () => [{ contentHash: HASH_A }],
      acquisitionDecisionJournal: {
        create: async (args: { data: DecisionJournalEntry }) => {
          journalEntries.push(args.data)
          return { id: "j1", ...args.data, createdAt: new Date() }
        },
      },
      async $transaction<T>(fn: (tx: typeof dbApi) => Promise<T>) {
        return fn(dbApi)
      },
    }
    const { maybeRunAutoDecisionAfterExtraction } = await import(
      "@/lib/acquisition/policy/auto-decision.service"
    )
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: {
        referenceInstant: new Date("2026-09-15T12:00:00.000Z"),
        db: dbApi as never,
        journal: {
          append: async (e: DecisionJournalEntry) => {
            journalEntries.push(e)
          },
        } as never,
        review: {
          approveImportDraft: async () => {
            approveCalls++
            draft.status = "APPROVED"
            draft.version = 2
            return { ok: true, outcome: "APPROVED", version: 2 }
          },
        } as never,
        conversion: {
          convertImportDraft: async () => {
            draft.status = "CONVERTED"
            return { ok: true, outcome: "CONVERTED" }
          },
        } as never,
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            companyId: "co1",
            name: "P",
            code: "partner",
            connector: "GMAIL",
            pipeline: "consultations",
            active: true,
            priority: 100,
            requireExactEmail: false,
            autoApproveEnabled: true,
            autoConvertEnabled: true,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "c1",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          findPartnerByDomain: async () => null,
          findPartnerByCode: async () => null,
          findPartnerByEmail: async () => null,
          findDomain: async () => null,
          listPartners: async () => [],
          listDomains: async () => [],
          listEmails: async () => [],
          partnerExists: async () => false,
          domainExists: async () => false,
        },
        resolveSystemActor: async () =>
          ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID" as const,
          ambiguous: false,
        }),
        log: () => {},
      },
    })
    assert.ok(journalEntries.some((j) => j.decisionCode === "AUTO_APPROVE_CONVERT"))
    assert.equal(approveCalls, 1)
    assert.equal(draft.status, "CONVERTED")
  })
})

describe("R12 source content FOR UPDATE lock", () => {
  it("1–2. freshness TX utilise FOR UPDATE + companyId/acquisitionMessageId", () => {
    const src = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/policy/auto-decision-source-freshness.ts"
      ),
      "utf8"
    )
    assert.match(src, /FOR UPDATE/)
    assert.match(src, /acquisition_message_contents/)
    assert.match(src, /"companyId"\s*=\s*\$\{companyId\}/)
    assert.match(src, /"acquisitionMessageId"\s*=\s*\$\{acquisitionMessageId\}/)
    assert.match(src, /lockCurrentAcquisitionContentHashForUpdate/)
    // assert TX ne doit plus lire le hash via findFirst
    const assertFn = src.slice(
      src.indexOf("export async function assertAutoDecisionSourceFreshInTransaction")
    )
    assert.equal(
      /acquisitionMessageContent\.findFirst/.test(assertFn),
      false
    )
  })

  it("3. ligne absente => STALE", async () => {
    const tx = {
      worksiteImportDraft: {
        findFirst: async () => ({
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
      },
      $queryRaw: async () => [],
    }
    const r = await assertAutoDecisionSourceFreshInTransaction(tx as never, {
      companyId: "co1",
      draftId: "d1",
      expectedContentHash: HASH_A,
    })
    assert.equal(r, "STALE")
  })

  it("4. hash A/A/A => FRESH", async () => {
    const tx = {
      worksiteImportDraft: {
        findFirst: async () => ({
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
      },
      $queryRaw: async () => [{ contentHash: HASH_A }],
    }
    const r = await assertAutoDecisionSourceFreshInTransaction(tx as never, {
      companyId: "co1",
      draftId: "d1",
      expectedContentHash: HASH_A,
    })
    assert.equal(r, "FRESH")
  })

  it("5. hash source B => STALE", async () => {
    const tx = {
      worksiteImportDraft: {
        findFirst: async () => ({
          detectionContentHash: HASH_A,
          contentHashAtExtraction: HASH_A,
          acquisitionMessageId: "msg1",
        }),
      },
      $queryRaw: async () => [{ contentHash: HASH_B }],
    }
    const r = await assertAutoDecisionSourceFreshInTransaction(tx as never, {
      companyId: "co1",
      draftId: "d1",
      expectedContentHash: HASH_A,
    })
    assert.equal(r, "STALE")
  })

  it("6. worksiteCreation ne passe jamais \"\" à requireSourceContentHash", () => {
    const src = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/orchestrator/acquisition-worksite-creation.worker.ts"
      ),
      "utf8"
    )
    assert.match(src, /requiredSourceContentHash/)
    assert.match(src, /requireSourceContentHash:\s*requiredSourceContentHash/)
    assert.equal(/requireSourceContentHash:\s*draft2\.contentHashAtExtraction\s*\|\|/.test(src), false)
    assert.equal(/requireSourceContentHash:\s*""/.test(src), false)
  })
})
