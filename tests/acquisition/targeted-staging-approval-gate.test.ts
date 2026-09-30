/**
 * Exemption TARGET-ONLY du master gate d'approbation (PLANIFICATOR_ACQUISITION_ENABLED).
 * VRAI ImportDraftReviewService + VRAI worker auto-decision ; DB en mémoire (aucune connexion).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  runAcquisitionAutoDecisionWorker,
  type AutoDecisionWorkerDeps,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import {
  buildTargetedAutoDecisionWorkerDeps,
  targetedApprovalMasterGateExemption,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"
import {
  buildAutoIntentIdempotencyKey,
  parseFrozenValidationCycle,
  type AutoDecisionIntentCode,
  type DecisionJournalEntry,
  type FrozenValidationCycle,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import type { ApprovalMasterGateExemption, ReviewActorContext } from "@/lib/acquisition/review/import-draft-review.types"

const COMPANY = "co1"
const DRAFT = "d1"
const HASH = "hash-1"

const ENV_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_AUTO_APPROVE_ENABLED",
  "ACQUISITION_AUTO_CONVERT_ENABLED",
  "ACQUISITION_CONVERSION_ENABLED",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  // Cible serveur autorisée par défaut ; master + globaux OFF.
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function flagsSnapshot() {
  return Object.fromEntries(ENV_KEYS.slice(0, 4).map((k) => [k, process.env[k]]))
}

// ---------------------------------------------------------------------------
// DB en mémoire : draft unique, contenu source, journal ; toute opération enregistrée ;
// tout modèle inconnu (Worksite, Client, …) → erreur explicite.
// ---------------------------------------------------------------------------

type Draft = Record<string, unknown> & { id: string; companyId: string; status: string; version: number }

function makeDraft(over: Partial<Draft> = {}): Draft {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 7,
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: "2",
    detectionClassification: "CONSULTATION",
    detectionContentHash: HASH,
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
    ...over,
  }
}

function makeDb(draft: Draft, opts: { sourceHash?: string; journal?: Journal } = {}) {
  const ops: string[] = []
  const writes: string[] = []
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (draft as Record<string, unknown>)[k] === v)
  const api: Record<string, unknown> = {
    worksiteImportDraft: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        ops.push("worksiteImportDraft.findFirst")
        return matches({ id: args.where.id, companyId: args.where.companyId }) ? { ...draft } : null
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        ops.push("worksiteImportDraft.updateMany")
        writes.push("worksiteImportDraft.updateMany")
        if (!matches(args.where)) return { count: 0 }
        const data = { ...args.data }
        const inc = (data.version as { increment?: number } | undefined)?.increment
        if (inc) data.version = draft.version + inc
        Object.assign(draft, data)
        return { count: 1 }
      },
    },
    acquisitionMessageContent: {
      findFirst: async () => {
        ops.push("acquisitionMessageContent.findFirst")
        return { contentHash: opts.sourceHash ?? HASH }
      },
    },
    $queryRaw: async () => {
      ops.push("$queryRaw")
      return [{ contentHash: opts.sourceHash ?? HASH }]
    },
    acquisitionDecisionJournal: {
      findUnique: async (args: { where: { idempotencyKey: string } }) => {
        ops.push("acquisitionDecisionJournal.findUnique")
        const entries = opts.journal?.entries ?? []
        const i = entries.findIndex((e) => e.idempotencyKey === args.where.idempotencyKey)
        return i < 0 ? null : { ...entries[i], id: `j${i}`, createdAt: new Date() }
      },
      create: async (args: { data: DecisionJournalEntry }) => {
        ops.push("acquisitionDecisionJournal.create")
        writes.push("acquisitionDecisionJournal.create")
        const r = await opts.journal!.appendOnce(args.data)
        return { ...r.row, idempotencyKey: args.data.idempotencyKey }
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ops.push("$transaction")
      return fn(db)
    },
  }
  const db = new Proxy(api, {
    get(target, prop) {
      if (typeof prop === "string" && !(prop in target) && prop !== "then") {
        ops.push(`FORBIDDEN:${prop}`)
        writes.push(`FORBIDDEN:${prop}`)
        throw new Error(`UNEXPECTED_MODEL:${prop}`)
      }
      return target[prop as string]
    },
  })
  return { db, ops, writes }
}

const OWNED_FENCE: TransactionalOwnershipFence = { assertOwnedAndLock: async () => "OWNED" }
const NOT_OWNED_FENCE: TransactionalOwnershipFence = { assertOwnedAndLock: async () => "NOT_OWNED" }

const SYSTEM: ReviewActorContext = { actorUserId: "sys1", actorRole: "SYSTEM", companyId: COMPANY }
const ADMIN: ReviewActorContext = { actorUserId: "u1", actorRole: "ADMIN", companyId: COMPANY }
const INPUT = { draftId: DRAFT, expectedVersion: 7 }

async function approve(opts: {
  ctx?: ReviewActorContext
  input?: { draftId: string; expectedVersion: number }
  draft?: Draft
  fence?: TransactionalOwnershipFence | null
  exemption?: ApprovalMasterGateExemption | null
  sourceHash?: string
}) {
  const draft = opts.draft ?? makeDraft()
  const { db, ops, writes } = makeDb(draft, { sourceHash: opts.sourceHash })
  const svc = new ImportDraftReviewService({ db: db as never, log: () => {}, now: () => new Date("2026-09-30T08:00:00.000Z") })
  const fence = opts.fence === null ? undefined : (opts.fence ?? OWNED_FENCE)
  const exemption = opts.exemption === null ? undefined : (opts.exemption ?? targetedApprovalMasterGateExemption)
  const before = flagsSnapshot()
  const out = await svc.approveImportDraft(opts.ctx ?? SYSTEM, opts.input ?? INPUT, {
    ...(fence ? { transactionalOwnershipFence: fence } : {}),
    requireSourceContentHash: HASH,
    ...(exemption ? { approvalMasterGateExemption: exemption } : {}),
  })
  assert.deepEqual(flagsSnapshot(), before, "aucun flag global modifié")
  return { out, ops, writes, draft }
}

function code(out: { ok: boolean } & Record<string, unknown>) {
  return out.ok ? "OK" : (out.code as string)
}

// ===========================================================================

describe("review service réel — master gate", () => {
  it("A. master OFF + chemin normal (sans exemption, SYSTEM + fence) → ACQUISITION_DISABLED, zéro DB", async () => {
    const r = await approve({ exemption: null })
    assert.equal(code(r.out), "ACQUISITION_DISABLED")
    assert.deepEqual(r.ops, [])
  })

  it("A. master OFF + chemin UI (ADMIN, sans options) → ACQUISITION_DISABLED, zéro DB", async () => {
    const r = await approve({ ctx: ADMIN, fence: null, exemption: null })
    assert.equal(code(r.out), "ACQUISITION_DISABLED")
    assert.deepEqual(r.ops, [])
  })

  it("B. master OFF + cible exacte + SYSTEM + fence OWNED → gate franchi, approbation réelle (status/version)", async () => {
    const r = await approve({})
    assert.equal(code(r.out), "OK", JSON.stringify(r.out))
    assert.equal(r.draft.status, "APPROVED")
    assert.equal(r.draft.version, 8)
    assert.deepEqual(r.writes, ["worksiteImportDraft.updateMany"])
    // Fence + fraîcheur source vérifiés dans la TX avant la mutation.
    assert.equal(r.ops[0], "$transaction")
    assert.ok(r.ops.indexOf("$queryRaw") < r.ops.indexOf("worksiteImportDraft.updateMany"))
  })

  const refusals: Array<[string, () => void, Parameters<typeof approve>[0]]> = [
    ["C. mauvais companyId (tenant acteur)", () => {}, { ctx: { ...SYSTEM, companyId: "co-other" } }],
    ["D. mauvais draftId", () => {}, { input: { draftId: "d-other", expectedVersion: 7 } }],
    ["E. env company absente", () => delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID, {}],
    ["E. env company vide", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = "  "), {}],
    ["F. env draft absente", () => delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID, {}],
    ["F. env draft vide", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = ""), {}],
    ["casse différente", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT.toUpperCase()), {}],
    ["cible inversée", () => {
      process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = DRAFT
      process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = COMPANY
    }, {}],
    ["G. acteur ADMIN (non SYSTEM)", () => {}, { ctx: ADMIN }],
    ["G. acteur SUPER_ADMIN (non SYSTEM)", () => {}, { ctx: { ...ADMIN, actorRole: "SUPER_ADMIN" } }],
    ["H. fence absent", () => {}, { fence: null }],
    ["entrée invalide", () => {}, { input: { draftId: "", expectedVersion: 7 } }],
  ]
  for (const [label, setup, opts] of refusals) {
    it(`${label} → ACQUISITION_DISABLED, zéro lecture / écriture`, async () => {
      setup()
      const r = await approve(opts)
      assert.equal(code(r.out), "ACQUISITION_DISABLED")
      assert.deepEqual(r.ops, [])
      assert.equal(r.draft.status, "PENDING_REVIEW")
    })
  }

  it("G. service : acteur non SYSTEM refusé même si le port répond toujours true (défense indépendante)", async () => {
    const alwaysTrue: ApprovalMasterGateExemption = { allowsApproval: () => true }
    for (const ctx of [ADMIN, { ...ADMIN, actorRole: "SUPER_ADMIN" as const }]) {
      const r = await approve({ ctx, exemption: alwaysTrue })
      assert.equal(code(r.out), "ACQUISITION_DISABLED")
      assert.deepEqual(r.ops, [])
    }
    // Contrôle positif : même port, acteur SYSTEM → franchi.
    assert.equal(code((await approve({ exemption: alwaysTrue })).out), "OK")
  })

  it("G. implémentation ciblée : refuse tout rôle non SYSTEM même sur la cible exacte (défense indépendante)", () => {
    for (const actorRole of ["ADMIN", "SUPER_ADMIN", "USER", "system", ""]) {
      assert.equal(
        targetedApprovalMasterGateExemption.allowsApproval({ companyId: COMPANY, draftId: DRAFT, actorRole: actorRole as never }),
        false,
        actorRole
      )
    }
    assert.equal(
      targetedApprovalMasterGateExemption.allowsApproval({ companyId: COMPANY, draftId: DRAFT, actorRole: "SYSTEM" }),
      true
    )
  })

  it("H. fence NOT_OWNED (contrat réel : lease orchestrateur) → LEASE_NOT_OWNED, aucune écriture", async () => {
    const r = await approve({ fence: NOT_OWNED_FENCE })
    assert.equal(code(r.out), "LEASE_NOT_OWNED")
    assert.deepEqual(r.writes, [])
    assert.equal(r.draft.status, "PENDING_REVIEW")
  })

  it("port qui lève / retourne une valeur non booléenne vraie → ACQUISITION_DISABLED", async () => {
    for (const exemption of [
      { allowsApproval: () => { throw new Error("boom") } },
      { allowsApproval: () => "true" as unknown as boolean },
      { allowsApproval: () => 1 as unknown as boolean },
    ]) {
      const r = await approve({ exemption })
      assert.equal(code(r.out), "ACQUISITION_DISABLED")
      assert.deepEqual(r.ops, [])
    }
  })

  it("l'exemption ne lève QUE le master gate : autres contrôles toujours appliqués", async () => {
    const cases: Array<[string, Parameters<typeof approve>[0], string]> = [
      ["version obsolète", { input: { draftId: DRAFT, expectedVersion: 6 } }, "STATE_CHANGED"],
      ["statut APPROVED", { draft: makeDraft({ status: "APPROVED" }) }, "INVALID_STATE"],
      ["statut REJECTED", { draft: makeDraft({ status: "REJECTED" }) }, "INVALID_STATE"],
      ["nom manquant", { draft: makeDraft({ proposedWorksiteName: " " }) }, "MISSING_WORKSITE_NAME"],
      ["fin sans début", { draft: makeDraft({ proposedStartDate: null }) }, "MISSING_DATES"],
      [
        "plage inversée",
        { draft: makeDraft({ proposedStartDate: new Date("2026-10-12T00:00:00.000Z"), proposedEndDate: new Date("2026-10-10T00:00:00.000Z") }) },
        "DATE_RANGE_INVALID",
      ],
      [
        "période obsolète",
        { draft: makeDraft({ proposedStartDate: new Date("2026-01-01T00:00:00.000Z"), proposedEndDate: new Date("2026-01-02T00:00:00.000Z") }) },
        "WORK_PERIOD_OBSOLETE",
      ],
      ["warnings bloquants", { draft: makeDraft({ warningData: [{ code: "X", blocking: true }] }) }, "BLOCKING_WARNINGS"],
      ["source modifiée", { sourceHash: "hash-new" }, "SOURCE_CONTENT_STALE"],
      ["draft introuvable (gate franchi, fraîcheur refuse)", { draft: makeDraft({ id: "zz" }) }, "SOURCE_CONTENT_STALE"],
    ]
    for (const [label, opts, expected] of cases) {
      const r = await approve(opts)
      assert.equal(code(r.out), expected, label)
      assert.deepEqual(r.writes, [], `${label} : aucune écriture`)
    }
  })

  it("I. master ON + chemin normal → comportement historique inchangé ; exemption jamais consultée", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    let consulted = 0
    const spy: ApprovalMasterGateExemption = {
      allowsApproval: () => {
        consulted++
        return false
      },
    }
    const system = await approve({ exemption: null })
    assert.equal(code(system.out), "OK")
    const admin = await approve({ ctx: ADMIN, fence: null, exemption: null })
    assert.equal(code(admin.out), "OK")
    const withSpy = await approve({ exemption: spy })
    assert.equal(code(withSpy.out), "OK")
    assert.equal(consulted, 0)
    // Master ON : cible non autorisée approuvée comme avant (exemption hors sujet).
    delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    assert.equal(code((await approve({ exemption: null })).out), "OK")
  })

  it("master ON : SYSTEM sans fence → LEASE_NOT_OWNED (historique)", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const r = await approve({ fence: null, exemption: null })
    assert.equal(code(r.out), "LEASE_NOT_OWNED")
    assert.deepEqual(r.ops, [])
  })
})

// ===========================================================================
// Worker réel + review réel (master OFF) : reprise de l'intention existante.
// ===========================================================================

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
      const key = e.idempotencyKey!.trim()
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
        if (!["AUTO_APPROVE_ONLY", "AUTO_APPROVE_CONVERT", "AUTO_REJECT_CANCELLED", "HUMAN_REVIEW_REQUIRED"].includes(e.decisionCode)) continue
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

const FROZEN: FrozenValidationCycle = { contentHash: HASH, extractionSchemaVersion: "2", validatedDraftVersion: 7 }

async function workerScenario(opts: { exemption: "targeted" | "none" }) {
  const journal = makeJournal()
  await journal.append({
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode: "VALIDATION_PASS",
    reasons: ["THRESHOLDS_OK"],
    scores: {},
    actorUserId: null,
    metadata: { contentHash: HASH, extractionSchemaVersion: "2", draftVersion: 7 },
  })
  // Intention déjà persistée par le RUN réel (même cycle figé, même clé d'idempotence).
  await journal.append({
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode: "AUTO_APPROVE_CONVERT",
    reasons: [],
    scores: {},
    actorUserId: "sys1",
    idempotencyKey: buildAutoIntentIdempotencyKey({ companyId: COMPANY, draftId: DRAFT, frozen: FROZEN }),
    metadata: { pipeline: "POST_EXTRACTION_STEPS", validationCycle: { ...FROZEN } },
  })
  const journalBefore = journal.entries.length
  const draft = makeDraft()
  const { db, ops, writes } = makeDb(draft, { journal })
  const partner = Object.freeze({
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
  const targeted = buildTargetedAutoDecisionWorkerDeps({
    selection: {
      async listEligibleCandidates(input) {
        return [
          {
            draftId: DRAFT,
            companyId: COMPANY,
            status: "PENDING_REVIEW",
            version: 7,
            contentHashAtExtraction: HASH,
            extractionSchemaVersion: "2",
            updatedAt: new Date(),
            selectionPath: "PASS" as const,
          },
        ].slice(0, input.limit)
      },
    },
    ensureOwnership: async () => "OWNED",
    transactionalOwnershipFence: OWNED_FENCE,
  })
  if (opts.exemption === "none") delete (targeted as Partial<AutoDecisionWorkerDeps>).approvalMasterGateExemption
  const before = flagsSnapshot()
  const result = await runAcquisitionAutoDecisionWorker({
    ...targeted,
    journal: journal as never,
    db: db as never,
    // Service de revue RÉEL (même DB en mémoire) ; system actor résolu OK comme en staging.
    review: new ImportDraftReviewService({ db: db as never, log: () => {}, now: () => new Date("2026-09-30T08:00:00.000Z") }),
    resolveSystemActor: async () => ({ ok: true, userId: "sys1", role: "ADMIN" }),
    evaluationDeps: {
      db: db as never,
      findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
      matchClient: async () => ({ clientId: "cli1", matchKind: "EMAIL" as const }),
      registry: { findPartnerById: async () => partner, findPartnerByDomain: async () => null } as never,
    },
    log: () => {},
  })
  assert.deepEqual(flagsSnapshot(), before)
  assert.equal(partner.autoApproveEnabled, false)
  assert.equal(partner.autoConvertEnabled, false)
  return { result, journal, journalBefore, draft, ops, writes }
}

describe("worker réel + review réel, master OFF — reprise de l'intention AUTO_APPROVE_CONVERT existante", () => {
  it("reproduction staging : sans exemption → intention réutilisée, approbation refusée (approved=0)", async () => {
    const s = await workerScenario({ exemption: "none" })
    assert.equal(s.result.status, "SUCCESS")
    assert.equal(s.result.stats.intentAppended, 0)
    assert.equal(s.result.stats.approved, 0)
    assert.equal(s.draft.status, "PENDING_REVIEW")
    assert.deepEqual(s.writes, [])
  })

  it("J. deps ciblées → intentAppended=0, NEEDS_APPROVE, approbation réelle réussie", async () => {
    const s = await workerScenario({ exemption: "targeted" })
    assert.equal(s.result.status, "SUCCESS", JSON.stringify(s.result))
    assert.equal(s.result.stats.intentAppended, 0)
    assert.equal(s.result.stats.approved, 1)
    assert.equal(s.journal.entries.length, s.journalBefore, "aucune nouvelle entrée journal")
    assert.equal(s.journal.entries.filter((e) => e.decisionCode === "AUTO_APPROVE_CONVERT").length, 1)
    assert.equal(s.draft.status, "APPROVED")
    assert.equal(s.draft.version, 8)
  })

  it("K. aucune conversion / création chantier ou client : seule écriture = updateMany du draft", async () => {
    const s = await workerScenario({ exemption: "targeted" })
    assert.deepEqual(s.writes, ["worksiteImportDraft.updateMany"])
    assert.ok(!s.ops.some((o) => o.startsWith("FORBIDDEN:")), JSON.stringify(s.ops))
    assert.notEqual(s.draft.status, "CONVERTED")
    assert.equal(s.draft.createdWorksiteId, undefined)
  })

  it("L. mauvaise cible serveur → aucune lecture ni mutation métier", async () => {
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = "d-other"
    const s = await workerScenario({ exemption: "targeted" })
    assert.deepEqual(s.ops, [])
    assert.deepEqual(s.writes, [])
    assert.equal(s.result.stats.approved, 0)
    assert.equal(s.result.stats.intentAppended, 0)
    assert.equal(s.draft.status, "PENDING_REVIEW")
  })
})
