process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { Prisma } from "@prisma/client"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { runAcquisitionValidationWorker } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"
import {
  TARGETED_STAGING_VALIDATION_RECORD_CHECK_CONFIRMATION,
  TARGETED_STAGING_VALIDATION_RECORD_CONFIRMATION,
  buildTargetedValidationPassEntry,
  handleTargetedStagingValidationRecord,
  type TargetedValidationRecordDeps,
} from "@/lib/acquisition/orchestrator/targeted-staging-validation-record.handler"
import {
  buildValidationDecisionIdempotencyKey,
  parseValidationCycleIdentity,
  validationCyclesMatch,
  type DecisionJournalEntry,
  type ValidationCycleIdentity,
} from "@/lib/acquisition/policy/decision-journal.repository"

const COMPANY = "co-validation-record"
const DRAFT = "draft-validation-record"
const HASH = "hash-record-1"
const CHECK = TARGETED_STAGING_VALIDATION_RECORD_CHECK_CONFIRMATION
const RECORD = TARGETED_STAGING_VALIDATION_RECORD_CONFIRMATION
const BEFORE_PERIOD = new Date("2026-09-05T00:00:00.000Z")
const HANDLER_PATH = "src/lib/acquisition/orchestrator/targeted-staging-validation-record.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-validation-record/route.ts"

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_VALIDATION_RECORD_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

// Ne doit jamais apparaître dans une réponse (hash, champs extraits, confiance, journal, lease).
const SENSITIVE = [
  HASH,
  "12 rue de la Foire",
  "Lyon",
  "69002",
  "client@expo.fr",
  "Client Expo",
  "Chantier Galya Hall A",
  "0.95",
  "snapshot",
  "confidence",
  "evidence",
  "v1:validation",
  "journal-row-",
  "run-active",
]

type Row = Record<string, unknown>

function draftRow(over: Row = {}): Row {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 5,
    proposedWorksiteName: "Chantier Galya Hall A",
    proposedClientName: "Client Expo",
    proposedAddress: "12 rue de la Foire",
    proposedPostalCode: "69002",
    proposedCity: "Lyon",
    proposedStartDate: new Date("2026-09-10T00:00:00.000Z"),
    proposedEndDate: new Date("2026-09-12T00:00:00.000Z"),
    proposedClientId: null,
    confidenceData: { worksiteName: 0.95, requestedStartDate: 0.95, requestedEndDate: 0.95 },
    warningData: [],
    extractedData: {
      requestClassification: "CONSULTATION",
      clientEmail: "client@expo.fr",
      consultationReference: "REF-001",
    },
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: "3",
    detectionClassification: "CONSULTATION_UPDATE",
    detectionContentHash: HASH,
    createdWorksiteId: null,
    updatedAt: new Date("2026-09-04T00:00:00.000Z"),
    acquisitionMessage: { resolvedPartnerId: null, senderDomain: null, threadId: null },
    ...over,
  }
}

const CYCLE: ValidationCycleIdentity = { contentHash: HASH, extractionSchemaVersion: "3", draftVersion: 5 }
const ATTEMPT_ONE_KEY = buildValidationDecisionIdempotencyKey({
  companyId: COMPANY,
  draftId: DRAFT,
  cycle: CYCLE,
  validationAttempt: 1,
})

let rowSeq = 0
function markerRow(
  decisionCode: string,
  opts: { cycle?: ValidationCycleIdentity; attempt?: number; meta?: Row } = {}
): Row {
  rowSeq += 1
  const cycle = opts.cycle ?? CYCLE
  const attempt = opts.attempt ?? 1
  return {
    id: `journal-row-${rowSeq}`,
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode,
    reasons: [],
    scores: {},
    actorUserId: null,
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      contentHash: cycle.contentHash,
      extractionSchemaVersion: cycle.extractionSchemaVersion,
      draftVersion: cycle.draftVersion,
      attempt,
      ...opts.meta,
    },
    createdAt: new Date(Date.UTC(2026, 8, 4, 0, 0, rowSeq)),
    idempotencyKey: buildValidationDecisionIdempotencyKey({
      companyId: COMPANY,
      draftId: DRAFT,
      cycle,
      validationAttempt: attempt,
    }),
  }
}

type Lease = { key: string; ownerRunId: string | null; leaseExpiresAt: Date | null; acquiredAt: Date | null }

type State = {
  draft: Row
  rows: Row[]
  lease: Lease | null
  dbCalls: string[]
  txOps: string[]
  txOptions: unknown[]
  txStarted: number
  commits: number
  leaseInserts: Array<{ sql: string; values: unknown[] }>
  lockQueries: Array<{ table: "lease" | "draft"; sql: string; strings: readonly string[]; values: unknown[] }>
  appendAttempts: DecisionJournalEntry[]
  contextClients: unknown[]
}

type Hooks = {
  /** Au verrou de la lease (peut jeter un conflit de sérialisation). */
  onLeaseLock?: (s: State) => void
  /** Avant le verrou du draft (écriture concurrente committée). */
  beforeLock?: (s: State) => void
  /** Juste après le verrou du draft (visible par les lectures tx suivantes : contexte). */
  afterLock?: (s: State) => void
  /** Au moment de l'append (peut jeter ou insérer une ligne concurrente). */
  onAppend?: (s: State) => void
  /** COMMIT rejeté sans être appliqué (rejet après fin du callback). */
  commitFails?: boolean
  /** COMMIT appliqué mais acquittement perdu (rejet après fin du callback). */
  commitAckLost?: boolean
  afterCommit?: (s: State) => void
  postCommitReadThrows?: boolean
  reconcileThrows?: boolean
  /** Juste avant la lecture de réconciliation (écriture concurrente du même slot). */
  beforeReconcile?: (s: State) => void
}

function acquireFree(lease: Lease): boolean {
  // Prédicat « libre » de AcquisitionOrchestratorLeaseRepository.acquire (orchestrateur réel).
  return (
    lease.ownerRunId === null ||
    (lease.leaseExpiresAt !== null && lease.leaseExpiresAt.getTime() < Date.now())
  )
}

/** Monde en mémoire : tx sérialisées (verrous), écritures bufferisées (rollback sur throw), lease transactionnelle. */
function world(opts: { draft?: Row; journal?: Row[]; lease?: Lease | null; hooks?: Hooks } = {}) {
  const hooks = opts.hooks ?? {}
  const state: State = {
    draft: draftRow(opts.draft),
    rows: [...(opts.journal ?? [])],
    lease: opts.lease === undefined ? null : opts.lease,
    dbCalls: [],
    txOps: [],
    txOptions: [],
    txStarted: 0,
    commits: 0,
    leaseInserts: [],
    lockQueries: [],
    appendAttempts: [],
    contextClients: [],
  }
  let chain: Promise<unknown> = Promise.resolve()
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const p = chain.then(run, run)
    chain = p.catch(() => undefined)
    return p
  }

  function readDraft(args: { where?: Row; select?: Record<string, unknown> } = {}) {
    const where = args.where ?? {}
    const d = state.draft
    if (where.id !== d.id || where.companyId !== d.companyId) return null
    if (!args.select) return { ...d }
    return Object.fromEntries(Object.keys(args.select).map((k) => [k, d[k]]))
  }

  function modelProxy(prefix: string, onRead: () => void) {
    return new Proxy(
      {},
      {
        get(_t, model) {
          if (typeof model !== "string") return undefined
          return new Proxy(
            {},
            {
              get(_m, op) {
                if (typeof op !== "string") return undefined
                return async (args: { where?: Row; select?: Record<string, unknown> } = {}) => {
                  const key = `${prefix}${model}.${op}`
                  state.dbCalls.push(key)
                  if (`${model}.${op}` !== "worksiteImportDraft.findFirst") {
                    throw new Error(`FORBIDDEN_DB_CALL ${key}`)
                  }
                  onRead()
                  return readDraft(args)
                }
              },
            }
          )
        },
      }
    )
  }

  type TxBuffer = { rows: Row[]; lease: Lease | null | undefined }

  function txClient(buffer: TxBuffer) {
    const models = modelProxy("tx.", () => state.txOps.push("context.draftRead"))
    const currentLease = () => (buffer.lease !== undefined ? buffer.lease : state.lease)
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "__pending") return buffer.rows
          if (prop === "$executeRaw") {
            return async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const sql = strings.join("?")
              state.dbCalls.push("tx.$executeRaw")
              if (!/INSERT INTO "acquisition_orchestrator_leases"[\s\S]*ON CONFLICT \("key"\) DO NOTHING/.test(sql)) {
                throw new Error(`FORBIDDEN_RAW_WRITE ${sql}`)
              }
              state.txOps.push("lease.insert")
              state.leaseInserts.push({ sql, values })
              if (currentLease() == null) {
                buffer.lease = { key: String(values[0]), ownerRunId: null, leaseExpiresAt: null, acquiredAt: null }
                return 1
              }
              return 0
            }
          }
          if (prop === "$queryRaw") {
            return async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const sql = strings.join("?")
              state.dbCalls.push("tx.$queryRaw")
              if (sql.includes('"acquisition_orchestrator_leases"')) {
                state.txOps.push("lease.lock")
                hooks.onLeaseLock?.(state)
                state.lockQueries.push({ table: "lease", sql, strings: [...strings], values })
                const lease = currentLease()
                // Disponibilité dérivée du SQL réellement émis (expression reconnue strictement) :
                // une clause d'expiration réintroduite rendrait « libre » une lease possédée expirée ;
                // toute autre expression est refusée par le fake.
                const expr = (sql.match(/"key",([\s\S]*?)AS "available"/)?.[1] ?? "").replace(/\s+/g, " ").trim()
                let available: boolean
                if (expr === '("ownerRunId" IS NULL)') {
                  available = lease != null && lease.ownerRunId === null
                } else if (/"leaseExpiresAt"\s*<\s*clock_timestamp\(\)/.test(expr) && /"ownerRunId" IS NULL/.test(expr)) {
                  available = lease != null && acquireFree(lease)
                } else {
                  throw new Error(`FAKE_UNRECOGNIZED_LEASE_AVAILABILITY ${expr}`)
                }
                return lease && lease.key === values[0] ? [{ key: lease.key, available }] : []
              }
              state.txOps.push("draft.lock")
              hooks.beforeLock?.(state)
              state.lockQueries.push({ table: "draft", sql, strings: [...strings], values })
              const d = state.draft
              const result =
                values[0] === d.id && values[1] === d.companyId
                  ? [
                      {
                        id: d.id,
                        companyId: d.companyId,
                        status: d.status,
                        version: d.version,
                        contentHashAtExtraction: d.contentHashAtExtraction,
                        extractionSchemaVersion: d.extractionSchemaVersion,
                        createdWorksiteId: d.createdWorksiteId,
                      },
                    ]
                  : []
              hooks.afterLock?.(state)
              return result
            }
          }
          if (typeof prop === "string" && prop.startsWith("$")) {
            return async () => {
              state.dbCalls.push(`tx.${prop}`)
              throw new Error(`FORBIDDEN_DB_CALL tx.${prop}`)
            }
          }
          return (models as Record<string | symbol, unknown>)[prop]
        },
      }
    )
  }

  function commit(buffer: TxBuffer) {
    state.rows.push(...buffer.rows)
    if (buffer.lease !== undefined) state.lease = buffer.lease
    state.commits += 1
  }

  let committedOnce = false
  const rootModels = modelProxy("", () => {
    if (committedOnce && hooks.postCommitReadThrows) throw new Error("POST_COMMIT_READ_FAILED")
  })
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
            state.txOptions.push(options)
            return serialized(async () => {
              state.txStarted += 1
              state.dbCalls.push("$transaction")
              const buffer: TxBuffer = { rows: [], lease: undefined }
              const result = await fn(txClient(buffer))
              if (hooks.commitFails) throw new Error("COMMIT_FAILED")
              commit(buffer)
              committedOnce = true
              if (hooks.commitAckLost) throw new Error("COMMIT_ACK_LOST")
              hooks.afterCommit?.(state)
              return result
            })
          }
        }
        if (typeof prop === "string" && prop.startsWith("$")) {
          return async () => {
            state.dbCalls.push(prop)
            throw new Error(`FORBIDDEN_DB_CALL ${prop}`)
          }
        }
        return (rootModels as Record<string | symbol, unknown>)[prop]
      },
    }
  ) as never

  function isTx(client: unknown): boolean {
    return Array.isArray((client as { __pending?: unknown }).__pending)
  }

  function visibleRows(client: unknown): Row[] {
    const pending = (client as { __pending?: unknown }).__pending
    return Array.isArray(pending) ? [...state.rows, ...pending] : state.rows
  }

  const journalFor = (client: unknown) => ({
    async findLatestValidationDecisionForCycle(input: {
      companyId: string
      draftId: string
      cycle: ValidationCycleIdentity
    }) {
      if (isTx(client)) state.txOps.push("journal.findLatest")
      const match = visibleRows(client)
        .filter((r) => {
          if (r.companyId !== input.companyId || r.draftId !== input.draftId) return false
          if (!String(r.decisionCode).startsWith("VALIDATION_")) return false
          const c = parseValidationCycleIdentity(r.metadata)
          return c != null && validationCyclesMatch(c, input.cycle)
        })
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
      return (match[0] as never) ?? null
    },
    async findByIdempotencyKey(key: string) {
      state.dbCalls.push(isTx(client) ? "tx.journal.findByIdempotencyKey" : "journal.findByIdempotencyKey")
      if (!isTx(client)) hooks.beforeReconcile?.(state)
      if (!isTx(client) && hooks.reconcileThrows) throw new Error("RECONCILE_READ_FAILED")
      return (visibleRows(client).find((r) => r.idempotencyKey === key) as never) ?? null
    },
    async appendOnceInTransaction(entry: DecisionJournalEntry) {
      const pending = (client as { __pending?: unknown }).__pending
      if (!Array.isArray(pending)) throw new Error("FORBIDDEN_ROOT_APPEND")
      state.txOps.push("journal.append")
      state.appendAttempts.push(entry)
      hooks.onAppend?.(state)
      const existing = visibleRows(client).find((r) => r.idempotencyKey === entry.idempotencyKey)
      if (existing) return { outcome: "ALREADY_EXISTS" as const, row: existing as never }
      rowSeq += 1
      const row = { id: `journal-row-${rowSeq}`, ...entry, createdAt: new Date(Date.UTC(2026, 8, 5, 0, 0, rowSeq)) }
      pending.push(row)
      return { outcome: "APPENDED" as const, row: row as never }
    },
  })

  const evaluationDeps = {
    registry: {
      findPartnerById: async () => null,
      findPartnerByDomain: async () => null,
    } as never,
    findDuplicate: async (input: { db?: unknown }) => {
      state.contextClients.push(input.db)
      return { worksiteId: null, matchKind: "NONE" as const }
    },
    matchClient: async (input: { db?: unknown }) => {
      state.contextClients.push(input.db)
      return { clientId: "cli1", matchKind: "EMAIL" as const }
    },
  }

  /** Acquisition orchestrateur simulée (même protocole : INSERT idle + UPDATE si libre), sérialisée comme une vraie tx. */
  function orchestratorAcquire(runId: string, ttlMs = 60_000) {
    return serialized(async () => {
      if (state.lease == null) {
        state.lease = { key: ACQUISITION_ORCHESTRATOR_LEASE_KEY, ownerRunId: null, leaseExpiresAt: null, acquiredAt: null }
      }
      if (!acquireFree(state.lease)) return "ALREADY_RUNNING" as const
      state.lease = {
        ...state.lease,
        ownerRunId: runId,
        leaseExpiresAt: new Date(Date.now() + ttlMs),
        acquiredAt: new Date(),
      }
      // Ce que la sélection du worker verrait immédiatement après l'acquisition.
      const terminalPassVisible = state.rows.some(
        (r) => r.decisionCode === "VALIDATION_PASS" && r.idempotencyKey === ATTEMPT_ONE_KEY
      )
      return { outcome: "ACQUIRED" as const, terminalPassVisible }
    })
  }

  return { state, db, journalFor, evaluationDeps, isTx, orchestratorAcquire }
}

function sessionAuth(role = "ADMIN", companyId: string | null = COMPANY) {
  return async () => ({ user: { id: "u1", role, companyId } })
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/acquisition/targeted-staging-validation-record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

type World = ReturnType<typeof world>

function depsFor(w: World, over: Partial<TargetedValidationRecordDeps> = {}) {
  let nowCalls = 0
  const deps: TargetedValidationRecordDeps = {
    auth: sessionAuth(),
    env: PREVIEW_ENV,
    now: () => {
      nowCalls += 1
      return BEFORE_PERIOD
    },
    db: w.db,
    journalFor: w.journalFor as never,
    evaluationDeps: w.evaluationDeps as never,
    ...over,
  }
  return { deps, nowCalls: () => nowCalls }
}

async function call(w: World, confirmation: string = CHECK, extra: Row = {}, over: Partial<TargetedValidationRecordDeps> = {}) {
  const { deps, nowCalls } = depsFor(w, over)
  const res = await handleTargetedStagingValidationRecord(request({ confirmation, ...extra }), deps)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text), nowCalls: nowCalls() }
}

function passRows(w: World): Row[] {
  return w.state.rows.filter((r) => r.decisionCode === "VALIDATION_PASS")
}

function assertNoLeak(text: string) {
  for (const s of SENSITIVE) assert.ok(!text.includes(s), `response leaks ${s}`)
}

function assertReadOnly(w: World) {
  assert.equal(w.state.txStarted, 0, "transaction opened")
  assert.equal(w.state.lockQueries.length, 0, "lock taken")
  assert.equal(w.state.leaseInserts.length, 0, "lease touched")
  assert.equal(w.state.appendAttempts.length, 0, "append attempted")
  for (const c of w.state.dbCalls) assert.equal(c, "worksiteImportDraft.findFirst")
}

function assertAllAppendsAttemptOne(w: World) {
  for (const e of w.state.appendAttempts) {
    assert.equal(e.decisionCode, "VALIDATION_PASS")
    assert.equal((e.metadata as Row).attempt, 1)
  }
  for (const r of w.state.rows) assert.notEqual((r.metadata as Row).attempt, 2, "attempt-2 row")
}

function prismaKnownError(code: string, meta: Record<string, unknown> = {}) {
  return new Prisma.PrismaClientKnownRequestError("simulated", { code, clientVersion: "5.22.0", meta })
}

const IDLE_LEASE: Lease = { key: ACQUISITION_ORCHESTRATOR_LEASE_KEY, ownerRunId: null, leaseExpiresAt: null, acquiredAt: null }

describe("targeted validation record — surface / security", () => {
  it("refuses every guard failure before any read, transaction or write", async () => {
    const cases: Array<[string, Partial<TargetedValidationRecordDeps>, number, string]> = [
      ["non-preview", { env: { ...PREVIEW_ENV, VERCEL_ENV: "production" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
      ["wrong project", { env: { ...PREVIEW_ENV, VERCEL_PROJECT_ID: "prj_other" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
      ["flag off", { env: { ...PREVIEW_ENV, TARGETED_STAGING_VALIDATION_RECORD_ENABLED: "false" } }, 403, "HARNESS_DISABLED"],
      ["flag not exact", { env: { ...PREVIEW_ENV, TARGETED_STAGING_VALIDATION_RECORD_ENABLED: "TRUE" } }, 403, "HARNESS_DISABLED"],
      ["unauthenticated", { auth: async () => null }, 401, "UNAUTHORIZED"],
      ["non-admin", { auth: sessionAuth("TEAM_LEADER") }, 403, "FORBIDDEN"],
      ["tenant mismatch", { auth: sessionAuth("ADMIN", "other-company") }, 403, "TENANT_MISMATCH"],
      ["no session company", { auth: sessionAuth("ADMIN", null) }, 403, "TENANT_MISMATCH"],
      [
        "missing target env",
        { env: { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: " " } },
        403,
        "HARNESS_TARGET_UNSET",
      ],
      [
        "forbidden draft",
        { env: { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID } },
        403,
        "FORBIDDEN_DRAFT",
      ],
    ]
    for (const confirmation of [CHECK, RECORD]) {
      for (const [label, over, status, code] of cases) {
        const w = world()
        const r = await call(w, confirmation, {}, over)
        assert.equal(r.status, status, `${confirmation} / ${label}`)
        assert.equal(r.body.code, code, `${confirmation} / ${label}`)
        assert.deepEqual(w.state.dbCalls, [], `${confirmation} / ${label}`)
        assert.equal(r.nowCalls, 0)
      }
    }
  })

  it("refuses malformed JSON and wrong / legacy confirmations", async () => {
    const w = world()
    const { deps } = depsFor(w)
    const bad = await handleTargetedStagingValidationRecord(request("{not json"), deps)
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).code, "INVALID_BODY")
    for (const confirmation of [
      "",
      "WRONG",
      "CHECK_TARGETED_STAGING_VALIDATION_PREFLIGHT",
      "RUN_TARGETED_STAGING_VALIDATION",
      "RECORD_TARGETED_STAGING_VALIDATION_QUARANTINE",
      "check_targeted_staging_validation_record",
    ]) {
      const r = await call(w, confirmation)
      assert.equal(r.status, 400, confirmation)
      assert.equal(r.body.code, "CONFIRMATION_REQUIRED")
    }
    assert.deepEqual(w.state.dbCalls, [])
  })

  it("refuses target, clock, cycle, version, hash, schema and attempt overrides in the body", async () => {
    const keys = [
      "companyId", "company_id", "draftId", "draft_id",
      "referenceInstant", "reference_instant", "now",
      "cycle", "version", "draftVersion", "draft_version", "expectedVersion", "expected_version",
      "contentHash", "content_hash", "contentHashAtExtraction", "content_hash_at_extraction",
      "extractionSchemaVersion", "extraction_schema_version", "schemaVersion", "schema_version",
      "attempt",
    ]
    for (const confirmation of [CHECK, RECORD]) {
      for (const key of keys) {
        const w = world()
        const r = await call(w, confirmation, { [key]: "x" })
        assert.equal(r.status, 400, `${confirmation} / ${key}`)
        assert.equal(r.body.code, "REQUEST_OVERRIDE_FORBIDDEN", key)
        assert.deepEqual(w.state.dbCalls, [])
      }
    }
  })

  it("generic 500 without internal details when a pre-transaction read throws", async () => {
    const w = world()
    const throwing = new Proxy({}, {
      get: () => ({ findFirst: async () => { throw new Error("secret postgres://u:p@h/db") } }),
    }) as never
    const r = await call(w, CHECK, {}, { db: throwing })
    assert.equal(r.status, 500)
    assert.deepEqual(r.body, { ok: false, code: "VALIDATION_RECORD_FAILED", message: "Erreur interne" })
    assert.ok(!r.text.includes("postgres://"))
  })
})

describe("targeted validation record — CHECK (read-only, no transaction, no lock, no lease)", () => {
  it("P. PASS prediction on a clean current cycle → ready; zero transaction, lock, lease or write", async () => {
    const w = world()
    const r = await call(w, CHECK)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, {
      ok: true,
      mode: "CHECK",
      referenceInstant: BEFORE_PERIOD.toISOString(),
      ready: true,
      alreadyRecorded: false,
      cycle: { draftVersion: 5 },
      predictedValidation: { code: "PASS", decisionCode: "VALIDATION_PASS", reasons: ["THRESHOLDS_OK"] },
      existingDecisionCode: null,
      proof: {
        draftPendingReview: true,
        noCreatedWorksite: true,
        currentCyclePresent: true,
        contextMatchesCycle: true,
        noBlockingTerminalMarker: true,
        predictionIsPass: true,
        sameTenant: true,
      },
    })
    assertReadOnly(w)
    assert.equal(w.state.lease, null, "CHECK must never initialize the lease row")
    assert.equal(r.nowCalls, 1)
    assertNoLeak(r.text)
  })

  it("non-PASS prediction (AMBIGUOUS_ADDRESS) → not ready", async () => {
    const w = world({ draft: { proposedCity: null } })
    const r = await call(w, CHECK)
    assert.equal(r.body.ready, false)
    assert.equal(r.body.predictedValidation.decisionCode, "VALIDATION_QUARANTINE")
    assert.ok(r.body.predictedValidation.reasons.includes("AMBIGUOUS_ADDRESS"))
    assertReadOnly(w)
  })

  it("existing PASS → alreadyRecorded (not ready); QUARANTINE / terminal / retryable → blocked", async () => {
    const pass = world({ journal: [markerRow("VALIDATION_PASS")] })
    const rp = await call(pass, CHECK)
    assert.equal(rp.body.alreadyRecorded, true)
    assert.equal(rp.body.ready, false)
    assertReadOnly(pass)
    for (const code of ["VALIDATION_QUARANTINE", "VALIDATION_FAIL_TERMINAL", "VALIDATION_FAIL_RETRYABLE"]) {
      const w = world({ journal: [markerRow(code)] })
      const r = await call(w, CHECK)
      assert.equal(r.body.ready, false, code)
      assert.equal(r.body.alreadyRecorded, false, code)
      assert.equal(r.body.existingDecisionCode, code)
      assert.equal(r.body.proof.noBlockingTerminalMarker, false, code)
      assertReadOnly(w)
    }
  })

  it("markers of another cycle do not block the current one", async () => {
    const w = world({ journal: [markerRow("VALIDATION_QUARANTINE", { cycle: { ...CYCLE, draftVersion: 3 } })] })
    const r = await call(w, CHECK)
    assert.equal(r.body.ready, true)
    assert.equal(r.body.existingDecisionCode, null)
  })

  it("non-PENDING_REVIEW / no cycle / worksite present → blocked, read-only, no leak", async () => {
    const cases: Array<[Row, string]> = [
      [{ status: "APPROVED" }, "draftPendingReview"],
      [{ contentHashAtExtraction: null }, "currentCyclePresent"],
      [{ createdWorksiteId: "ws-1" }, "noCreatedWorksite"],
    ]
    for (const [draft, key] of cases) {
      const w = world({ draft })
      const r = await call(w, CHECK)
      assert.equal(r.body.ready, false, JSON.stringify(draft))
      assert.equal(r.body.proof[key], false, JSON.stringify(draft))
      assertReadOnly(w)
      assert.ok(!r.text.includes("ws-1"))
      assertNoLeak(r.text)
    }
  })
})

describe("targeted validation record — lease coordination (existing orchestrator protocol)", () => {
  it("3. idle-row INSERT is acquire's exact statement; availability is ONLY ownerRunId IS NULL (stricter than acquire)", () => {
    const handler = readFileSync(path.join(process.cwd(), HANDLER_PATH), "utf8")
    const repo = readFileSync(
      path.join(process.cwd(), "src/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository.ts"),
      "utf8"
    )
    const norm = (s: string) => s.replace(/\$\{[^}]+\}/g, "?").replace(/\s+/g, " ").trim()
    const insertRe = /INSERT INTO "acquisition_orchestrator_leases"[\s\S]*?ON CONFLICT \("key"\) DO NOTHING/
    const handlerInsert = handler.match(insertRe)?.[0]
    const repoInsert = repo.match(insertRe)?.[0]
    assert.ok(handlerInsert && repoInsert)
    assert.equal(norm(handlerInsert), norm(repoInsert), "idle-row INSERT must equal acquire's first statement")
    assert.match(norm(handlerInsert), /VALUES \( \?, NULL, NULL, NULL, clock_timestamp\(\) \)/)

    const freeRe = /"ownerRunId" IS NULL\s+OR \(\s+"leaseExpiresAt" IS NOT NULL\s+AND "leaseExpiresAt" < clock_timestamp\(\)\s+\)/
    assert.ok(freeRe.test(repo), "repository 'free' predicate drifted")
    assert.ok(!freeRe.test(handler), "handler must NOT reuse acquire's expiry-based 'free' predicate")
    assert.match(handler, /\("ownerRunId" IS NULL\) AS "available"/)
    assert.equal(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "acquisition-orchestrator")
    assert.match(handler, /\$\{ACQUISITION_ORCHESTRATOR_LEASE_KEY\}/)

    // La même clé canonique protège acquire (service) et le fence des appends de validation (workers).
    const service = readFileSync(path.join(process.cwd(), "src/lib/acquisition/orchestrator/acquisition-orchestrator.service.ts"), "utf8")
    const workers = readFileSync(path.join(process.cwd(), "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"), "utf8")
    assert.match(service, /leaseRepository\.acquire\(\{\s+key: ACQUISITION_ORCHESTRATOR_LEASE_KEY/)
    assert.match(workers, /leaseKey: ACQUISITION_ORCHESTRATOR_LEASE_KEY/)

    // Colonnes / défauts du modèle Prisma inchangés.
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8")
    const model = schema.match(/model AcquisitionOrchestratorLease \{[\s\S]*?\n\}/)?.[0] ?? ""
    for (const line of [
      /key\s+String\s+@id/,
      /ownerRunId\s+String\?/,
      /leaseExpiresAt\s+DateTime\?/,
      /acquiredAt\s+DateTime\?/,
      /updatedAt\s+DateTime\s+@updatedAt/,
      /@@map\("acquisition_orchestrator_leases"\)/,
    ]) {
      assert.match(model, line)
    }
  })

  it("1/2/4/6. RepeatableRead; absent lease → idle row inserted, then locked, then draft locked", async () => {
    const w = world({ lease: null })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(w.state.txOptions, [{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }])
    assert.equal(Prisma.TransactionIsolationLevel.RepeatableRead, "RepeatableRead")
    assert.deepEqual(w.state.txOps.slice(0, 3), ["lease.insert", "lease.lock", "draft.lock"])
    assert.deepEqual(w.state.leaseInserts.map((i) => i.values), [[ACQUISITION_ORCHESTRATOR_LEASE_KEY]])
    const leaseLock = w.state.lockQueries.find((q) => q.table === "lease")!
    assert.match(leaseLock.sql, /FROM "acquisition_orchestrator_leases"\s+WHERE "key" = \?\s+FOR UPDATE/)
    assert.deepEqual(leaseLock.values, [ACQUISITION_ORCHESTRATOR_LEASE_KEY])
    // Ligne IDLE committée, compatible acquire / release.
    assert.deepEqual(w.state.lease, IDLE_LEASE)
    assert.equal(passRows(w).length, 1)
  })

  it("6. existing idle lease → INSERT is a no-op (idempotent), row locked, lease unchanged", async () => {
    const w = world({ lease: { ...IDLE_LEASE } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.equal(w.state.leaseInserts.length, 1)
    assert.deepEqual(w.state.lease, IDLE_LEASE)
  })

  it("1. idle lease (ownerRunId null, even with a stale expiry value) permits RECORD", async () => {
    for (const lease of [
      { ...IDLE_LEASE },
      { ...IDLE_LEASE, leaseExpiresAt: new Date(Date.now() - 60_000) },
    ]) {
      const w = world({ lease })
      const r = await call(w, RECORD)
      assert.equal(r.status, 200, r.text)
      assert.equal(r.body.record.proof.leaseAvailable, true)
      assert.equal(passRows(w).length, 1)
      assert.deepEqual(w.state.lease, lease, "lease must not be modified")
    }
  })

  it("2/3/4. any owned lease (live, EXPIRED, or without expiry) → ORCHESTRATOR_RUN_ACTIVE, zero PASS, draft never locked, lease untouched", async () => {
    for (const lease of [
      { ...IDLE_LEASE, ownerRunId: "run-active", leaseExpiresAt: new Date(Date.now() + 60_000) },
      { ...IDLE_LEASE, ownerRunId: "run-active", leaseExpiresAt: new Date(Date.now() - 60_000) },
      { ...IDLE_LEASE, ownerRunId: "run-active", leaseExpiresAt: null },
    ]) {
      const w = world({ lease })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409)
      assert.equal(r.body.code, "ORCHESTRATOR_RUN_ACTIVE")
      assert.equal(r.body.commitOutcome, "ROLLED_BACK")
      assert.equal(r.body.proof.leaseAvailable, false)
      assert.equal(passRows(w).length, 0)
      assert.equal(w.state.appendAttempts.length, 0)
      assert.ok(!w.state.txOps.includes("draft.lock"))
      assert.deepEqual(w.state.lease, lease, "lease must not be modified")
      assertNoLeak(r.text)
    }
  })

  it("7. unit-level coordination: an orchestrator acquire queued behind RECORD sees the committed PASS; an active run blocks RECORD", async () => {
    // NB : modèle unitaire de la sérialisation par verrou ligne — ne prouve pas le comportement PostgreSQL.
    // Acquire émis PENDANT que RECORD détient le verrou de lease : il attend le COMMIT.
    let acquire: ReturnType<World["orchestratorAcquire"]> | null = null
    const w: World = world({
      lease: { ...IDLE_LEASE },
      hooks: { onLeaseLock: () => { acquire ??= w.orchestratorAcquire("run-after") } },
    })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.ok(acquire, "acquire was not issued during RECORD")
    assert.deepEqual(await acquire, { outcome: "ACQUIRED", terminalPassVisible: true })

    // Acquire émis avant le verrou de RECORD (pendant sa pré-lecture) : RECORD refuse ensuite.
    const w1 = world({ lease: { ...IDLE_LEASE } })
    const early = call(w1, RECORD)
    const acquired = await w1.orchestratorAcquire("run-first")
    assert.equal((acquired as { outcome: string }).outcome, "ACQUIRED")
    assert.equal((await early).body.code, "ORCHESTRATOR_RUN_ACTIVE")
    assert.equal(passRows(w1).length, 0)

    const w2 = world({ lease: { ...IDLE_LEASE } })
    const a2 = await w2.orchestratorAcquire("run-before")
    assert.equal((a2 as { outcome: string }).outcome, "ACQUIRED")
    const r2 = await call(w2, RECORD)
    assert.equal(r2.body.code, "ORCHESTRATOR_RUN_ACTIVE")
    assert.equal(passRows(w2).length, 0)
  })

  it("8. every evaluation read inside RECORD is bound to the transaction client", async () => {
    const w = world()
    await call(w, RECORD)
    assert.ok(w.state.contextClients.length >= 2)
    for (const c of w.state.contextClients) assert.equal(w.isTx(c), true, "context read on the root client")
    const ops = w.state.txOps
    assert.ok(ops.indexOf("draft.lock") < ops.indexOf("journal.findLatest"))
    assert.ok(ops.indexOf("journal.findLatest") < ops.indexOf("context.draftRead"))
    assert.ok(ops.indexOf("context.draftRead") < ops.indexOf("journal.append"))
    // Racine : uniquement la pré-lecture et le diagnostic post-commit.
    assert.equal(w.state.dbCalls.filter((c) => c === "worksiteImportDraft.findFirst").length, 2)
  })
})

describe("targeted validation record — RECORD (Option C transaction)", () => {
  it("A. one RR transaction, parameterized FOR UPDATE on lease then draft, one PASS appended", async () => {
    const w = world()
    const r = await call(w, RECORD)
    assert.equal(r.status, 200, r.text)
    assert.equal(w.state.txStarted, 1)
    assert.equal(w.state.commits, 1)
    assert.deepEqual(w.state.lockQueries.map((q) => q.table), ["lease", "draft"])
    const lock = w.state.lockQueries.find((q) => q.table === "draft")!
    assert.match(lock.sql, /FROM "worksite_import_drafts" d/)
    assert.match(lock.sql, /WHERE d\.id = \?\s+AND d\."companyId" = \?\s+FOR UPDATE/)
    assert.deepEqual(lock.values, [DRAFT, COMPANY])
    for (const s of lock.strings) {
      assert.ok(!s.includes(DRAFT) && !s.includes(COMPANY), "ids must be bound parameters")
    }
    assert.deepEqual(r.body, {
      ok: true,
      mode: "RECORD",
      referenceInstant: BEFORE_PERIOD.toISOString(),
      record: {
        commitOutcome: "COMMITTED",
        committed: true,
        journalAppended: true,
        alreadyRecorded: false,
        cycle: { draftVersion: 5 },
        proof: {
          leaseAvailable: true,
          lockedScope: true,
          statusPendingReview: true,
          noCreatedWorksite: true,
          cycleMatchesAuthorized: true,
          noBlockingMarker: true,
          contextMatchesCycle: true,
          predictionIsPass: true,
          passBelongsToAuthorizedCycle: true,
        },
      },
      postCommit: { available: true, stillCurrentAfterCommit: true },
    })
    assert.equal(passRows(w).length, 1)
    const row = passRows(w)[0]!
    assert.deepEqual(parseValidationCycleIdentity(row.metadata), CYCLE)
    assert.equal(row.idempotencyKey, ATTEMPT_ONE_KEY)
    for (const c of w.state.dbCalls) {
      assert.ok(
        [
          "worksiteImportDraft.findFirst",
          "tx.worksiteImportDraft.findFirst",
          "tx.$queryRaw",
          "tx.$executeRaw",
          "$transaction",
        ].includes(c),
        c
      )
    }
    assert.equal(r.nowCalls, 1)
    assertNoLeak(r.text)
  })

  it("B. state / cycle / status / worksite change visible under the draft lock → rollback, zero PASS", async () => {
    const cases: Array<[string, Row, string]> = [
      ["status", { status: "APPROVED" }, "DRAFT_STATUS_INVALID"],
      ["worksite", { createdWorksiteId: "ws-1" }, "WORKSITE_ALREADY_CREATED"],
      ["version", { version: 6 }, "CYCLE_CHANGED"],
      ["hash", { contentHashAtExtraction: "hash-other" }, "CYCLE_CHANGED"],
      ["schema", { extractionSchemaVersion: "4" }, "CYCLE_CHANGED"],
    ]
    for (const [label, change, code] of cases) {
      const w = world({ hooks: { beforeLock: (s) => { s.draft = { ...s.draft, ...change } } } })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409, label)
      assert.equal(r.body.code, code, label)
      assert.equal(r.body.commitOutcome, "ROLLED_BACK")
      assert.equal(r.body.committed, false)
      assert.equal(w.state.appendAttempts.length, 0, label)
      assert.equal(passRows(w).length, 0, label)
      assert.equal(w.state.lease, null, `${label}: rolled-back lease init must not persist`)
      assert.ok(!r.text.includes("ws-1"))
      assert.equal(r.body.proof.lockedScope, true, label)
      assert.equal("contextMatchesCycle" in r.body.proof, false, label)
      assert.ok(!w.state.dbCalls.includes("tx.worksiteImportDraft.findFirst"), label)
      if (code === "CYCLE_CHANGED") assert.equal(r.body.proof.cycleMatchesAuthorized, false, label)
    }
  })

  it("C. context / prediction change inside the transaction before append → rollback, zero PASS", async () => {
    const cases: Array<[string, Row, string]> = [
      ["prediction becomes QUARANTINE", { proposedCity: null }, "PREDICTION_NOT_PASS"],
      ["context cycle differs", { version: 6 }, "CYCLE_CHANGED"],
    ]
    for (const [label, change, code] of cases) {
      const w = world({ hooks: { afterLock: (s) => { s.draft = { ...s.draft, ...change } } } })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409, label)
      assert.equal(r.body.code, code, label)
      assert.equal(w.state.appendAttempts.length, 0, label)
      assert.equal(passRows(w).length, 0, label)
    }
  })

  it("D / 10. append throws (before callback completion) → ROLLED_BACK, zero PASS", async () => {
    const w = world({ hooks: { onAppend: () => { throw new Error("db error during append") } } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "RECORD_TRANSACTION_FAILED")
    assert.equal(r.body.commitOutcome, "ROLLED_BACK")
    assert.equal(r.body.committed, false)
    assert.equal(w.state.appendAttempts.length, 1)
    assert.equal(passRows(w).length, 0)
    assert.ok(!r.text.includes("db error"))
  })

  it("9. serialization / deadlock conflicts → SERIALIZATION_CONFLICT, ROLLED_BACK, no automatic retry", async () => {
    for (const err of [
      prismaKnownError("P2034"),
      prismaKnownError("P2010", { code: "40001" }),
      prismaKnownError("P2010", { code: "40P01" }),
    ]) {
      const w = world({ hooks: { onLeaseLock: () => { throw err } } })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409)
      assert.equal(r.body.code, "SERIALIZATION_CONFLICT", err.code)
      assert.equal(r.body.commitOutcome, "ROLLED_BACK")
      assert.equal(r.body.committed, false)
      assert.equal(w.state.txStarted, 1, "no automatic retry")
      assert.equal(passRows(w).length, 0)
    }
    // Autre erreur Prisma connue : pas une sérialisation.
    const w = world({ hooks: { onLeaseLock: () => { throw prismaKnownError("P2010", { code: "23505" }) } } })
    const r = await call(w, RECORD)
    assert.equal(r.body.code, "RECORD_TRANSACTION_FAILED")
  })

  it("E / 11 / 13. COMMIT rejected after callback completion (not applied) → UNKNOWN + NOT_OBSERVED, never 'rolled back'", async () => {
    const w = world({ hooks: { commitFails: true } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "RECORD_OUTCOME_UNKNOWN")
    assert.equal(r.body.commitOutcome, "UNKNOWN")
    assert.equal(r.body.reconciliation, "NOT_OBSERVED")
    assert.equal("committed" in r.body, false, "absence must not be reported as committed:false")
    assert.ok(!/ROLLED_BACK|rollback/i.test(r.text))
    assert.equal(passRows(w).length, 0)
    assert.ok(w.state.dbCalls.includes("journal.findByIdempotencyKey"), "reconciliation read performed")
  })

  it("11 / 12. commit applied but acknowledgement lost → UNKNOWN + PRESENT (exact attempt-1 slot), no extra write", async () => {
    const w = world({ hooks: { commitAckLost: true } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.record, {
      commitOutcome: "UNKNOWN",
      reconciliation: "PRESENT",
      passPresentForAuthorizedCycle: true,
      cycle: { draftVersion: 5 },
    })
    assert.equal(passRows(w).length, 1)
    assert.equal(w.state.appendAttempts.length, 1, "reconciliation must not write")
    assert.equal(w.state.txStarted, 1)
  })

  it("12. reconciliation only accepts the exact attempt-1 PASS: a non-PASS decision in that slot → NOT_OBSERVED", async () => {
    const w = world({
      hooks: {
        commitFails: true,
        beforeReconcile: (s) => { s.rows.push(markerRow("VALIDATION_FAIL_RETRYABLE", { attempt: 1 })) },
      },
    })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.commitOutcome, "UNKNOWN")
    assert.equal(r.body.reconciliation, "NOT_OBSERVED")
    assert.equal(passRows(w).length, 0)
  })

  it("14. UNKNOWN + reconciliation read failure → UNAVAILABLE", async () => {
    const w = world({ hooks: { commitFails: true, reconcileThrows: true } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.commitOutcome, "UNKNOWN")
    assert.equal(r.body.reconciliation, "UNAVAILABLE")
    assert.equal("committed" in r.body, false)
  })

  it("F. existing PASS + current valid PASS → idempotent success from locked verification, no new row", async () => {
    const w = world({ journal: [markerRow("VALIDATION_PASS")] })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.equal(r.body.record.commitOutcome, "COMMITTED")
    assert.equal(r.body.record.alreadyRecorded, true)
    assert.equal(r.body.record.journalAppended, false)
    assert.deepEqual(r.body.record.proof, {
      leaseAvailable: true,
      lockedScope: true,
      statusPendingReview: true,
      noCreatedWorksite: true,
      cycleMatchesAuthorized: true,
      noBlockingMarker: true,
      contextMatchesCycle: true,
      predictionIsPass: true,
      passBelongsToAuthorizedCycle: true,
    })
    assert.deepEqual(w.state.lockQueries.map((q) => q.table), ["lease", "draft"])
    assert.equal(w.state.appendAttempts.length, 0)
    assert.equal(w.state.rows.length, 1)
  })

  it("G. existing PASS + stale status → conflict, no write", async () => {
    const w = world({ journal: [markerRow("VALIDATION_PASS")], draft: { status: "APPROVED" } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "DRAFT_STATUS_INVALID")
    assert.equal(r.body.proof.statusPendingReview, false)
    assert.equal(w.state.appendAttempts.length, 0)
    assert.equal(w.state.rows.length, 1)
  })

  it("H. existing PASS + cycle changed before the draft lock → conflict, no write", async () => {
    const w = world({
      journal: [markerRow("VALIDATION_PASS")],
      hooks: { beforeLock: (s) => { s.draft = { ...s.draft, version: 6 } } },
    })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "CYCLE_CHANGED")
    assert.equal(r.body.proof.cycleMatchesAuthorized, false)
    assert.equal(w.state.appendAttempts.length, 0)
    assert.equal(w.state.rows.length, 1)
  })

  it("I. existing PASS + current prediction QUARANTINE → conflict, no write", async () => {
    const w = world({ journal: [markerRow("VALIDATION_PASS")], draft: { proposedCity: null } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "EXISTING_PASS_STATE_MISMATCH")
    assert.equal(r.body.proof.predictionIsPass, false)
    assert.equal(r.body.predictedValidation.decisionCode, "VALIDATION_QUARANTINE")
    assert.equal(w.state.appendAttempts.length, 0)
    assert.equal(w.state.rows.length, 1)
  })

  it("existing QUARANTINE / terminal / retryable marker → blocked under the locks, no write", async () => {
    for (const code of ["VALIDATION_QUARANTINE", "VALIDATION_FAIL_TERMINAL", "VALIDATION_FAIL_RETRYABLE"]) {
      const w = world({ journal: [markerRow(code)] })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409, code)
      assert.equal(r.body.code, "EXISTING_MARKER_BLOCKS_RECORD")
      assert.equal(r.body.existingDecisionCode, code)
      assert.equal(w.state.appendAttempts.length, 0)
      assert.equal(passRows(w).length, 0)
    }
  })

  it("J. FAIL_RETRYABLE committed concurrently (after pre-read, before the draft lock) → no PASS", async () => {
    const w = world({ hooks: { beforeLock: (s) => { s.rows.push(markerRow("VALIDATION_FAIL_RETRYABLE")) } } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "EXISTING_MARKER_BLOCKS_RECORD")
    assert.equal(passRows(w).length, 0)
    assert.equal(w.state.appendAttempts.length, 0)
  })

  it("K. expired retry marker (retry due) → still blocked, never an attempt-2 row", async () => {
    const w = world({
      journal: [markerRow("VALIDATION_FAIL_RETRYABLE", { meta: { nextRetryAt: "2020-01-01T00:00:00.000Z" } })],
    })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "EXISTING_MARKER_BLOCKS_RECORD")
    assert.equal(passRows(w).length, 0)
    assertAllAppendsAttemptOne(w)
  })

  it("L. attempt-2 impossible: builder fixes attempt 1; slot taken by another decision at append → rollback", async () => {
    const entry = buildTargetedValidationPassEntry({
      companyId: COMPANY,
      draftId: DRAFT,
      cycle: CYCLE,
      decision: { code: "PASS", reasons: ["THRESHOLDS_OK"] },
      scores: {},
    })
    assert.equal((entry.metadata as Row).attempt, 1)
    assert.equal(entry.idempotencyKey, ATTEMPT_ONE_KEY)
    assert.notEqual(
      entry.idempotencyKey,
      buildValidationDecisionIdempotencyKey({ companyId: COMPANY, draftId: DRAFT, cycle: CYCLE, validationAttempt: 2 })
    )
    const w = world({ hooks: { onAppend: (s) => { s.rows.push(markerRow("VALIDATION_FAIL_RETRYABLE")) } } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "IDEMPOTENCY_SLOT_CONFLICT")
    assert.equal(r.body.commitOutcome, "ROLLED_BACK")
    assert.equal(passRows(w).length, 0)
    assertAllAppendsAttemptOne(w)
    const src = readFileSync(path.join(process.cwd(), HANDLER_PATH), "utf8")
    for (const forbidden of ["resolveValidationAttemptNumber", "computeValidationRetryNextAt", "validationAttempt: 2"]) {
      assert.ok(!src.includes(forbidden), `handler must not reference ${forbidden}`)
    }
  })

  it("M. two concurrent clean RECORD requests → one PASS row, one appended + one idempotent", async () => {
    const w = world()
    const [a, b] = await Promise.all([call(w, RECORD), call(w, RECORD)])
    assert.equal(a.status, 200, a.text)
    assert.equal(b.status, 200, b.text)
    assert.equal(passRows(w).length, 1)
    assert.deepEqual([a.body.record.journalAppended, b.body.record.journalAppended].sort(), [false, true])
    assert.deepEqual([a.body.record.alreadyRecorded, b.body.record.alreadyRecorded].sort(), [false, true])
    assertAllAppendsAttemptOne(w)
  })

  it("N. draft changes AFTER a successful commit → RECORD stays successful, stillCurrentAfterCommit false", async () => {
    const w = world({ hooks: { afterCommit: (s) => { s.draft = { ...s.draft, version: 6 } } } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.equal(r.body.record.commitOutcome, "COMMITTED")
    assert.equal(r.body.record.journalAppended, true)
    assert.deepEqual(r.body.postCommit, { available: true, stillCurrentAfterCommit: false })
    assert.equal(passRows(w).length, 1)
  })

  it("O. post-commit diagnostic read throws → committed RECORD not reported as a failure", async () => {
    const w = world({ hooks: { postCommitReadThrows: true } })
    const r = await call(w, RECORD)
    assert.equal(r.status, 200)
    assert.equal(r.body.record.commitOutcome, "COMMITTED")
    assert.deepEqual(r.body.postCommit, { available: false, stillCurrentAfterCommit: null })
    assert.equal(passRows(w).length, 1)
  })

  it("non-PENDING_REVIEW / worksite / no cycle → refused, zero PASS", async () => {
    const cases: Array<[Row, string]> = [
      [{ status: "APPROVED" }, "DRAFT_STATUS_INVALID"],
      [{ status: "OBSOLETE" }, "DRAFT_STATUS_INVALID"],
      [{ createdWorksiteId: "ws-1" }, "WORKSITE_ALREADY_CREATED"],
      [{ contentHashAtExtraction: null }, "CYCLE_UNAVAILABLE"],
    ]
    for (const [draft, code] of cases) {
      const w = world({ draft })
      const r = await call(w, RECORD)
      assert.equal(r.status, 409, code)
      assert.equal(r.body.code, code)
      assert.equal(w.state.appendAttempts.length, 0)
      assert.equal(passRows(w).length, 0)
    }
  })

  it("Q. parity: targeted PASS entry equals the production worker's PASS entry for the same fixture", async () => {
    const workerWorld = world()
    let workerEntry: DecisionJournalEntry | null = null
    const workerJournal = {
      findLatestValidationDecisionForCycle: async () => null,
      appendOnce: async (entry: DecisionJournalEntry) => {
        workerEntry = entry
        return { outcome: "APPENDED" as const, row: { id: "w", ...entry, createdAt: new Date() } as never }
      },
    }
    const workerResult = await runAcquisitionValidationWorker({
      db: workerWorld.db,
      journal: workerJournal as never,
      selection: {
        listEligibleCandidates: async () => [
          {
            draftId: DRAFT,
            companyId: COMPANY,
            version: 5,
            contentHashAtExtraction: HASH,
            extractionSchemaVersion: "3",
            updatedAt: new Date("2026-09-04T00:00:00.000Z"),
          },
        ],
      },
      evaluationDeps: { ...workerWorld.evaluationDeps, db: workerWorld.db } as never,
      now: () => BEFORE_PERIOD,
      maxCandidates: 1,
      maxScan: 1,
      maxPerCompany: 1,
    })
    assert.equal(workerResult.stats.journalAppended, 1)
    assert.ok(workerEntry, "worker did not append")

    const harnessWorld = world()
    const r = await call(harnessWorld, RECORD)
    assert.equal(r.status, 200)
    const harnessEntry = harnessWorld.state.appendAttempts[0]!

    const pick = (e: DecisionJournalEntry) => ({
      companyId: e.companyId,
      draftId: e.draftId,
      decisionCode: e.decisionCode,
      reasons: e.reasons,
      scores: e.scores,
      actorUserId: e.actorUserId,
      metadata: e.metadata,
      idempotencyKey: e.idempotencyKey,
    })
    assert.deepEqual(pick(harnessEntry), pick(workerEntry!))
  })
})

describe("targeted validation record — regression / module boundaries", () => {
  it("route exports runtime nodejs and POST delegates fail-closed", async () => {
    const route = await import("@/app/api/acquisition/targeted-staging-validation-record/route")
    assert.equal(route.runtime, "nodejs")
    const res = await route.POST(request({ confirmation: CHECK }))
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "HARNESS_SURFACE_FORBIDDEN")
  })

  it("static guard: REQUIRES RR transaction, lease INSERT + two FOR UPDATE locks; forbids worker writes, downstream paths and other raw writes", () => {
    const handler = readFileSync(path.join(process.cwd(), HANDLER_PATH), "utf8")
    const src = handler + readFileSync(path.join(process.cwd(), ROUTE_PATH), "utf8")
    // Requis.
    assert.equal((handler.match(/db\.\$transaction\(/g) ?? []).length, 1, "exactly one interactive transaction")
    assert.match(handler, /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/)
    assert.equal((handler.match(/\$queryRaw[<`]/g) ?? []).length, 2, "exactly two raw reads (lease lock, draft lock)")
    assert.equal((handler.match(/FOR UPDATE\s*`/g) ?? []).length, 2, "exactly two row locks")
    assert.equal((handler.match(/\$executeRaw[<`]/g) ?? []).length, 1, "exactly one raw write (idle lease row)")
    assert.equal((handler.match(/INSERT INTO/g) ?? []).length, 1)
    assert.match(handler, /INSERT INTO "acquisition_orchestrator_leases"/)
    assert.ok(handler.includes("appendOnceInTransaction("), "append must use the transaction client")
    // 5. Durcissement : aucune réintroduction de l'expiration comme condition de disponibilité.
    assert.equal((handler.match(/"ownerRunId" IS NULL/g) ?? []).length, 1)
    assert.ok(!/"ownerRunId" IS NULL\s+OR/.test(handler), "expiry alternative reintroduced")
    assert.ok(!/"leaseExpiresAt"\s*<\s*clock_timestamp\(\)/.test(handler), "expiry comparison reintroduced")
    assert.ok(!/"leaseExpiresAt" IS NOT NULL/.test(handler), "expiry condition reintroduced")
    // Interdits.
    for (const forbidden of [
      "runAcquisitionValidationWorker",
      "runAcquisitionAutoDecisionWorker",
      "acquisition-auto-decision.worker",
      "runAcquisitionWorksiteCreationWorker",
      "acquisition-worksite-creation.worker",
      "acquisition-orchestrator-workers",
      "acquisition-orchestrator.service",
      "runAcquisitionOrchestrator",
      "extraction.service",
      "@/lib/acquisition/extraction/",
      "anthropic",
      "cloudinary",
      "gmail",
      "approveImportDraft",
      "rejectImportDraft",
      "convertImportDraft",
      "conversion.service",
      "$executeRawUnsafe",
      "$queryRawUnsafe",
      "DELETE FROM",
      "UPDATE \"",
      "SET \"",
      ".appendOnce(",
      ".append(",
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      "createMany",
      "updateMany",
      "deleteMany",
      "fetch(",
    ]) {
      assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()), `handler/route must not reference ${forbidden}`)
    }
  })

  it("fresh process: importing the handler loads no forbidden module, SDK, DB access or network call", () => {
    const FORBIDDEN_MODULES = [
      path.join("orchestrator", "acquisition-auto-decision.worker.ts"),
      path.join("orchestrator", "acquisition-worksite-creation.worker.ts"),
      path.join("orchestrator", "acquisition-orchestrator-workers.ts"),
      path.join("orchestrator", "acquisition-orchestrator.service.ts"),
      path.join("orchestrator", "acquisition-orchestrator-lease.repository.ts"),
      path.join("extraction", "extraction.service.ts"),
      path.join("conversion", "conversion.service.ts"),
      path.join("review", "import-draft-review.service.ts"),
      path.join("policy", "auto-decision.service.ts"),
    ]
    const MARKER = "__VALIDATION_RECORD_GRAPH__"
    const probe = [
      `const prismaAccess = [];`,
      `globalThis.prisma = new Proxy({}, { get(_t, p) { if (typeof p === "string") prismaAccess.push(p); return undefined } });`,
      `let fetchCalls = 0; globalThis.fetch = async () => { fetchCalls += 1; throw new Error("NO_NETWORK") };`,
      `const m = require("@/lib/acquisition/orchestrator/targeted-staging-validation-record.handler");`,
      `setImmediate(() => setTimeout(() => {`,
      `  process.stdout.write("\\n${MARKER}" + JSON.stringify({`,
      `    handlerExport: typeof m.handleTargetedStagingValidationRecord,`,
      `    loaded: Object.keys(require.cache), prismaAccess, fetchCalls,`,
      `  }) + "\\n");`,
      `}, 50));`,
    ].join("\n")
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    }
    delete childEnv.NODE_TEST_CONTEXT
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "-e", probe], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    })
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER))
    assert.ok(line, "child did not report its module graph")
    const graph = JSON.parse(line.slice(MARKER.length)) as {
      handlerExport: string
      loaded: string[]
      prismaAccess: string[]
      fetchCalls: number
    }
    assert.equal(graph.handlerExport, "function")
    assert.deepEqual(FORBIDDEN_MODULES.filter((m) => graph.loaded.some((p) => p.endsWith(m))), [])
    assert.deepEqual(
      graph.loaded.filter((p) => /node_modules[\\/](@anthropic-ai|cloudinary|googleapis|@googleapis)[\\/]/.test(p)),
      []
    )
    assert.deepEqual(graph.prismaAccess, [])
    assert.equal(graph.fetchCalls, 0)
  })
})
