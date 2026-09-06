/**
 * PLAN-ACQ-AGENTS-LOT-3F — Tests worker worksiteCreation.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { ConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import type {
  ConversionActorContext,
  ConvertImportDraftResult,
} from "@/lib/acquisition/conversion/conversion.types"
import {
  buildLegacyConvertInput,
  isClientBlockedForConversion,
  isDuplicateBlockedForConversion,
  mapConvertResultToWorksiteCreationDecision,
  mapSkipPhaseToWorksiteCreationDecision,
  rankWorksiteCreationCandidatesFairness,
  resolveWorksiteCreationState,
  runAcquisitionWorksiteCreationWorker,
  type WorksiteCreationPhase,
  type WorksiteCreationWorkerCandidate,
  type WorksiteCreationWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-worksite-creation.worker"
import {
  isDirectApprovalAssociation,
  isPostExtractionStepsPipeline,
  parseFrozenValidationCycle,
  type AutoDecisionIntentCode,
  type FrozenValidationCycle,
  type JournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import {
  createPostExtractionPlaceholderRunner,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { createDefaultStubStepRunners } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import { runAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import type { AcquisitionOrchestratorStepRunners } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

const WORKER_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-worksite-creation.worker.ts"
)
const WORKERS_WIRING_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"
)

function frozen(over: Partial<FrozenValidationCycle> = {}): FrozenValidationCycle {
  return {
    contentHash: "hash-1",
    extractionSchemaVersion: "2",
    validatedDraftVersion: 7,
    ...over,
  }
}

function intentRow(
  code: AutoDecisionIntentCode,
  f: FrozenValidationCycle = frozen(),
  over: Partial<Omit<JournalRow, "decisionCode">> = {}
): JournalRow & { decisionCode: AutoDecisionIntentCode } {
  return {
    id: "i1",
    companyId: "co1",
    draftId: "d1",
    reasons: [],
    scores: {},
    actorUserId: "sys1",
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: { ...f },
    },
    createdAt: new Date(),
    ...over,
    decisionCode: code,
  }
}

function okSystemActor() {
  return {
    ok: true as const,
    userId: "sys1",
    role: "ADMIN" as const,
  }
}

function baseState(over: {
  draftStatus?: string
  createdWorksiteId?: string | null
  draftVersion?: number
  draftContentHash?: string | null
  draftExtractionSchemaVersion?: string | null
  latestIntent?: (JournalRow & { decisionCode: AutoDecisionIntentCode }) | null
  systemActorOk?: boolean
  clientBlocked?: boolean
  duplicateBlocked?: boolean
  stateChanged?: boolean
} = {}) {
  return {
    draftStatus: over.draftStatus ?? "APPROVED",
    createdWorksiteId: over.createdWorksiteId ?? null,
    draftVersion: over.draftVersion ?? 8,
    draftContentHash: over.draftContentHash ?? "hash-1",
    draftExtractionSchemaVersion: over.draftExtractionSchemaVersion ?? "2",
    latestIntent:
      over.latestIntent === undefined
        ? intentRow("AUTO_APPROVE_CONVERT")
        : over.latestIntent,
    systemActorOk: over.systemActorOk ?? true,
    clientBlocked: over.clientBlocked ?? false,
    duplicateBlocked: over.duplicateBlocked ?? false,
    stateChanged: over.stateChanged,
  }
}

function makeCtx(over: {
  clientId?: string | null
  ambiguous?: boolean
  allowCreateClient?: boolean
  duplicateWorksiteId?: string | null
  proposedClientName?: string | null
  clientEmail?: string | null
} = {}): ConsultationEvaluationContext {
  return {
    draft: {
      id: "d1",
      companyId: "co1",
      status: "APPROVED",
      version: 8,
      proposedWorksiteName: "Chantier A",
      proposedClientName: over.proposedClientName ?? "Client SA",
      proposedAddress: "1 rue Test",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-01"),
      proposedEndDate: new Date("2026-10-05"),
      proposedClientId: null,
      confidenceData: {},
      warningData: [],
      extractedData: { clientEmail: over.clientEmail ?? "c@example.com" },
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "lauralu.fr",
        threadId: "t1",
      },
    },
    cycle: {
      contentHash: "hash-1",
      extractionSchemaVersion: "2",
      draftVersion: 8,
    },
    classification: "CONSULTATION",
    partner: {
      id: "p1",
      code: "lauralu",
      minConfidence: null,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      allowCreateClient: over.allowCreateClient ?? false,
      clientId: null,
    },
    partnerProfile: null,
    clientMatch: {
      clientId: over.clientId === undefined ? "cli1" : over.clientId,
      matchKind: over.clientId === null ? "NONE" : "EMAIL",
      ambiguous: over.ambiguous,
    },
    duplicate: {
      worksiteId: over.duplicateWorksiteId ?? null,
      matchKind: over.duplicateWorksiteId ? "ADDRESS" : "NONE",
    },
    snapshot: {
      worksiteName: "Chantier A",
      address: "1 rue Test",
      city: "Paris",
      postalCode: "75001",
      clientName: over.proposedClientName ?? "Client SA",
      clientEmail: over.clientEmail ?? "c@example.com",
      consultationReference: null,
      requestedStartDate: "2026-10-01",
      requestedEndDate: "2026-10-05",
      confidenceData: {},
      warnings: [],
      clientAmbiguous: Boolean(over.ambiguous),
      hasResolvedClient: over.clientId !== null && over.clientId !== undefined,
      potentialDuplicate: Boolean(over.duplicateWorksiteId),
      duplicateRequiresAck: Boolean(over.duplicateWorksiteId),
      requiredDocumentUnreadable: false,
      consultationCancelled: false,
      contentMissingRetryable: false,
    },
  } as ConsultationEvaluationContext
}

describe("PLAN-ACQ-AGENTS-LOT-3F association + state machine", () => {
  it("1. intent v7 + APPROVED v8 → NEEDS_CONVERSION", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ draftVersion: 8 })),
      "NEEDS_CONVERSION"
    )
    assert.equal(
      isDirectApprovalAssociation({
        draftVersion: 8,
        validatedDraftVersion: 7,
      }),
      true
    )
  })

  it("2. intent v7 + APPROVED v9 → SKIP_STALE_APPROVAL", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ draftVersion: 9 })),
      "SKIP_STALE_APPROVAL"
    )
  })

  it("3. same hash/schema does not authorize v9", () => {
    const phase = resolveWorksiteCreationState(
      baseState({
        draftVersion: 9,
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        latestIntent: intentRow("AUTO_APPROVE_CONVERT", frozen()),
      })
    )
    assert.equal(phase, "SKIP_STALE_APPROVAL")
  })

  it("A–F Correction-1 formula", () => {
    assert.equal(
      isDirectApprovalAssociation({
        draftVersion: 8,
        validatedDraftVersion: 7,
      }),
      true
    )
    assert.equal(
      isDirectApprovalAssociation({
        draftVersion: 9,
        validatedDraftVersion: 7,
      }),
      false
    )
  })

  it("17. AUTO_APPROVE_ONLY → SKIP_AUTO_APPROVE_ONLY", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({
          latestIntent: intentRow("AUTO_APPROVE_ONLY"),
        })
      ),
      "SKIP_AUTO_APPROVE_ONLY"
    )
  })

  it("18. HUMAN latest → SKIP_NO_VALID_INTENT", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({
          latestIntent: intentRow("HUMAN_REVIEW_REQUIRED"),
        })
      ),
      "SKIP_NO_VALID_INTENT"
    )
  })

  it("19. mauvais hash → SKIP_NO_VALID_INTENT", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({ draftContentHash: "other-hash" })
      ),
      "SKIP_NO_VALID_INTENT"
    )
  })

  it("20. mauvais schema → SKIP_NO_VALID_INTENT", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({ draftExtractionSchemaVersion: "99" })
      ),
      "SKIP_NO_VALID_INTENT"
    )
  })

  it("21. REJECTED → SKIP_CANCELLED", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ draftStatus: "REJECTED" })),
      "SKIP_CANCELLED"
    )
  })

  it("22. AUTO_REJECT_CANCELLED intent → SKIP_CANCELLED", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({
          latestIntent: intentRow("AUTO_REJECT_CANCELLED"),
        })
      ),
      "SKIP_CANCELLED"
    )
  })

  it("ALREADY_CONVERTED when createdWorksiteId set", () => {
    assert.equal(
      resolveWorksiteCreationState(
        baseState({
          draftStatus: "CONVERTED",
          createdWorksiteId: "ws1",
        })
      ),
      "ALREADY_CONVERTED"
    )
  })

  it("29. system actor invalid → BLOCKED_SYSTEM_ACTOR", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ systemActorOk: false })),
      "BLOCKED_SYSTEM_ACTOR"
    )
  })

  it("23. duplicate blocked → BLOCKED_DUPLICATE", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ duplicateBlocked: true })),
      "BLOCKED_DUPLICATE"
    )
  })

  it("27–28. client blocked → BLOCKED_CLIENT", () => {
    assert.equal(
      resolveWorksiteCreationState(baseState({ clientBlocked: true })),
      "BLOCKED_CLIENT"
    )
  })

  it("37. intent legacy sans pipeline → SKIP", () => {
    const legacy = intentRow("AUTO_APPROVE_CONVERT")
    legacy.metadata = {
      validationCycle: frozen(),
    }
    assert.equal(isPostExtractionStepsPipeline(legacy.metadata), false)
    assert.equal(
      resolveWorksiteCreationState(baseState({ latestIntent: legacy })),
      "SKIP_NO_VALID_INTENT"
    )
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3F client / convert mapping", () => {
  it("25. EXISTING client input", () => {
    const ctx = makeCtx({ clientId: "cli1" })
    const input = buildLegacyConvertInput({
      draftId: "d1",
      expectedVersion: 8,
      ctx,
    })
    assert.ok(input)
    assert.equal(input!.clientMode, "EXISTING")
    assert.equal(input!.existingClientId, "cli1")
    assert.equal(input!.expectedVersion, 8)
    assert.equal(input!.acknowledgeDuplicateWorksite, false)
  })

  it("4–5. expectedVersion = 8 jamais 7", () => {
    const ctx = makeCtx({ clientId: "cli1" })
    const input = buildLegacyConvertInput({
      draftId: "d1",
      expectedVersion: 8,
      ctx,
    })
    assert.equal(input!.expectedVersion, 8)
    assert.notEqual(input!.expectedVersion, 7)
    const f = frozen({ validatedDraftVersion: 7 })
    assert.notEqual(input!.expectedVersion, f.validatedDraftVersion)
  })

  it("24. acknowledgeDuplicateWorksite === false", () => {
    const ctx = makeCtx({ clientId: "cli1" })
    const input = buildLegacyConvertInput({
      draftId: "d1",
      expectedVersion: 8,
      ctx,
    })
    assert.equal(input!.acknowledgeDuplicateWorksite, false)
  })

  it("26. NEW client allowCreateClient=true", () => {
    const ctx = makeCtx({
      clientId: null,
      allowCreateClient: true,
      proposedClientName: "Nouveau Client",
      clientEmail: "n@ex.com",
    })
    const input = buildLegacyConvertInput({
      draftId: "d1",
      expectedVersion: 8,
      ctx,
    })
    assert.ok(input)
    assert.equal(input!.clientMode, "NEW")
    assert.equal(input!.newClient?.name, "Nouveau Client")
    assert.equal(input!.newClient?.email, "n@ex.com")
    assert.equal(input!.newClient?.phone, null)
    assert.equal(input!.acknowledgeDuplicateWorksite, false)
  })

  it("27. NEW allowCreateClient=false → blocked", () => {
    const ctx = makeCtx({
      clientId: null,
      allowCreateClient: false,
    })
    assert.equal(isClientBlockedForConversion(ctx), true)
    assert.equal(
      buildLegacyConvertInput({ draftId: "d1", expectedVersion: 8, ctx }),
      null
    )
  })

  it("28. client ambiguous → blocked", () => {
    const ctx = makeCtx({
      clientId: null,
      allowCreateClient: true,
      ambiguous: true,
    })
    assert.equal(isClientBlockedForConversion(ctx), true)
  })

  it("duplicate context → blocked", () => {
    const ctx = makeCtx({ duplicateWorksiteId: "ws-dup" })
    assert.equal(isDuplicateBlockedForConversion(ctx), true)
  })

  it("map CONVERTED → CREATED ; ALREADY → ALREADY_CONVERTED", () => {
    assert.deepEqual(
      mapConvertResultToWorksiteCreationDecision({
        ok: true,
        outcome: "CONVERTED",
        worksiteId: "ws1",
        clientId: "cli1",
        clientCreated: false,
        documentCount: 0,
        skippedAttachmentCount: 0,
      }),
      { code: "CREATED", worksiteId: "ws1", clientId: "cli1" }
    )
    assert.deepEqual(
      mapConvertResultToWorksiteCreationDecision({
        ok: true,
        outcome: "ALREADY_CONVERTED",
        worksiteId: "ws1",
        clientId: "cli1",
        clientCreated: false,
        documentCount: 1,
        skippedAttachmentCount: 0,
      }),
      { code: "ALREADY_CONVERTED", worksiteId: "ws1", clientId: "cli1" }
    )
  })

  it("map failures + skip reasons contrat", () => {
    const fail: ConvertImportDraftResult = {
      ok: false,
      outcome: "DUPLICATE_REQUIRES_ACK",
      code: "DUPLICATE_REQUIRES_ACK",
      message: "dup",
      existingWorksiteId: "ws-x",
    }
    const mapped = mapConvertResultToWorksiteCreationDecision(fail)
    assert.equal(mapped.code, "FAILED")
    if (mapped.code === "FAILED") {
      assert.equal(mapped.outcome, "DUPLICATE_REQUIRES_ACK")
      assert.equal(mapped.existingWorksiteId, "ws-x")
    }
    assert.deepEqual(mapSkipPhaseToWorksiteCreationDecision("SKIP_CANCELLED"), {
      code: "SKIPPED",
      reason: "CANCELLED",
    })
    assert.deepEqual(
      mapSkipPhaseToWorksiteCreationDecision("SKIP_STALE_APPROVAL"),
      { code: "SKIPPED", reason: "NOT_APPROVED" }
    )
    const phases: WorksiteCreationPhase[] = [
      "SKIP_AUTO_APPROVE_ONLY",
      "SKIP_NO_VALID_INTENT",
    ]
    for (const p of phases) {
      assert.equal(mapSkipPhaseToWorksiteCreationDecision(p).code, "SKIPPED")
    }
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3F fairness", () => {
  it("31–33. fairness maxPerCompany + deterministic order", () => {
    const t0 = new Date("2026-01-01T00:00:00Z")
    const t1 = new Date("2026-01-01T00:01:00Z")
    const rows: WorksiteCreationWorkerCandidate[] = [
      {
        draftId: "d-b2",
        companyId: "coB",
        status: "APPROVED",
        version: 8,
        contentHashAtExtraction: "h",
        extractionSchemaVersion: "2",
        updatedAt: t1,
      },
      {
        draftId: "d-a1",
        companyId: "coA",
        status: "APPROVED",
        version: 8,
        contentHashAtExtraction: "h",
        extractionSchemaVersion: "2",
        updatedAt: t0,
      },
      {
        draftId: "d-a2",
        companyId: "coA",
        status: "APPROVED",
        version: 8,
        contentHashAtExtraction: "h",
        extractionSchemaVersion: "2",
        updatedAt: t1,
      },
      {
        draftId: "d-a3",
        companyId: "coA",
        status: "APPROVED",
        version: 8,
        contentHashAtExtraction: "h",
        extractionSchemaVersion: "2",
        updatedAt: new Date("2026-01-01T00:02:00Z"),
      },
      {
        draftId: "d-c1",
        companyId: "coC",
        status: "APPROVED",
        version: 8,
        contentHashAtExtraction: "h",
        extractionSchemaVersion: "2",
        updatedAt: t0,
      },
    ]
    const ranked = rankWorksiteCreationCandidatesFairness(rows, {
      maxPerCompany: 1,
      limit: 10,
    })
    assert.equal(ranked.length, 3)
    assert.deepEqual(
      ranked.map((r) => r.companyId),
      ["coA", "coC", "coB"]
    )
    assert.equal(ranked[0]!.draftId, "d-a1")
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3F worker integration (mocked)", () => {
  function selectionOf(
    candidates: WorksiteCreationWorkerCandidate[]
  ): WorksiteCreationWorkerSelectionPort {
    return {
      async listEligibleCandidates() {
        return candidates
      },
    }
  }

  function candidate(
    over: Partial<WorksiteCreationWorkerCandidate> = {}
  ): WorksiteCreationWorkerCandidate {
    return {
      draftId: "d1",
      companyId: "co1",
      status: "APPROVED",
      version: 8,
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      updatedAt: new Date(),
      ...over,
    }
  }

  function reloadRow(over: Record<string, unknown> = {}) {
    return {
      id: "d1",
      companyId: "co1",
      status: "APPROVED",
      version: 8,
      createdWorksiteId: null,
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      proposedClientName: "Client SA",
      proposedAddress: "1 rue",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      ...over,
    }
  }

  function evaluationDraft(over: Record<string, unknown> = {}) {
    return {
      id: "d1",
      companyId: "co1",
      status: "APPROVED",
      version: 8,
      proposedWorksiteName: "Chantier A",
      proposedClientName: "Client SA",
      proposedAddress: "1 rue",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-10-01"),
      proposedEndDate: new Date("2026-10-05"),
      proposedClientId: null,
      confidenceData: {},
      warningData: [],
      extractedData: { clientEmail: "c@example.com" },
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "lauralu.fr",
        threadId: "t1",
      },
      ...over,
    }
  }

  function makeDb(reload: () => unknown, evalDraft: () => unknown) {
    return {
      worksiteImportDraft: {
        findFirst: async () => {
          // reloadDraft + loadConsultationEvaluationDraft share findFirst;
          // return union-compatible row.
          const r = reload() as Record<string, unknown>
          const e = evalDraft() as Record<string, unknown>
          return { ...e, ...r }
        },
      },
    } as never
  }

  const defaultRegistry = {
    findPartnerById: async () => ({
      id: "p1",
      code: "lauralu",
      active: true,
      minConfidence: null,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      allowCreateClient: false,
      clientId: null,
      requireExactEmail: false,
    }),
    findPartnerByDomain: async () => null,
  }

  it("6–7. CONVERT → CREATED via convertImportDraft ; expectedVersion 8", async () => {
    const calls: unknown[] = []
    const db = makeDb(() => reloadRow(), () => evaluationDraft())

    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (
          _ctx: ConversionActorContext,
          raw: unknown
        ) => {
          calls.push(raw)
          return {
            ok: true as const,
            outcome: "CONVERTED" as const,
            worksiteId: "ws1",
            clientId: "cli1",
            clientCreated: false,
            documentCount: 0,
            skippedAttachmentCount: 0,
          }
        },
      },
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(result.stats.converted, 1)
    assert.equal(calls.length, 1)
    const payload = calls[0] as { expectedVersion: number }
    assert.equal(payload.expectedVersion, 8)
    assert.notEqual(payload.expectedVersion, 7)
  })

  it("12. ALREADY_CONVERTED mapped on rerun outcome", async () => {
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async () => ({
          ok: true as const,
          outcome: "ALREADY_CONVERTED" as const,
          worksiteId: "ws1",
          clientId: "cli1",
          clientCreated: false,
          documentCount: 0,
          skippedAttachmentCount: 0,
        }),
      },
    })
    assert.equal(result.stats.alreadyConverted, 1)
    assert.equal(result.stats.converted, 0)
  })

  it("15. lease lost before convert → 0 create", async () => {
    let ownershipChecks = 0
    const convertCalls: unknown[] = []
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => {
        ownershipChecks++
        // Fail on FINAL fence (après final actor resolve)
        if (ownershipChecks >= 5) {
          return "NOT_OWNED"
        }
        return "OWNED"
      },
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, raw) => {
          convertCalls.push(raw)
          return {
            ok: true as const,
            outcome: "CONVERTED" as const,
            worksiteId: "ws1",
            clientId: "cli1",
            clientCreated: false,
            documentCount: 0,
            skippedAttachmentCount: 0,
          }
        },
      },
    })
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(convertCalls.length, 0)
    assert.equal(result.stats.converted, 0)
  })

  it("LOT-3F: convert LEASE_NOT_OWNED → leaseStolen (fence TX)", async () => {
    let fencePassed: unknown
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, _raw, options) => {
          fencePassed = options?.transactionalOwnershipFence
          return {
            ok: false as const,
            outcome: "LEASE_NOT_OWNED" as const,
            code: "LEASE_NOT_OWNED",
            message: "Ownership orchestrateur perdu",
          }
        },
      },
    })
    assert.ok(fencePassed)
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(result.stats.leaseStolen, 1)
    assert.equal(result.stats.converted, 0)
    assert.equal(result.stats.errors, 0)
  })

  it("Correction-1: actor OK initial, invalide au final → 0 convert + BLOCKED_SYSTEM_ACTOR", async () => {
    let actorCalls = 0
    const convertCalls: unknown[] = []
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => {
        actorCalls++
        if (actorCalls === 1) return okSystemActor()
        return {
          ok: false as const,
          code: "SYSTEM_ACTOR_INVALID" as const,
          reason: "tenant_mismatch",
        }
      },
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, raw) => {
          convertCalls.push(raw)
          throw new Error("must not convert")
        },
      },
    })
    assert.equal(actorCalls, 2)
    assert.equal(convertCalls.length, 0)
    assert.equal(result.stats.blockedSystemActor, 1)
    assert.equal(result.stats.converted, 0)
  })

  it("Correction-1: actor OK initial + OK final → conversion une fois ; userId FINAL", async () => {
    let actorCalls = 0
    const actorsSeen: ConversionActorContext[] = []
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => {
        actorCalls++
        if (actorCalls === 1) {
          return {
            ok: true as const,
            userId: "sys-INITIAL",
            role: "ADMIN" as const,
          }
        }
        return {
          ok: true as const,
          userId: "sys-FINAL",
          role: "ADMIN" as const,
        }
      },
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (ctx, _raw) => {
          actorsSeen.push(ctx)
          return {
            ok: true as const,
            outcome: "CONVERTED" as const,
            worksiteId: "ws1",
            clientId: "cli1",
            clientCreated: false,
            documentCount: 0,
            skippedAttachmentCount: 0,
          }
        },
      },
    })
    assert.equal(actorCalls, 2)
    assert.equal(result.stats.converted, 1)
    assert.equal(actorsSeen.length, 1)
    assert.equal(actorsSeen[0]!.actorUserId, "sys-FINAL")
    assert.notEqual(actorsSeen[0]!.actorUserId, "sys-INITIAL")
    assert.equal(actorsSeen[0]!.actorRole, "SYSTEM")
  })

  it("Correction-1: lease perdu après final actor resolve → 0 convert", async () => {
    let actorCalls = 0
    let ownershipChecks = 0
    const convertCalls: unknown[] = []
    const db = makeDb(() => reloadRow(), () => evaluationDraft())
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => {
        ownershipChecks++
        if (actorCalls >= 2 && ownershipChecks >= 5) return "NOT_OWNED"
        return "OWNED"
      },
      resolveSystemActor: async () => {
        actorCalls++
        return okSystemActor()
      },
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, raw) => {
          convertCalls.push(raw)
          throw new Error("must not convert")
        },
      },
    })
    assert.equal(actorCalls, 2)
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(convertCalls.length, 0)
  })

  it("2/E. stale approval v9 → 0 convert call", async () => {
    const convertCalls: unknown[] = []
    const db = makeDb(
      () => reloadRow({ version: 9 }),
      () => evaluationDraft({ version: 9 })
    )
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate({ version: 9 })]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT", frozen({ validatedDraftVersion: 7 })),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, raw) => {
          convertCalls.push(raw)
          throw new Error("should not convert")
        },
      },
    })
    assert.equal(result.stats.staleApproval, 1)
    assert.equal(convertCalls.length, 0)
  })

  it("34–35. status/version changed before final → no create", async () => {
    const convertCalls: unknown[] = []
    let finds = 0
    const db = {
      worksiteImportDraft: {
        findFirst: async () => {
          finds++
          if (finds <= 2) {
            return {
              ...evaluationDraft(),
              ...reloadRow({ version: 8 }),
            }
          }
          return {
            ...evaluationDraft({ version: 9 }),
            ...reloadRow({ version: 9 }),
          }
        },
      },
    } as never
    const result = await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate()]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () =>
          intentRow("AUTO_APPROVE_CONVERT"),
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: defaultRegistry as never,
      },
      conversion: {
        convertImportDraft: async (_c, raw) => {
          convertCalls.push(raw)
          throw new Error("no")
        },
      },
    })
    assert.equal(convertCalls.length, 0)
    assert.ok(result.stats.stateChanged >= 1)
  })

  it("30. tenant isolation on reload (companyId scoped)", async () => {
    const finds: Array<{ companyId?: string; id?: string }> = []
    const db = {
      worksiteImportDraft: {
        findFirst: async (args: {
          where: { companyId: string; id: string }
        }) => {
          finds.push(args.where)
          return {
            ...evaluationDraft({ companyId: "co-tenant-a", version: 9 }),
            ...reloadRow({ companyId: "co-tenant-a", version: 9 }),
          }
        },
      },
    } as never
    await runAcquisitionWorksiteCreationWorker({
      selection: selectionOf([candidate({ companyId: "co-tenant-a" })]),
      ensureOwnership: async () => "OWNED",
      resolveSystemActor: async () => okSystemActor(),
      journal: {
        findLatestPostExtractionAutoIntentForExtractionIdentity: async (q: {
          companyId: string
        }) => {
          assert.equal(q.companyId, "co-tenant-a")
          return intentRow("AUTO_APPROVE_CONVERT")
        },
      } as never,
      db,
      evaluationDeps: {
        db,
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        findDuplicate: async () => ({
          worksiteId: null,
          matchKind: "NONE" as const,
        }),
        registry: {
          findPartnerById: async () => null,
          findPartnerByDomain: async () => null,
        } as never,
      },
      conversion: {
        convertImportDraft: async () => {
          throw new Error("no")
        },
      },
    })
    assert.ok(finds.every((f) => f.companyId === "co-tenant-a"))
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3F static guards + wiring", () => {
  it("46–47. aucun Assignment/team ; aucun db.worksite.create dans worker", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.equal(/worksite\.create/.test(src), false)
    assert.equal(/client\.create/.test(src), false)
    assert.equal(/document\.create/.test(src), false)
    assert.equal(/assignment/i.test(src), false)
    assert.equal(/teamId/.test(src), false)
    assert.equal(/convertImportDraft/.test(src), true)
    assert.equal(/ImportDraftConversionService|importDraftConversionService/.test(src), true)
    assert.equal(/WORKSITE_CREATION_INTENT/.test(src), false)
    assert.equal(/WORKSITE_CREATION_APPLIED/.test(src), false)
  })

  it("Correction-1: aucune I/O entre final ownership fence et convertImportDraft", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    const fenceMarker =
      "Fence FINAL — aucune I/O (DB / journal / actor) entre fence et convert"
    const fenceIdx = src.indexOf(fenceMarker)
    assert.ok(fenceIdx > 0, "fence FINAL marker missing")
    const convertIdx = src.indexOf(
      "conversion.convertImportDraft(actor, convertInput",
      fenceIdx
    )
    assert.ok(convertIdx > fenceIdx, "convert must follow final fence")
    const between = src.slice(fenceIdx, convertIdx)
    assert.equal(/await\s+input\.resolveSystemActor/.test(between), false)
    assert.equal(/reloadDraft\(/.test(between), false)
    assert.equal(
      /findLatestPostExtractionAutoIntentForExtractionIdentity/.test(between),
      false
    )
    assert.equal(/buildConsultationEvaluationContext/.test(between), false)
    assert.equal(/db\.\w+\./.test(between), false)
    assert.equal(/journal\./.test(between), false)
    // Seules opérations autorisées : ownership check, construction actor pure, log
    assert.equal(/isOrchestratorOwnershipValid/.test(between), true)
    assert.equal(/convertImportDraft/.test(between), false)
  })

  it("LOT-3F: convert reçoit transactionalOwnershipFence ; LEASE_NOT_OWNED → leaseStolen", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.match(src, /transactionalOwnershipFence/)
    assert.match(src, /LEASE_NOT_OWNED/)
    assert.match(src, /stats\.leaseStolen\+\+/)
  })

  it("8–10. target PLANNED / 0 Assignment / À affecter — délégué conversion (assert source)", () => {
    const conversionSrc = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/conversion/conversion.service.ts"
      ),
      "utf8"
    )
    assert.equal(/status:\s*"PLANNED"/.test(conversionSrc), true)
    assert.equal(/assignment\.create/i.test(conversionSrc), false)
    const uiSrc = readFileSync(
      path.join(process.cwd(), "src/components/chantiers/ChantiersView.tsx"),
      "utf8"
    )
    assert.equal(
      /status === "PLANNED" && c\._count\.assignments === 0/.test(uiSrc),
      true
    )
  })

  it("38–39. flag OFF DISABLED ; flag ON wire réel worksiteCreation", () => {
    const wiring = readFileSync(WORKERS_WIRING_SRC, "utf8")
    assert.equal(/runAcquisitionWorksiteCreationWorker/.test(wiring), true)
    assert.equal(
      /worksiteCreation:\s*postExtractionStepsEnabled\s*\?\s*notImplementedPlaceholder/.test(
        wiring
      ),
      false
    )
  })

  it("38. createPostExtractionPlaceholderRunner OFF → DISABLED", async () => {
    const off = createPostExtractionPlaceholderRunner(false)
    const steps: AcquisitionOrchestratorStepRunners = {
      ...createDefaultStubStepRunners(),
      worksiteCreation: off,
    }
    const result = await runAcquisitionOrchestrator({
      runId: "lot3f-off",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps,
      config: {
        maxDurationMs: 5000,
        safetyMarginMs: 500,
        leaseTtlMs: 30_000,
      },
    })
    assert.equal(result.steps.worksiteCreation.skipReason, "DISABLED")
  })

  it("parseFrozen + pipeline helpers", () => {
    const meta = {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: frozen(),
    }
    assert.equal(isPostExtractionStepsPipeline(meta), true)
    const f = parseFrozenValidationCycle(meta)
    assert.ok(f)
    assert.equal(f!.validatedDraftVersion, 7)
  })
})
