/**
 * PLAN-ACQ-012-4 R1 — Fencing UI_MANUAL / UNIT_CRON / ORCHESTRATOR_AUTO.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import type {
  AttachmentDownloadOrchestratorDownloadPort,
  AttachmentDownloadOrchestratorRepository,
} from "@/lib/acquisition/attachments/attachment-download-orchestrator.types"
import { runAcquisitionAttachmentRecoveryOrchestrator } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator"
import type { AttachmentRecoveryOrchestratorRepository } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"
import { runAcquisitionContentCronOrchestrator } from "@/lib/acquisition/content/message-content-cron.orchestrator"
import type { ContentFetchOrchestratorRepository } from "@/lib/acquisition/content/message-content-cron.orchestrator.types"
import { runAcquisitionExtractionCronOrchestrator } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import type { ExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import {
  runDraftExtraction,
  runDraftExtractionOrchestrated,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import type {
  DraftExtractionRow,
  MessageContentLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import {
  InMemoryAcquisitionOrchestratorLeaseRepository,
  acquisitionOrchestratorLeaseRepository,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import type { AcquisitionOrchestratorLeaseRepositoryPort } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import * as orchestratorOwnership from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import { checkOrchestratorLeaseHeartbeat } from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import * as orchestratorWorkers from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { runProductionAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import * as orchestratorHandler from "@/lib/acquisition/orchestrator/acquisition-orchestrator.handler"
import { gmailConnectionListingAdapter } from "@/lib/acquisition/persistence/gmail-connection-listing.adapter"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { acquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { draftExtractionRepository } from "@/lib/acquisition/extraction/extraction.repository"

function actor() {
  return { userId: "u1", role: "ADMIN" as const, companyId: "co1" as string | null }
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
  let markFailedCount = 0

  const repository = {
    persists,
    get draft() {
      return draft
    },
    get claimCount() {
      return claimCount
    },
    get markFailedCount() {
      return markFailedCount
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
      markFailedCount++
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK" as const
    },
  }
  return repository
}

function selectionRepo(
  draftIds: string[]
): ExtractionCronSelectionRepository {
  return {
    listCompanyIdsWithEligibleExtraction: async () => ["co1"],
    listEligibleCandidatesForCompany: async () =>
      draftIds.map((draftId) => ({
        draftId,
        companyId: "co1",
        acquisitionMessageId: "m1",
        status: "PENDING_EXTRACTION" as const,
        createdAt: new Date(),
        extractionAttemptCount: 0,
        lastExtractionErrorAt: null,
        extractionStartedAt: null,
      })),
  }
}

function patchMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  impl: T[K]
): () => void {
  const original = target[key]
  target[key] = impl
  return () => {
    target[key] = original
  }
}

function installProductionLeaseAuthority(input?: {
  stealAfterAsserts?: number
}) {
  const repo = acquisitionOrchestratorLeaseRepository
  let acquireCalls = 0
  let assertCalls = 0
  let renewCalls = 0
  const restore = [
    patchMethod(repo, "acquire", async () => {
      acquireCalls += 1
      return { outcome: "ACQUIRED" as const }
    }),
    patchMethod(repo, "assertOwned", async () => {
      assertCalls += 1
      if (
        input?.stealAfterAsserts != null &&
        assertCalls > input.stealAfterAsserts
      ) {
        return { outcome: "NOT_OWNER" as const }
      }
      return { outcome: "OWNED" as const }
    }),
    patchMethod(repo, "renew", async () => {
      renewCalls += 1
      if (
        input?.stealAfterAsserts != null &&
        assertCalls > input.stealAfterAsserts
      ) {
        return { outcome: "NOT_OWNER" as const }
      }
      return { outcome: "OWNED" as const }
    }),
    patchMethod(repo, "release", async () => ({ outcome: "RELEASED" as const })),
  ]
  return {
    stats: () => ({ acquireCalls, assertCalls, renewCalls }),
    restore: () => {
      for (const fn of restore) fn()
    },
  }
}

function installEmptySiblingWorkers() {
  return [
    patchMethod(gmailConnectionListingAdapter, "listCompanyIdsWithGmailConnection", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithReclaimCandidates", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithRetryCandidates", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithDiscoveredAttachments", async () => []),
    patchMethod(
      acquisitionContentFetchStateRepository,
      "listCompanyIdsWithEligibleContentFetch",
      async () => []
    ),
  ]
}

function enableOrchestratorProductionFlags() {
  process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED = "true"
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  delete process.env.ACQUISITION_ORCHESTRATOR_ALLOW_STUBS
}

describe("PLAN-ACQ-012-4 fencing", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    enableExtractionFlags()
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key]
    }
    Object.assign(process.env, envBackup)
  })

  it("pas de booléen public allowAutoDecision", () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(runDraftExtraction, "allowAutoDecision"),
      false
    )
  })

  describe("A. UI_MANUAL", () => {
    it("extrait en PENDING_REVIEW sans AUTO", async () => {
      const repo = createFakeRepo()
      let autoCalls = 0
      const result = await runDraftExtraction(
        { actor: actor(), draftId: "draft1" },
        {
          repository: repo as never,
          runAutoDecisionAfterExtraction: async () => {
            autoCalls += 1
          },
        }
      )
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.status, "PENDING_REVIEW")
      assert.equal(repo.draft.status, "PENDING_REVIEW")
      assert.equal(autoCalls, 0)
    })
  })

  describe("B. UNIT_CRON", () => {
    it("extrait sans AUTO et sans ownership", async () => {
      const repo = createFakeRepo()
      let autoCalls = 0
      const result = await runDraftExtractionSystem(
        { companyId: "co1", draftId: "draft1" },
        {
          repository: repo as never,
          runAutoDecisionAfterExtraction: async () => {
            autoCalls += 1
          },
        }
      )
      assert.equal(result.ok, true)
      assert.equal(autoCalls, 0)
      assert.equal(repo.draft.status, "PENDING_REVIEW")
    })
  })

  describe("C. ORCHESTRATOR_AUTO extraction fences (capability authentique)", () => {
    async function runAuthenticExtraction(input: {
      stealAfterAsserts?: number
      draftRepo: ReturnType<typeof createFakeRepo>
    }) {
      enableOrchestratorProductionFlags()
      process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "false"
      process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "false"
      const lease = installProductionLeaseAuthority({
        stealAfterAsserts: input.stealAfterAsserts,
      })
      const restoreWorkers = installEmptySiblingWorkers()
      const fake = input.draftRepo
      const restoreDraft = [
        patchMethod(draftExtractionRepository, "findDraft", (companyId, draftId) =>
          fake.findDraft(companyId, draftId)
        ),
        patchMethod(draftExtractionRepository, "findContent", () => fake.findContent()),
        patchMethod(draftExtractionRepository, "findMessage", () => fake.findMessage()),
        patchMethod(draftExtractionRepository, "listAttachmentMetadata", () =>
          fake.listAttachmentMetadata()
        ),
        patchMethod(draftExtractionRepository, "claimExtracting", (args) =>
          fake.claimExtracting(args)
        ),
        patchMethod(draftExtractionRepository, "persistExtraction", (args) =>
          fake.persistExtraction(args)
        ),
        patchMethod(draftExtractionRepository, "markFailedWhileExtracting", () =>
          fake.markFailedWhileExtracting()
        ),
      ]
      const restoreSelection = [
        patchMethod(
          acquisitionExtractionCronSelectionRepository,
          "listCompanyIdsWithEligibleExtraction",
          async () => ["co1"]
        ),
        patchMethod(
          acquisitionExtractionCronSelectionRepository,
          "listEligibleCandidatesForCompany",
          async () => [
            {
              draftId: "draft1",
              companyId: "co1",
              acquisitionMessageId: "msg1",
              status: "PENDING_EXTRACTION" as const,
              createdAt: new Date(),
              extractionAttemptCount: 0,
              lastExtractionErrorAt: null,
              extractionStartedAt: null,
            },
          ]
        ),
      ]
      try {
        const result = await runProductionAcquisitionOrchestrator({
          runId: "run-extract-auto",
        })
        return { result, lease: lease.stats() }
      } finally {
        lease.restore()
        for (const fn of restoreWorkers) fn()
        for (const fn of restoreDraft) fn()
        for (const fn of restoreSelection) fn()
      }
    }

    it("ownership valide → persist via capability authentique", async () => {
      const repo = createFakeRepo()
      const { result } = await runAuthenticExtraction({ draftRepo: repo })
      assert.notEqual(result.steps.extraction?.skipReason, "LEASE_STOLEN")
      assert.equal(repo.persists.length, 1)
      assert.equal(repo.persists[0]?.status, "PENDING_REVIEW")
    })

    it("lease perdue avant extract → pas de claim", async () => {
      const repo = createFakeRepo()
      const { result } = await runAuthenticExtraction({
        stealAfterAsserts: 0,
        draftRepo: repo,
      })
      assert.equal(result.steps.gmailSync?.skipReason, "LEASE_STOLEN")
      assert.equal(repo.claimCount, 0)
      assert.equal(repo.persists.length, 0)
    })

    it("lease perdue après provider avant persist → aucune persist", async () => {
      const repo = createFakeRepo()
      const { result, lease } = await runAuthenticExtraction({
        stealAfterAsserts: 8,
        draftRepo: repo,
      })
      assert.equal(
        result.steps.extraction?.skipReason,
        "LEASE_STOLEN",
        JSON.stringify({ steps: result.steps, lease })
      )
      assert.notEqual(result.status, "SUCCESS")
      assert.equal(repo.claimCount, 1)
      assert.equal(repo.persists.length, 0)
      assert.equal(repo.draft.status, "EXTRACTING")
    })

    it("lease perdue après persist avant AUTO → persist conservé, LEASE_STOLEN", async () => {
      const repo = createFakeRepo()
      const { result, lease } = await runAuthenticExtraction({
        stealAfterAsserts: 9,
        draftRepo: repo,
      })
      assert.equal(
        result.steps.extraction?.skipReason,
        "LEASE_STOLEN",
        JSON.stringify({ steps: result.steps, lease, persists: repo.persists.length })
      )
      assert.notEqual(result.status, "SUCCESS")
      assert.equal(repo.persists.length, 1)
      assert.equal(repo.persists[0]?.status, "PENDING_REVIEW")
      assert.equal(repo.draft.status, "PENDING_REVIEW")
    })

    it("assertOwned throw via heartbeat → fail-closed NOT_OWNED", async () => {
      const lease: AcquisitionOrchestratorLeaseRepositoryPort = {
        acquire: async () => ({ outcome: "ACQUIRED" }),
        release: async () => ({ outcome: "RELEASED" }),
        assertOwned: async () => {
          throw new Error("lease lookup failed")
        },
        renew: async () => ({ outcome: "OWNED" }),
      }
      assert.equal(
        await checkOrchestratorLeaseHeartbeat({
          leaseRepository: lease,
          ownerRunId: "r",
        }),
        "NOT_OWNED"
      )
    })
  })

  describe("extraction cron entre drafts", () => {

    it("lease stolen mid-loop → stop, pas de nouvel extract", async () => {
      const extracted: string[] = []
      let n = 0
      const result = await runAcquisitionExtractionCronOrchestrator({
        repository: selectionRepo(["d1", "d2"]),
        extractDraft: async ({ draftId }) => {
          extracted.push(draftId)
          return {
            ok: true,
            outcome: "EXTRACTED",
            draftId,
            status: "PENDING_REVIEW",
            contentHashAtExtraction: "h",
            warningCount: 0,
          }
        },
        isProviderConfigured: () => true,
        createRunId: () => "ext-stolen",
        ensureOwnership: async () => {
          n += 1
          return n === 1 ? "OWNED" : "NOT_OWNED"
        },
        config: {
          maxPerCompany: 10,
          maxPerRun: 10,
          maxCompaniesPerRun: 10,
          maxDurationMs: 240_000,
          safetyMarginMs: 5_000,
          providerTimeoutMs: 1_000,
          maxAttempts: 5,
          reclaimTtlMs: 300_000,
        },
      })
      assert.deepEqual(extracted, ["d1"])
      assert.equal(result.skipReason, "LEASE_STOLEN")
      assert.notEqual(result.status, "SUCCESS")
    })

    it("dernier draft LEASE_STOLEN après persist → parent ≠ SUCCESS", async () => {
      const result = await runAcquisitionExtractionCronOrchestrator({
        repository: selectionRepo(["d1"]),
        extractDraft: async ({ draftId }) => ({
          ok: false,
          outcome: "LEASE_STOLEN",
          code: "LEASE_STOLEN",
          message: "Lease orchestrateur perdue",
          draftId,
          status: "PENDING_REVIEW",
        }),
        isProviderConfigured: () => true,
        createRunId: () => "ext-last-stolen",
        config: {
          maxPerCompany: 10,
          maxPerRun: 10,
          maxCompaniesPerRun: 10,
          maxDurationMs: 240_000,
          safetyMarginMs: 5_000,
          providerTimeoutMs: 1_000,
          maxAttempts: 5,
          reclaimTtlMs: 300_000,
        },
      })
      assert.equal(result.skipReason, "LEASE_STOLEN")
      assert.notEqual(result.status, "SUCCESS")
    })
  })

  describe("D. attachment recovery", () => {
    it("ownership valide entre items puis stolen mid-loop", async () => {
      const reclaimed: string[] = []
      let n = 0
      const repo: AttachmentRecoveryOrchestratorRepository = {
        listCompanyIdsWithReclaimCandidates: async () => ["co1"],
        listPendingDownloadsForReclaim: async () => [
          { id: "a1", companyId: "co1", downloadClaimedAt: new Date(0) },
          { id: "a2", companyId: "co1", downloadClaimedAt: new Date(0) },
        ],
        reclaimPendingDownload: async ({ attachmentId }) => {
          reclaimed.push(attachmentId)
          return "RECLAIMED"
        },
        listCompanyIdsWithRetryCandidates: async () => ["co1"],
        listFailedAttachmentsForRetry: async () => [
          { id: "r1", companyId: "co1", downloadRetryCount: 0, lastErrorCode: "TIMEOUT" },
        ],
        scheduleRetryToDiscovered: async () => {
          throw new Error("retry ne doit pas partir après steal")
        },
      }
      const result = await runAcquisitionAttachmentRecoveryOrchestrator({
        repository: repo,
        createRunId: () => "rec-stolen",
        ensureOwnership: async () => {
          n += 1
          return n === 1 ? "OWNED" : "NOT_OWNED"
        },
        config: {
          reclaimTtlMs: 20 * 60_000,
          maxRetries: 5,
          baseDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxPerCompany: 20,
          maxPerRun: 100,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240_000,
        },
      })
      assert.deepEqual(reclaimed, ["a1"])
      assert.equal(result.skipReason, "LEASE_STOLEN")
      assert.notEqual(result.status, "SUCCESS")
    })

    it("unit path sans ensureOwnership conserve SUCCESS", async () => {
      const result = await runAcquisitionAttachmentRecoveryOrchestrator({
        repository: {
          listCompanyIdsWithReclaimCandidates: async () => ["co1"],
          listPendingDownloadsForReclaim: async () => [
            { id: "a1", companyId: "co1", downloadClaimedAt: new Date(0) },
          ],
          reclaimPendingDownload: async () => "RECLAIMED",
          listCompanyIdsWithRetryCandidates: async () => [],
          listFailedAttachmentsForRetry: async () => [],
          scheduleRetryToDiscovered: async () => "NOOP",
        },
        createRunId: () => "rec-unit",
        config: {
          reclaimTtlMs: 20 * 60_000,
          maxRetries: 5,
          baseDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxPerCompany: 20,
          maxPerRun: 100,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240_000,
        },
      })
      assert.equal(result.status, "SUCCESS")
      assert.equal(result.skipReason, undefined)
    })
  })

  describe("E. attachment download", () => {
    function downloadRepo(): AttachmentDownloadOrchestratorRepository {
      return {
        listCompanyIdsWithDiscoveredAttachments: async () => ["co1"],
        listDiscoveredAttachmentsForCompany: async () => [
          { id: "att1", companyId: "co1", createdAt: new Date() },
          { id: "att2", companyId: "co1", createdAt: new Date() },
        ],
      }
    }

    it("ownership check avant claim/download, stolen stoppe les suivantes", async () => {
      const downloads: string[] = []
      let n = 0
      const downloadAttachment: AttachmentDownloadOrchestratorDownloadPort = async ({
        attachmentId,
      }) => {
        downloads.push(attachmentId)
        return { outcome: "STORED" }
      }
      const result = await runAcquisitionAttachmentDownloadOrchestrator({
        repository: downloadRepo(),
        downloadAttachment,
        createRunId: () => "dl-stolen",
        ensureOwnership: async () => {
          n += 1
          return n === 1 ? "OWNED" : "NOT_OWNED"
        },
        config: {
          maxPerCompany: 20,
          maxPerRun: 100,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240_000,
        },
      })
      assert.deepEqual(downloads, ["att1"])
      assert.equal(result.skipReason, "LEASE_STOLEN")
      assert.notEqual(result.status, "SUCCESS")
    })

    it("unit path inchangé sans callback", async () => {
      const downloads: string[] = []
      const result = await runAcquisitionAttachmentDownloadOrchestrator({
        repository: downloadRepo(),
        downloadAttachment: async ({ attachmentId }) => {
          downloads.push(attachmentId)
          return { outcome: "STORED" }
        },
        createRunId: () => "dl-unit",
        config: {
          maxPerCompany: 20,
          maxPerRun: 100,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240_000,
        },
      })
      assert.deepEqual(downloads, ["att1", "att2"])
      assert.equal(result.status, "SUCCESS")
      assert.equal(result.skipReason, undefined)
    })
  })

  describe("F. content fetch", () => {
    function contentRepo(): ContentFetchOrchestratorRepository {
      return {
        listCompanyIdsWithEligibleContentFetch: async () => ["co1"],
        listEligibleCandidatesForCompany: async () => [
          {
            companyId: "co1",
            acquisitionMessageId: "m1",
            draftId: "d1",
            draftCreatedAt: new Date(),
          },
          {
            companyId: "co1",
            acquisitionMessageId: "m2",
            draftId: "d2",
            draftCreatedAt: new Date(),
          },
        ],
        hasContent: async () => false,
        markRetryableFailure: async () => ({
          skippedDueToContent: false,
          terminal: false,
          attemptCount: 1,
        }),
        markPermanentFailure: async () => ({
          skippedDueToContent: false,
          terminal: true,
          attemptCount: 5,
        }),
      }
    }

    it("stolen avant item → aucun nouveau fetch/persist", async () => {
      const fetched: string[] = []
      let n = 0
      const result = await runAcquisitionContentCronOrchestrator({
        repository: contentRepo(),
        fetchContent: async ({ acquisitionMessageId }) => {
          fetched.push(acquisitionMessageId)
          return {
            ok: true,
            outcome: "FETCHED",
            content: {
              id: "c",
              companyId: "co1",
              acquisitionMessageId,
              normalizedText: "x",
              contentHash: "h",
              sourceMimeType: "text/plain",
              sourceCharset: "utf-8",
              hadHtml: false,
              byteLengthOriginal: 1,
              fetchedAt: new Date(),
              sanitizedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            idempotent: false,
          }
        },
        createRunId: () => "ct-stolen",
        ensureOwnership: async () => {
          n += 1
          return n === 1 ? "OWNED" : "NOT_OWNED"
        },
        config: {
          maxPerCompany: 20,
          maxPerRun: 100,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240_000,
          maxAttempts: 5,
        },
      })
      assert.deepEqual(fetched, ["m1"])
      assert.equal(result.skipReason, "LEASE_STOLEN")
      assert.notEqual(result.status, "SUCCESS")
    })
  })

  describe("G. lease globale", () => {
    it("second orchestrateur concurrent → ALREADY_RUNNING, clé globale unique", async () => {
      const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
      const first = await repo.acquire({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: "run-a",
        leaseTtlMs: 60_000,
      })
      const second = await repo.acquire({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: "run-b",
        leaseTtlMs: 60_000,
      })
      assert.equal(first.outcome, "ACQUIRED")
      assert.equal(second.outcome, "ALREADY_RUNNING")
      assert.equal(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "acquisition-orchestrator")
      assert.equal(repo.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "run-a")
    })

    it("heartbeat ownership n’appelle jamais acquire", async () => {
      const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
      await lease.acquire({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: "run-own",
        leaseTtlMs: 60_000,
      })
      let acquireCalls = 0
      const wrapped: AcquisitionOrchestratorLeaseRepositoryPort = {
        acquire: async (input) => {
          acquireCalls += 1
          return lease.acquire(input)
        },
        release: (input) => lease.release(input),
        assertOwned: (input) => lease.assertOwned(input),
        renew: (input) => {
          if (typeof lease.renew !== "function") {
            return Promise.resolve({ outcome: "NOT_OWNER" })
          }
          return lease.renew(input)
        },
      }
      assert.equal(
        await checkOrchestratorLeaseHeartbeat({
          leaseRepository: wrapped,
          ownerRunId: "run-own",
        }),
        "OWNED"
      )
      assert.equal(acquireCalls, 0)
    })
  })

  describe("MAJOR 1 — renew absent fail-closed", () => {
    it("port sans renew → heartbeat NOT_OWNED, aucune mutation extraction", async () => {
      const lease: AcquisitionOrchestratorLeaseRepositoryPort = {
        acquire: async () => ({ outcome: "ACQUIRED" }),
        release: async () => ({ outcome: "RELEASED" }),
        assertOwned: async () => ({ outcome: "OWNED" }),
      }
      assert.equal(
        await checkOrchestratorLeaseHeartbeat({
          leaseRepository: lease,
          ownerRunId: "run-no-renew",
        }),
        "NOT_OWNED"
      )
      const repo = createFakeRepo()
      const forged = {
        ensureOwned: async () => "OWNED" as const,
      }
      const result = await runDraftExtractionOrchestrated(
        { companyId: "co1", draftId: "draft1" },
        // @ts-expect-error fake runtime capability
        forged,
        { repository: repo as never }
      )
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.outcome, "LEASE_STOLEN")
      assert.equal(repo.claimCount, 0)
      assert.equal(repo.persists.length, 0)
    })

    it("renew NOT_OWNER → heartbeat NOT_OWNED", async () => {
      const lease: AcquisitionOrchestratorLeaseRepositoryPort = {
        acquire: async () => ({ outcome: "ACQUIRED" }),
        release: async () => ({ outcome: "RELEASED" }),
        assertOwned: async () => ({ outcome: "OWNED" }),
        renew: async () => ({ outcome: "NOT_OWNER" }),
      }
      assert.equal(
        await checkOrchestratorLeaseHeartbeat({
          leaseRepository: lease,
          ownerRunId: "run-renew-lost",
        }),
        "NOT_OWNED"
      )
    })
  })

  describe("MAJOR 3 — provenance capability", () => {
    it("fake { ensureOwned: OWNED } rejeté : pas de persist ni AUTO", async () => {
      const repo = createFakeRepo()
      let autoCalls = 0
      const fakeCapability = {
        ensureOwned: async () => "OWNED" as const,
      }
      const result = await runDraftExtractionOrchestrated(
        { companyId: "co1", draftId: "draft1" },
        // @ts-expect-error contrafaçon runtime JS
        fakeCapability,
        {
          repository: repo as never,
          runAutoDecisionAfterExtraction: async () => {
            autoCalls += 1
          },
        }
      )
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.outcome, "LEASE_STOLEN")
      assert.equal(repo.claimCount, 0)
      assert.equal(repo.persists.length, 0)
      assert.equal(autoCalls, 0)
    })

    it("callbacks arbitraires refusés : type + runtime fail-closed", async () => {
      const repo = createFakeRepo()
      const forgedCallbacks = {
        kind: "ORCHESTRATOR_AUTO" as const,
        assertOwned: async () => "OWNED" as const,
        renew: async () => "OWNED" as const,
      }
      const result = await runDraftExtractionOrchestrated(
        { companyId: "co1", draftId: "draft1" },
        // @ts-expect-error callbacks bruts ≠ OrchestratorAutoCapability
        forgedCallbacks,
        { repository: repo as never }
      )
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.outcome, "LEASE_STOLEN")
      assert.equal(repo.claimCount, 0)
    })

    it("UI ne peut pas passer une capability AUTO", async () => {
      const repo = createFakeRepo()
      let autoCalls = 0
      const result = await runDraftExtraction(
        {
          actor: actor(),
          draftId: "draft1",
          // @ts-expect-error UI n’accepte pas de capability orchestrateur
          capability: { forged: true },
        },
        {
          repository: repo as never,
          runAutoDecisionAfterExtraction: async () => {
            autoCalls += 1
          },
        }
      )
      assert.equal(result.ok, true)
      assert.equal(autoCalls, 0)
    })

    it("UNIT_CRON ne peut pas passer une capability AUTO", async () => {
      const repo = createFakeRepo()
      let autoCalls = 0
      const result = await runDraftExtractionSystem(
        {
          companyId: "co1",
          draftId: "draft1",
          // @ts-expect-error UNIT_CRON n’accepte pas de capability orchestrateur
          capability: { forged: true },
        },
        {
          repository: repo as never,
          runAutoDecisionAfterExtraction: async () => {
            autoCalls += 1
          },
        }
      )
      assert.equal(result.ok, true)
      assert.equal(autoCalls, 0)
    })

    it("exports publics : aucune factory AUTO / runners AUTO injectables", () => {
      assert.equal(
        "createOrchestratorAutoCapability" in orchestratorWorkers,
        false
      )
      assert.equal(
        "createOrchestratedExtractionBindings" in orchestratorWorkers,
        false
      )
      assert.equal("createProductionStepRunners" in orchestratorWorkers, false)
      assert.equal("ProductionStepRunnersDeps" in orchestratorWorkers, false)
      assert.equal(
        "createOrchestratorAutoCapability" in orchestratorOwnership,
        false
      )
      assert.equal("createProductionStepRunners" in orchestratorHandler, false)
      assert.equal(
        typeof orchestratorWorkers.runProductionAcquisitionOrchestrator,
        "function"
      )
    })

    it("wiring production : acquire + worker réel + même autorité assertOwned/renew + LEASE_STOLEN", async () => {
      enableOrchestratorProductionFlags()
      const lease = installProductionLeaseAuthority({ stealAfterAsserts: 4 })
      const restoreListings = [
        patchMethod(gmailConnectionListingAdapter, "listCompanyIdsWithGmailConnection", async () => []),
        patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithDiscoveredAttachments", async () => []),
        patchMethod(
          acquisitionContentFetchStateRepository,
          "listCompanyIdsWithEligibleContentFetch",
          async () => []
        ),
        patchMethod(
          acquisitionExtractionCronSelectionRepository,
          "listCompanyIdsWithEligibleExtraction",
          async () => []
        ),
      ]
      const reclaimed: string[] = []
      const restoreRecovery = [
        patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithReclaimCandidates", async () => [
          "co1",
        ]),
        patchMethod(acquisitionAttachmentRepository, "listPendingDownloadsForReclaim", async () => [
          { id: "a1", companyId: "co1", downloadClaimedAt: new Date(0) },
          { id: "a2", companyId: "co1", downloadClaimedAt: new Date(0) },
        ]),
        patchMethod(acquisitionAttachmentRepository, "reclaimPendingDownload", async ({ attachmentId }) => {
          reclaimed.push(attachmentId)
          return "RECLAIMED" as const
        }),
        patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithRetryCandidates", async () => []),
      ]
      try {
        const result = await runProductionAcquisitionOrchestrator({
          runId: "prov-worker-authority",
        })
        const stats = lease.stats()
        assert.equal(stats.acquireCalls, 1)
        assert.ok(stats.assertCalls >= 2)
        assert.ok(stats.renewCalls >= 1)
        assert.equal(reclaimed.length, 1)
        assert.equal(reclaimed[0], "a1")
        assert.equal(result.steps.attachmentRecovery?.skipReason, "LEASE_STOLEN")
        assert.notEqual(result.status, "SUCCESS")
      } finally {
        lease.restore()
        for (const fn of restoreListings) fn()
        for (const fn of restoreRecovery) fn()
      }
    })
  })
})
