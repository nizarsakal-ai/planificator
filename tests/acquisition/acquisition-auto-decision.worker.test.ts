/**
 * PLAN-ACQ-AGENTS-LOT-3E — Tests worker auto-decision.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  cancelProofSql,
  computeEffectiveAutoFlags,
  isConsultationCancelledTerminal,
  rankAutoDecisionCandidatesFairness,
  resolveAutoDecisionApplicationState,
  runAcquisitionAutoDecisionWorker,
  type AutoDecisionWorkerCandidate,
  type AutoDecisionWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import {
  draftMatchesFrozenCycle,
  parseFrozenValidationCycle,
  toFrozenValidationCycle,
  type AutoDecisionIntentCode,
  type DecisionJournalEntry,
  type FrozenValidationCycle,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

const WORKER_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-auto-decision.worker.ts"
)

function frozen(over: Partial<FrozenValidationCycle> = {}): FrozenValidationCycle {
  return {
    contentHash: "hash-1",
    extractionSchemaVersion: "2",
    validatedDraftVersion: 7,
    ...over,
  }
}

function cycle(over: Partial<ValidationCycleIdentity> = {}): ValidationCycleIdentity {
  return {
    contentHash: "hash-1",
    extractionSchemaVersion: "2",
    draftVersion: 7,
    ...over,
  }
}

function validationRow(
  over: Partial<ValidationJournalRow> & { decisionCode: ValidationJournalRow["decisionCode"] }
): ValidationJournalRow {
  const c = cycle()
  return {
    id: "v1",
    companyId: "co1",
    draftId: "d1",
    reasons: [],
    scores: {},
    actorUserId: null,
    metadata: {
      contentHash: c.contentHash,
      extractionSchemaVersion: c.extractionSchemaVersion,
      draftVersion: c.draftVersion,
    },
    createdAt: new Date(),
    ...over,
  }
}

function intentRow(
  code: AutoDecisionIntentCode,
  f: FrozenValidationCycle = frozen()
) {
  return {
    id: "i1",
    companyId: "co1",
    draftId: "d1",
    decisionCode: code,
    reasons: [],
    scores: {},
    actorUserId: null,
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: { ...f },
    },
    createdAt: new Date(),
  }
}

describe("PLAN-ACQ-AGENTS-LOT-3E state machine", () => {
  it("NEEDS_DECISION when PASS and no intent", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 7,
        validationForCurrentCycle: validationRow({ decisionCode: "VALIDATION_PASS" }),
        intentForFrozenCycle: null,
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "NEEDS_DECISION"
    )
  })

  it("SKIP_INELIGIBLE for QUARANTINE / RETRYABLE / non-cancel TERMINAL", () => {
    for (const decisionCode of [
      "VALIDATION_QUARANTINE",
      "VALIDATION_FAIL_RETRYABLE",
      "VALIDATION_FAIL_TERMINAL",
    ] as const) {
      assert.equal(
        resolveAutoDecisionApplicationState({
          draftStatus: "PENDING_REVIEW",
          draftContentHash: "hash-1",
          draftExtractionSchemaVersion: "2",
          draftVersion: 7,
          validationForCurrentCycle: validationRow({
            decisionCode,
            reasons: decisionCode === "VALIDATION_FAIL_TERMINAL" ? ["OTHER"] : [],
            metadata: {
              contentHash: "hash-1",
              extractionSchemaVersion: "2",
              draftVersion: 7,
              ...(decisionCode === "VALIDATION_FAIL_TERMINAL"
                ? { errorCode: "OTHER" }
                : {}),
            },
          }),
          intentForFrozenCycle: null,
          followUpForIntentCycle: null,
          systemActorOk: true,
        }),
        "SKIP_INELIGIBLE"
      )
    }
  })

  it("cancel FAIL_TERMINAL → NEEDS_DECISION", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 7,
        validationForCurrentCycle: validationRow({
          decisionCode: "VALIDATION_FAIL_TERMINAL",
          reasons: ["CONSULTATION_CANCELLED"],
          metadata: {
            contentHash: "hash-1",
            extractionSchemaVersion: "2",
            draftVersion: 7,
            errorCode: "CONSULTATION_CANCELLED",
          },
        }),
        intentForFrozenCycle: null,
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "NEEDS_DECISION"
    )
  })

  it("HUMAN intent → DONE_HUMAN", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 7,
        validationForCurrentCycle: validationRow({ decisionCode: "VALIDATION_PASS" }),
        intentForFrozenCycle: intentRow("HUMAN_REVIEW_REQUIRED"),
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "DONE_HUMAN"
    )
  })

  it("AUTO_APPROVE + PENDING → NEEDS_APPROVE ; actor invalid → BLOCKED", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 7,
        validationForCurrentCycle: validationRow({ decisionCode: "VALIDATION_PASS" }),
        intentForFrozenCycle: intentRow("AUTO_APPROVE_CONVERT"),
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "NEEDS_APPROVE"
    )
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 7,
        validationForCurrentCycle: validationRow({ decisionCode: "VALIDATION_PASS" }),
        intentForFrozenCycle: intentRow("AUTO_APPROVE_ONLY"),
        followUpForIntentCycle: null,
        systemActorOk: false,
      }),
      "BLOCKED_SYSTEM_ACTOR"
    )
  })

  it("Correction-1: PENDING v8 + intent v7 → STALE_CYCLE", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "PENDING_REVIEW",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 8,
        validationForCurrentCycle: null,
        intentForFrozenCycle: intentRow("AUTO_REJECT_CANCELLED", frozen({ validatedDraftVersion: 7 })),
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "STALE_CYCLE"
    )
  })

  it("Correction-1: REJECTED v8 + intent v7 + no FU → NEEDS_CANCEL_FOLLOWUP", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "REJECTED",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 8,
        validationForCurrentCycle: null,
        intentForFrozenCycle: intentRow("AUTO_REJECT_CANCELLED", frozen({ validatedDraftVersion: 7 })),
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "NEEDS_CANCEL_FOLLOWUP"
    )
  })

  it("REJECTED + follow-up same cycle → DONE_REJECTED", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "REJECTED",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 8,
        validationForCurrentCycle: null,
        intentForFrozenCycle: intentRow("AUTO_REJECT_CANCELLED"),
        followUpForIntentCycle: {
          id: "fu",
          companyId: "co1",
          draftId: "d1",
          decisionCode: "CANCELLATION_NO_LINK",
          reasons: [],
          scores: {},
          actorUserId: null,
          metadata: { validationCycle: frozen() },
          createdAt: new Date(),
        },
        systemActorOk: true,
      }),
      "DONE_REJECTED"
    )
  })

  it("APPROVED v8 + AUTO_APPROVE_CONVERT intent v7 → DONE_APPROVED", () => {
    assert.equal(
      resolveAutoDecisionApplicationState({
        draftStatus: "APPROVED",
        draftContentHash: "hash-1",
        draftExtractionSchemaVersion: "2",
        draftVersion: 8,
        validationForCurrentCycle: null,
        intentForFrozenCycle: intentRow("AUTO_APPROVE_CONVERT", frozen({ validatedDraftVersion: 7 })),
        followUpForIntentCycle: null,
        systemActorOk: true,
      }),
      "DONE_APPROVED"
    )
  })

  it("isConsultationCancelledTerminal strict", () => {
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: ["CONSULTATION_CANCELLED"],
        metadata: {},
      }),
      true
    )
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: ["OTHER"],
        metadata: { errorCode: "CONSULTATION_CANCELLED" },
      }),
      true
    )
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: ["OTHER"],
        metadata: { errorCode: "X" },
      }),
      false
    )
  })

  it("draftMatchesFrozenCycle pre-mutation", () => {
    const f = frozen({ validatedDraftVersion: 7 })
    assert.equal(
      draftMatchesFrozenCycle({
        contentHashAtExtraction: "hash-1",
        extractionSchemaVersion: "2",
        version: 7,
        frozen: f,
      }),
      true
    )
    assert.equal(
      draftMatchesFrozenCycle({
        contentHashAtExtraction: "hash-1",
        extractionSchemaVersion: "2",
        version: 8,
        frozen: f,
      }),
      false
    )
  })

  it("toFrozen / parseFrozen roundtrip", () => {
    const f = toFrozenValidationCycle(cycle({ draftVersion: 7 }))
    assert.equal(f.validatedDraftVersion, 7)
    const parsed = parseFrozenValidationCycle({
      validationCycle: f,
    })
    assert.deepEqual(parsed, f)
  })

  it("effective flags env ∩ partner", () => {
    assert.deepEqual(
      computeEffectiveAutoFlags({
        partnerAutoApprove: true,
        partnerAutoConvert: true,
        globalAutoApprove: true,
        globalAutoConvert: false,
      }),
      {
        effectiveAutoApproveEnabled: true,
        effectiveAutoConvertEnabled: false,
      }
    )
    assert.deepEqual(
      computeEffectiveAutoFlags({
        partnerAutoApprove: false,
        partnerAutoConvert: true,
        globalAutoApprove: true,
        globalAutoConvert: true,
      }),
      {
        effectiveAutoApproveEnabled: false,
        effectiveAutoConvertEnabled: true,
      }
    )
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3E worker integration (mocked)", () => {
  function makeJournal() {
    const entries: DecisionJournalEntry[] = []
    const byKey = new Map<string, number>()
    return {
      entries,
      async append(e: DecisionJournalEntry) {
        entries.push(e)
        if (e.idempotencyKey?.trim()) {
          byKey.set(e.idempotencyKey.trim(), entries.length - 1)
        }
      },
      async appendOnce(e: DecisionJournalEntry) {
        const key = e.idempotencyKey?.trim()
        if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED")
        const existingIdx = byKey.get(key)
        if (existingIdx != null) {
          const prev = entries[existingIdx]!
          return {
            outcome: "ALREADY_EXISTS" as const,
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
        entries.push(e)
        const idx = entries.length - 1
        byKey.set(key, idx)
        const cur = entries[idx]!
        return {
          outcome: "APPENDED" as const,
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
      async findLatestValidationDecisionForCycle(input: {
        companyId: string
        draftId: string
        cycle: ValidationCycleIdentity
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          if (!String(e.decisionCode).startsWith("VALIDATION_")) continue
          const m = e.metadata ?? {}
          if (
            m.contentHash === input.cycle.contentHash &&
            m.extractionSchemaVersion === input.cycle.extractionSchemaVersion &&
            m.draftVersion === input.cycle.draftVersion
          ) {
            return {
              id: `v${i}`,
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
      async findLatestAutoIntentForCycle(input: {
        companyId: string
        draftId: string
        frozen: FrozenValidationCycle
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          const code = e.decisionCode
          if (
            code !== "AUTO_APPROVE_ONLY" &&
            code !== "AUTO_APPROVE_CONVERT" &&
            code !== "AUTO_REJECT_CANCELLED" &&
            code !== "HUMAN_REVIEW_REQUIRED"
          ) {
            continue
          }
          const f = parseFrozenValidationCycle(e.metadata)
          if (
            f &&
            f.contentHash === input.frozen.contentHash &&
            f.extractionSchemaVersion === input.frozen.extractionSchemaVersion &&
            f.validatedDraftVersion === input.frozen.validatedDraftVersion
          ) {
            return {
              id: `i${i}`,
              companyId: e.companyId,
              draftId: e.draftId,
              decisionCode: code as AutoDecisionIntentCode,
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
      async findLatestCancellationFollowUpForCycle(input: {
        companyId: string
        draftId: string
        frozen: FrozenValidationCycle
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          if (!String(e.decisionCode).startsWith("CANCELLATION_")) continue
          const f = parseFrozenValidationCycle(e.metadata)
          if (
            f &&
            f.contentHash === input.frozen.contentHash &&
            f.validatedDraftVersion === input.frozen.validatedDraftVersion
          ) {
            return {
              id: `f${i}`,
              companyId: e.companyId,
              draftId: e.draftId,
              decisionCode: e.decisionCode,
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
      async findLatestSystemActorInvalidForCycle() {
        return null
      },
      async findLatestAutoRejectIntentAny(input: {
        companyId: string
        draftId: string
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          if (e.decisionCode !== "AUTO_REJECT_CANCELLED") continue
          if (!parseFrozenValidationCycle(e.metadata)) continue
          return {
            id: `r${i}`,
            companyId: e.companyId,
            draftId: e.draftId,
            decisionCode: "AUTO_REJECT_CANCELLED" as const,
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

  function makeSelection(
    rows: AutoDecisionWorkerCandidate[]
  ): AutoDecisionWorkerSelectionPort {
    return {
      async listEligibleCandidates(input) {
        return rows.slice(0, input.limit)
      },
    }
  }

  function passDraft(status = "PENDING_REVIEW", version = 7) {
    return {
      id: "d1",
      companyId: "co1",
      status,
      version,
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      proposedWorksiteName: "Chantier Galya Hall A",
      proposedClientName: "Client Expo",
      proposedAddress: "12 rue de la Foire",
      proposedPostalCode: "69002",
      proposedCity: "Lyon",
      proposedStartDate: new Date("2026-09-10T00:00:00.000Z"),
      proposedEndDate: new Date("2026-09-12T00:00:00.000Z"),
      proposedClientId: "cli1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: {
        requestClassification: "CONSULTATION",
        clientEmail: "c@expo.fr",
        consultationReference: "R1",
      },
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "expo.fr",
        threadId: "th-1",
      },
    }
  }

  it("PASS → AUTO_APPROVE_CONVERT → APPROVED, jamais CONVERTED ; zero convert calls", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: ["THRESHOLDS_OK"],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })

    const draft = passDraft()
    let convertCalls = 0
    let approveCalls = 0

    const result = await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: makeSelection([
        {
          draftId: "d1",
          companyId: "co1",
          status: "PENDING_REVIEW",
          version: 7,
          contentHashAtExtraction: "hash-1",
          extractionSchemaVersion: "2",
          updatedAt: new Date(),
          selectionPath: "PASS",
        },
      ]),
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => true,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          approveCalls++
          draft.status = "APPROVED"
          draft.version = 8
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => {
          throw new Error("should not reject")
        },
      } as never,
      evaluationDeps: {
        db: {
          worksiteImportDraft: {
            findFirst: async () => draft,
          },
        } as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "cli1",
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
            clientId: "cli1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: {
        worksiteImportDraft: {
          findFirst: async () => draft,
        },
      } as never,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(approveCalls, 1)
    assert.equal(convertCalls, 0)
    assert.equal(draft.status, "APPROVED")
    assert.notEqual(String(draft.status), "CONVERTED")
    const intent = journal.entries.find((e) =>
      String(e.decisionCode).startsWith("AUTO_APPROVE")
    )
    assert.ok(intent)
    assert.equal(intent!.decisionCode, "AUTO_APPROVE_CONVERT")
    const f = parseFrozenValidationCycle(intent!.metadata)
    assert.equal(f?.validatedDraftVersion, 7)
  })

  it("HUMAN → intent once ; rerun no spam", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft()
    // Force human via partner autoApprove false
    const deps = {
      journal: journal as never,
      selection: makeSelection([
        {
          draftId: "d1",
          companyId: "co1",
          status: "PENDING_REVIEW",
          version: 7,
          contentHashAtExtraction: "hash-1",
          extractionSchemaVersion: "2",
          updatedAt: new Date(),
          selectionPath: "PASS" as const,
        },
      ]),
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => false,
      resolveSystemActor: async () =>
        ({
          ok: true as const,
          userId: "sys1",
          role: "ADMIN" as const,
        }) as const,
      review: {
        approveImportDraft: async () => {
          throw new Error("no approve")
        },
        rejectImportDraft: async () => {
          throw new Error("no reject")
        },
      } as never,
      evaluationDeps: {
        db: {
          worksiteImportDraft: { findFirst: async () => draft },
        } as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "cli1",
          matchKind: "EMAIL" as const,
        }),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            autoApproveEnabled: false,
            autoConvertEnabled: false,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: null,
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    }

    await runAcquisitionAutoDecisionWorker(deps as never)
    await runAcquisitionAutoDecisionWorker(deps as never)
    const humans = journal.entries.filter(
      (e) => e.decisionCode === "HUMAN_REVIEW_REQUIRED"
    )
    assert.equal(humans.length, 1)
    assert.equal(draft.status, "PENDING_REVIEW")
  })

  it("lease stolen immediately before approve → aucune mutation", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    // Pre-seed intent so we go to NEEDS_APPROVE quickly
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "AUTO_APPROVE_ONLY",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        pipeline: "POST_EXTRACTION_STEPS",
        validationCycle: frozen(),
      },
    })
    const draft = passDraft()
    let approveCalls = 0
    let ownershipChecks = 0

    const result = await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: makeSelection([
        {
          draftId: "d1",
          companyId: "co1",
          status: "PENDING_REVIEW",
          version: 7,
          contentHashAtExtraction: "hash-1",
          extractionSchemaVersion: "2",
          updatedAt: new Date(),
          selectionPath: "PASS",
        },
      ]),
      isAutoApproveEnabled: () => true,
      ensureOwnership: async () => {
        ownershipChecks++
        // Fail on last fence before approve (after context)
        return ownershipChecks < 4 ? "OWNED" : "NOT_OWNED"
      },
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
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: {
        db: {
          worksiteImportDraft: { findFirst: async () => draft },
        } as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({
          clientId: "cli1",
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
            clientId: "cli1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })

    assert.equal(approveCalls, 0)
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.equal(result.skipReason, "LEASE_STOLEN")
  })

  it("worker source: zero conversion imports métier", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.equal(/ImportDraftConversionService/.test(src), false)
    assert.equal(/convertImportDraft/.test(src), false)
    // Port fence générique autorisé ; pas le service conversion.
    assert.equal(
      /from ["']@\/lib\/acquisition\/conversion\/(?!conversion-ownership-fence\.port)/.test(
        src
      ),
      false
    )
    assert.equal(/approveImportDraft/.test(src), true)
    assert.equal(/rejectImportDraft/.test(src), true)
    assert.equal(/applyCancellationFollowUpTransactionally/.test(src), true)
    assert.equal(
      /applyCancellationFollowUp\b/.test(src.replace(/applyCancellationFollowUpTransactionally/g, "")),
      false
    )
  })
})

describe("PLAN-ACQ-AGENTS-LOT-3E CORRECTION-1", () => {
  it("cancel SQL exact — pas de LIKE substring ; @> jsonb + errorCode", () => {
    const sql = cancelProofSql()
    const text = sql.sql
    assert.equal(/LIKE/.test(text), false)
    assert.equal(/errorCode/.test(text), true)
    assert.equal(/@>/.test(text), true)
    assert.ok(
      sql.values.some(
        (v) =>
          typeof v === "string" && v.includes("CONSULTATION_CANCELLED")
      )
    )
    // runtime parity : faux substring
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: ["NOT_CONSULTATION_CANCELLED_OTHER"],
        metadata: {},
      }),
      false
    )
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: ["CONSULTATION_CANCELLED"],
        metadata: {},
      }),
      true
    )
    assert.equal(
      isConsultationCancelledTerminal({
        decisionCode: "VALIDATION_FAIL_TERMINAL",
        reasons: [],
        metadata: { errorCode: "CONSULTATION_CANCELLED" },
      }),
      true
    )
  })

  it("fairness : tenant après limite lexico n’est pas masqué si candidat plus ancien", () => {
    const rows: AutoDecisionWorkerCandidate[] = []
    // tenants t01..t30 — t26 a l’updatedAt le plus ancien
    for (let i = 1; i <= 30; i++) {
      const id = `t${String(i).padStart(2, "0")}`
      rows.push({
        draftId: `d-${id}`,
        companyId: id,
        status: "PENDING_REVIEW",
        version: 1,
        contentHashAtExtraction: `h-${id}`,
        extractionSchemaVersion: "2",
        updatedAt:
          i === 26
            ? new Date("2026-01-01T00:00:00.000Z")
            : new Date(`2026-01-02T00:00:${String(i).padStart(2, "0")}.000Z`),
        selectionPath: "PASS",
      })
    }
    const picked = rankAutoDecisionCandidatesFairness(rows, {
      maxPerCompany: 1,
      limit: 25,
    })
    assert.equal(picked.length, 25)
    assert.ok(picked.some((p) => p.companyId === "t26"))
    // Pas d’ordre purement lexico companyId : le plus ancien est premier
    assert.equal(picked[0]!.companyId, "t26")
    // Source SQL n’utilise plus DISTINCT companyId ORDER BY companyId LIMIT
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.equal(/ROW_NUMBER\(\)/.test(src), true)
    assert.equal(/PARTITION BY e\."companyId"/.test(src), true)
    assert.equal(
      /SELECT DISTINCT q\."companyId"[\s\S]*ORDER BY q\."companyId" ASC\s*LIMIT/.test(
        src
      ),
      false
    )
  })

  it("maxPerCompany respecté", () => {
    const rows: AutoDecisionWorkerCandidate[] = []
    for (let i = 0; i < 10; i++) {
      rows.push({
        draftId: `a-${i}`,
        companyId: "tenant-A",
        status: "PENDING_REVIEW",
        version: 1,
        contentHashAtExtraction: `ha-${i}`,
        extractionSchemaVersion: "2",
        updatedAt: new Date(`2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`),
        selectionPath: "PASS",
      })
    }
    rows.push({
      draftId: "b-0",
      companyId: "tenant-B",
      status: "PENDING_REVIEW",
      version: 1,
      contentHashAtExtraction: "hb",
      extractionSchemaVersion: "2",
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      selectionPath: "PASS",
    })
    const picked = rankAutoDecisionCandidatesFairness(rows, {
      maxPerCompany: 2,
      limit: 10,
    })
    assert.equal(picked.filter((p) => p.companyId === "tenant-A").length, 2)
    assert.ok(picked.some((p) => p.companyId === "tenant-B"))
  })

  function makeJournal() {
    const entries: DecisionJournalEntry[] = []
    const byKey = new Map<string, number>()
    return {
      entries,
      async append(e: DecisionJournalEntry) {
        entries.push(e)
        if (e.idempotencyKey?.trim()) {
          byKey.set(e.idempotencyKey.trim(), entries.length - 1)
        }
      },
      async appendOnce(e: DecisionJournalEntry) {
        const key = e.idempotencyKey?.trim()
        if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED")
        const existingIdx = byKey.get(key)
        if (existingIdx != null) {
          const prev = entries[existingIdx]!
          return {
            outcome: "ALREADY_EXISTS" as const,
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
        entries.push(e)
        const idx = entries.length - 1
        byKey.set(key, idx)
        const cur = entries[idx]!
        return {
          outcome: "APPENDED" as const,
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
      async findLatestValidationDecisionForCycle(input: {
        companyId: string
        draftId: string
        cycle: ValidationCycleIdentity
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          if (!String(e.decisionCode).startsWith("VALIDATION_")) continue
          const m = e.metadata ?? {}
          if (
            m.contentHash === input.cycle.contentHash &&
            m.extractionSchemaVersion === input.cycle.extractionSchemaVersion &&
            m.draftVersion === input.cycle.draftVersion
          ) {
            return {
              id: `v${i}`,
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
      async findLatestAutoIntentForCycle(input: {
        companyId: string
        draftId: string
        frozen: FrozenValidationCycle
      }) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]!
          if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
          const code = e.decisionCode
          if (
            code !== "AUTO_APPROVE_ONLY" &&
            code !== "AUTO_APPROVE_CONVERT" &&
            code !== "AUTO_REJECT_CANCELLED" &&
            code !== "HUMAN_REVIEW_REQUIRED"
          ) {
            continue
          }
          const f = parseFrozenValidationCycle(e.metadata)
          if (
            f &&
            f.contentHash === input.frozen.contentHash &&
            f.extractionSchemaVersion === input.frozen.extractionSchemaVersion &&
            f.validatedDraftVersion === input.frozen.validatedDraftVersion
          ) {
            return {
              id: `i${i}`,
              companyId: e.companyId,
              draftId: e.draftId,
              decisionCode: code as AutoDecisionIntentCode,
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
  }

  function passDraft(version = 7) {
    return {
      id: "d1",
      companyId: "co1",
      status: "PENDING_REVIEW",
      version,
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      proposedWorksiteName: "Chantier Galya Hall A",
      proposedClientName: "Client Expo",
      proposedAddress: "12 rue de la Foire",
      proposedPostalCode: "69002",
      proposedCity: "Lyon",
      proposedStartDate: new Date("2026-09-10T00:00:00.000Z"),
      proposedEndDate: new Date("2026-09-12T00:00:00.000Z"),
      proposedClientId: "cli1",
      confidenceData: {
        worksiteName: 0.95,
        requestedStartDate: 0.95,
        requestedEndDate: 0.95,
      },
      warningData: [],
      extractedData: {
        requestClassification: "CONSULTATION",
        clientEmail: "c@expo.fr",
      },
      acquisitionMessage: {
        resolvedPartnerId: "p1",
        senderDomain: "expo.fr",
        threadId: "th-1",
      },
    }
  }

  function baseEval(draft: ReturnType<typeof passDraft>) {
    return {
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
      findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
      matchClient: async () => ({
        clientId: "cli1",
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
          clientId: "cli1",
          requireExactEmail: false,
        }),
        findPartnerByDomain: async () => null,
      } as never,
    }
  }

  it("PASS v7 + draft reste v7 → intent créé", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
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
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => false,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async (_a: unknown, raw: { expectedVersion: number }) => {
          assert.equal(raw.expectedVersion, 7)
          draft.status = "APPROVED"
          draft.version = 8
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: baseEval(draft),
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })
    assert.equal(result.stats.intentAppended, 1)
    assert.ok(journal.entries.some((e) => e.decisionCode === "AUTO_APPROVE_ONLY"))
    assert.equal(draft.status, "APPROVED")
  })

  it("PASS v7 + draft v8 avant append → stale, aucun intent", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let n = 0
    const load = async () => {
      n++
      // 1=processCandidate, 2=context, 3=final recheck before intent
      if (n >= 3) return { ...draft, version: 8 }
      return { ...draft, version: 7 }
    }
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
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          throw new Error("no approve")
        },
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: {
        ...baseEval(draft),
        db: {
          worksiteImportDraft: { findFirst: load },
        } as never,
      },
      db: {
        worksiteImportDraft: { findFirst: load },
      } as never,
    })
    assert.equal(result.stats.stale >= 1, true)
    assert.equal(
      journal.entries.filter((e) => String(e.decisionCode).startsWith("AUTO_"))
        .length,
      0
    )
  })

  it("contentHash change avant append → aucun intent", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let n = 0
    const load = async () => {
      n++
      if (n >= 3) return { ...draft, contentHashAtExtraction: "hash-changed" }
      return { ...draft }
    }
    await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
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
        ...baseEval(draft),
        db: { worksiteImportDraft: { findFirst: load } } as never,
      },
      db: { worksiteImportDraft: { findFirst: load } } as never,
    })
    assert.equal(
      journal.entries.some((e) => String(e.decisionCode).startsWith("AUTO_")),
      false
    )
  })

  it("extractionSchemaVersion change avant append → aucun intent", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let n = 0
    const load = async () => {
      n++
      if (n >= 3) return { ...draft, extractionSchemaVersion: "99" }
      return { ...draft }
    }
    await runAcquisitionAutoDecisionWorker({
      journal: journal as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
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
        ...baseEval(draft),
        db: { worksiteImportDraft: { findFirst: load } } as never,
      },
      db: { worksiteImportDraft: { findFirst: load } } as never,
    })
    assert.equal(
      journal.entries.some((e) => String(e.decisionCode).startsWith("AUTO_")),
      false
    )
  })

  it("lease perdu immédiatement avant intent append → aucun intent", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let ownership = 0
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
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      ensureOwnership: async () => {
        ownership++
        // Fail on fence immediately before append (6e check typique)
        return ownership < 6 ? "OWNED" : "NOT_OWNED"
      },
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
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
      evaluationDeps: baseEval(draft),
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })
    assert.equal(
      journal.entries.some((e) => String(e.decisionCode).startsWith("AUTO_")),
      false
    )
    assert.equal(result.skipReason, "LEASE_STOLEN")
  })

  it("race : intent créé entre policy et race-check → pas de second intent", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let intentLookups = 0
    const base = makeJournal()
    // Share entries with wrapper that injects race
    const journalRace = {
      ...base,
      entries: journal.entries,
      append: journal.append.bind(journal),
      findLatestValidationDecisionForCycle:
        journal.findLatestValidationDecisionForCycle.bind(journal),
      findLatestAutoIntentForCycle: async (input: {
        companyId: string
        draftId: string
        frozen: FrozenValidationCycle
      }) => {
        intentLookups++
        // First lookup (state machine) empty; before append inject rival intent
        if (intentLookups === 2) {
          await journal.append({
            companyId: "co1",
            draftId: "d1",
            decisionCode: "AUTO_APPROVE_ONLY",
            reasons: ["RACE"],
            scores: {},
            actorUserId: null,
            metadata: {
              pipeline: "POST_EXTRACTION_STEPS",
              validationCycle: frozen(),
            },
          })
        }
        return journal.findLatestAutoIntentForCycle(input)
      },
      findLatestCancellationFollowUpForCycle:
        journal.findLatestCancellationFollowUpForCycle.bind(journal),
      findLatestSystemActorInvalidForCycle:
        journal.findLatestSystemActorInvalidForCycle.bind(journal),
      findLatestAutoRejectIntentAny:
        journal.findLatestAutoRejectIntentAny.bind(journal),
    }

    await runAcquisitionAutoDecisionWorker({
      journal: journalRace as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          draft.status = "APPROVED"
          draft.version = 8
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => ({ ok: false }),
      } as never,
      evaluationDeps: baseEval(draft),
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })

    const intents = journal.entries.filter((e) =>
      String(e.decisionCode).startsWith("AUTO_APPROVE")
    )
    assert.equal(intents.length, 1)
    assert.deepEqual(intents[0]!.reasons, ["RACE"])
  })

  it("R1 — local HUMAN + winner DB AUTO_APPROVE_CONVERT → chemin AUTO", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let approveCalls = 0
    const journalLoser = {
      ...journal,
      findLatestAutoIntentForCycle: async () => null,
      async appendOnce(e: DecisionJournalEntry) {
        assert.equal(e.decisionCode, "HUMAN_REVIEW_REQUIRED")
        return {
          outcome: "ALREADY_EXISTS" as const,
          row: {
            id: "db-win-convert",
            companyId: e.companyId,
            draftId: e.draftId,
            decisionCode: "AUTO_APPROVE_CONVERT",
            reasons: ["DB_WINNER"],
            scores: {},
            actorUserId: "sys1",
            metadata: {
              pipeline: "POST_EXTRACTION_STEPS",
              validationCycle: frozen(),
            },
            createdAt: new Date(),
          },
        }
      },
    }

    const result = await runAcquisitionAutoDecisionWorker({
      journal: journalLoser as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => true,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          approveCalls++
          draft.status = "APPROVED"
          draft.version = 8
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 8 }
        },
        rejectImportDraft: async () => {
          throw new Error("should not reject")
        },
      } as never,
      evaluationDeps: {
        ...baseEval(draft),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            // Local evaluate → HUMAN ; winner DB = CONVERT
            autoApproveEnabled: false,
            autoConvertEnabled: false,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "cli1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })

    assert.equal(result.stats.human, 0)
    assert.equal(approveCalls, 1)
    assert.equal(draft.status, "APPROVED")
  })

  it("R1 — local AUTO_APPROVE_CONVERT + winner DB HUMAN → chemin HUMAN", async () => {
    const journal = makeJournal()
    await journal.append({
      companyId: "co1",
      draftId: "d1",
      decisionCode: "VALIDATION_PASS",
      reasons: [],
      scores: {},
      actorUserId: null,
      metadata: {
        contentHash: "hash-1",
        extractionSchemaVersion: "2",
        draftVersion: 7,
      },
    })
    const draft = passDraft(7)
    let approveCalls = 0
    const journalLoser = {
      ...journal,
      findLatestAutoIntentForCycle: async () => null,
      async appendOnce(e: DecisionJournalEntry) {
        assert.equal(e.decisionCode, "AUTO_APPROVE_CONVERT")
        return {
          outcome: "ALREADY_EXISTS" as const,
          row: {
            id: "db-win-human",
            companyId: e.companyId,
            draftId: e.draftId,
            decisionCode: "HUMAN_REVIEW_REQUIRED",
            reasons: ["DB_WINNER_HUMAN"],
            scores: {},
            actorUserId: null,
            metadata: {
              pipeline: "POST_EXTRACTION_STEPS",
              validationCycle: frozen(),
            },
            createdAt: new Date(),
          },
        }
      },
    }

    const result = await runAcquisitionAutoDecisionWorker({
      journal: journalLoser as never,
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: "d1",
              companyId: "co1",
              status: "PENDING_REVIEW",
              version: 7,
              contentHashAtExtraction: "hash-1",
              extractionSchemaVersion: "2",
              updatedAt: new Date(),
              selectionPath: "PASS",
            },
          ]
        },
      },
      isAutoApproveEnabled: () => true,
      isAutoConvertEnabled: () => true,
      resolveSystemActor: async () => ({
        ok: true,
        userId: "sys1",
        role: "ADMIN",
      }),
      review: {
        approveImportDraft: async () => {
          approveCalls++
          throw new Error("should not approve on HUMAN winner")
        },
        rejectImportDraft: async () => {
          throw new Error("should not reject")
        },
      } as never,
      evaluationDeps: {
        ...baseEval(draft),
        registry: {
          findPartnerById: async () => ({
            id: "p1",
            code: "P",
            active: true,
            autoApproveEnabled: true,
            autoConvertEnabled: true,
            allowCreateClient: false,
            minConfidence: 0.75,
            clientId: "cli1",
            requireExactEmail: false,
          }),
          findPartnerByDomain: async () => null,
        } as never,
      },
      db: {
        worksiteImportDraft: { findFirst: async () => draft },
      } as never,
    })

    assert.equal(result.stats.human, 1)
    assert.equal(approveCalls, 0)
    assert.equal(draft.status, "PENDING_REVIEW")
  })

  it("R1 — après election winner, aucune branche ne relit decision.code pour la SM", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.equal(
      src.includes('decision.code === "HUMAN_REVIEW_REQUIRED"'),
      false
    )
    assert.match(
      src,
      /intent\.decisionCode === "HUMAN_REVIEW_REQUIRED"/
    )
    // decision.code ne doit apparaître que comme payload d'écriture locale
    const payloadOnly = src.match(/decisionCode:\s*decision\.code/g) ?? []
    assert.equal(payloadOnly.length, 1)
  })
})
