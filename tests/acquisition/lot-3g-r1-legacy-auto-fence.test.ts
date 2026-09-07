/**
 * PLAN-ACQ-AGENTS-LOT-3G-R1 — Legacy AUTO sous fencing transactionnel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
process.env.ACQUISITION_CONVERSION_ENABLED = "true"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import {
  AutoDecisionLeaseNotOwnedError,
  maybeRunAutoDecisionAfterExtraction,
} from "@/lib/acquisition/policy/auto-decision.service"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import {
  runDraftExtraction,
  runDraftExtractionOrchestrated,
  runDraftExtractionSystem,
  executeLegacyAutoDecisionAfterExtractionPersist,
} from "@/lib/acquisition/extraction/extraction.service"
import type {
  DraftExtractionRow,
  MessageContentLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { AcquisitionPartnerRecord } from "@/lib/acquisition/persistence/partner-registry.repository"
import type { PartnerRegistryRepositoryPort } from "@/lib/acquisition/persistence/partner-registry.repository"
import type { DecisionJournalEntry } from "@/lib/acquisition/policy/decision-journal.repository"
import { runProductionAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import {
  InMemoryAcquisitionOrchestratorLeaseRepository,
  acquisitionOrchestratorLeaseRepository,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { draftExtractionRepository } from "@/lib/acquisition/extraction/extraction.repository"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { acquisitionGmailConnectionListingAdapter } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { acquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import * as orchestratorWorkers from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { readdirSync, statSync } from "node:fs"

const ownedFence: TransactionalOwnershipFence = {
  assertOwnedAndLock: async () => "OWNED",
}
const notOwnedFence: TransactionalOwnershipFence = {
  assertOwnedAndLock: async () => "NOT_OWNED",
}

/** Instant fixe : plage fixture août 2026 = FUTURE (indépendant du mur). */
const REFERENCE_INSTANT = new Date("2026-07-15T12:00:00.000Z")

function partner(over: Partial<AcquisitionPartnerRecord> = {}): AcquisitionPartnerRecord {
  return {
    id: "p1",
    companyId: "co1",
    name: "Partner",
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
    clientId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

function emptyRegistry(p: AcquisitionPartnerRecord | null): PartnerRegistryRepositoryPort {
  return {
    findPartnerByCode: async () => null,
    findPartnerById: async () => p,
    findPartnerByDomain: async () => null,
    findPartnerByEmail: async () => null,
    findDomain: async () => null,
    listPartners: async () => (p ? [p] : []),
    listDomains: async () => [],
    listEmails: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

type DraftRow = {
  id: string
  companyId: string
  status: string
  version: number
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  proposedContactEmail: string | null
  proposedClientId: string | null
  confidenceData: Record<string, number>
  warningData: unknown[]
  extractedData: unknown
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  acquisitionMessage: {
    resolvedPartnerId: string | null
    senderDomain: string | null
    threadId: string | null
  }
}

function baseDraft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: "d1",
    companyId: "co1",
    status: "PENDING_REVIEW",
    version: 1,
    proposedWorksiteName: "Site Alpha",
    proposedClientName: "Client SA",
    proposedAddress: "10 rue Test",
    proposedPostalCode: "75001",
    proposedCity: "Paris",
    proposedStartDate: new Date("2026-08-01"),
    proposedEndDate: new Date("2026-08-05"),
    proposedContactEmail: "c@example.com",
    proposedClientId: "c1",
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warningData: [],
    extractedData: {},
    contentHashAtExtraction: "hash-abc",
    extractionSchemaVersion: "2",
    acquisitionMessage: {
      resolvedPartnerId: "p1",
      senderDomain: "partner.fr",
      threadId: "thread-1",
    },
    ...over,
  }
}

function makeTxDb(draft: DraftRow) {
  const journalCreates: DecisionJournalEntry[] = []
  let mutated = false
  let followUpMutated = false
  const api = {
    journalCreates,
    get mutated() {
      return mutated
    },
    get followUpMutated() {
      return followUpMutated
    },
    worksiteImportDraft: {
      findFirst: async () => ({ ...draft }),
      updateMany: async (args: {
        where?: { status?: unknown; id?: string }
        data?: { status?: string; version?: unknown }
      }) => {
        const st = draft.status
        if (args.where?.status && typeof args.where.status === "object") {
          // rejectable follow-up path
          followUpMutated = true
        }
        mutated = true
        if (args.data?.status) draft.status = args.data.status
        if (args.data?.version && typeof args.data.version === "object") {
          draft.version += 1
        }
        if (st === "PENDING_REVIEW" || st === "APPROVED") {
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    acquisitionDecisionJournal: {
      create: async (args: { data: DecisionJournalEntry }) => {
        journalCreates.push(args.data)
        return {
          id: `j-${journalCreates.length}`,
          ...args.data,
          createdAt: new Date(),
          idempotencyKey: args.data.idempotencyKey ?? null,
        }
      },
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
    },
    acquisitionMessage: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
      return fn(api)
    },
  }
  return api
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
        contentHashAtExtraction: input.contentHashAtExtraction,
        extractionSchemaVersion: input.extractionSchemaVersion,
      }
      return "OK"
    },
    async markFailedWhileExtracting() {
      return "OK" as const
    },
  }
}

function patchMethod<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  impl: T[K]
): () => void {
  const prev = obj[key]
  obj[key] = impl
  return () => {
    obj[key] = prev
  }
}

describe("LOT-3G-R1 — legacy AUTO fenced", () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env = { ...env }
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "sys1"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("1 — fence OWNED + vrai review → AUTO_APPROVE OK (plus de LEASE_NOT_OWNED)", async () => {
    const draft = baseDraft()
    const db = makeTxDb(draft)
    const review = new ImportDraftReviewService({ db: db as never, now: () => REFERENCE_INSTANT })
    let convertCalled = false
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      deps: {
        referenceInstant: REFERENCE_INSTANT,
        db: db as never,
        review,
        conversion: {
          convertImportDraft: async (_a, _i, opts) => {
            convertCalled = true
            assert.ok(opts?.transactionalOwnershipFence)
            draft.status = "CONVERTED"
            return { ok: true, outcome: "CONVERTED", worksiteId: "ws1", version: 3 }
          },
        } as never,
        registry: emptyRegistry(partner()),
        resolveSystemActor: async () =>
          ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID",
          ambiguous: false,
        }),
        log: () => {},
      },
    })
    assert.equal(draft.status, "CONVERTED")
    assert.equal(convertCalled, true)
    assert.equal(db.mutated, true)
    assert.ok(db.journalCreates.some((j) => j.decisionCode === "AUTO_APPROVE_CONVERT"))
  })

  it("2 — fence NOT_OWNED avant approve → throw LEASE + zéro mutation", async () => {
    const draft = baseDraft()
    const db = makeTxDb(draft)
    const review = new ImportDraftReviewService({ db: db as never, now: () => REFERENCE_INSTANT })
    await assert.rejects(
      () =>
        maybeRunAutoDecisionAfterExtraction({
          companyId: "co1",
          draftId: "d1",
          transactionalOwnershipFence: notOwnedFence,
          deps: {
            referenceInstant: REFERENCE_INSTANT,
            db: db as never,
            review,
            conversion: {
              convertImportDraft: async () => {
                throw new Error("convert must not run")
              },
            } as never,
            registry: emptyRegistry(partner()),
            resolveSystemActor: async () =>
              ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
            findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
            matchClient: async () => ({
              clientId: "c1",
              matchKind: "PROPOSED_ID",
              ambiguous: false,
            }),
            log: () => {},
          },
        }),
      (err: unknown) => err instanceof AutoDecisionLeaseNotOwnedError
    )
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.equal(db.mutated, false)
    assert.equal(db.journalCreates.length, 0)
  })

  it("3 — approve TX NOT_OWNED → PENDING_REVIEW, zéro convert", async () => {
    let lockCalls = 0
    const fence: TransactionalOwnershipFence = {
      assertOwnedAndLock: async () => {
        lockCalls++
        // 1 = journal initial OWNED ; 2 = approve TX NOT_OWNED
        return lockCalls === 1 ? "OWNED" : "NOT_OWNED"
      },
    }
    const draft = baseDraft()
    const db = makeTxDb(draft)
    const review = new ImportDraftReviewService({ db: db as never, now: () => REFERENCE_INSTANT })
    let convertCalls = 0
    await assert.rejects(
      () =>
        maybeRunAutoDecisionAfterExtraction({
          companyId: "co1",
          draftId: "d1",
          transactionalOwnershipFence: fence,
          deps: {
            referenceInstant: REFERENCE_INSTANT,
            db: db as never,
            review,
            conversion: {
              convertImportDraft: async () => {
                convertCalls++
                return { ok: true, outcome: "CONVERTED" }
              },
            } as never,
            registry: emptyRegistry(partner()),
            resolveSystemActor: async () =>
              ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
            findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
            matchClient: async () => ({
              clientId: "c1",
              matchKind: "PROPOSED_ID",
              ambiguous: false,
            }),
            log: () => {},
          },
        }),
      (err: unknown) => err instanceof AutoDecisionLeaseNotOwnedError
    )
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.equal(convertCalls, 0)
    assert.equal(db.mutated, false)
  })

  it("4 — convert reçoit le même fence ; NOT_OWNED → zéro chantier", async () => {
    const fence = ownedFence
    const draft = baseDraft()
    const db = makeTxDb(draft)
    const review = new ImportDraftReviewService({ db: db as never, now: () => REFERENCE_INSTANT })
    let seenFence: TransactionalOwnershipFence | undefined
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: fence,
      deps: {
        referenceInstant: REFERENCE_INSTANT,
        db: db as never,
        review,
        conversion: {
          convertImportDraft: async (_a, _i, opts) => {
            seenFence = opts?.transactionalOwnershipFence
            return {
              ok: false,
              outcome: "LEASE_NOT_OWNED",
              code: "LEASE_NOT_OWNED",
              message: "LEASE_NOT_OWNED",
            }
          },
        } as never,
        registry: emptyRegistry(partner()),
        resolveSystemActor: async () =>
          ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID",
          ambiguous: false,
        }),
        log: () => {},
      },
    }).then(
      () => {
        throw new Error("expected LEASE throw")
      },
      (err: unknown) => {
        assert.ok(err instanceof AutoDecisionLeaseNotOwnedError)
      }
    )
    assert.equal(seenFence, fence)
    assert.notEqual(draft.status, "CONVERTED")
  })

  it("5 — AUTO_REJECT_CANCELLED : reject fail → zéro follow-up", async () => {
    const draft = baseDraft({
      extractedData: { requestClassification: "CANCELLED_CONSULTATION" },
    })
    const db = makeTxDb(draft)
    const review = {
      rejectImportDraft: async (
        _a: unknown,
        _i: unknown,
        opts?: { transactionalOwnershipFence?: TransactionalOwnershipFence }
      ) => {
        assert.ok(opts?.transactionalOwnershipFence)
        return {
          ok: false,
          outcome: "INVALID_STATE",
          code: "INVALID_STATE",
          message: "nope",
        }
      },
      approveImportDraft: async () => {
        throw new Error("approve must not run")
      },
    }
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      deps: {
        referenceInstant: REFERENCE_INSTANT,
        db: db as never,
        review: review as never,
        conversion: { convertImportDraft: async () => ({ ok: true }) } as never,
        registry: emptyRegistry(partner()),
        resolveSystemActor: async () =>
          ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID",
          ambiguous: false,
        }),
        log: () => {},
      },
    })
    assert.equal(
      db.journalCreates.filter((j) =>
        String(j.decisionCode).startsWith("CANCELLATION_")
      ).length,
      0
    )
  })

  it("5b — cancellation NOT_OWNED → zéro mutation follow-up + zéro journal follow-up", async () => {
    let lockCalls = 0
    const fence: TransactionalOwnershipFence = {
      assertOwnedAndLock: async () => {
        lockCalls++
        // journal + reject OWNED ; follow-up NOT_OWNED
        return lockCalls <= 2 ? "OWNED" : "NOT_OWNED"
      },
    }
    const draft = baseDraft({
      extractedData: { requestClassification: "CANCELLED_CONSULTATION" },
    })
    const db = makeTxDb(draft)
    const review = new ImportDraftReviewService({ db: db as never, now: () => REFERENCE_INSTANT })
    await assert.rejects(
      () =>
        maybeRunAutoDecisionAfterExtraction({
          companyId: "co1",
          draftId: "d1",
          transactionalOwnershipFence: fence,
          deps: {
            referenceInstant: REFERENCE_INSTANT,
            db: db as never,
            review,
            conversion: { convertImportDraft: async () => ({ ok: true }) } as never,
            registry: emptyRegistry(partner()),
            resolveSystemActor: async () =>
              ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
            findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
            matchClient: async () => ({
              clientId: "c1",
              matchKind: "PROPOSED_ID",
              ambiguous: false,
            }),
            log: () => {},
          },
        }),
      (err: unknown) => err instanceof AutoDecisionLeaseNotOwnedError
    )
    assert.equal(
      db.journalCreates.filter((j) =>
        String(j.decisionCode).startsWith("CANCELLATION_")
      ).length,
      0
    )
  })

  it("6 — SYSTEM_ACTOR_INVALID fenced OWNED vs NOT_OWNED", async () => {
    const draft = baseDraft()
    const dbOwned = makeTxDb({ ...draft })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      deps: {
        referenceInstant: REFERENCE_INSTANT,
        db: dbOwned as never,
        review: {
          approveImportDraft: async () => {
            throw new Error("no approve")
          },
        } as never,
        conversion: { convertImportDraft: async () => ({ ok: true }) } as never,
        registry: emptyRegistry(partner()),
        resolveSystemActor: async () =>
          ({
            ok: false,
            code: "SYSTEM_ACTOR_INVALID",
            reason: "user_inactive",
          }) as const,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
        matchClient: async () => ({
          clientId: "c1",
          matchKind: "PROPOSED_ID",
          ambiguous: false,
        }),
        log: () => {},
      },
    })
    assert.ok(
      dbOwned.journalCreates.some((j) => j.decisionCode === "SYSTEM_ACTOR_INVALID")
    )

    const dbLost = makeTxDb({ ...baseDraft() })
    await assert.rejects(
      () =>
        maybeRunAutoDecisionAfterExtraction({
          companyId: "co1",
          draftId: "d1",
          transactionalOwnershipFence: notOwnedFence,
          deps: {
            referenceInstant: REFERENCE_INSTANT,
            db: dbLost as never,
            review: {
              approveImportDraft: async () => {
                throw new Error("no approve")
              },
            } as never,
            conversion: { convertImportDraft: async () => ({ ok: true }) } as never,
            registry: emptyRegistry(partner()),
            resolveSystemActor: async () =>
              ({
                ok: false,
                code: "SYSTEM_ACTOR_INVALID",
                reason: "user_inactive",
              }) as const,
            findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
            matchClient: async () => ({
              clientId: "c1",
              matchKind: "PROPOSED_ID",
              ambiguous: false,
            }),
            log: () => {},
          },
        }),
      (err: unknown) => err instanceof AutoDecisionLeaseNotOwnedError
    )
    assert.equal(dbLost.journalCreates.length, 0)
  })

  it("7 — journal initial NOT_OWNED → zéro ligne decision", async () => {
    const draft = baseDraft()
    const db = makeTxDb(draft)
    await assert.rejects(
      () =>
        maybeRunAutoDecisionAfterExtraction({
          companyId: "co1",
          draftId: "d1",
          transactionalOwnershipFence: notOwnedFence,
          deps: {
            referenceInstant: REFERENCE_INSTANT,
            db: db as never,
            review: { approveImportDraft: async () => ({ ok: true }) } as never,
            conversion: { convertImportDraft: async () => ({ ok: true }) } as never,
            registry: emptyRegistry(partner()),
            resolveSystemActor: async () =>
              ({ ok: true, userId: "sys1", role: "ADMIN" }) as const,
            findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }),
            matchClient: async () => ({
              clientId: "c1",
              matchKind: "PROPOSED_ID",
              ambiguous: false,
            }),
            log: () => {},
          },
        }),
      (err: unknown) => err instanceof AutoDecisionLeaseNotOwnedError
    )
    assert.equal(db.journalCreates.length, 0)
  })

  it("8 — UI / UNIT_CRON : pas de hook AUTO", async () => {
    enableExtractionFlags()
    const repo = createFakeRepo()
    let autoCalls = 0
    const ui = await runDraftExtraction(
      { actor: { userId: "u1", role: "ADMIN", companyId: "co1" }, draftId: "draft1" },
      {
        repository: repo as never,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    assert.equal(ui.ok, true)
    assert.equal(autoCalls, 0)

    const cron = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      {
        repository: createFakeRepo() as never,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    assert.equal(cron.ok, true)
    assert.equal(autoCalls, 0)
  })

  it("H — extraction forge → LEASE_STOLEN avant hook", async () => {
    enableExtractionFlags()
    const repo = createFakeRepo()
    const forged = { not: "cap" } as never
    const r1 = await runDraftExtractionOrchestrated(
      { companyId: "co1", draftId: "draft1" },
      forged,
      {
        repository: repo as never,
        postExtractionStepsEnabled: false,
        runAutoDecisionAfterExtraction: async () => {
          throw new Error("hook must not run")
        },
      }
    )
    assert.equal(r1.ok, false)
    if (!r1.ok) assert.equal(r1.outcome, "LEASE_STOLEN")
  })

  it("H2 — executeLegacy hook : fence transmis ; LEASE → LEASE_STOLEN ; erreur soft → COMPLETED", async () => {
    let seen: TransactionalOwnershipFence | undefined
    const stolen = await executeLegacyAutoDecisionAfterExtractionPersist({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      runAutoDecisionAfterExtraction: async (input) => {
        seen = input.transactionalOwnershipFence
        throw new AutoDecisionLeaseNotOwnedError()
      },
      log: () => {},
    })
    assert.equal(stolen, "LEASE_STOLEN")
    assert.equal(seen, ownedFence)

    const missing = await executeLegacyAutoDecisionAfterExtractionPersist({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: undefined,
      runAutoDecisionAfterExtraction: async () => {
        throw new Error("must not run")
      },
      log: () => {},
    })
    assert.equal(missing, "LEASE_STOLEN")

    const soft = await executeLegacyAutoDecisionAfterExtractionPersist({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      runAutoDecisionAfterExtraction: async () => {
        throw new Error("boom")
      },
      log: () => {},
    })
    assert.equal(soft, "COMPLETED")

    const ok = await executeLegacyAutoDecisionAfterExtractionPersist({
      companyId: "co1",
      draftId: "d1",
      transactionalOwnershipFence: ownedFence,
      runAutoDecisionAfterExtraction: async (input) => {
        assert.equal(input.transactionalOwnershipFence, ownedFence)
      },
      log: () => {},
    })
    assert.equal(ok, "COMPLETED")
  })

  it("H3 — XOR OFF + capability authentique : persist OK ; post-steps DISABLED", async () => {
    enableExtractionFlags()
    process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED = "true"
    process.env.ACQUISITION_ORCHESTRATOR_STUBS_ALLOWED = "false"
    process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = "false"
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "false"
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    delete process.env.ACQUISITION_ORCHESTRATOR_ALLOW_STUBS

    const mem = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const restoreLease = [
      patchMethod(acquisitionOrchestratorLeaseRepository, "acquire", (i) =>
        mem.acquire(i)
      ),
      patchMethod(acquisitionOrchestratorLeaseRepository, "release", (i) =>
        mem.release(i)
      ),
      patchMethod(acquisitionOrchestratorLeaseRepository, "assertOwned", (i) =>
        mem.assertOwned(i)
      ),
      patchMethod(acquisitionOrchestratorLeaseRepository, "renew", (i) =>
        mem.renew!(i)
      ),
    ]

    const restoreSiblings = [
      patchMethod(
        acquisitionGmailConnectionListingAdapter,
        "listActiveAcquisitionGmailConnections",
        async () => []
      ),
      patchMethod(
        acquisitionAttachmentRepository,
        "listCompanyIdsWithReclaimCandidates",
        async () => []
      ),
      patchMethod(
        acquisitionAttachmentRepository,
        "listCompanyIdsWithRetryCandidates",
        async () => []
      ),
      patchMethod(
        acquisitionAttachmentRepository,
        "listCompanyIdsWithDiscoveredAttachments",
        async () => []
      ),
      patchMethod(
        acquisitionContentFetchStateRepository,
        "listCompanyIdsWithEligibleContentFetch",
        async () => []
      ),
    ]

    const fake = createFakeRepo()
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
        runId: "lot3g-r1-xor-auth",
        postExtractionStepsEnabled: false,
      })
      assert.equal(fake.persists.length, 1)
      assert.notEqual(result.steps.extraction?.skipReason, "LEASE_STOLEN")
      assert.equal(result.steps.validation?.skipReason, "DISABLED")
      assert.equal(result.steps.autoDecision?.skipReason, "DISABLED")
      assert.equal(typeof ACQUISITION_ORCHESTRATOR_LEASE_KEY, "string")
    } finally {
      for (const fn of restoreLease) fn()
      for (const fn of restoreSiblings) fn()
      for (const fn of restoreDraft) fn()
      for (const fn of restoreSelection) fn()
    }
  })

  it("9 — static guards ForTests / fence resolver / no acquire in métier", () => {
    const root = path.join(process.cwd(), "src/lib/acquisition")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (name.endsWith(".ts")) files.push(p)
      }
    }
    walk(root)
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      assert.equal(/ForTests/.test(src), false, f)
    }
    const extractionSrc = readFileSync(
      path.join(root, "extraction/extraction.service.ts"),
      "utf8"
    )
    assert.match(extractionSrc, /resolveOrchestratorAutoTransactionalFence/)
    assert.match(extractionSrc, /executeLegacyAutoDecisionAfterExtractionPersist/)
    assert.match(extractionSrc, /transactionalOwnershipFence:\s*fence/)
    assert.equal(/createOrchestratorLeaseTransactionalFence\(/.test(extractionSrc), false)

    const autoSrc = readFileSync(
      path.join(root, "policy/auto-decision.service.ts"),
      "utf8"
    )
    assert.equal(/\.acquire\(/.test(autoSrc), false)
    assert.equal(/\.renew\(/.test(autoSrc), false)
    assert.match(autoSrc, /applyCancellationFollowUpTransactionally/)
    assert.match(
      autoSrc,
      /transactionalOwnershipFence/
    )

    assert.equal(
      "createOrchestratorAutoCapabilityForTests" in orchestratorWorkers,
      false
    )
    assert.equal(
      "createOrchestratorLeaseTransactionalFenceForTests" in orchestratorWorkers,
      false
    )
  })
})
