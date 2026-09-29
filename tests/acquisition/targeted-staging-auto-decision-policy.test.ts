/**
 * Override de politique TARGET-ONLY — preuves RUNTIME via le worker auto-decision réel
 * (dépendances mockées, aucune DB réelle). Global env OFF + partner OFF dans tous les cas.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  computeEffectiveAutoFlags,
  runAcquisitionAutoDecisionWorker,
  type AutoDecisionEffectiveFlagsInput,
  type AutoDecisionEffectiveFlagsResolver,
  type AutoDecisionWorkerCandidate,
  type AutoDecisionWorkerDeps,
  type AutoDecisionWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import {
  parseFrozenValidationCycle,
  type AutoDecisionIntentCode,
  type DecisionJournalEntry,
  type FrozenValidationCycle,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import {
  TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED,
  buildTargetedAutoDecisionWorkerDeps,
  resolveTargetedAutoDecisionEffectiveFlags,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"

const COMPANY = "co1"
const DRAFT = "d1"

// ---------------------------------------------------------------------------
// Env process : globaux auto OFF, cible harness pilotée par test ; restauration stricte.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ACQUISITION_AUTO_APPROVE_ENABLED",
  "ACQUISITION_AUTO_CONVERT_ENABLED",
  "ACQUISITION_SYSTEM_ACTOR_USER_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function setTargetEnv(companyId: string | undefined, draftId: string | undefined) {
  if (companyId === undefined) delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID
  else process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = companyId
  if (draftId === undefined) delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
  else process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = draftId
}

/** Snapshot des flags globaux (env) — doit être identique avant/après chaque run. */
function globalFlagsSnapshot() {
  return {
    approve: process.env.ACQUISITION_AUTO_APPROVE_ENABLED,
    convert: process.env.ACQUISITION_AUTO_CONVERT_ENABLED,
  }
}

// ---------------------------------------------------------------------------
// Fakes (mêmes contrats que tests/acquisition/acquisition-auto-decision.worker.test.ts)
// ---------------------------------------------------------------------------

function makeJournal() {
  const entries: DecisionJournalEntry[] = []
  const byKey = new Map<string, number>()
  const row = (i: number) => {
    const e = entries[i]!
    return {
      id: `j${i}`,
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
  return {
    entries,
    async append(e: DecisionJournalEntry) {
      entries.push(e)
      if (e.idempotencyKey?.trim()) byKey.set(e.idempotencyKey.trim(), entries.length - 1)
    },
    async appendOnce(e: DecisionJournalEntry) {
      const key = e.idempotencyKey?.trim()
      if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED")
      const existing = byKey.get(key)
      if (existing != null) return { outcome: "ALREADY_EXISTS" as const, row: row(existing) }
      entries.push(e)
      byKey.set(key, entries.length - 1)
      return { outcome: "APPENDED" as const, row: row(entries.length - 1) }
    },
    async findLatestValidationDecisionForCycle(input: { companyId: string; draftId: string; cycle: ValidationCycleIdentity }) {
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
          return { ...row(i), decisionCode: e.decisionCode as ValidationJournalRow["decisionCode"] }
        }
      }
      return null
    },
    async findLatestAutoIntentForCycle(input: { companyId: string; draftId: string; frozen: FrozenValidationCycle }) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        if (e.companyId !== input.companyId || e.draftId !== input.draftId) continue
        if (!["AUTO_APPROVE_ONLY", "AUTO_APPROVE_CONVERT", "AUTO_REJECT_CANCELLED", "HUMAN_REVIEW_REQUIRED"].includes(e.decisionCode)) {
          continue
        }
        const f = parseFrozenValidationCycle(e.metadata)
        if (
          f &&
          f.contentHash === input.frozen.contentHash &&
          f.extractionSchemaVersion === input.frozen.extractionSchemaVersion &&
          f.validatedDraftVersion === input.frozen.validatedDraftVersion
        ) {
          return { ...row(i), decisionCode: e.decisionCode as AutoDecisionIntentCode }
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

type Journal = ReturnType<typeof makeJournal>

function passDraft() {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 7,
    contentHashAtExtraction: "hash-1",
    extractionSchemaVersion: "2",
    detectionClassification: "CONSULTATION",
    detectionContentHash: "hash-1",
    acquisitionMessageId: "msg1",
    proposedWorksiteName: "Chantier Galya Hall A",
    proposedClientName: "Client Expo",
    proposedAddress: "12 rue de la Foire",
    proposedPostalCode: "69002",
    proposedCity: "Lyon",
    proposedStartDate: new Date("2026-10-10T00:00:00.000Z"),
    proposedEndDate: new Date("2026-10-12T00:00:00.000Z"),
    proposedClientId: "cli1",
    confidenceData: { worksiteName: 0.95, requestedStartDate: 0.95, requestedEndDate: 0.95 },
    warningData: [],
    extractedData: { requestClassification: "CONSULTATION", clientEmail: "c@expo.fr", consultationReference: "R1" },
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: "expo.fr", threadId: "th-1" },
  }
}

type Draft = ReturnType<typeof passDraft>

/** DB mockée : toute lecture comptée ; append intent via journal ; aucune écriture partner possible. */
function makeDb(draft: Draft, journal: Journal, reads: string[]) {
  const api = {
    worksiteImportDraft: {
      findFirst: async () => {
        reads.push("worksiteImportDraft.findFirst")
        return draft
      },
    },
    acquisitionMessageContent: {
      findFirst: async () => {
        reads.push("acquisitionMessageContent.findFirst")
        return { contentHash: draft.contentHashAtExtraction }
      },
    },
    $queryRaw: async () => {
      reads.push("$queryRaw")
      return [{ contentHash: draft.contentHashAtExtraction }]
    },
    acquisitionDecisionJournal: {
      findUnique: async (args: { where: { idempotencyKey: string } }) => {
        reads.push("acquisitionDecisionJournal.findUnique")
        const i = journal.entries.findIndex((e) => e.idempotencyKey === args.where.idempotencyKey)
        return i < 0 ? null : { ...journal.entries[i], id: `j${i}`, createdAt: new Date() }
      },
      create: async (args: { data: DecisionJournalEntry }) => {
        const r = await journal.appendOnce(args.data)
        return { ...r.row, idempotencyKey: args.data.idempotencyKey }
      },
    },
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      return fn(api as never)
    },
  }
  return api
}

/** Partner DB : flags OFF, objet gelé → toute écriture/falsification lève. */
function frozenPartner() {
  return Object.freeze({
    id: "p1",
    code: "P",
    active: true,
    autoApproveEnabled: false,
    autoConvertEnabled: false,
    allowCreateClient: false,
    minConfidence: 0.75,
    clientId: "cli1",
    requireExactEmail: false,
  })
}

const FENCE: TransactionalOwnershipFence = { assertOwnedAndLock: async () => "OWNED" }

function candidate(over: Partial<AutoDecisionWorkerCandidate> = {}): AutoDecisionWorkerCandidate {
  return {
    draftId: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 7,
    contentHashAtExtraction: "hash-1",
    extractionSchemaVersion: "2",
    updatedAt: new Date(),
    selectionPath: "PASS",
    ...over,
  }
}

async function scenario(opts: {
  /** "production" = aucun resolver ; "targeted" = deps construites par buildTargetedAutoDecisionWorkerDeps. */
  mode: "production" | "targeted"
  resolver?: AutoDecisionEffectiveFlagsResolver
  candidates?: AutoDecisionWorkerCandidate[]
  globalApprove?: boolean
}) {
  const journal = makeJournal()
  await journal.append({
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode: "VALIDATION_PASS",
    reasons: ["THRESHOLDS_OK"],
    scores: {},
    actorUserId: null,
    metadata: { contentHash: "hash-1", extractionSchemaVersion: "2", draftVersion: 7 },
  })
  const baseEntries = journal.entries.length
  const draft = passDraft()
  const reads: string[] = []
  const db = makeDb(draft, journal, reads)
  const partner = frozenPartner()
  const partnerBefore = JSON.stringify(partner)
  const globalsBefore = globalFlagsSnapshot()
  let listCalls = 0
  let approveCalls = 0
  const selection: AutoDecisionWorkerSelectionPort = {
    async listEligibleCandidates(input) {
      listCalls++
      return (opts.candidates ?? [candidate()]).slice(0, input.limit)
    },
  }
  const common: Partial<AutoDecisionWorkerDeps> = {
    journal: journal as never,
    db: db as never,
    resolveSystemActor: async () => ({ ok: true, userId: "sys1", role: "ADMIN" }),
    review: {
      approveImportDraft: async () => {
        approveCalls++
        draft.status = "APPROVED"
        draft.version = 8
        return { ok: true, outcome: "APPROVED", draftId: DRAFT, version: 8 }
      },
      rejectImportDraft: async () => {
        throw new Error("no reject")
      },
    } as never,
    evaluationDeps: {
      db: db as never,
      findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
      matchClient: async () => ({ clientId: "cli1", matchKind: "EMAIL" as const }),
      registry: { findPartnerById: async () => partner, findPartnerByDomain: async () => null } as never,
    },
    log: () => {},
  }
  if (opts.globalApprove) process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
  const deps: AutoDecisionWorkerDeps =
    opts.mode === "targeted"
      ? {
          ...common,
          ...buildTargetedAutoDecisionWorkerDeps({
            selection,
            ensureOwnership: async () => "OWNED",
            transactionalOwnershipFence: FENCE,
          }),
          ...(opts.resolver ? { resolveEffectiveAutoFlags: opts.resolver } : {}),
        }
      : {
          ...common,
          selection,
          ...(opts.resolver ? { resolveEffectiveAutoFlags: opts.resolver } : {}),
        }
  const globalsDuring = globalFlagsSnapshot()
  const result = await runAcquisitionAutoDecisionWorker(deps)
  // K — aucun flag global ni partner écrit / modifié.
  assert.deepEqual(globalFlagsSnapshot(), globalsDuring)
  if (!opts.globalApprove) assert.deepEqual(globalFlagsSnapshot(), globalsBefore)
  assert.equal(JSON.stringify(partner), partnerBefore)
  assert.equal(partner.autoApproveEnabled, false)
  assert.equal(partner.autoConvertEnabled, false)
  const written = journal.entries.slice(baseEntries)
  return { result, written, reads, listCalls, approveCalls, draft }
}

// ===========================================================================

describe("A/B. chemin production (aucun resolver) inchangé", () => {
  it("B. global OFF + partner OFF → SKIPPED AUTO_APPROVE_DISABLED, aucune sélection / lecture / écriture", async () => {
    const out = await scenario({ mode: "production" })
    assert.equal(out.result.status, "SKIPPED")
    assert.equal(out.result.skipReason, "AUTO_APPROVE_DISABLED")
    assert.equal(out.listCalls, 0)
    assert.deepEqual(out.reads, [])
    assert.deepEqual(out.written, [])
    assert.equal(out.approveCalls, 0)
  })

  it("A. global ON + partner OFF → HUMAN_REVIEW_REQUIRED (computeEffectiveAutoFlags)", async () => {
    const out = await scenario({ mode: "production", globalApprove: true })
    assert.equal(out.result.status, "SUCCESS")
    assert.deepEqual(
      out.written.map((e) => e.decisionCode),
      ["HUMAN_REVIEW_REQUIRED"]
    )
    assert.equal(out.approveCalls, 0)
    assert.equal(out.draft.status, "PENDING_REVIEW")
  })

  it("A. computeEffectiveAutoFlags inchangé (env ∩ partner)", () => {
    for (const [pa, pc, ga, gc] of [
      [false, false, false, false],
      [false, false, true, true],
      [true, true, false, false],
      [true, true, true, true],
      [true, false, true, true],
    ] as const) {
      assert.deepEqual(
        computeEffectiveAutoFlags({ partnerAutoApprove: pa, partnerAutoConvert: pc, globalAutoApprove: ga, globalAutoConvert: gc }),
        { effectiveAutoApproveEnabled: pa && ga, effectiveAutoConvertEnabled: pc && gc }
      )
    }
  })

  it("A. production ne reçoit jamais le resolver ciblé (deps par défaut sans resolveEffectiveAutoFlags)", async () => {
    const out = await scenario({ mode: "production", globalApprove: true })
    assert.ok(!out.written.some((e) => String(e.decisionCode).startsWith("AUTO_APPROVE")))
  })
})

describe("C. cible exacte → approve + convert effectifs (runtime, global OFF, partner OFF)", () => {
  it("resolver : exacte → { true, true }, quelles que soient les entrées partner/global", () => {
    setTargetEnv(COMPANY, DRAFT)
    for (const flags of [
      { partnerAutoApprove: false, partnerAutoConvert: false, globalAutoApprove: false, globalAutoConvert: false },
      { partnerAutoApprove: true, partnerAutoConvert: true, globalAutoApprove: true, globalAutoConvert: true },
    ]) {
      assert.deepEqual(resolveTargetedAutoDecisionEffectiveFlags({ companyId: COMPANY, draftId: DRAFT, ...flags }), {
        effectiveAutoApproveEnabled: true,
        effectiveAutoConvertEnabled: true,
      })
    }
  })

  it("worker réel via deps ciblées : intent AUTO_APPROVE_CONVERT puis approbation (mock review)", async () => {
    setTargetEnv(COMPANY, DRAFT)
    const out = await scenario({ mode: "targeted" })
    assert.equal(out.result.status, "SUCCESS", JSON.stringify(out.result))
    assert.deepEqual(
      out.written.map((e) => e.decisionCode),
      ["AUTO_APPROVE_CONVERT"]
    )
    assert.equal(out.approveCalls, 1)
    assert.equal(parseFrozenValidationCycle(out.written[0]!.metadata)?.validatedDraftVersion, 7)
  })

  it("les deps ciblées portent exactement le resolver fixe (non paramétrable)", () => {
    const deps = buildTargetedAutoDecisionWorkerDeps({
      selection: { listEligibleCandidates: async () => [] },
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: FENCE,
    })
    assert.equal(deps.resolveEffectiveAutoFlags, resolveTargetedAutoDecisionEffectiveFlags)
    assert.equal(resolveTargetedAutoDecisionEffectiveFlags.length, 1)
  })
})

describe("D-G. toute autre cible → fail-closed (aucune lecture, aucune écriture)", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["D. mauvais companyId", "co-other", DRAFT],
    ["E. mauvais draftId", COMPANY, "d-other"],
    ["F. env absentes", undefined, undefined],
    ["F. env company absente", undefined, DRAFT],
    ["F. env draft absente", COMPANY, undefined],
    ["F. env vides", "", ""],
    ["F. env blanches", "   ", "   "],
    ["G. casse companyId", COMPANY.toUpperCase(), DRAFT],
    ["G. casse draftId", COMPANY, DRAFT.toUpperCase()],
    ["G. cible inversée", DRAFT, COMPANY],
  ]
  for (const [label, envCompany, envDraft] of cases) {
    it(`${label} → resolver null ; worker : candidat ignoré, zéro lecture / écriture`, async () => {
      setTargetEnv(envCompany, envDraft)
      assert.equal(
        resolveTargetedAutoDecisionEffectiveFlags({
          companyId: COMPANY,
          draftId: DRAFT,
          partnerAutoApprove: true,
          partnerAutoConvert: true,
          globalAutoApprove: true,
          globalAutoConvert: true,
        }),
        null
      )
      const out = await scenario({ mode: "targeted" })
      assert.deepEqual(out.written, [])
      assert.deepEqual(out.reads, [])
      assert.equal(out.approveCalls, 0)
      assert.equal(out.result.stats.skipped, 1)
      assert.equal(out.result.stats.intentAppended, 0)
    })
  }

  it("G. espaces autour de la cible candidate → fail-closed (égalité exacte)", async () => {
    setTargetEnv(COMPANY, DRAFT)
    for (const target of [
      { companyId: ` ${COMPANY}`, draftId: DRAFT },
      { companyId: COMPANY, draftId: `${DRAFT} ` },
      { companyId: DRAFT, draftId: COMPANY },
    ]) {
      assert.equal(
        resolveTargetedAutoDecisionEffectiveFlags({
          ...target,
          partnerAutoApprove: false,
          partnerAutoConvert: false,
          globalAutoApprove: false,
          globalAutoConvert: false,
        }),
        null
      )
    }
  })

  it("défense en profondeur : selector (fautif) livrant un autre draft → ignoré sans écriture", async () => {
    setTargetEnv(COMPANY, DRAFT)
    const out = await scenario({
      mode: "targeted",
      candidates: [candidate({ draftId: "d-other" })],
    })
    assert.deepEqual(out.written, [])
    assert.deepEqual(out.reads, [])
    assert.equal(out.result.stats.skipped, 1)
  })

  it("resolver qui lève / forme invalide → fail-closed, aucune écriture", async () => {
    setTargetEnv(COMPANY, DRAFT)
    const bad: AutoDecisionEffectiveFlagsResolver[] = [
      () => {
        throw new Error("boom")
      },
      () => ({ effectiveAutoApproveEnabled: "true", effectiveAutoConvertEnabled: true }) as never,
      () => ({}) as never,
      () => undefined as never,
    ]
    for (const resolver of bad) {
      const out = await scenario({ mode: "targeted", resolver })
      assert.deepEqual(out.written, [])
      assert.deepEqual(out.reads, [])
      assert.equal(out.approveCalls, 0)
      // Skip contrôlé (contrat null), pas une exception remontée.
      assert.equal(out.result.stats.skipped, 1)
      assert.equal(out.result.stats.errors, 0)
    }
  })

  it("resolver appelé avec companyId / draftId / partner / global réels du candidat", async () => {
    setTargetEnv(COMPANY, DRAFT)
    const seen: AutoDecisionEffectiveFlagsInput[] = []
    const out = await scenario({
      mode: "targeted",
      resolver: (input) => {
        seen.push(input)
        return resolveTargetedAutoDecisionEffectiveFlags(input)
      },
    })
    assert.equal(out.approveCalls, 1)
    // 1er appel = autorisation pré-lecture ; 2e = calcul des flags avec partner réel (OFF).
    assert.deepEqual(seen.at(-1), {
      companyId: COMPANY,
      draftId: DRAFT,
      partnerAutoApprove: false,
      partnerAutoConvert: false,
      globalAutoApprove: false,
      globalAutoConvert: false,
    })
  })
})

describe("H/I. bornes et hard-stop", () => {
  it("H. deps ciblées bornées à 1 : un seul candidat traité même si la sélection en propose 3", async () => {
    setTargetEnv(COMPANY, DRAFT)
    const out = await scenario({ mode: "targeted", candidates: [candidate(), candidate(), candidate()] })
    assert.equal(out.result.stats.selected, 1)
    assert.equal(out.approveCalls, 1)
  })

  it("I. état armé (armement explicite) : l'override reste target-only (cf. D-G)", () => {
    assert.equal(TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED, true)
  })
})
