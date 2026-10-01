/**
 * Exemption TARGET-ONLY du gate conversion (isAcquisitionConversionFullyEnabled) — unitaires.
 * VRAI ImportDraftConversionService / VRAI worker worksiteCreation / VRAI wiring ; DB mockée
 * sans aucune connexion. Les garanties transactionnelles (rollback, claim, concurrence) sont
 * prouvées sur PostgreSQL réel dans targeted-staging-conversion-gate.pg.test.ts.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { PrismaClient } from "@prisma/client"
import type { ConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import type { ConversionTransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import type {
  ConversionActorContext,
  ConversionMasterGateExemption,
  ConvertImportDraftResult,
} from "@/lib/acquisition/conversion/conversion.types"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import {
  InMemoryAcquisitionOrchestratorLeaseRepository,
  acquisitionOrchestratorLeaseRepository,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import * as orchestratorWorkers from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import { runTargetedWorksiteCreationUnderOrchestratorLease } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import {
  runAcquisitionWorksiteCreationWorker,
  type WorksiteCreationWorkerCandidate,
  type WorksiteCreationWorkerDeps,
} from "@/lib/acquisition/orchestrator/acquisition-worksite-creation.worker"
import {
  buildTargetedWorksiteCreationWorkerDeps,
  createTargetedWorksiteCreationSelectionPort,
  targetedConversionMasterGateExemption,
} from "@/lib/acquisition/orchestrator/targeted-staging-worksite-creation-selection"
import type { AutoDecisionIntentCode, JournalRow } from "@/lib/acquisition/policy/decision-journal.repository"
import { prisma } from "@/lib/prisma"
import {
  GEOCODE_SETTLE_MS,
  TARGETED_WORKSITE_CREATION_CONFIRMATION,
  evaluateTargetedWorksiteCreationScriptGuards,
  summarizeRun,
} from "../../scripts/run-targeted-staging-worksite-creation"

const ROOT = path.resolve(__dirname, "../..")
const SERVICE_PATH = "src/lib/acquisition/conversion/conversion.service.ts"
const WORKER_PATH = "src/lib/acquisition/orchestrator/acquisition-worksite-creation.worker.ts"
const SELECTION_PATH = "src/lib/acquisition/orchestrator/targeted-staging-worksite-creation-selection.ts"
const WIRING_PATH = "src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts"
const SCRIPT_PATH = "scripts/run-targeted-staging-worksite-creation.ts"

const COMPANY = "co-conv-target"
const DRAFT = "draft-conv-target"

const ENV_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONVERSION_ENABLED",
  "ACQUISITION_AUTO_APPROVE_ENABLED",
  "ACQUISITION_AUTO_CONVERT_ENABLED",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  // Gates globaux OFF ; cible serveur autorisée par défaut.
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
  dbCalls.length = 0
  dbArgs.length = 0
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function globalFlags() {
  return {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    conversion: process.env.ACQUISITION_CONVERSION_ENABLED,
  }
}

function readCode(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

function patchMethod<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): () => void {
  const original = target[key]
  target[key] = impl
  return () => {
    target[key] = original
  }
}

// ---------------------------------------------------------------------------
// Service réel, DB mockée enregistrant toute opération (aucune connexion).
// Signal « gate franchi » : la 1re lecture (early findFirst) a lieu → NOT_FOUND (DB vide).
// ---------------------------------------------------------------------------

function recordingDb(opts: { draft?: Record<string, unknown> | null } = {}) {
  const ops: string[] = []
  const writes: string[] = []
  const api: Record<string, unknown> = {
    worksiteImportDraft: {
      findFirst: async () => {
        ops.push("worksiteImportDraft.findFirst")
        return opts.draft ?? null
      },
      updateMany: async () => {
        ops.push("worksiteImportDraft.updateMany")
        writes.push("worksiteImportDraft.updateMany")
        return { count: 1 }
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
        ops.push(`UNEXPECTED:${prop}`)
        writes.push(`UNEXPECTED:${prop}`)
        throw new Error(`UNEXPECTED_MODEL:${prop}`)
      }
      return target[prop as string]
    },
  })
  return { db: db as unknown as PrismaClient, ops, writes }
}

const OWNED_FENCE: ConversionTransactionalOwnershipFence = { assertOwnedAndLock: async () => "OWNED" }
const NOT_OWNED_FENCE: ConversionTransactionalOwnershipFence = { assertOwnedAndLock: async () => "NOT_OWNED" }
const SYSTEM: ConversionActorContext = { actorUserId: "sys1", actorRole: "SYSTEM", companyId: COMPANY }
const ADMIN: ConversionActorContext = { actorUserId: "u1", actorRole: "ADMIN", companyId: COMPANY }
const INPUT = { draftId: DRAFT, expectedVersion: 6, clientMode: "EXISTING", existingClientId: "cli1" }

async function convert(opts: {
  ctx?: ConversionActorContext
  input?: unknown
  fence?: ConversionTransactionalOwnershipFence | null
  exemption?: ConversionMasterGateExemption | null
  draft?: Record<string, unknown> | null
}) {
  const { db, ops, writes } = recordingDb({ draft: opts.draft })
  const svc = new ImportDraftConversionService({ db, log: () => {}, geocode: { geocodeAddress: async () => null } })
  const fence = opts.fence === null ? undefined : (opts.fence ?? OWNED_FENCE)
  const exemption = opts.exemption === null ? undefined : (opts.exemption ?? targetedConversionMasterGateExemption)
  const before = globalFlags()
  const out = await svc.convertImportDraft(opts.ctx ?? SYSTEM, opts.input ?? INPUT, {
    ...(fence ? { transactionalOwnershipFence: fence } : {}),
    ...(exemption ? { conversionMasterGateExemption: exemption } : {}),
  })
  assert.deepEqual(globalFlags(), before, "aucun flag global modifié")
  return { out, ops, writes }
}

const code = (out: ConvertImportDraftResult) => (out.ok ? out.outcome : out.code)

describe("service réel — gate conversion OFF + exemption ciblée", () => {
  it("sans exemption (chemin normal) → CONVERSION_DISABLED, zéro accès DB", async () => {
    for (const ctx of [SYSTEM, ADMIN]) {
      const r = await convert({ ctx, exemption: null, fence: ctx === ADMIN ? null : undefined })
      assert.equal(code(r.out), "CONVERSION_DISABLED")
      assert.deepEqual(r.ops, [])
    }
  })

  it("gates OFF + cible exacte + SYSTEM + fence → gate franchi (1re lecture exécutée)", async () => {
    const r = await convert({})
    assert.equal(code(r.out), "NOT_FOUND")
    assert.deepEqual(r.ops, ["worksiteImportDraft.findFirst"])
    assert.deepEqual(r.writes, [])
  })

  const refused: Array<[string, () => void, Parameters<typeof convert>[0]]> = [
    ["mauvaise company", () => {}, { ctx: { ...SYSTEM, companyId: "co-other" } }],
    ["mauvais draft", () => {}, { input: { ...INPUT, draftId: "draft-other" } }],
    ["acteur ADMIN", () => {}, { ctx: ADMIN }],
    ["acteur SUPER_ADMIN", () => {}, { ctx: { ...ADMIN, actorRole: "SUPER_ADMIN" } }],
    ["fence absent", () => {}, { fence: null }],
    ["env company absente", () => delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID, {}],
    ["env draft absente", () => delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID, {}],
    ["env company vide", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = "  "), {}],
    ["env draft vide", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = ""), {}],
    ["casse différente", () => (process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT.toUpperCase()), {}],
    ["cible inversée", () => {
      process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = DRAFT
      process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = COMPANY
    }, {}],
    ["entrée invalide (clientMode manquant)", () => {}, { input: { draftId: DRAFT, expectedVersion: 6 } }],
    ["entrée invalide (expectedVersion non entier)", () => {}, { input: { ...INPUT, expectedVersion: "6" } }],
  ]
  for (const [label, setup, opts] of refused) {
    it(`${label} → CONVERSION_DISABLED, zéro accès DB`, async () => {
      setup()
      const r = await convert(opts)
      assert.equal(code(r.out), "CONVERSION_DISABLED")
      assert.deepEqual(r.ops, [])
    })
  }

  it("port qui lève / retourne une valeur non strictement true → CONVERSION_DISABLED", async () => {
    for (const exemption of [
      { allowsConversion: () => { throw new Error("boom") } },
      { allowsConversion: () => "true" as unknown as boolean },
      { allowsConversion: () => 1 as unknown as boolean },
      { allowsConversion: () => undefined as unknown as boolean },
    ]) {
      const r = await convert({ exemption })
      assert.equal(code(r.out), "CONVERSION_DISABLED")
      assert.deepEqual(r.ops, [])
    }
  })

  it("défense indépendante : port toujours true + acteur non SYSTEM → refusé ; SYSTEM → franchi", async () => {
    const alwaysTrue: ConversionMasterGateExemption = { allowsConversion: () => true }
    for (const ctx of [ADMIN, { ...ADMIN, actorRole: "SUPER_ADMIN" as const }]) {
      const r = await convert({ ctx, exemption: alwaysTrue })
      assert.equal(code(r.out), "CONVERSION_DISABLED")
      assert.deepEqual(r.ops, [])
    }
    assert.equal(code((await convert({ exemption: alwaysTrue })).out), "NOT_FOUND")
  })

  it("défense indépendante : implémentation ciblée refuse tout rôle non SYSTEM sur la cible exacte", () => {
    for (const actorRole of ["ADMIN", "SUPER_ADMIN", "USER", "system", ""]) {
      assert.equal(
        targetedConversionMasterGateExemption.allowsConversion({ companyId: COMPANY, draftId: DRAFT, actorRole: actorRole as never }),
        false,
        actorRole
      )
    }
    assert.equal(
      targetedConversionMasterGateExemption.allowsConversion({ companyId: COMPANY, draftId: DRAFT, actorRole: "SYSTEM" }),
      true
    )
    assert.ok(Object.isFrozen(targetedConversionMasterGateExemption))
  })

  it("fence NOT_OWNED (gate franchi) → LEASE_NOT_OWNED, aucune écriture", async () => {
    const r = await convert({
      fence: NOT_OWNED_FENCE,
      draft: { status: "APPROVED", createdWorksiteId: null, createdWorksite: null },
    })
    assert.equal(code(r.out), "LEASE_NOT_OWNED")
    assert.deepEqual(r.writes, [])
    // Fence évalué en tête de TX : aucune lecture métier après le fence.
    assert.deepEqual(r.ops, ["worksiteImportDraft.findFirst", "$transaction"])
  })

  it("gates normaux ON → chemin historique, exemption jamais consultée", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
    let consulted = 0
    const spy: ConversionMasterGateExemption = {
      allowsConversion: () => {
        consulted++
        return false
      },
    }
    assert.equal(code((await convert({ ctx: ADMIN, fence: null, exemption: null })).out), "NOT_FOUND")
    assert.equal(code((await convert({ exemption: null })).out), "NOT_FOUND")
    assert.equal(code((await convert({ exemption: spy })).out), "NOT_FOUND")
    // Cible non autorisée : sans importance quand le gate est ON (historique).
    delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    assert.equal(code((await convert({ ctx: ADMIN, fence: null, exemption: null })).out), "NOT_FOUND")
    assert.equal(consulted, 0)
  })

  it("gate partiellement ON (une seule composante) sans exemption → CONVERSION_DISABLED (historique)", async () => {
    for (const [master, conv] of [["true", undefined], [undefined, "true"]] as const) {
      delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
      delete process.env.ACQUISITION_CONVERSION_ENABLED
      if (master) process.env.PLANIFICATOR_ACQUISITION_ENABLED = master
      if (conv) process.env.ACQUISITION_CONVERSION_ENABLED = conv
      assert.equal(code((await convert({ ctx: ADMIN, fence: null, exemption: null })).out), "CONVERSION_DISABLED")
      assert.equal(code((await convert({})).out), "NOT_FOUND", "exemption ciblée lève les deux composantes")
    }
  })

  it("master ON + conversion ON : SYSTEM sans fence → LEASE_NOT_OWNED (historique)", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
    const r = await convert({ fence: null, exemption: null })
    assert.equal(code(r.out), "LEASE_NOT_OWNED")
    assert.deepEqual(r.ops, [])
  })

  it("source : seule modification du gate = `!enabled && !exempted` ; isAcquisitionConversionFullyEnabled inchangé", () => {
    const src = readCode(SERVICE_PATH)
    assert.match(src, /if \(!isAcquisitionConversionFullyEnabled\(\) && !isConversionGateExempted\(ctx, raw, options\)\) \{/)
    const flags = readFileSync(path.join(ROOT, "src/lib/acquisition/conversion/conversion-feature-flag.ts"), "utf8")
    assert.match(flags, /process\.env\.PLANIFICATOR_ACQUISITION_ENABLED === "true" &&\s*process\.env\.ACQUISITION_CONVERSION_ENABLED === "true"/)
  })
})

// ---------------------------------------------------------------------------
// Sélection mono-target + deps ciblées
// ---------------------------------------------------------------------------

function portDb(row: Record<string, unknown> | null) {
  const calls: unknown[] = []
  const forbidden: string[] = []
  const forbid = (n: string) => () => {
    forbidden.push(n)
    throw new Error(`FORBIDDEN:${n}`)
  }
  const db = {
    worksiteImportDraft: {
      findFirst: async (args: unknown) => {
        calls.push(args)
        return row
      },
      findMany: forbid("findMany"),
    },
    $queryRaw: forbid("$queryRaw"),
    $queryRawUnsafe: forbid("$queryRawUnsafe"),
    $transaction: forbid("$transaction"),
  } as unknown as PrismaClient
  return { db, calls, forbidden }
}

function targetRow(over: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "APPROVED",
    version: 6,
    createdWorksiteId: null,
    contentHashAtExtraction: "hash-x",
    extractionSchemaVersion: "3",
    updatedAt: new Date("2026-09-30T00:00:00Z"),
    ...over,
  }
}

const LIST = { limit: 1, now: new Date(), maxPerCompany: 1 }

describe("sélection mono-target — aucun scan de backlog", () => {
  it("cible APPROVED sans chantier → exactement la cible ; lecture id + companyId uniquement", async () => {
    const p = portDb(targetRow())
    const port = createTargetedWorksiteCreationSelectionPort({ companyId: COMPANY, draftId: DRAFT, db: p.db })
    const out = await port.listEligibleCandidates(LIST)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.draftId, DRAFT)
    assert.equal(out[0]!.version, 6)
    assert.deepEqual((p.calls[0] as { where: unknown }).where, { id: DRAFT, companyId: COMPANY })
    assert.deepEqual(p.forbidden, [])
  })

  it("autre draft / autre tenant / introuvable / non APPROVED / chantier existant / hash absent → []", async () => {
    for (const row of [
      targetRow({ id: "draft-other" }),
      targetRow({ companyId: "co-other" }),
      null,
      targetRow({ status: "PENDING_REVIEW" }),
      targetRow({ status: "CONVERTED" }),
      targetRow({ createdWorksiteId: "ws-1" }),
      targetRow({ contentHashAtExtraction: null }),
    ]) {
      const p = portDb(row)
      const port = createTargetedWorksiteCreationSelectionPort({ companyId: COMPANY, draftId: DRAFT, db: p.db })
      assert.deepEqual(await port.listEligibleCandidates(LIST), [])
    }
  })

  it("limit < 1 / NaN → [] sans lecture", async () => {
    for (const limit of [0, -1, Number.NaN]) {
      const p = portDb(targetRow())
      const port = createTargetedWorksiteCreationSelectionPort({ companyId: COMPANY, draftId: DRAFT, db: p.db })
      assert.deepEqual(await port.listEligibleCandidates({ ...LIST, limit }), [])
      assert.equal(p.calls.length, 0)
    }
  })

  it("source : ni SQL brut, ni findMany, ni selector global", () => {
    const src = readCode(SELECTION_PATH)
    assert.ok(!/\$queryRaw|\$executeRaw|findMany|createPrismaWorksiteCreationSelectionPort/.test(src))
  })

  it("deps ciblées : liste blanche exacte, bornes 1, exemption figée, aucun override conversion/actor/contexte", () => {
    const selection = { listEligibleCandidates: async () => [] }
    const deps = buildTargetedWorksiteCreationWorkerDeps({
      selection,
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: OWNED_FENCE,
      maxDurationMs: 1_000,
    })
    assert.deepEqual(Object.keys(deps).sort(), [
      "conversionMasterGateExemption",
      "ensureOwnership",
      "maxCandidates",
      "maxDurationMs",
      "maxPerCompany",
      "maxScan",
      "selection",
      "transactionalOwnershipFence",
    ])
    assert.equal(deps.conversionMasterGateExemption, targetedConversionMasterGateExemption)
    assert.equal(deps.maxCandidates, 1)
    assert.equal(deps.maxScan, 1)
    assert.equal(deps.maxPerCompany, 1)
  })
})

// ---------------------------------------------------------------------------
// Worker réel : pass-through de l'exemption, pas de retry sur STATE_CHANGED / INVALID_STATE
// (harnais repris de acquisition-worksite-creation.worker.test.ts)
// ---------------------------------------------------------------------------

function intentRow(): JournalRow & { decisionCode: AutoDecisionIntentCode } {
  return {
    id: "i1",
    companyId: COMPANY,
    draftId: DRAFT,
    reasons: [],
    scores: {},
    actorUserId: "sys1",
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: { contentHash: "hash-x", extractionSchemaVersion: "3", validatedDraftVersion: 5 },
    },
    createdAt: new Date(),
    decisionCode: "AUTO_APPROVE_CONVERT",
  }
}

function workerDb() {
  const draft = {
    id: DRAFT,
    companyId: COMPANY,
    status: "APPROVED",
    version: 6,
    createdWorksiteId: null,
    contentHashAtExtraction: "hash-x",
    extractionSchemaVersion: "3",
    proposedWorksiteName: "Chantier cible",
    proposedClientName: "Client SA",
    proposedAddress: "1 rue",
    proposedPostalCode: "75001",
    proposedCity: "Paris",
    proposedStartDate: new Date("2026-09-11"),
    proposedEndDate: null,
    proposedClientId: null,
    confidenceData: {},
    warningData: [],
    extractedData: { clientEmail: "c@example.com" },
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: "lauralu.fr", threadId: "t1" },
  }
  return { worksiteImportDraft: { findFirst: async () => ({ ...draft }) } } as never
}

const registry = {
  findPartnerById: async () => ({
    id: "p1",
    code: "lauralu",
    active: true,
    minConfidence: null,
    autoApproveEnabled: false,
    autoConvertEnabled: false,
    allowCreateClient: false,
    clientId: null,
    requireExactEmail: false,
  }),
  findPartnerByDomain: async () => null,
}

type ConvertCall = { raw: unknown; options: Record<string, unknown> | undefined }

async function runWorker(opts: {
  targeted: boolean
  fence?: boolean
  convertResult?: ConvertImportDraftResult
}) {
  const calls: ConvertCall[] = []
  const db = workerDb()
  const candidate: WorksiteCreationWorkerCandidate = {
    draftId: DRAFT,
    companyId: COMPANY,
    status: "APPROVED",
    version: 6,
    contentHashAtExtraction: "hash-x",
    extractionSchemaVersion: "3",
    updatedAt: new Date(),
  }
  const selection = { listEligibleCandidates: async () => [candidate] }
  const base: WorksiteCreationWorkerDeps = opts.targeted
    ? buildTargetedWorksiteCreationWorkerDeps({
        selection,
        ensureOwnership: async () => "OWNED",
        transactionalOwnershipFence: OWNED_FENCE,
      })
    : {
        selection,
        ensureOwnership: async () => "OWNED",
        ...(opts.fence === false ? {} : { transactionalOwnershipFence: OWNED_FENCE }),
      }
  if (opts.targeted && opts.fence === false) delete base.transactionalOwnershipFence
  const result = await runAcquisitionWorksiteCreationWorker({
    ...base,
    db,
    journal: { findLatestPostExtractionAutoIntentForExtractionIdentity: async () => intentRow() } as never,
    resolveSystemActor: async () => ({ ok: true, userId: "sys1", role: "ADMIN" }),
    evaluationDeps: {
      db,
      matchClient: async () => ({ clientId: "cli1", matchKind: "EMAIL" as const }),
      findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
      registry: registry as never,
    },
    conversion: {
      convertImportDraft: async (_ctx: ConversionActorContext, raw: unknown, options?: unknown) => {
        calls.push({ raw, options: options as Record<string, unknown> | undefined })
        return (
          opts.convertResult ?? {
            ok: true as const,
            outcome: "CONVERTED" as const,
            worksiteId: "ws1",
            clientId: "cli1",
            clientCreated: false,
            documentCount: 0,
            skippedAttachmentCount: 0,
          }
        )
      },
    },
    log: () => {},
  })
  return { result, calls }
}

describe("worker réel — pass-through et concurrence (sans retry)", () => {
  it("deps ciblées → exemption figée + fence transmis ; expectedVersion = relecture finale (6)", async () => {
    const { result, calls } = await runWorker({ targeted: true })
    assert.equal(result.stats.converted, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.options?.conversionMasterGateExemption, targetedConversionMasterGateExemption)
    assert.equal(calls[0]!.options?.transactionalOwnershipFence, OWNED_FENCE)
    assert.equal((calls[0]!.raw as { expectedVersion: number }).expectedVersion, 6)
  })

  it("chemin production (sans exemption) → options de conversion inchangées (aucune clé d'exemption)", async () => {
    const { calls } = await runWorker({ targeted: false })
    assert.equal(calls.length, 1)
    assert.deepEqual(Object.keys(calls[0]!.options ?? {}).sort(), ["requireSourceContentHash", "transactionalOwnershipFence"])
  })

  it("exemption sans fence → jamais transmise", async () => {
    const { calls } = await runWorker({ targeted: true, fence: false })
    assert.equal(calls.length, 1)
    assert.ok(!("conversionMasterGateExemption" in (calls[0]!.options ?? {})))
  })

  for (const outcome of ["STATE_CHANGED", "INVALID_STATE"] as const) {
    it(`${outcome} → arrêt fail-closed, un seul appel de conversion (aucun retry)`, async () => {
      const { result, calls } = await runWorker({
        targeted: true,
        convertResult: { ok: false, outcome, code: outcome, message: "x" },
      })
      assert.equal(calls.length, 1)
      assert.equal(result.stats.stateChanged, 1)
      assert.equal(result.stats.converted, 0)
      assert.equal(result.stats.errors, 0)
    })
  }

  it("source : chemin production createProductionStepRunners.worksiteCreation sans exemption", () => {
    const src = readCode(WIRING_PATH)
    const step = src.slice(src.indexOf("worksiteCreation: async"), src.indexOf("worksiteCreation: async") + 700)
    assert.ok(!step.includes("conversionMasterGateExemption"))
    assert.ok(!step.includes("buildTargetedWorksiteCreationWorkerDeps"))
    const worker = readCode(WORKER_PATH)
    assert.match(
      worker,
      /\.\.\.\(input\.transactionalOwnershipFence && input\.conversionMasterGateExemption\n\s*\? \{ conversionMasterGateExemption: input\.conversionMasterGateExemption \}\n\s*: \{\}\),/
    )
  })
})

// ---------------------------------------------------------------------------
// Wiring réel : lease canonique (repository production patché → mémoire), Prisma mocké.
// ---------------------------------------------------------------------------

const dbCalls: string[] = []
const dbArgs: unknown[] = []
prisma.$use(async (params) => {
  const key = `${params.model ?? "raw"}.${params.action}`
  dbCalls.push(key)
  dbArgs.push(params.args)
  if (key === "WorksiteImportDraft.findFirst") return null
  throw new Error(`DB_ACCESS_FORBIDDEN:${key}`)
})

function installLease(opts: { busyBy?: string } = {}) {
  const mem = new InMemoryAcquisitionOrchestratorLeaseRepository()
  if (opts.busyBy) mem.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, opts.busyBy, 60_000)
  const ops: Array<{ op: string; ownerRunId: string }> = []
  const repo = acquisitionOrchestratorLeaseRepository
  const restore = (["acquire", "assertOwned", "renew", "release"] as const).map((op) =>
    patchMethod(repo, op, (async (input: { ownerRunId: string }) => {
      ops.push({ op, ownerRunId: input.ownerRunId })
      return (mem[op] as (i: unknown) => Promise<unknown>)(input)
    }) as never)
  )
  return { mem, ops, restore: () => restore.forEach((fn) => fn()) }
}

describe("wiring runTargetedWorksiteCreationUnderOrchestratorLease", () => {
  it("export ajouté ; factory capability toujours privée", () => {
    assert.equal(typeof orchestratorWorkers.runTargetedWorksiteCreationUnderOrchestratorLease, "function")
    assert.equal("createOrchestratorAutoCapability" in orchestratorWorkers, false)
  })

  it("cible ≠ env / env absente → TARGET_NOT_AUTHORIZED avant toute opération lease ou DB", async () => {
    for (const target of [
      { companyId: COMPANY, draftId: "draft-other" },
      { companyId: "co-other", draftId: DRAFT },
      { companyId: ` ${COMPANY}`, draftId: DRAFT },
    ]) {
      const lease = installLease()
      try {
        assert.deepEqual(await runTargetedWorksiteCreationUnderOrchestratorLease({ target }), {
          outcome: "TARGET_NOT_AUTHORIZED",
        })
        assert.deepEqual(lease.ops, [])
        assert.deepEqual(dbCalls, [])
      } finally {
        lease.restore()
      }
    }
    delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    const lease = installLease()
    try {
      assert.deepEqual(
        await runTargetedWorksiteCreationUnderOrchestratorLease({ target: { companyId: COMPANY, draftId: DRAFT } }),
        { outcome: "TARGET_NOT_AUTHORIZED" }
      )
      assert.deepEqual(lease.ops, [])
    } finally {
      lease.restore()
    }
  })

  it("cible exacte → lease canonique, heartbeat, worker (sélection mono-target), release ; gates OFF", async () => {
    const lease = installLease()
    try {
      const out = await runTargetedWorksiteCreationUnderOrchestratorLease({ target: { companyId: COMPANY, draftId: DRAFT } })
      assert.equal(out.outcome, "WORKER_FINISHED", JSON.stringify(out))
      if (out.outcome === "WORKER_FINISHED") {
        assert.equal(out.release, "RELEASED")
        assert.equal(out.worker.stats.selected, 0)
        assert.equal(out.worker.stats.converted, 0)
      }
      assert.deepEqual(
        lease.ops.map((o) => o.op),
        ["acquire", "assertOwned", "renew", "assertOwned", "renew", "release"]
      )
      assert.match(lease.ops[0]!.ownerRunId, /^targeted-worksite-creation:[0-9a-f-]{36}$/)
      assert.ok(lease.ops.every((o) => o.ownerRunId === lease.ops[0]!.ownerRunId))
      assert.deepEqual(dbCalls, ["WorksiteImportDraft.findFirst"])
      assert.deepEqual((dbArgs[0] as { where: unknown }).where, { id: DRAFT, companyId: COMPANY })
      assert.ok(!JSON.stringify(out).includes(lease.ops[0]!.ownerRunId))
      assert.equal(process.env.PLANIFICATOR_ACQUISITION_ENABLED, undefined)
      assert.equal(process.env.ACQUISITION_CONVERSION_ENABLED, undefined)
    } finally {
      lease.restore()
    }
  })

  it("lease occupée → ALREADY_RUNNING, aucun worker ni DB, lease intacte", async () => {
    const lease = installLease({ busyBy: "cron-run-live" })
    try {
      assert.deepEqual(
        await runTargetedWorksiteCreationUnderOrchestratorLease({ target: { companyId: COMPANY, draftId: DRAFT } }),
        { outcome: "ALREADY_RUNNING" }
      )
      assert.deepEqual(lease.ops.map((o) => o.op), ["acquire"])
      assert.deepEqual(dbCalls, [])
      assert.equal(lease.mem.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "cron-run-live")
    } finally {
      lease.restore()
    }
  })

  it("ownership perdue avant worker → LEASE_NOT_OWNED, aucune lecture métier, release tentée", async () => {
    const lease = installLease()
    const repo = acquisitionOrchestratorLeaseRepository
    const restoreSteal = patchMethod(repo, "acquire", (async (input: { ownerRunId: string; key: string; leaseTtlMs: number }) => {
      lease.ops.push({ op: "acquire", ownerRunId: input.ownerRunId })
      const r = await lease.mem.acquire(input)
      lease.mem.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "cron-run-thief", 60_000)
      return r
    }) as never)
    try {
      const out = await runTargetedWorksiteCreationUnderOrchestratorLease({ target: { companyId: COMPANY, draftId: DRAFT } })
      assert.deepEqual(out, { outcome: "LEASE_NOT_OWNED", release: "NOT_OWNER" })
      assert.deepEqual(dbCalls, [])
      assert.equal(lease.ops.at(-1)?.op, "release")
    } finally {
      restoreSteal()
      lease.restore()
    }
  })

  it("source : capability créée après ACQUIRED, cible vérifiée avant acquire, release en finally, sans hardcode de version", () => {
    const src = readCode(WIRING_PATH)
    const start = src.indexOf("export async function runTargetedWorksiteCreationUnderOrchestratorLease")
    const fn = src.slice(start, src.indexOf("export type TargetedAutoDecisionLeaseReleaseState", start))
    const iAuth = fn.indexOf("isAuthorizedTargetedAutoDecisionTarget({ companyId, draftId })")
    const iAcquire = fn.indexOf("leaseRepository.acquire(")
    const iAcquired = fn.indexOf('if (!acquired) return { outcome: "ALREADY_RUNNING" }')
    const iCap = fn.indexOf("createOrchestratorAutoCapability({")
    const iFinally = fn.indexOf("} finally {")
    const iRelease = fn.indexOf("releaseState = await release()")
    assert.ok(iAuth > 0 && iAcquire > iAuth && iAcquired > iAcquire && iCap > iAcquired)
    assert.ok(iFinally > iCap && iRelease > iFinally)
    assert.ok(!/expectedVersion|version:\s*\d/.test(fn))
    for (const forbidden of ["runProductionAcquisitionOrchestrator(", "runAcquisitionAutoDecisionWorker(", "createPrismaWorksiteCreationSelectionPort"]) {
      assert.ok(!fn.includes(forbidden), forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// Script manuel : gardes pures (le script n'est jamais exécuté ici)
// ---------------------------------------------------------------------------

const GOOD_ENV = {
  TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: "true",
  TARGETED_STAGING_EXPECTED_DATABASE_HOST: "db.staging.example",
  TARGETED_STAGING_EXPECTED_DATABASE_NAME: "app",
  TARGETED_STAGING_FORBIDDEN_DATABASE_HOST: "db.live.example",
  DATABASE_URL: "postgresql://u:p@db.staging.example:5432/app",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
}
const GOOD_ARGV = ["node", "script.ts", `--confirm=${TARGETED_WORKSITE_CREATION_CONFIRMATION}`]

describe("script manuel — gardes fail-closed", () => {
  it("toutes gardes OK → cible env (jamais d'argument de cible)", () => {
    assert.deepEqual(evaluateTargetedWorksiteCreationScriptGuards({ argv: GOOD_ARGV, env: GOOD_ENV }), {
      ok: true,
      target: { companyId: COMPANY, draftId: DRAFT },
      expectedDatabaseName: "app",
    })
  })

  const cases: Array<[string, string[], Record<string, string | undefined>, string]> = [
    ["sans confirmation", ["node", "s.ts"], GOOD_ENV, "CONFIRMATION_REQUIRED"],
    ["confirmation erronée", ["node", "s.ts", "--confirm=RUN"], GOOD_ENV, "CONFIRMATION_REQUIRED"],
    ["argument de cible ajouté", [...GOOD_ARGV, `--draftId=${DRAFT}`], GOOD_ENV, "CONFIRMATION_REQUIRED"],
    ["gate absent", GOOD_ARGV, { ...GOOD_ENV, TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: undefined }, "RUN_DISABLED"],
    ["gate ≠ true", GOOD_ARGV, { ...GOOD_ENV, TARGETED_STAGING_WORKSITE_CREATION_RUN_ENABLED: "TRUE" }, "RUN_DISABLED"],
    ["VERCEL_ENV production", GOOD_ARGV, { ...GOOD_ENV, VERCEL_ENV: "production" }, "PRODUCTION_FORBIDDEN"],
    ["NODE_ENV production", GOOD_ARGV, { ...GOOD_ENV, NODE_ENV: "production" }, "PRODUCTION_FORBIDDEN"],
    ["hôte attendu absent", GOOD_ARGV, { ...GOOD_ENV, TARGETED_STAGING_EXPECTED_DATABASE_HOST: "" }, "DATABASE_IDENTITY_CONFIG_MISSING"],
    ["DATABASE_URL invalide", GOOD_ARGV, { ...GOOD_ENV, DATABASE_URL: "not a url" }, "DATABASE_URL_INVALID"],
    ["hôte DB différent", GOOD_ARGV, { ...GOOD_ENV, DATABASE_URL: "postgresql://u:p@db.other.example:5432/app" }, "DATABASE_IDENTITY_MISMATCH"],
    ["cible env absente", GOOD_ARGV, { ...GOOD_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: " " }, "TARGET_UNSET"],
  ]
  for (const [label, argv, env, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      assert.deepEqual(evaluateTargetedWorksiteCreationScriptGuards({ argv, env }), { ok: false, code: expected })
    })
  }

  it("résumé : exit 0 uniquement si WORKER_FINISHED + RELEASED + SUCCESS + converted=1", () => {
    const stats = { selected: 1, scanned: 1, converted: 1, alreadyConverted: 0, skipped: 0, staleApproval: 0, blockedSystemActor: 0, blockedClient: 0, blockedDuplicate: 0, stateChanged: 0, leaseStolen: 0, errors: 0 }
    assert.equal(summarizeRun({ outcome: "WORKER_FINISHED", release: "RELEASED", worker: { status: "SUCCESS", skipReason: undefined, stats } }).exitCode, 0)
    assert.equal(summarizeRun({ outcome: "WORKER_FINISHED", release: "NOT_OWNER", worker: { status: "SUCCESS", skipReason: undefined, stats } }).exitCode, 1)
    assert.equal(summarizeRun({ outcome: "WORKER_FINISHED", release: "RELEASED", worker: { status: "SUCCESS", skipReason: undefined, stats: { ...stats, converted: 0, stateChanged: 1 } } }).exitCode, 1)
    assert.equal(summarizeRun({ outcome: "ALREADY_RUNNING" }).exitCode, 1)
    assert.equal(summarizeRun({ outcome: "TARGET_NOT_AUTHORIZED" }).exitCode, 1)
  })

  it("source : aucun process.exit, attente géocodage bornée > timeout Nominatim, aucune route", () => {
    const src = readCode(SCRIPT_PATH)
    assert.ok(!/process\.exit\(/.test(src))
    assert.ok(GEOCODE_SETTLE_MS > 5_000)
    const appFiles = listFiles(path.join(ROOT, "src/app"))
    const importers = appFiles.filter((f) => {
      const s = readFileSync(f, "utf8")
      return s.includes("runTargetedWorksiteCreationUnderOrchestratorLease") || s.includes("targeted-staging-worksite-creation")
    })
    assert.deepEqual(importers, [])
  })
})

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

void ({} as ConsultationEvaluationContext)
