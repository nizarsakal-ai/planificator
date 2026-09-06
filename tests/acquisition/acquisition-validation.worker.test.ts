/**
 * PLAN-ACQ-AGENTS-LOT-3D (+ CORRECTION-1/2) — Tests worker validation.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { mapToConsultationClassification } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import type { ConsultationValidationSnapshot } from "@/lib/acquisition/capabilities/validation.capability"
import {
  createDefaultStubStepRunners,
  runAcquisitionOrchestrator,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { createPostExtractionPlaceholderRunner } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import type { AcquisitionOrchestratorStepRunners } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import {
  computeValidationRetryNextAt,
  createPrismaValidationSelectionPort,
  mergeCompanyBucketsRoundRobin,
  runAcquisitionValidationWorker,
  shouldSkipValidationForExistingMarker,
  validationDecisionToCode,
  validationEligibleDraftPredicateSql,
  VALIDATION_WORKER_MAX_PER_COMPANY,
  VALIDATION_WORKER_MAX_RETRY_ATTEMPTS,
  VALIDATION_WORKER_MAX_SCAN,
  type ValidationWorkerCandidate,
  type ValidationWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-validation.worker"
import type { PrismaClient } from "@prisma/client"
import {
  AcquisitionDecisionJournalRepository,
  type DecisionJournalEntry,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"

const WORKER_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-validation.worker.ts"
)
const WORKERS_WIRING_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"
)
const JOURNAL_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/policy/decision-journal.repository.ts"
)

const cfg = {
  maxDurationMs: 60_000,
  safetyMarginMs: 1_000,
  leaseTtlMs: 120_000,
}

function completeSnap(
  overrides: Partial<ConsultationValidationSnapshot> = {}
): ConsultationValidationSnapshot {
  return {
    worksiteName: "Chantier Galya Hall A",
    address: "12 rue de la Foire",
    city: "Lyon",
    postalCode: "69002",
    clientName: "Client Expo",
    clientEmail: "client@expo.fr",
    consultationReference: "REF-001",
    requestedStartDate: "2026-09-10",
    requestedEndDate: "2026-09-12",
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warnings: [],
    ...overrides,
  }
}

function cycle(over: Partial<ValidationCycleIdentity> = {}): ValidationCycleIdentity {
  return {
    contentHash: "hash-1",
    extractionSchemaVersion: "2",
    draftVersion: 3,
    ...over,
  }
}

function makeJournal(): {
  entries: DecisionJournalEntry[]
  append: (e: DecisionJournalEntry) => Promise<void>
  appendOnce: (
    e: DecisionJournalEntry
  ) => Promise<{ outcome: "APPENDED" | "ALREADY_EXISTS"; row: {
    id: string
    companyId: string
    draftId: string
    decisionCode: string
    reasons: unknown
    scores: unknown
    actorUserId: string | null
    metadata: unknown
    createdAt: Date
  } }>
  findLatestValidationDecisionForCycle: (input: {
    companyId: string
    draftId: string
    cycle: ValidationCycleIdentity
  }) => Promise<ValidationJournalRow | null>
  findLatestValidationDecision: (input: {
    companyId: string
    draftId: string
  }) => Promise<ValidationJournalRow | null>
} {
  const entries: DecisionJournalEntry[] = []
  const byKey = new Map<string, number>()
  return {
    entries,
    async append(e) {
      entries.push({
        ...e,
        metadata: { ...(e.metadata ?? {}), __createdAt: Date.now() },
      })
    },
    async appendOnce(e) {
      const key = e.idempotencyKey?.trim()
      if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED")
      const existingIdx = byKey.get(key)
      if (existingIdx != null) {
        const prev = entries[existingIdx]!
        return {
          outcome: "ALREADY_EXISTS",
          row: {
            id: `j${existingIdx}`,
            companyId: prev.companyId,
            draftId: prev.draftId,
            decisionCode: prev.decisionCode,
            reasons: prev.reasons,
            scores: prev.scores,
            actorUserId: prev.actorUserId,
            metadata: prev.metadata ?? null,
            createdAt: new Date(),
          },
        }
      }
      entries.push({
        ...e,
        metadata: { ...(e.metadata ?? {}), __createdAt: Date.now() },
      })
      const idx = entries.length - 1
      byKey.set(key, idx)
      const cur = entries[idx]!
      return {
        outcome: "APPENDED",
        row: {
          id: `j${idx}`,
          companyId: cur.companyId,
          draftId: cur.draftId,
          decisionCode: cur.decisionCode,
          reasons: cur.reasons,
          scores: cur.scores,
          actorUserId: cur.actorUserId,
          metadata: cur.metadata ?? null,
          createdAt: new Date(),
        },
      }
    },
    async findLatestValidationDecisionForCycle(input) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
        if (!String(e.decisionCode).startsWith("VALIDATION_")) continue
        const meta = e.metadata ?? {}
        if (
          meta.contentHash === input.cycle.contentHash &&
          meta.extractionSchemaVersion === input.cycle.extractionSchemaVersion &&
          meta.draftVersion === input.cycle.draftVersion
        ) {
          return {
            id: `j${i}`,
            companyId: e.companyId,
            draftId: e.draftId,
            decisionCode: e.decisionCode as ValidationJournalRow["decisionCode"],
            reasons: e.reasons,
            scores: e.scores,
            actorUserId: e.actorUserId,
            metadata: e.metadata ?? null,
            createdAt: new Date(),
          }
        }
      }
      return null
    },
    async findLatestValidationDecision(input) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
        if (!String(e.decisionCode).startsWith("VALIDATION_")) continue
        return {
          id: `j${i}`,
          companyId: e.companyId,
          draftId: e.draftId,
          decisionCode: e.decisionCode as ValidationJournalRow["decisionCode"],
          reasons: e.reasons,
          scores: e.scores,
          actorUserId: e.actorUserId,
          metadata: e.metadata ?? null,
          createdAt: new Date(),
        }
      }
      return null
    },
  }
}

/**
 * Port mémoire miroir CORRECTION-2 : filtre éligibilité + fairness company.
 * Les inéligibles ne sont jamais retournés (équivalent exclusion DB).
 */
function makeEligibleSelection(
  rows: ValidationWorkerCandidate[],
  journal: ReturnType<typeof makeJournal>
): ValidationWorkerSelectionPort {
  const sorted = [...rows].sort((a, b) => {
    const t = a.updatedAt.getTime() - b.updatedAt.getTime()
    if (t !== 0) return t
    return a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0
  })
  return {
    async listEligibleCandidates(input) {
      const maxPerCompany = Math.max(
        1,
        Math.floor(input.maxPerCompany ?? VALIDATION_WORKER_MAX_PER_COMPANY)
      )
      const byCompany = new Map<string, ValidationWorkerCandidate[]>()
      for (const row of sorted) {
        const cyc: ValidationCycleIdentity = {
          contentHash: row.contentHashAtExtraction,
          extractionSchemaVersion: row.extractionSchemaVersion,
          draftVersion: row.version,
        }
        const existing = await journal.findLatestValidationDecisionForCycle({
          companyId: row.companyId,
          draftId: row.draftId,
          cycle: cyc,
        })
        if (
          shouldSkipValidationForExistingMarker({
            existing,
            cycle: cyc,
            now: input.now,
          }) !== "PROCESS"
        ) {
          continue
        }
        const bucket = byCompany.get(row.companyId) ?? []
        if (bucket.length < maxPerCompany) {
          bucket.push(row)
          byCompany.set(row.companyId, bucket)
        }
      }
      // CORRECTION-3 — miroir SQL : oldestEligibleAt ASC, companyId ASC
      const companyEntries = [...byCompany.entries()].map(([id, bucket]) => ({
        id,
        oldest: Math.min(...bucket.map((b) => b.updatedAt.getTime())),
        bucket,
      }))
      companyEntries.sort((a, b) => {
        if (a.oldest !== b.oldest) return a.oldest - b.oldest
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const buckets = companyEntries.map((e) => e.bucket)
      return mergeCompanyBucketsRoundRobin(buckets, input.limit)
    },
  }
}

type FakeDraft = {
  id: string
  companyId: string
  status: string
  version: number
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  proposedClientId: string | null
  confidenceData: Record<string, number>
  warningData: unknown[]
  extractedData: Record<string, unknown>
  acquisitionMessage: {
    resolvedPartnerId: string | null
    senderDomain: string | null
  }
}

function baseDraft(over: Partial<FakeDraft> = {}): FakeDraft {
  return {
    id: "d1",
    companyId: "co1",
    status: "PENDING_REVIEW",
    version: 3,
    contentHashAtExtraction: "hash-1",
    extractionSchemaVersion: "2",
    proposedWorksiteName: "Chantier Galya Hall A",
    proposedClientName: "Client Expo",
    proposedAddress: "12 rue de la Foire",
    proposedPostalCode: "69002",
    proposedCity: "Lyon",
    proposedStartDate: new Date("2026-09-10T00:00:00.000Z"),
    proposedEndDate: new Date("2026-09-12T00:00:00.000Z"),
    proposedClientId: null,
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warningData: [],
    extractedData: {
      requestClassification: "CONSULTATION",
      clientEmail: "client@expo.fr",
      consultationReference: "REF-001",
    },
    acquisitionMessage: { resolvedPartnerId: null, senderDomain: null },
    ...over,
  }
}

function candidateFromDraft(
  d: FakeDraft,
  updatedAt: Date
): ValidationWorkerCandidate {
  return {
    draftId: d.id,
    companyId: d.companyId,
    version: d.version,
    contentHashAtExtraction: d.contentHashAtExtraction!,
    extractionSchemaVersion: d.extractionSchemaVersion,
    updatedAt,
  }
}

function evalDeps(draft: FakeDraft | (() => FakeDraft)) {
  return {
    db: {
      worksiteImportDraft: {
        findFirst: async () => (typeof draft === "function" ? draft() : draft),
      },
    } as never,
    findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
    matchClient: async () => ({
      clientId: "cli1",
      matchKind: "EMAIL" as const,
    }),
    registry: {
      findPartnerById: async () => null,
      findPartnerByDomain: async () => null,
    } as never,
  }
}

async function seedTerminalMarker(
  journal: ReturnType<typeof makeJournal>,
  d: FakeDraft,
  code:
    | "VALIDATION_PASS"
    | "VALIDATION_QUARANTINE"
    | "VALIDATION_FAIL_TERMINAL"
    | "VALIDATION_FAIL_RETRYABLE",
  metaExtra: Record<string, unknown> = {}
) {
  await journal.append({
    companyId: d.companyId,
    draftId: d.id,
    decisionCode: code,
    reasons: ["TEST"],
    scores: {},
    actorUserId: null,
    metadata: {
      contentHash: d.contentHashAtExtraction,
      extractionSchemaVersion: d.extractionSchemaVersion,
      draftVersion: d.version,
      ...metaExtra,
    },
  })
}

describe("PLAN-ACQ-AGENTS-LOT-3D validation worker", () => {
  it("16–19. classification mapping", () => {
    assert.equal(
      mapToConsultationClassification({
        requestClassification: "CONSULTATION",
        consultationCancelledWarning: false,
      }),
      "CONSULTATION"
    )
    assert.equal(
      mapToConsultationClassification({
        requestClassification: "CANCELLED_CONSULTATION",
        consultationCancelledWarning: false,
      }),
      "CANCELLATION"
    )
  })

  it("idempotence / retry gate helpers", () => {
    const c = cycle()
    const passRow: ValidationJournalRow = {
      id: "j1",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: { ...c },
      createdAt: new Date(),
    }
    assert.equal(
      shouldSkipValidationForExistingMarker({
        existing: passRow,
        cycle: c,
        now: new Date(),
      }),
      "SKIP_IDEMPOTENT"
    )
    assert.equal(
      shouldSkipValidationForExistingMarker({
        existing: {
          ...passRow,
          decisionCode: "VALIDATION_FAIL_RETRYABLE",
          metadata: {
            ...c,
            attempt: VALIDATION_WORKER_MAX_RETRY_ATTEMPTS,
          },
        },
        cycle: c,
        now: new Date(),
      }),
      "SKIP_MAX_RETRY"
    )
    assert.equal(
      computeValidationRetryNextAt({
        attempt: 1,
        now: new Date("2026-01-01T00:00:00.000Z"),
      })?.toISOString(),
      "2026-01-01T00:01:00.000Z"
    )
  })

  it("2–3. PASS journalisé sans mutation statut", async () => {
    const draft = baseDraft()
    const journal = makeJournal()
    const statuses: string[] = []
    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(
        [candidateFromDraft(draft, new Date("2026-01-01T00:00:00.000Z"))],
        journal
      ),
      evaluationDeps: {
        ...evalDeps(draft),
        db: {
          worksiteImportDraft: {
            findFirst: async () => {
              statuses.push(draft.status)
              return draft
            },
          },
        } as never,
      },
      now: () => new Date("2026-09-05T00:00:00.000Z"),
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(journal.entries.length, 1)
    assert.equal(journal.entries[0]!.decisionCode, "VALIDATION_PASS")
    assert.ok(statuses.every((s) => s === "PENDING_REVIEW"))
  })

  it("4. QUARANTINE idempotente même cycle", async () => {
    const draft = baseDraft({
      confidenceData: {
        worksiteName: 0.2,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
    })
    const journal = makeJournal()
    const selection = makeEligibleSelection(
      [candidateFromDraft(draft, new Date("2026-01-01T00:00:00.000Z"))],
      journal
    )
    const runOnce = () =>
      runAcquisitionValidationWorker({
        journal: journal as never,
        selection,
        evaluationDeps: evalDeps(draft),
      })
    const r1 = await runOnce()
    assert.equal(r1.stats.journalAppended, 1)
    assert.equal(journal.entries[0]!.decisionCode, "VALIDATION_QUARANTINE")
    const r2 = await runOnce()
    assert.equal(r2.stats.selected, 0)
    assert.equal(journal.entries.length, 1)
  })

  it("5. FAIL_TERMINAL journal only — no reject", async () => {
    const draft = baseDraft({
      extractedData: { requestClassification: "CANCELLED_CONSULTATION" },
      warningData: [catalogWarning("CONSULTATION_CANCELLED", { source: "SERVICE" })],
    })
    const journal = makeJournal()
    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(
        [candidateFromDraft(draft, new Date("2026-01-01T00:00:00.000Z"))],
        journal
      ),
      evaluationDeps: evalDeps(draft),
    })
    assert.equal(result.stats.journalAppended, 1)
    assert.equal(journal.entries[0]!.decisionCode, "VALIDATION_FAIL_TERMINAL")
    assert.equal(draft.status, "PENDING_REVIEW")
  })

  it("CORRECTION-1/2: terminal prefix n’affame pas le neuf (même run)", async () => {
    const journal = makeJournal()
    const rows: ValidationWorkerCandidate[] = []
    const drafts = new Map<string, FakeDraft>()
    for (let i = 0; i < 25; i++) {
      const id = `q${String(i).padStart(2, "0")}`
      const d = baseDraft({
        id,
        version: 1,
        contentHashAtExtraction: `hq-${i}`,
        confidenceData: {
          worksiteName: 0.2,
          requestedStartDate: 0.95,
          requestedEndDate: 0.95,
        },
      })
      drafts.set(id, d)
      rows.push(
        candidateFromDraft(d, new Date(`2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`))
      )
      await seedTerminalMarker(journal, d, "VALIDATION_QUARANTINE")
    }
    const fresh = baseDraft({
      id: "fresh-new",
      version: 1,
      contentHashAtExtraction: "hfresh",
    })
    drafts.set("fresh-new", fresh)
    rows.push(candidateFromDraft(fresh, new Date("2026-01-01T00:01:00.000Z")))

    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(rows, journal),
      maxCandidates: 1,
      evaluationDeps: {
        ...evalDeps(fresh),
        db: {
          worksiteImportDraft: {
            findFirst: async (args: { where: { id: string } }) =>
              drafts.get(args.where.id) ?? null,
          },
        } as never,
      },
    })
    assert.equal(result.stats.selected, 1)
    assert.equal(result.stats.journalAppended, 1)
    assert.equal(journal.entries.at(-1)!.draftId, "fresh-new")
  })

  it("CORRECTION-2: 500 inéligibles + 1 éligible → traité même run", async () => {
    const journal = makeJournal()
    const rows: ValidationWorkerCandidate[] = []
    const drafts = new Map<string, FakeDraft>()
    for (let i = 0; i < 500; i++) {
      const id = `t${String(i).padStart(3, "0")}`
      const d = baseDraft({
        id,
        version: 1,
        contentHashAtExtraction: `ht-${i}`,
      })
      drafts.set(id, d)
      const sec = String(i % 60).padStart(2, "0")
      const min = String(Math.floor(i / 60) % 60).padStart(2, "0")
      const hour = String(Math.floor(i / 3600)).padStart(2, "0")
      rows.push(
        candidateFromDraft(d, new Date(`2026-01-01T${hour}:${min}:${sec}.000Z`))
      )
      await seedTerminalMarker(journal, d, "VALIDATION_PASS")
    }
    const fresh = baseDraft({
      id: "after-500",
      version: 1,
      contentHashAtExtraction: "hafter",
    })
    drafts.set("after-500", fresh)
    rows.push(candidateFromDraft(fresh, new Date("2026-01-02T00:00:00.000Z")))

    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(rows, journal),
      maxCandidates: 1,
      maxScan: VALIDATION_WORKER_MAX_SCAN,
      evaluationDeps: {
        ...evalDeps(fresh),
        db: {
          worksiteImportDraft: {
            findFirst: async (args: { where: { id: string } }) =>
              drafts.get(args.where.id) ?? null,
          },
        } as never,
      },
    })
    assert.equal(result.stats.scanned, 1)
    assert.equal(result.stats.selected, 1)
    assert.equal(journal.entries.at(-1)!.draftId, "after-500")
    assert.equal(journal.entries.at(-1)!.decisionCode, "VALIDATION_PASS")
  })

  it("CORRECTION-2: 1000 inéligibles + N éligibles → aucune starvation", async () => {
    const journal = makeJournal()
    const rows: ValidationWorkerCandidate[] = []
    const drafts = new Map<string, FakeDraft>()
    for (let i = 0; i < 1000; i++) {
      const id = `x${String(i).padStart(4, "0")}`
      const d = baseDraft({
        id,
        version: 1,
        contentHashAtExtraction: `hx-${i}`,
      })
      drafts.set(id, d)
      rows.push(candidateFromDraft(d, new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i))))
      await seedTerminalMarker(journal, d, "VALIDATION_QUARANTINE")
    }
    const eligibleIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = `elig-${i}`
      eligibleIds.push(id)
      const d = baseDraft({
        id,
        version: 1,
        contentHashAtExtraction: `helig-${i}`,
      })
      drafts.set(id, d)
      rows.push(candidateFromDraft(d, new Date(`2026-02-01T00:00:0${i}.000Z`)))
    }

    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(rows, journal),
      maxCandidates: 3,
      maxScan: 500,
      evaluationDeps: {
        ...evalDeps(baseDraft()),
        db: {
          worksiteImportDraft: {
            findFirst: async (args: { where: { id: string } }) =>
              drafts.get(args.where.id) ?? null,
          },
        } as never,
      },
    })
    assert.equal(result.stats.journalAppended, 3)
    const written = journal.entries.slice(-3).map((e) => e.draftId).sort()
    assert.deepEqual(written, [...eligibleIds].sort())
  })

  it("CORRECTION-2: markers cycle — terminal exclu ; hash/schema/version anciens → éligible", async () => {
    const journal = makeJournal()
    const now = new Date("2026-09-05T00:00:00.000Z")

    const terminal = baseDraft({ id: "term", version: 1, contentHashAtExtraction: "h1" })
    await seedTerminalMarker(journal, terminal, "VALIDATION_FAIL_TERMINAL")

    const hashChanged = baseDraft({
      id: "hash",
      version: 1,
      contentHashAtExtraction: "h-new",
    })
    await journal.append({
      companyId: "co1",
      draftId: "hash",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "h-old",
        extractionSchemaVersion: "2",
        draftVersion: 1,
      },
    })

    const schemaChanged = baseDraft({
      id: "schema",
      version: 1,
      contentHashAtExtraction: "hs",
      extractionSchemaVersion: "9",
    })
    await journal.append({
      companyId: "co1",
      draftId: "schema",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hs",
        extractionSchemaVersion: "2",
        draftVersion: 1,
      },
    })

    const versionChanged = baseDraft({
      id: "ver",
      version: 5,
      contentHashAtExtraction: "hv",
    })
    await journal.append({
      companyId: "co1",
      draftId: "ver",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hv",
        extractionSchemaVersion: "2",
        draftVersion: 1,
      },
    })

    const rows = [terminal, hashChanged, schemaChanged, versionChanged].map(
      (d, i) => candidateFromDraft(d, new Date(`2026-01-01T00:00:0${i}.000Z`))
    )
    const selection = makeEligibleSelection(rows, journal)
    const eligible = await selection.listEligibleCandidates({
      limit: 10,
      now,
      maxPerCompany: 10,
    })
    const ids = eligible.map((e) => e.draftId).sort()
    assert.deepEqual(ids, ["hash", "schema", "ver"])
  })

  it("CORRECTION-2: retry wait exclu ; échéance atteinte éligible ; max attempts exclu", async () => {
    const journal = makeJournal()
    const now = new Date("2026-09-05T12:00:00.000Z")

    const wait = baseDraft({ id: "wait", version: 1, contentHashAtExtraction: "hw" })
    await seedTerminalMarker(journal, wait, "VALIDATION_FAIL_RETRYABLE", {
      attempt: 1,
      nextRetryAt: "2099-01-01T00:00:00.000Z",
    })

    const due = baseDraft({ id: "due", version: 1, contentHashAtExtraction: "hd" })
    await seedTerminalMarker(journal, due, "VALIDATION_FAIL_RETRYABLE", {
      attempt: 1,
      nextRetryAt: "2020-01-01T00:00:00.000Z",
    })

    const maxed = baseDraft({ id: "maxed", version: 1, contentHashAtExtraction: "hm" })
    await seedTerminalMarker(journal, maxed, "VALIDATION_FAIL_RETRYABLE", {
      attempt: VALIDATION_WORKER_MAX_RETRY_ATTEMPTS,
      nextRetryAt: "2020-01-01T00:00:00.000Z",
    })

    const rows = [wait, due, maxed].map((d, i) =>
      candidateFromDraft(d, new Date(`2026-01-01T00:00:0${i}.000Z`))
    )
    const eligible = await makeEligibleSelection(rows, journal).listEligibleCandidates({
      limit: 10,
      now,
    })
    assert.deepEqual(
      eligible.map((e) => e.draftId),
      ["due"]
    )
  })

  it("CORRECTION-2: tenant A saturé n’affame pas tenant B", async () => {
    const journal = makeJournal()
    const rows: ValidationWorkerCandidate[] = []
    const drafts = new Map<string, FakeDraft>()

    for (let i = 0; i < 20; i++) {
      const id = `a-${i}`
      const d = baseDraft({
        id,
        companyId: "tenant-A",
        version: 1,
        contentHashAtExtraction: `ha-${i}`,
      })
      drafts.set(id, d)
      rows.push(candidateFromDraft(d, new Date(`2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`)))
    }
    const b = baseDraft({
      id: "b-only",
      companyId: "tenant-B",
      version: 1,
      contentHashAtExtraction: "hb",
    })
    drafts.set("b-only", b)
    rows.push(candidateFromDraft(b, new Date("2026-01-01T01:00:00.000Z")))

    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(rows, journal),
      maxCandidates: 6,
      maxPerCompany: 5,
      evaluationDeps: {
        ...evalDeps(b),
        db: {
          worksiteImportDraft: {
            findFirst: async (args: { where: { id: string } }) =>
              drafts.get(args.where.id) ?? null,
          },
        } as never,
      },
    })
    const companies = new Set(
      journal.entries.map((e) => e.companyId)
    )
    assert.ok(companies.has("tenant-B"))
    assert.ok(companies.has("tenant-A"))
    assert.equal(
      journal.entries.filter((e) => e.companyId === "tenant-A").length <= 5,
      true
    )
    assert.equal(
      journal.entries.some((e) => e.draftId === "b-only"),
      true
    )
    assert.ok(result.stats.journalAppended <= 6)
  })

  it("CORRECTION-2: SQL predicate paramétré (pas de concat user) + bound maxScan", () => {
    const sql = validationEligibleDraftPredicateSql({
      now: new Date("2026-09-05T00:00:00.000Z"),
      maxRetryAttempts: 3,
    })
    const text = sql.sql
    assert.equal(/PENDING_REVIEW/.test(text), true)
    assert.equal(/NOT EXISTS/.test(text), true)
    assert.equal(/contentHash/.test(text), true)
    assert.equal(/draftVersion/.test(text), true)
    assert.equal(/VALIDATION_FAIL_RETRYABLE/.test(text), true)
    assert.equal(VALIDATION_WORKER_MAX_SCAN, 500)
    assert.equal(VALIDATION_WORKER_MAX_PER_COMPANY, 5)
    // paramètres bindés, pas interpolation string user
    assert.ok(Array.isArray(sql.values))
    assert.equal(sql.values.length >= 2, true)
  })

  it("CORRECTION-2: merge round-robin fairness", () => {
    const a = [
      candidateFromDraft(baseDraft({ id: "a1", companyId: "A" }), new Date()),
      candidateFromDraft(baseDraft({ id: "a2", companyId: "A" }), new Date()),
    ]
    const b = [
      candidateFromDraft(baseDraft({ id: "b1", companyId: "B" }), new Date()),
    ]
    const merged = mergeCompanyBucketsRoundRobin([a, b], 3)
    assert.deepEqual(
      merged.map((m) => m.draftId),
      ["a1", "b1", "a2"]
    )
  })

  it("CORRECTION-3: sélection tenants par oldestEligibleAt (pas companyId ASC)", async () => {
    const sqlTexts: string[] = []
    let companyQueryCount = 0
    const fakeDb = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        const text = Array.from(strings).join(" ")
        sqlTexts.push(text)
        if (text.includes("oldestEligibleAt") || text.includes('MIN(d."updatedAt")')) {
          companyQueryCount++
          return [
            { companyId: "zzz-old", oldestEligibleAt: new Date("2026-01-01T00:00:00.000Z") },
            { companyId: "aaa-new", oldestEligibleAt: new Date("2026-06-01T00:00:00.000Z") },
          ]
        }
        const companyId = values.find(
          (v) => typeof v === "string" && (v === "zzz-old" || v === "aaa-new")
        )
        if (companyId === "zzz-old") {
          return [
            {
              id: "d-zzz",
              companyId: "zzz-old",
              version: 1,
              contentHashAtExtraction: "h",
              extractionSchemaVersion: "2",
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ]
        }
        if (companyId === "aaa-new") {
          return [
            {
              id: "d-aaa",
              companyId: "aaa-new",
              version: 1,
              contentHashAtExtraction: "h",
              extractionSchemaVersion: "2",
              updatedAt: new Date("2026-06-01T00:00:00.000Z"),
            },
          ]
        }
        return []
      },
    } as unknown as PrismaClient

    const port = createPrismaValidationSelectionPort(fakeDb)
    const rows = await port.listEligibleCandidates({
      limit: 10,
      now: new Date("2026-07-01T00:00:00.000Z"),
      maxPerCompany: 2,
    })

    assert.equal(companyQueryCount, 1)
    const companySql = sqlTexts.find(
      (t) => t.includes("oldestEligibleAt") || t.includes('MIN(d."updatedAt")')
    )
    assert.ok(companySql)
    assert.match(companySql!, /MIN\s*\(\s*d\."updatedAt"\s*\)/i)
    assert.match(companySql!, /GROUP BY\s+d\."companyId"/i)
    assert.match(companySql!, /ORDER BY\s+"oldestEligibleAt"\s+ASC/i)
    assert.equal(/SELECT\s+DISTINCT\s+d\."companyId"/i.test(companySql!), false)

    assert.equal(rows[0]?.companyId, "zzz-old")
    assert.equal(rows[1]?.companyId, "aaa-new")
  })

  it("CORRECTION-3: mémoire — tie-break companyId ASC si oldestEligibleAt égal", async () => {
    const journal = makeJournal()
    const now = new Date("2026-08-01T00:00:00.000Z")
    const same = new Date("2026-01-15T00:00:00.000Z")
    const selection = makeEligibleSelection(
      [
        candidateFromDraft(
          baseDraft({ id: "db", companyId: "tenant-b", contentHashAtExtraction: "hb" }),
          same
        ),
        candidateFromDraft(
          baseDraft({ id: "da", companyId: "tenant-a", contentHashAtExtraction: "ha" }),
          same
        ),
        candidateFromDraft(
          baseDraft({ id: "dc", companyId: "tenant-c", contentHashAtExtraction: "hc" }),
          new Date("2026-01-01T00:00:00.000Z")
        ),
      ],
      journal
    )
    const rows = await selection.listEligibleCandidates({
      limit: 10,
      now,
      maxPerCompany: 1,
    })
    assert.deepEqual(
      rows.map((r) => r.companyId),
      ["tenant-c", "tenant-a", "tenant-b"]
    )
  })

  it("maxCandidates limite les PROCESS", async () => {
    const journal = makeJournal()
    const rows: ValidationWorkerCandidate[] = []
    const drafts = new Map<string, FakeDraft>()
    for (let i = 0; i < 5; i++) {
      const id = `p${i}`
      const d = baseDraft({
        id,
        version: 1,
        contentHashAtExtraction: `hp-${i}`,
      })
      drafts.set(id, d)
      rows.push(candidateFromDraft(d, new Date(`2026-01-01T00:00:0${i}.000Z`)))
    }
    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(rows, journal),
      maxCandidates: 2,
      evaluationDeps: {
        ...evalDeps(baseDraft()),
        db: {
          worksiteImportDraft: {
            findFirst: async (args: { where: { id: string } }) =>
              drafts.get(args.where.id) ?? null,
          },
        } as never,
      },
    })
    assert.equal(result.stats.selected, 2)
    assert.equal(result.stats.journalAppended, 2)
  })

  it("cycle mismatch beforeWrite → aucun journal", async () => {
    const draft = baseDraft()
    const journal = makeJournal()
    let reads = 0
    await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection(
        [candidateFromDraft(draft, new Date("2026-01-01T00:00:00.000Z"))],
        journal
      ),
      evaluationDeps: {
        ...evalDeps(draft),
        db: {
          worksiteImportDraft: {
            findFirst: async () => {
              reads++
              if (reads >= 3) draft.contentHashAtExtraction = "changed"
              return { ...draft }
            },
          },
        } as never,
      },
    })
    assert.equal(journal.entries.length, 0)
  })

  it("lease volée après beforeWrite avant append → aucun journal", async () => {
    const draft = baseDraft()
    const journal = makeJournal()
    let ownedChecks = 0
    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      ensureOwnership: async () => {
        ownedChecks++
        return ownedChecks < 5 ? "OWNED" : "NOT_OWNED"
      },
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
      selection: makeEligibleSelection(
        [candidateFromDraft(draft, new Date("2026-01-01T00:00:00.000Z"))],
        journal
      ),
      evaluationDeps: evalDeps(draft),
    })
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(journal.entries.length, 0)
  })

  it(">20 événements validation → cycle ancien retrouvé", async () => {
    const rows: Array<{
      id: string
      companyId: string
      draftId: string
      decisionCode: string
      reasons: unknown
      scores: unknown
      actorUserId: string | null
      metadata: unknown
      createdAt: Date
    }> = []
    const targetCycle = {
      contentHash: "old-hash",
      extractionSchemaVersion: "2",
      draftVersion: 1,
    }
    rows.push({
      id: "j-old",
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: targetCycle,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    for (let i = 0; i < 55; i++) {
      const sec = String(i % 60).padStart(2, "0")
      const min = String(Math.floor(i / 60)).padStart(2, "0")
      rows.push({
        id: `j-new-${String(i).padStart(3, "0")}`,
        companyId: "co1",
        draftId: "d1",
        decisionCode: "VALIDATION_QUARANTINE",
        reasons: [],
        scores: {},
        actorUserId: null,
        metadata: {
          contentHash: `new-${i}`,
          extractionSchemaVersion: "2",
          draftVersion: 2 + i,
        },
        createdAt: new Date(`2026-02-01T00:${min}:${sec}.000Z`),
      })
    }

    const fakeDb = {
      acquisitionDecisionJournal: {
        findMany: async (args: {
          where: { OR?: unknown }
          take: number
        }) => {
          const all = [...rows].sort((a, b) => {
            const t = b.createdAt.getTime() - a.createdAt.getTime()
            if (t !== 0) return t
            return b.id < a.id ? -1 : 1
          })
          let start = 0
          const or = args.where.OR as
            | Array<Record<string, unknown>>
            | undefined
          if (or) {
            const ltCreated = or[0] as { createdAt: { lt: Date } }
            const andEq = or[1] as {
              AND: [{ createdAt: Date }, { id: { lt: string } }]
            }
            const boundaryCreated = ltCreated.createdAt.lt
            const boundaryId = andEq.AND[1].id.lt
            start = all.findIndex(
              (r) =>
                r.createdAt.getTime() < boundaryCreated.getTime() ||
                (r.createdAt.getTime() === boundaryCreated.getTime() &&
                  r.id < boundaryId)
            )
            if (start < 0) start = all.length
          }
          return all.slice(start, start + args.take)
        },
      },
    }

    const repo = new AcquisitionDecisionJournalRepository(fakeDb as never)
    const found = await repo.findLatestValidationDecisionForCycle({
      companyId: "co1",
      draftId: "d1",
      cycle: targetCycle,
    })
    assert.ok(found)
    assert.equal(found!.id, "j-old")
    assert.equal(/take:\s*20/.test(readFileSync(JOURNAL_SRC, "utf8")), false)
  })

  it("sélection vide → selected 0", async () => {
    const journal = makeJournal()
    const result = await runAcquisitionValidationWorker({
      journal: journal as never,
      selection: makeEligibleSelection([], journal),
    })
    assert.equal(result.stats.selected, 0)
  })

  it("flag OFF DISABLED ; flag ON worksiteCreation NOT_IMPLEMENTED (autoDecision stub placeholder)", async () => {
    const offPost = createPostExtractionPlaceholderRunner(false)
    const onPost = createPostExtractionPlaceholderRunner(true)
    const off: AcquisitionOrchestratorStepRunners = {
      ...createDefaultStubStepRunners(),
      validation: offPost,
      autoDecision: offPost,
      worksiteCreation: offPost,
    }
    const offResult = await runAcquisitionOrchestrator({
      runId: "lot3d-off",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: off,
      config: cfg,
    })
    assert.equal(offResult.steps.validation.skipReason, "DISABLED")

    const on: AcquisitionOrchestratorStepRunners = {
      ...createDefaultStubStepRunners(),
      validation: async () => ({ status: "SUCCESS", result: { stubValidation: true } }),
      autoDecision: onPost,
      worksiteCreation: onPost,
    }
    const onResult = await runAcquisitionOrchestrator({
      runId: "lot3d-on",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: on,
      config: cfg,
    })
    assert.equal(onResult.steps.worksiteCreation.skipReason, "NOT_IMPLEMENTED")
  })

  it("aucun approve/reject/convert dans worker", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.equal(/approveImportDraft/.test(src), false)
    assert.equal(/rejectImportDraft/.test(src), false)
    assert.equal(/convertImportDraft/.test(src), false)
    assert.equal(/\$queryRaw/.test(src), true)
    assert.equal(/validationEligibleDraftPredicateSql/.test(src), true)
  })

  it("wiring : validation worker importé ; autoDecision reste placeholder", () => {
    const src = readFileSync(WORKERS_WIRING_SRC, "utf8")
    assert.equal(/runAcquisitionValidationWorker/.test(src), true)
    assert.equal(/convertImportDraft/.test(src), false)
  })

  it("snapshot shape Lot 2", () => {
    assert.equal(completeSnap({ clientAmbiguous: true }).clientAmbiguous, true)
  })

  it("validationDecisionToCode mapping", () => {
    assert.equal(validationDecisionToCode({ code: "PASS", reasons: [] }), "VALIDATION_PASS")
  })
})
