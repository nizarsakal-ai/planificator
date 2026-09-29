process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { PrismaClient } from "@prisma/client"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { acquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import { acquisitionConsultationDetectionSelectionRepository } from "@/lib/acquisition/detection/consultation-detection.selection.repository"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import {
  computeEffectiveAutoFlags,
  runAcquisitionAutoDecisionWorker,
  type AutoDecisionWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import {
  ACQUISITION_ORCHESTRATOR_LEASE_KEY,
  getAcquisitionOrchestratorConfig,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import {
  InMemoryAcquisitionOrchestratorLeaseRepository,
  acquisitionOrchestratorLeaseRepository,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import * as orchestratorWorkers from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { runTargetedAutoDecisionUnderOrchestratorLease } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { acquisitionGmailConnectionListingAdapter } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import { resolveValidatedSystemActor } from "@/lib/acquisition/policy/system-actor"
import {
  TARGETED_AUTO_DECISION_RUN_GATE,
  runTargetedStagingAutoDecision,
  type TargetedAutoDecisionRunnerDeps,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-runner"
import {
  TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED,
  buildTargetedAutoDecisionWorkerDeps,
  createTargetedAutoDecisionSelectionPort,
  resolveTargetedAutoDecisionEffectiveFlags,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"

const ROOT = path.resolve(__dirname, "../..")
const RUNNER_PATH = "src/lib/acquisition/orchestrator/targeted-staging-auto-decision-runner.ts"
const SELECTION_PATH = "src/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection.ts"
const WORKERS_PATH = "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"
const PREFLIGHT_PATH = "src/lib/acquisition/orchestrator/targeted-staging-auto-decision-preflight.handler.ts"
const PREFLIGHT_ROUTE_PATH = "src/app/api/acquisition/targeted-staging-auto-decision-preflight/route.ts"

const COMPANY = "co-auto-decision-runner"
const DRAFT = "draft-auto-decision-runner"
const HASH = "hash-runner-1"
const NOW = new Date("2026-09-29T10:00:00.000Z")

const RUN_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  [TARGETED_AUTO_DECISION_RUN_GATE]: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

function sessionAuth(role = "ADMIN", companyId: string | null = COMPANY) {
  return (async () => ({ user: { id: "u1", role, companyId } })) as never
}

/** DB piège : tout accès est enregistré. */
function trapDb(): { db: PrismaClient; accesses: string[] } {
  const accesses: string[] = []
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        accesses.push(String(prop))
        throw new Error(`DB_ACCESS_FORBIDDEN:${String(prop)}`)
      },
    }
  ) as unknown as PrismaClient
  return { db, accesses }
}

const FAKE_FENCE: TransactionalOwnershipFence = {
  async assertOwnedAndLock() {
    throw new Error("FENCE_MUST_NOT_BE_USED")
  },
}

function readSource(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

/** Code seul (commentaires retirés) pour les gardes statiques. */
function readCode(rel: string): string {
  return readSource(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full))
    else out.push(full)
  }
  return out
}

/** Source de la fonction ciblée du wiring (jusqu'à la fin du fichier). */
function targetedWiringSource(): string {
  const src = readCode(WORKERS_PATH)
  const start = src.indexOf("export async function runTargetedAutoDecisionUnderOrchestratorLease")
  assert.ok(start > 0)
  return src.slice(start)
}

// ---------------------------------------------------------------------------
// Lease canonique : méthodes du repository PRODUCTION patchées vers une lease mémoire
// (mêmes règles), avec journal des appels.
// ---------------------------------------------------------------------------

type LeaseCall = { op: "acquire" | "assertOwned" | "renew" | "release"; key: string; ownerRunId: string; leaseTtlMs?: number }

function patchMethod<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): () => void {
  const original = target[key]
  target[key] = impl
  return () => {
    target[key] = original
  }
}

function installCanonicalLease(opts: {
  onAcquired?: (mem: InMemoryAcquisitionOrchestratorLeaseRepository, ownerRunId: string) => void
  acquireThrows?: boolean
  assertOwnedThrows?: boolean
  releaseOutcome?: "NOT_FOUND" | "THROW"
} = {}) {
  const mem = new InMemoryAcquisitionOrchestratorLeaseRepository()
  const calls: LeaseCall[] = []
  const repo = acquisitionOrchestratorLeaseRepository
  const restore = [
    patchMethod(repo, "acquire", async (input) => {
      calls.push({ op: "acquire", ...input })
      if (opts.acquireThrows) throw new Error("acquire commit unknown")
      const out = await mem.acquire(input)
      if (out.outcome === "ACQUIRED") opts.onAcquired?.(mem, input.ownerRunId)
      return out
    }),
    patchMethod(repo, "assertOwned", async (input) => {
      calls.push({ op: "assertOwned", ...input })
      if (opts.assertOwnedThrows) throw new Error("lease lookup failed")
      return mem.assertOwned(input)
    }),
    patchMethod(repo, "renew", async (input) => {
      calls.push({ op: "renew", ...input })
      return mem.renew(input)
    }),
    patchMethod(repo, "release", async (input) => {
      calls.push({ op: "release", ...input })
      if (opts.releaseOutcome === "THROW") throw new Error("release failed")
      if (opts.releaseOutcome === "NOT_FOUND") return { outcome: "NOT_FOUND" as const }
      return mem.release(input)
    }),
  ]
  return {
    mem,
    calls,
    ops: () => calls.map((c) => c.op),
    restore: () => {
      for (const fn of restore) fn()
    },
  }
}

/** Toute autre étape orchestrateur → échec explicite + journal. */
function installOtherStepTraps() {
  const hits: string[] = []
  const trap = (name: string) => async () => {
    hits.push(name)
    throw new Error(`OTHER_STEP_FORBIDDEN:${name}`)
  }
  const restore = [
    patchMethod(acquisitionGmailConnectionListingAdapter, "listActiveAcquisitionGmailConnections", trap("gmailSync")),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithReclaimCandidates", trap("attachmentRecovery")),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithRetryCandidates", trap("attachmentRecovery.retry")),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithDiscoveredAttachments", trap("attachmentDownload")),
    patchMethod(acquisitionContentFetchStateRepository, "listCompanyIdsWithEligibleContentFetch", trap("contentFetch")),
    patchMethod(acquisitionConsultationDetectionSelectionRepository, "listCompanyIdsNeedingDetection", trap("consultationDetection")),
    patchMethod(acquisitionExtractionCronSelectionRepository, "listCompanyIdsWithEligibleExtraction", trap("extraction")),
  ]
  return {
    hits,
    restore: () => {
      for (const fn of restore) fn()
    },
  }
}

// Env process restauré après chaque test (kill-switches / system actor / pipeline).
const PROCESS_ENV_KEYS = [
  "ACQUISITION_AUTO_APPROVE_ENABLED",
  "ACQUISITION_AUTO_CONVERT_ENABLED",
  "ACQUISITION_SYSTEM_ACTOR_USER_ID",
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS",
  "ACQUISITION_ORCHESTRATOR_CRON_ENABLED",
  "ACQUISITION_ORCHESTRATOR_ALLOW_STUBS",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = Object.fromEntries(PROCESS_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of PROCESS_ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of PROCESS_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

/** Cible autorisée côté serveur (process.env, seule source lue par le wiring). */
function authorizeTargetEnv() {
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
}

async function runWiring(
  opts: Parameters<typeof installCanonicalLease>[0] = {},
  target = { companyId: COMPANY, draftId: DRAFT }
) {
  const lease = installCanonicalLease(opts)
  const steps = installOtherStepTraps()
  try {
    const result = await runTargetedAutoDecisionUnderOrchestratorLease({ target })
    return { result, lease, steps }
  } finally {
    lease.restore()
    steps.restore()
  }
}

// ---------------------------------------------------------------------------
// Fixtures port mono-draft
// ---------------------------------------------------------------------------

type DraftRow = {
  id: string
  companyId: string
  status: string
  version: number
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  updatedAt: Date
}

function draftRow(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 3,
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: "2",
    updatedAt: NOW,
    ...over,
  }
}

type ValidationFixture = { decisionCode: string; reasons?: string[]; metadata?: Record<string, unknown> }

function portFixture(opts: {
  row?: DraftRow | null
  validation?: ValidationFixture | null
  validationCycle?: { contentHash: string; extractionSchemaVersion: string | null; draftVersion: number }
}) {
  const findFirstCalls: unknown[] = []
  const journalCalls: unknown[] = []
  const forbiddenCalls: string[] = []
  const row = opts.row === undefined ? draftRow() : opts.row
  const forbid = (name: string) => () => {
    forbiddenCalls.push(name)
    throw new Error(`FORBIDDEN:${name}`)
  }
  const db = {
    worksiteImportDraft: {
      findFirst: async (args: unknown) => {
        findFirstCalls.push(args)
        return row
      },
      findMany: forbid("worksiteImportDraft.findMany"),
      update: forbid("worksiteImportDraft.update"),
      updateMany: forbid("worksiteImportDraft.updateMany"),
    },
    $queryRaw: forbid("$queryRaw"),
    $queryRawUnsafe: forbid("$queryRawUnsafe"),
    $executeRaw: forbid("$executeRaw"),
    $executeRawUnsafe: forbid("$executeRawUnsafe"),
    $transaction: forbid("$transaction"),
  } as unknown as PrismaClient
  const cycle = opts.validationCycle ?? { contentHash: HASH, extractionSchemaVersion: "2", draftVersion: 3 }
  const journal = {
    findLatestValidationDecisionForCycle: async (input: {
      companyId: string
      draftId: string
      cycle: { contentHash: string; extractionSchemaVersion: string | null; draftVersion: number }
    }) => {
      journalCalls.push(input)
      if (!opts.validation) return null
      if (
        input.companyId !== COMPANY ||
        input.draftId !== DRAFT ||
        input.cycle.contentHash !== cycle.contentHash ||
        input.cycle.extractionSchemaVersion !== cycle.extractionSchemaVersion ||
        input.cycle.draftVersion !== cycle.draftVersion
      ) {
        return null
      }
      return {
        id: "val-1",
        companyId: COMPANY,
        draftId: DRAFT,
        decisionCode: opts.validation.decisionCode,
        reasons: opts.validation.reasons ?? [],
        scores: {},
        actorUserId: null,
        metadata: opts.validation.metadata ?? {},
        createdAt: NOW,
      }
    },
  }
  const port = createTargetedAutoDecisionSelectionPort({
    companyId: COMPANY,
    draftId: DRAFT,
    db,
    journal: journal as never,
  })
  return { port, findFirstCalls, journalCalls, forbiddenCalls }
}

const LIST = { limit: 1, now: NOW, maxPerCompany: 1 }

function runnerDeps(over: Partial<TargetedAutoDecisionRunnerDeps> = {}): TargetedAutoDecisionRunnerDeps {
  return { env: { ...RUN_ENV }, auth: sessionAuth(), ...over }
}

/** Runner avec lease canonique instrumentée : aucune opération lease attendue. */
async function runRunner(deps: TargetedAutoDecisionRunnerDeps) {
  authorizeTargetEnv()
  const lease = installCanonicalLease()
  const steps = installOtherStepTraps()
  try {
    const out = await runTargetedStagingAutoDecision(deps)
    return { out, leaseOps: lease.ops(), stepHits: steps.hits }
  } finally {
    lease.restore()
    steps.restore()
  }
}

// ===========================================================================

describe("A. frontière capability — factory privée, aucune capability depuis l'extérieur", () => {
  it("exports runtime du wiring : liste fermée, factory AUTO absente", () => {
    assert.deepEqual(Object.keys(orchestratorWorkers).sort(), [
      "createPostExtractionPlaceholderRunner",
      "resolveOrchestratorAutoOwnership",
      "resolveOrchestratorAutoTransactionalFence",
      "runProductionAcquisitionOrchestrator",
      "runTargetedAutoDecisionUnderOrchestratorLease",
    ])
    assert.equal("createOrchestratorAutoCapability" in orchestratorWorkers, false)
    assert.ok(!/export\s+(async\s+)?function\s+createOrchestratorAutoCapability/.test(readSource(WORKERS_PATH)))
    assert.ok(!/export\s+(const|let)\s+autoCapabilityInternals/.test(readSource(WORKERS_PATH)))
  })

  it("la fonction ciblée n'accepte que la cible (ni capability, ni runId, ni repository, ni fence)", () => {
    const src = targetedWiringSource()
    const signature = src.slice(0, src.indexOf("): Promise<TargetedAutoDecisionLeaseRunResult>"))
    assert.match(signature, /input:\s*\{\s*target:\s*\{\s*companyId:\s*string;\s*draftId:\s*string\s*\}\s*\}/)
    assert.equal(runTargetedAutoDecisionUnderOrchestratorLease.length, 1)
  })

  it("le runner ne manipule jamais capability / lease / fence", () => {
    const src = readCode(RUNNER_PATH)
    for (const forbidden of [
      "OrchestratorAutoCapability",
      "capability",
      "resolveOrchestratorAutoOwnership",
      "resolveOrchestratorAutoTransactionalFence",
      "Fence",
      "leaseRepository",
      "ownerRunId",
      "runAcquisitionAutoDecisionWorker",
    ]) {
      assert.ok(!src.includes(forbidden), `runner ne doit pas référencer ${forbidden}`)
    }
  })

  it("résultat du wiring : ni ownerRunId, ni lease key, ni capability, ni fence exposés", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring()
    const serialized = JSON.stringify(result)
    const runId = lease.calls[0]?.ownerRunId ?? ""
    assert.ok(runId.length > 0)
    assert.ok(!serialized.includes(runId))
    assert.ok(!serialized.includes(ACQUISITION_ORCHESTRATOR_LEASE_KEY))
    assert.deepEqual(Object.keys(result).sort(), ["outcome", "release"])
  })

  it("seuls le wiring et le runner référencent la fonction ciblée ; seule la route RUN (via handler) atteint le runner", () => {
    const srcFiles = listFilesRecursive(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f))
    const users = srcFiles
      .filter((f) => readFileSync(f, "utf8").includes("runTargetedAutoDecisionUnderOrchestratorLease"))
      .map((f) => path.relative(ROOT, f))
      .sort()
    assert.deepEqual(users, [WORKERS_PATH, RUNNER_PATH].sort())
    const routeImporters = listFilesRecursive(path.join(ROOT, "src/app")).filter((f) => {
      const s = readFileSync(f, "utf8")
      return s.includes("targeted-staging-auto-decision-runner") || s.includes("targeted-staging-auto-decision-selection")
    })
    assert.deepEqual(routeImporters, [], "aucune route n'importe runner/sélection directement")
    const runnerUsers = srcFiles
      .filter((f) => readFileSync(f, "utf8").includes("targeted-staging-auto-decision-runner\""))
      .map((f) => path.relative(ROOT, f))
    assert.deepEqual(runnerUsers, ["src/lib/acquisition/orchestrator/targeted-staging-auto-decision-run.handler.ts"])
  })
})

describe("B. lease canonique — acquisition, ALREADY_RUNNING, capability après ACQUIRED, release finally", () => {
  it("acquire unique sur la clé canonique, runId ciblé généré, TTL production", async () => {
    authorizeTargetEnv()
    const { lease } = await runWiring()
    const acquires = lease.calls.filter((c) => c.op === "acquire")
    assert.equal(acquires.length, 1)
    assert.equal(acquires[0]?.key, "acquisition-orchestrator")
    assert.match(acquires[0]?.ownerRunId ?? "", /^targeted-auto-decision:[0-9a-f-]{36}$/)
    assert.equal(acquires[0]?.leaseTtlMs, getAcquisitionOrchestratorConfig().leaseTtlMs)
    // Toutes les opérations portent la même clé et le même runId.
    for (const c of lease.calls) {
      assert.equal(c.key, ACQUISITION_ORCHESTRATOR_LEASE_KEY)
      assert.equal(c.ownerRunId, acquires[0]?.ownerRunId)
    }
  })

  it("deux exécutions → runIds distincts (jamais fournis par l'appelant)", async () => {
    authorizeTargetEnv()
    const a = await runWiring()
    const b = await runWiring()
    assert.notEqual(a.lease.calls[0]?.ownerRunId, b.lease.calls[0]?.ownerRunId)
  })

  it("ALREADY_RUNNING (orchestrateur actif) → refus, aucun heartbeat, aucune release, lease intacte", async () => {
    authorizeTargetEnv()
    const lease = installCanonicalLease()
    lease.mem.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "cron-run-live", 60_000)
    const steps = installOtherStepTraps()
    try {
      const result = await runTargetedAutoDecisionUnderOrchestratorLease({
        target: { companyId: COMPANY, draftId: DRAFT },
      })
      assert.deepEqual(result, { outcome: "ALREADY_RUNNING" })
      assert.deepEqual(lease.ops(), ["acquire"])
      assert.equal(lease.mem.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "cron-run-live")
      assert.deepEqual(steps.hits, [])
    } finally {
      lease.restore()
      steps.restore()
    }
  })

  it("capability seulement après ACQUIRED : acquire en erreur → aucun heartbeat, release best-effort", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring({ acquireThrows: true })
    assert.equal(result.outcome, "LEASE_ACQUIRE_FAILED")
    assert.deepEqual(lease.ops(), ["acquire", "release"])
    assert.equal(lease.calls[1]?.ownerRunId, lease.calls[0]?.ownerRunId)
  })

  it("ACQUIRED → heartbeat de la capability sur la lease canonique (assertOwned + renew), puis release", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
    assert.deepEqual(lease.ops(), ["acquire", "assertOwned", "renew", "release"])
    assert.equal(lease.mem.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, null)
  })

  it("lease perdue après acquire (volée) → LEASE_NOT_OWNED, release NOT_OWNER, lease du voleur intacte", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring({
      onAcquired: (mem) => mem.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "cron-run-thief", 60_000),
    })
    assert.deepEqual(result, { outcome: "LEASE_NOT_OWNED", release: "NOT_OWNER" })
    assert.deepEqual(lease.ops(), ["acquire", "assertOwned", "release"])
    assert.equal(lease.mem.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "cron-run-thief")
  })

  it("lease expirée après acquire → LEASE_NOT_OWNED fail-closed", async () => {
    authorizeTargetEnv()
    const { result } = await runWiring({
      onAcquired: (mem) => {
        const t0 = Date.now()
        mem.nowFn = () => new Date(t0 + getAcquisitionOrchestratorConfig().leaseTtlMs + 1_000)
      },
    })
    assert.equal(result.outcome, "LEASE_NOT_OWNED")
  })

  it("heartbeat en erreur → LEASE_NOT_OWNED, release quand même exécutée", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring({ assertOwnedThrows: true })
    assert.deepEqual(result, { outcome: "LEASE_NOT_OWNED", release: "RELEASED" })
    assert.equal(lease.ops().at(-1), "release")
  })

  it("release NOT_FOUND / en erreur → état remonté (fail-closed côté runner)", async () => {
    authorizeTargetEnv()
    const notFound = await runWiring({ releaseOutcome: "NOT_FOUND" })
    assert.deepEqual(notFound.result, { outcome: "NOT_ARMED", release: "NOT_FOUND" })
    const thrown = await runWiring({ releaseOutcome: "THROW" })
    assert.deepEqual(thrown.result, { outcome: "NOT_ARMED", release: "RELEASE_FAILED" })
    const src = readSource(RUNNER_PATH)
    assert.match(src, /run\.release !== "RELEASED"\) return refused\("LEASE_RELEASE_NOT_CONFIRMED"\)/)
  })

  it("release dans un finally ; capability créée après le test ACQUIRED (ordre source)", () => {
    const src = targetedWiringSource()
    const iAcquired = src.indexOf('if (!acquired) return { outcome: "ALREADY_RUNNING" }')
    const iCapability = src.indexOf("createOrchestratorAutoCapability({")
    const iFinally = src.indexOf("} finally {")
    const iRelease = src.indexOf("releaseState = await release()")
    assert.ok(iAcquired > 0 && iCapability > iAcquired, "capability après ACQUIRED")
    assert.ok(iFinally > iCapability && iRelease > iFinally, "release dans finally")
    assert.equal(src.split("createOrchestratorAutoCapability(").length - 1, 1)
  })
})

/** Listings des étapes sœurs vides (run production sans I/O). */
function installEmptyProductionListings() {
  const restore = [
    patchMethod(acquisitionGmailConnectionListingAdapter, "listActiveAcquisitionGmailConnections", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithReclaimCandidates", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithRetryCandidates", async () => []),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithDiscoveredAttachments", async () => []),
    patchMethod(acquisitionContentFetchStateRepository, "listCompanyIdsWithEligibleContentFetch", async () => []),
    patchMethod(acquisitionConsultationDetectionSelectionRepository, "listCompanyIdsNeedingDetection", async () => []),
    patchMethod(acquisitionConsultationDetectionSelectionRepository, "listCandidatesForCompany", async () => []),
    patchMethod(acquisitionExtractionCronSelectionRepository, "listCompanyIdsWithEligibleExtraction", async () => []),
  ]
  return () => {
    for (const fn of restore) fn()
  }
}

async function runProduction() {
  const lease = installCanonicalLease()
  const restoreListings = installEmptyProductionListings()
  try {
    const result = await orchestratorWorkers.runProductionAcquisitionOrchestrator({ runId: "prod-regression" })
    return { result, lease }
  } finally {
    lease.restore()
    restoreListings()
  }
}

describe("C. gates globaux : production inchangée, primitive ciblée indépendante", () => {
  it("A. master acquisition OFF → production SKIPPED MASTER_DISABLED, aucune lease", async () => {
    process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED = "true"
    process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = "true"
    const { result, lease } = await runProduction()
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "MASTER_DISABLED")
    assert.equal(result.steps.autoDecision.status, "NOT_RUN")
    assert.deepEqual(lease.ops(), [])
  })

  it("A. master acquisition OFF → primitive ciblée non dépendante (atteint NOT_ARMED)", async () => {
    authorizeTargetEnv()
    process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = "true"
    const { result } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
  })

  it("B. post-extraction OFF → production : validation / autoDecision / worksiteCreation DISABLED", async () => {
    process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const { result, lease } = await runProduction()
    for (const step of ["validation", "autoDecision", "worksiteCreation"] as const) {
      assert.equal(result.steps[step].status, "SKIPPED", step)
      assert.equal(result.steps[step].skipReason, "DISABLED", step)
    }
    assert.equal(lease.calls.filter((c) => c.op === "acquire")[0]?.ownerRunId, "prod-regression")
  })

  it("B. post-extraction OFF → primitive ciblée non dépendante (atteint NOT_ARMED)", async () => {
    authorizeTargetEnv()
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const { result } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
  })

  it("A+B. les deux gates globaux OFF → primitive ciblée atteint NOT_ARMED, gates non modifiés", async () => {
    authorizeTargetEnv()
    const { result } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
    assert.equal(process.env.PLANIFICATOR_ACQUISITION_ENABLED, undefined)
    assert.equal(process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS, undefined)
    const src = targetedWiringSource()
    assert.ok(!src.includes("isAcquisitionEnabled"))
    assert.ok(!src.includes("isAcquisitionOrchestratorPostExtractionStepsEnabled"))
    assert.ok(!src.includes("process.env.PLANIFICATOR_ACQUISITION_ENABLED ="))
  })

  it("C. cible ≠ env autorisées → TARGET_NOT_AUTHORIZED avant toute opération lease", async () => {
    authorizeTargetEnv()
    for (const target of [
      { companyId: COMPANY, draftId: "draft-other" },
      { companyId: "co-other", draftId: DRAFT },
      { companyId: "co-other", draftId: "draft-other" },
      { companyId: ` ${COMPANY}`, draftId: DRAFT },
      { companyId: COMPANY, draftId: `${DRAFT} ` },
      { companyId: COMPANY.toUpperCase(), draftId: DRAFT },
      { companyId: DRAFT, draftId: COMPANY },
    ]) {
      const { result, lease, steps } = await runWiring({}, target)
      assert.deepEqual(result, { outcome: "TARGET_NOT_AUTHORIZED" }, JSON.stringify(target))
      assert.deepEqual(lease.ops(), [])
      assert.deepEqual(steps.hits, [])
    }
  })

  it("C. env cible absentes / vides → TARGET_NOT_AUTHORIZED, même pour la « bonne » cible", async () => {
    for (const env of [
      {},
      { TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY },
      { TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT },
      { TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: " ", TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: " " },
    ]) {
      delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID
      delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
      Object.assign(process.env, env)
      const { result, lease } = await runWiring()
      assert.deepEqual(result, { outcome: "TARGET_NOT_AUTHORIZED" })
      assert.deepEqual(lease.ops(), [])
    }
  })

  it("C. vérification de cible avant acquire (ordre source), env non injectable", () => {
    const src = targetedWiringSource()
    const iAuth = src.indexOf("isAuthorizedTargetedAutoDecisionTarget({ companyId, draftId })")
    const iAcquire = src.indexOf("leaseRepository.acquire(")
    assert.ok(iAuth > 0 && iAcquire > iAuth)
    const signature = src.slice(0, src.indexOf("): Promise<TargetedAutoDecisionLeaseRunResult>"))
    assert.ok(!/env/.test(signature))
    assert.match(readCode(SELECTION_PATH), /process\.env\[TARGETED_AUTO_DECISION_COMPANY_ENV\]/)
    assert.match(readCode(SELECTION_PATH), /target\.companyId === companyId && target\.draftId === draftId/)
  })

  it("D. cible exacte → NOT_ARMED dans le wiring", async () => {
    authorizeTargetEnv()
    const { result, lease } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
    assert.deepEqual(lease.ops(), ["acquire", "assertOwned", "renew", "release"])
  })

  it("le cron orchestrateur global n'est ni requis ni activé", async () => {
    authorizeTargetEnv()
    await runWiring()
    assert.equal(process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED, undefined)
    assert.ok(!targetedWiringSource().includes("resolveAcquisitionOrchestratorCronGate"))
  })

  it("cible vide / non-string → INVALID_TARGET ; blanche → TARGET_NOT_AUTHORIZED ; aucune lease", async () => {
    authorizeTargetEnv()
    for (const target of [
      { companyId: "", draftId: DRAFT },
      { companyId: COMPANY, draftId: "" },
      { companyId: 42 as unknown as string, draftId: DRAFT },
    ]) {
      const { result, lease } = await runWiring({}, target)
      assert.deepEqual(result, { outcome: "INVALID_TARGET" })
      assert.deepEqual(lease.ops(), [])
    }
    const blank = await runWiring({}, { companyId: COMPANY, draftId: "  " })
    assert.deepEqual(blank.result, { outcome: "TARGET_NOT_AUTHORIZED" })
    assert.deepEqual(blank.lease.ops(), [])
  })
})

describe("D. aucune autre étape orchestrateur, aucun worker tant que hard-stop false", () => {
  it("hard-stop constant false", () => {
    assert.equal(TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED, false)
    assert.match(readSource(SELECTION_PATH), /TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED = false as boolean/)
  })

  it("wiring : aucune étape Gmail/recovery/download/content/detection/extraction, worker non appelé", async () => {
    authorizeTargetEnv()
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    const { result, lease, steps } = await runWiring()
    assert.deepEqual(result, { outcome: "NOT_ARMED", release: "RELEASED" })
    assert.deepEqual(steps.hits, [])
    // Le worker ferait son propre contrôle d'ownership (assertOwned supplémentaire) :
    // un seul heartbeat = heartbeat du wiring uniquement.
    assert.equal(lease.calls.filter((c) => c.op === "assertOwned").length, 1)
  })

  it("wiring : jamais runProductionAcquisitionOrchestrator / runAcquisitionOrchestrator / autres workers", () => {
    const src = targetedWiringSource()
    for (const forbidden of [
      "runProductionAcquisitionOrchestrator(",
      "runAcquisitionOrchestrator(",
      "createProductionStepRunners(",
      "runGmailSync(",
      "runAcquisitionAttachmentRecoveryOrchestrator",
      "runAcquisitionAttachmentDownloadOrchestrator",
      "runAcquisitionContentCronOrchestratorDefault",
      "runConsultationDetectionWorker",
      "runAcquisitionExtractionCronOrchestrator",
      "runDraftExtractionOrchestrated",
      "runAcquisitionValidationWorker",
      "runAcquisitionWorksiteCreationWorker",
      "createPrismaAutoDecisionSelectionPort",
    ]) {
      assert.ok(!src.includes(forbidden), `wiring ciblé ne doit pas référencer ${forbidden}`)
    }
    assert.equal(src.split("runAcquisitionAutoDecisionWorker(").length - 1, 1)
  })

  it("wiring : worker (branche armée) reçoit ownership + fence de la capability et le port mono-draft", () => {
    const src = targetedWiringSource()
    const iArmed = src.indexOf("!TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED")
    const iWorker = src.indexOf("runAcquisitionAutoDecisionWorker(")
    assert.ok(iArmed > 0 && iWorker > iArmed, "worker après hard-stop")
    assert.ok(src.indexOf("resolveOrchestratorAutoOwnership(capability)") < iArmed, "ownership vérifiée avant hard-stop")
    const call = src.slice(iWorker, src.indexOf("body = {", iWorker))
    assert.match(call, /createTargetedAutoDecisionSelectionPort\(\{ companyId, draftId \}\)/)
    assert.match(call, /ensureOwnership: ownershipCheckFrom\(capability\)/)
    assert.match(call, /transactionalOwnershipFence: fence/)
    assert.match(src, /const fence = resolveOrchestratorAutoTransactionalFence\(capability\)/)
    for (const forbidden of ["resolveSystemActor", "isAutoApproveEnabled", "isAutoConvertEnabled", "evaluationDeps", "review:"]) {
      assert.ok(!call.includes(forbidden))
    }
  })

  it("runner : chemin entièrement valide → TARGETED_RUN_NOT_ARMED sans aucune opération lease", async () => {
    const { out, leaseOps, stepHits } = await runRunner(runnerDeps())
    assert.deepEqual(out, { ok: false, code: "TARGETED_RUN_NOT_ARMED" })
    assert.deepEqual(leaseOps, [])
    assert.deepEqual(stepHits, [])
  })

  it("runner : SUPER_ADMIN du tenant → même hard-stop", async () => {
    const { out, leaseOps } = await runRunner(runnerDeps({ auth: sessionAuth("SUPER_ADMIN") }))
    assert.deepEqual(out, { ok: false, code: "TARGETED_RUN_NOT_ARMED" })
    assert.deepEqual(leaseOps, [])
  })
})

describe("E. runner — surface, gate dédié, rôle, tenant, cible env", () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true", "yes"]) {
    it(`gate ${JSON.stringify(value)} → TARGETED_RUN_DISABLED avant auth`, async () => {
      let authCalls = 0
      const env: Record<string, string | undefined> = { ...RUN_ENV }
      if (value === undefined) delete env[TARGETED_AUTO_DECISION_RUN_GATE]
      else env[TARGETED_AUTO_DECISION_RUN_GATE] = value
      const { out, leaseOps } = await runRunner(
        runnerDeps({
          env,
          auth: (async () => {
            authCalls++
            return { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
          }) as never,
        })
      )
      assert.deepEqual(out, { ok: false, code: "TARGETED_RUN_DISABLED" })
      assert.equal(authCalls, 0)
      assert.deepEqual(leaseOps, [])
    })
  }

  it("le flag CHECK preflight n'active pas le runner", async () => {
    const env: Record<string, string | undefined> = { ...RUN_ENV, TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_ENABLED: "true" }
    delete env[TARGETED_AUTO_DECISION_RUN_GATE]
    const { out } = await runRunner(runnerDeps({ env }))
    assert.deepEqual(out, { ok: false, code: "TARGETED_RUN_DISABLED" })
  })

  it("surface hors preview autorisée → HARNESS_SURFACE_FORBIDDEN", async () => {
    for (const env of [
      { ...RUN_ENV, VERCEL_ENV: "production" },
      { ...RUN_ENV, VERCEL_PROJECT_ID: "prj_other" },
    ]) {
      const { out, leaseOps } = await runRunner(runnerDeps({ env }))
      assert.deepEqual(out, { ok: false, code: "HARNESS_SURFACE_FORBIDDEN" })
      assert.deepEqual(leaseOps, [])
    }
  })

  it("sans session → UNAUTHORIZED ; rôle non admin → FORBIDDEN", async () => {
    assert.deepEqual((await runRunner(runnerDeps({ auth: (async () => null) as never }))).out, {
      ok: false,
      code: "UNAUTHORIZED",
    })
    for (const role of ["USER", "MANAGER", "admin"]) {
      assert.deepEqual((await runRunner(runnerDeps({ auth: sessionAuth(role) }))).out, { ok: false, code: "FORBIDDEN" })
    }
  })

  it("cible env absente → HARNESS_TARGET_UNSET ; draft exclu → FORBIDDEN_DRAFT", async () => {
    for (const over of [
      { TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: "" },
      { TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "   " },
    ]) {
      assert.deepEqual((await runRunner(runnerDeps({ env: { ...RUN_ENV, ...over } }))).out, {
        ok: false,
        code: "HARNESS_TARGET_UNSET",
      })
    }
    assert.deepEqual(
      (
        await runRunner(
          runnerDeps({ env: { ...RUN_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID } })
        )
      ).out,
      { ok: false, code: "FORBIDDEN_DRAFT" }
    )
  })

  it("tenant session ≠ cible (ou null) → TENANT_MISMATCH", async () => {
    for (const companyId of ["co-other", null]) {
      const { out, leaseOps } = await runRunner(runnerDeps({ auth: sessionAuth("SUPER_ADMIN", companyId) }))
      assert.deepEqual(out, { ok: false, code: "TENANT_MISMATCH" })
      assert.deepEqual(leaseOps, [])
    }
  })

  it("aucun paramètre de cible : deps = { env, auth } uniquement, pas de requête", () => {
    const src = readSource(RUNNER_PATH)
    assert.ok(!/req(uest)?\s*:\s*Request/.test(src))
    assert.ok(!/\.json\(\)/.test(src))
    const depsType = src.slice(
      src.indexOf("export type TargetedAutoDecisionRunnerDeps"),
      src.indexOf("export type TargetedAutoDecisionRunOutcome")
    )
    assert.ok(!/companyId|draftId|capability|db\?|journal/.test(depsType))
  })
})

describe("F. CHECK preflight inchangé et READ-ONLY", () => {
  it("le preflight n'importe ni runner, ni sélection ciblée, ni wiring orchestrateur", () => {
    const preflight = readSource(PREFLIGHT_PATH)
    assert.ok(!preflight.includes("targeted-staging-auto-decision-runner"))
    assert.ok(!preflight.includes("targeted-staging-auto-decision-selection"))
    assert.ok(!preflight.includes("acquisition-orchestrator-workers"))
    assert.ok(!/runacquisitionautodecisionworker/i.test(preflight))
    assert.ok(!preflight.includes(TARGETED_AUTO_DECISION_RUN_GATE))
    assert.ok(!readSource(PREFLIGHT_ROUTE_PATH).includes("runner"))
  })

  it("contrat HTTP preflight : confirmation CHECK uniquement", () => {
    const preflight = readSource(PREFLIGHT_PATH)
    assert.ok(preflight.includes('"CHECK_TARGETED_STAGING_AUTO_DECISION_PREFLIGHT"'))
    assert.ok(!/RUN_TARGETED_STAGING_AUTO_DECISION/.test(preflight))
  })
})

describe("G. sélecteur mono-draft strict", () => {
  it("PASS du cycle courant → exactement la cible", async () => {
    const f = portFixture({ validation: { decisionCode: "VALIDATION_PASS" } })
    assert.deepEqual(await f.port.listEligibleCandidates(LIST), [
      {
        draftId: DRAFT,
        companyId: COMPANY,
        status: "PENDING_REVIEW",
        version: 3,
        contentHashAtExtraction: HASH,
        extractionSchemaVersion: "2",
        updatedAt: NOW,
        selectionPath: "PASS",
      },
    ])
    assert.deepEqual((f.findFirstCalls[0] as { where: unknown }).where, { id: DRAFT, companyId: COMPANY })
  })

  it("FAIL_TERMINAL CONSULTATION_CANCELLED → CANCEL (critère production)", async () => {
    const byReason = portFixture({
      validation: { decisionCode: "VALIDATION_FAIL_TERMINAL", reasons: ["CONSULTATION_CANCELLED"] },
    })
    assert.equal((await byReason.port.listEligibleCandidates(LIST))[0]?.selectionPath, "CANCEL")
    const byMeta = portFixture({
      validation: { decisionCode: "VALIDATION_FAIL_TERMINAL", metadata: { errorCode: "CONSULTATION_CANCELLED" } },
    })
    assert.equal((await byMeta.port.listEligibleCandidates(LIST))[0]?.selectionPath, "CANCEL")
  })

  it("ligne d'un autre draft / tenant jamais retournée ; draft introuvable → []", async () => {
    for (const row of [draftRow({ id: "draft-other" }), draftRow({ companyId: "co-other" }), null]) {
      const f = portFixture({ row, validation: { decisionCode: "VALIDATION_PASS" } })
      assert.deepEqual(await f.port.listEligibleCandidates(LIST), [])
      assert.equal(f.journalCalls.length, 0)
    }
  })

  it("limit < 1 / NaN → [] sans lecture", async () => {
    for (const limit of [0, -1, Number.NaN]) {
      const f = portFixture({ validation: { decisionCode: "VALIDATION_PASS" } })
      assert.deepEqual(await f.port.listEligibleCandidates({ ...LIST, limit }), [])
      assert.equal(f.findFirstCalls.length, 0)
    }
  })

  it("statuts hors PENDING_REVIEW (dont REJECTED/RECONCILE) → []", async () => {
    for (const status of ["REJECTED", "APPROVED", "CONVERTED", "EXTRACTING"]) {
      const f = portFixture({ row: draftRow({ status }), validation: { decisionCode: "VALIDATION_PASS" } })
      assert.deepEqual(await f.port.listEligibleCandidates(LIST), [])
    }
  })

  it("cycle antérieur (version / hash / schéma) → [] ; cycle courant exact demandé", async () => {
    for (const validationCycle of [
      { contentHash: HASH, extractionSchemaVersion: "2", draftVersion: 2 },
      { contentHash: "hash-old", extractionSchemaVersion: "2", draftVersion: 3 },
      { contentHash: HASH, extractionSchemaVersion: "1", draftVersion: 3 },
    ]) {
      const f = portFixture({ validation: { decisionCode: "VALIDATION_PASS" }, validationCycle })
      assert.deepEqual(await f.port.listEligibleCandidates(LIST), [])
      assert.deepEqual(f.journalCalls, [
        { companyId: COMPANY, draftId: DRAFT, cycle: { contentHash: HASH, extractionSchemaVersion: "2", draftVersion: 3 } },
      ])
    }
  })

  it("hash source absent → [] ; validation absente / non-PASS non-annulation → []", async () => {
    const noHash = portFixture({ row: draftRow({ contentHashAtExtraction: null }), validation: { decisionCode: "VALIDATION_PASS" } })
    assert.deepEqual(await noHash.port.listEligibleCandidates(LIST), [])
    for (const validation of [
      null,
      { decisionCode: "VALIDATION_FAIL_TERMINAL", reasons: ["AMBIGUOUS_ADDRESS"] },
      { decisionCode: "VALIDATION_FAIL_RETRYABLE", reasons: ["CONSULTATION_CANCELLED"] },
      { decisionCode: "VALIDATION_HUMAN_REVIEW" },
    ]) {
      assert.deepEqual(await portFixture({ validation }).port.listEligibleCandidates(LIST), [])
    }
  })

  it("aucun scan global : ni SQL brut, ni findMany, ni transaction ; jamais le selector global", async () => {
    const f = portFixture({ validation: { decisionCode: "VALIDATION_PASS" } })
    await f.port.listEligibleCandidates(LIST)
    assert.deepEqual(f.forbiddenCalls, [])
    const src = readSource(SELECTION_PATH)
    assert.ok(!src.includes("createPrismaAutoDecisionSelectionPort"))
    assert.ok(!/\$queryRaw|\$executeRaw|findMany/.test(src))
  })
})

describe("H. politiques production non contournées (partner, kill-switches, system actor)", () => {
  it("liste blanche exacte des deps worker, bornes à 1", () => {
    const selection: AutoDecisionWorkerSelectionPort = { listEligibleCandidates: async () => [] }
    const deps = buildTargetedAutoDecisionWorkerDeps({
      selection,
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: FAKE_FENCE,
      maxDurationMs: 1_000,
    })
    assert.deepEqual(Object.keys(deps).sort(), [
      "ensureOwnership",
      "maxCandidates",
      "maxDurationMs",
      "maxPerCompany",
      "maxScan",
      "resolveEffectiveAutoFlags",
      "selection",
      "transactionalOwnershipFence",
    ])
    // Seul override de politique : le resolver target-only fixe.
    assert.equal(deps.resolveEffectiveAutoFlags, resolveTargetedAutoDecisionEffectiveFlags)
    assert.equal(deps.selection, selection)
    assert.equal(deps.maxCandidates, 1)
    assert.equal(deps.maxScan, 1)
    assert.equal(deps.maxPerCompany, 1)
    for (const file of [SELECTION_PATH, RUNNER_PATH]) {
      const src = readCode(file)
      for (const forbidden of [
        "resolveSystemActor",
        "isAutoApproveEnabled",
        "isAutoConvertEnabled",
        "evaluationDeps",
        "autoApproveEnabled",
        "autoConvertEnabled",
        "processCandidate",
        "evaluateAutoDecision",
        "ImportDraftReviewService",
      ]) {
        assert.ok(!src.includes(forbidden), `${file} ne doit pas référencer ${forbidden}`)
      }
    }
  })

  it("partner OFF reste OFF même kill-switches globaux ON", () => {
    assert.deepEqual(
      computeEffectiveAutoFlags({
        partnerAutoApprove: false,
        partnerAutoConvert: false,
        globalAutoApprove: true,
        globalAutoConvert: true,
      }),
      { effectiveAutoApproveEnabled: false, effectiveAutoConvertEnabled: false }
    )
  })

  it("kill-switch auto-approve OFF, deps SANS resolver (production) → worker réel SKIPPED avant sélection", async () => {
    let selected = 0
    const trap = trapDb()
    const { resolveEffectiveAutoFlags: _targetedOnly, ...productionLike } = buildTargetedAutoDecisionWorkerDeps({
      selection: {
        async listEligibleCandidates() {
          selected++
          return []
        },
      },
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: FAKE_FENCE,
      db: trap.db,
      journal: trap.db as never,
    })
    void _targetedOnly
    const out = await runAcquisitionAutoDecisionWorker({ ...productionLike, log: () => {} })
    assert.equal(out.status, "SKIPPED")
    assert.equal(out.skipReason, "AUTO_APPROVE_DISABLED")
    assert.equal(selected, 0)
    assert.deepEqual(trap.accesses, [])
  })

  it("kill-switch OFF, deps ciblées, cible env non autorisée → candidat ignoré sans aucun accès DB", async () => {
    // TARGETED_STAGING_* absentes (beforeEach) : le resolver refuse toute cible.
    const trap = trapDb()
    const deps = buildTargetedAutoDecisionWorkerDeps({
      selection: {
        async listEligibleCandidates() {
          return [
            {
              draftId: DRAFT,
              companyId: COMPANY,
              status: "PENDING_REVIEW",
              version: 3,
              contentHashAtExtraction: HASH,
              extractionSchemaVersion: "2",
              updatedAt: NOW,
              selectionPath: "PASS",
            },
          ]
        },
      },
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: FAKE_FENCE,
      db: trap.db,
      journal: trap.db as never,
    })
    const out = await runAcquisitionAutoDecisionWorker({ ...deps, log: () => {} })
    assert.equal(out.stats.skipped, 1)
    assert.equal(out.stats.intentAppended, 0)
    assert.deepEqual(trap.accesses, [])
  })

  it("worker réel : ownership sans fence → FAILED ; NOT_OWNED → SKIPPED (aucune sélection)", async () => {
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    for (const [ensureOwnership, fence, status] of [
      [async () => "OWNED" as const, undefined, "FAILED"],
      [async () => "NOT_OWNED" as const, FAKE_FENCE, "SKIPPED"],
    ] as const) {
      let selected = 0
      const trap = trapDb()
      const deps = buildTargetedAutoDecisionWorkerDeps({
        selection: {
          async listEligibleCandidates() {
            selected++
            return []
          },
        },
        ensureOwnership,
        transactionalOwnershipFence: fence as never,
        db: trap.db,
        journal: trap.db as never,
      })
      const out = await runAcquisitionAutoDecisionWorker({ ...deps, log: () => {} })
      assert.equal(out.status, status)
      assert.equal(out.skipReason, "LEASE_STOLEN")
      assert.equal(selected, 0)
      assert.deepEqual(trap.accesses, [])
    }
  })

  it("system actor absent → SYSTEM_ACTOR_MISSING (résolveur production, sans DB)", async () => {
    const trap = trapDb()
    assert.deepEqual(await resolveValidatedSystemActor(COMPANY, trap.db), {
      ok: false,
      code: "SYSTEM_ACTOR_MISSING",
      reason: "env_unset",
    })
    assert.deepEqual(trap.accesses, [])
  })
})
