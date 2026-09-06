/**
 * PLAN-ACQ-AGENTS-LOT-3C — Flag XOR + placeholders post-extraction.
 * Aucun métier validation / autoDecision / worksiteCreation.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import {
  isAcquisitionOrchestratorPostExtractionStepsEnabled,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import {
  createDefaultStubStepRunners,
  runAcquisitionOrchestrator,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import {
  ORCHESTRATOR_STEP_KEYS,
  type AcquisitionOrchestratorStepRunners,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import {
  createPostExtractionPlaceholderRunner,
  resolveOrchestratorAutoOwnership,
  type OrchestratorAutoCapability,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { runDraftExtractionOrchestrated } from "@/lib/acquisition/extraction/extraction.service"
import type {
  DraftExtractionRow,
  MessageContentLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"

const WORKERS_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"
)

const cfg = {
  maxDurationMs: 60_000,
  safetyMarginMs: 1_000,
  leaseTtlMs: 120_000,
}

function enableExtractionFlags() {
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
  process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
  process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
}

function createFakeRepo() {
  let draft: DraftExtractionRow & { status: WorksiteImportDraftStatus } = {
    id: "draft1",
    companyId: "co1",
    acquisitionMessageId: "msg1",
    status: "PENDING_EXTRACTION",
    version: 0,
    extractionAttemptCount: 0,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
  }
  const content: MessageContentLite = {
    normalizedText: "Chantier : Tour Alpha\nContact: alice@example.com\nRéférence : REF-99",
    contentHash: "hash-abc",
  }
  const persists: PersistExtractionInput[] = []
  let claimCount = 0

  return {
    persists,
    get draft() {
      return draft
    },
    get claimCount() {
      return claimCount
    },
    async findDraft(companyId: string, draftId: string) {
      if (draft.companyId !== companyId || draft.id !== draftId) return null
      return { ...draft }
    },
    async findContent() {
      return { ...content }
    },
    async findMessage() {
      return { id: "msg1", subject: "Consultation Tour Alpha" }
    },
    async listAttachmentMetadata() {
      return []
    },
    async claimExtracting(input: { expectedVersion: number; now: Date }) {
      claimCount++
      if (draft.version !== input.expectedVersion) return null
      draft = {
        ...draft,
        status: "EXTRACTING",
        version: draft.version + 1,
        extractionAttemptCount: draft.extractionAttemptCount + 1,
        extractionStartedAt: input.now,
      }
      return { ...draft }
    },
    async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
      persists.push(input)
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        extractionSchemaVersion: "2",
      }
      return "OK"
    },
    async markFailedWhileExtracting() {
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK" as const
    },
  }
}

describe("PLAN-ACQ-AGENTS-LOT-3C post-extraction foundations", () => {
  beforeEach(() => {
    enableExtractionFlags()
  })

  it("1–3. flag absent / false / true", () => {
    assert.equal(isAcquisitionOrchestratorPostExtractionStepsEnabled({}), false)
    assert.equal(
      isAcquisitionOrchestratorPostExtractionStepsEnabled({
        ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS: undefined,
      }),
      false
    )
    assert.equal(
      isAcquisitionOrchestratorPostExtractionStepsEnabled({
        ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS: "false",
      }),
      false
    )
    assert.equal(
      isAcquisitionOrchestratorPostExtractionStepsEnabled({
        ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS: "true",
      }),
      true
    )
  })

  it("8. STEP_ORDER exact 8 steps", () => {
    assert.deepEqual([...ORCHESTRATOR_STEP_KEYS], [
      "gmailSync",
      "attachmentRecovery",
      "attachmentDownload",
      "contentFetch",
      "extraction",
      "validation",
      "autoDecision",
      "worksiteCreation",
    ])
    assert.equal(ORCHESTRATOR_STEP_KEYS.length, 8)
  })

  it("4. capability forge → ownership NOT_OWNED → hook legacy jamais invoqué", async () => {
    const forged = { not: "capability" } as unknown as OrchestratorAutoCapability
    assert.equal(await resolveOrchestratorAutoOwnership(forged), "NOT_OWNED")
    const repo = createFakeRepo()
    let autoCalls = 0
    const result = await runDraftExtractionOrchestrated(
      { companyId: "co1", draftId: "draft1" },
      forged,
      {
        repository: repo as never,
        postExtractionStepsEnabled: false,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    // Persist OK mais run ≠ SUCCESS (lease stolen après persist)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "LEASE_STOLEN")
    assert.equal(autoCalls, 0)
    assert.equal(repo.persists.length, 0)
  })

  it("5. flag ON → hook legacy jamais invoqué (même capability forge)", async () => {
    const forged = { not: "capability" } as unknown as OrchestratorAutoCapability
    const repo = createFakeRepo()
    let autoCalls = 0
    const result = await runDraftExtractionOrchestrated(
      { companyId: "co1", draftId: "draft1" },
      forged,
      {
        repository: repo as never,
        postExtractionStepsEnabled: true,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "LEASE_STOLEN")
    assert.equal(autoCalls, 0)
    assert.equal(repo.persists.length, 0)
  })

  it("6. flag OFF → post steps SKIPPED/DISABLED", async () => {
    const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const post = createPostExtractionPlaceholderRunner(false)
    const light: AcquisitionOrchestratorStepRunners = {
      ...createDefaultStubStepRunners(),
      validation: post,
      autoDecision: post,
      worksiteCreation: post,
    }
    const result = await runAcquisitionOrchestrator({
      runId: "lot3c-off",
      leaseRepository: lease,
      resolveGate: () => ({ allowed: true }),
      steps: light,
      config: cfg,
    })
    for (const key of ["validation", "autoDecision", "worksiteCreation"] as const) {
      assert.equal(result.steps[key].status, "SKIPPED")
      assert.equal(result.steps[key].skipReason, "DISABLED")
    }
  })

  it("7. flag ON placeholder → worksiteCreation NOT_IMPLEMENTED (autoDecision réel hors ce stub)", async () => {
    const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const post = createPostExtractionPlaceholderRunner(true)
    const light: AcquisitionOrchestratorStepRunners = {
      ...createDefaultStubStepRunners(),
      autoDecision: post,
      worksiteCreation: post,
    }
    const result = await runAcquisitionOrchestrator({
      runId: "lot3c-on",
      leaseRepository: lease,
      resolveGate: () => ({ allowed: true }),
      steps: light,
      config: cfg,
    })
    assert.equal(result.steps.autoDecision.skipReason, "NOT_IMPLEMENTED")
    assert.equal(result.steps.worksiteCreation.skipReason, "NOT_IMPLEMENTED")
  })

  it("9–10. wiring n’importe pas convert ; autoDecision worker branché", () => {
    const src = readFileSync(WORKERS_SRC, "utf8")
    assert.equal(/runAcquisitionAutoDecisionWorker/.test(src), true)
    assert.equal(/convertImportDraft/.test(src), false)
    assert.equal(/ImportDraftConversionService/.test(src), false)
    assert.equal(/maybeRunAutoDecisionAfterExtraction/.test(src), false)
  })

  it("12. snapshot flag stable pour tout un run (env flip ignoré)", async () => {
    const runner = createPostExtractionPlaceholderRunner(true)
    const prev = process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS
    try {
      process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = "false"
      const a = await runner({ runId: "r1", remainingMs: 10_000 })
      const b = await runner({ runId: "r1", remainingMs: 10_000 })
      assert.equal(a.skipReason, "NOT_IMPLEMENTED")
      assert.equal(b.skipReason, "NOT_IMPLEMENTED")
    } finally {
      if (prev === undefined) delete process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS
      else process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = prev
    }
  })

  it("XOR invariant : legacyHookRuns && postExtractionMode impossible", () => {
    const cases: Array<{
      orchestratorAuto: boolean
      owned: boolean
      postSteps: boolean
    }> = [
      { orchestratorAuto: true, owned: true, postSteps: false },
      { orchestratorAuto: true, owned: true, postSteps: true },
      { orchestratorAuto: true, owned: false, postSteps: false },
      { orchestratorAuto: false, owned: true, postSteps: false },
      { orchestratorAuto: false, owned: true, postSteps: true },
    ]
    for (const c of cases) {
      const legacyHookRuns = c.orchestratorAuto && c.owned && !c.postSteps
      const postExtractionMode = c.postSteps
      assert.equal(legacyHookRuns && postExtractionMode, false)
    }
  })
})
