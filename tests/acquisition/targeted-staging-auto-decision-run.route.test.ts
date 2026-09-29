process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import { acquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import { acquisitionConsultationDetectionSelectionRepository } from "@/lib/acquisition/detection/consultation-detection.selection.repository"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import {
  InMemoryAcquisitionOrchestratorLeaseRepository,
  acquisitionOrchestratorLeaseRepository,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { acquisitionGmailConnectionListingAdapter } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import {
  TARGETED_STAGING_AUTO_DECISION_RUN_CONFIRMATION,
  handleTargetedStagingAutoDecisionRun,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-run.handler"
import { TARGETED_AUTO_DECISION_RUN_GATE } from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-runner"
import { TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED } from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"
import { prisma } from "@/lib/prisma"
import * as runRoute from "@/app/api/acquisition/targeted-staging-auto-decision-run/route"

const ROOT = path.resolve(__dirname, "../..")
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-auto-decision-run/route.ts"
const HANDLER_PATH = "src/lib/acquisition/orchestrator/targeted-staging-auto-decision-run.handler.ts"
const URL_RUN = "http://localhost/api/acquisition/targeted-staging-auto-decision-run"

const COMPANY = "co-auto-decision-run"
const DRAFT = "draft-auto-decision-run"
const CONFIRM = TARGETED_STAGING_AUTO_DECISION_RUN_CONFIRMATION

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

function request(body: unknown, opts: { url?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(opts.url ?? URL_RUN, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function readSource(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

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

function patchMethod<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): () => void {
  const original = target[key]
  target[key] = impl
  return () => {
    target[key] = original
  }
}

// ---------------------------------------------------------------------------
// Pièges : DB (middleware Prisma : requêtes modèle ET raw), lease canonique, autres étapes.
// ---------------------------------------------------------------------------

// Prisma 100 % mocké : le middleware ne rappelle JAMAIS next() → aucune connexion DB possible.
const dbHits: string[] = []
const dbArgs: unknown[] = []
let dbResponder: ((key: string) => unknown) | null = null
prisma.$use(async (params) => {
  const key = `${params.model ?? "raw"}.${params.action}`
  dbHits.push(key)
  dbArgs.push(params.args)
  if (dbResponder) return dbResponder(key)
  throw new Error(`DB_ACCESS_FORBIDDEN:${key}`)
})

/** Cible introuvable (sélection mono-draft vide) ; toute autre requête → erreur explicite. */
const TARGET_NOT_FOUND_DB = (key: string) => {
  if (key === "WorksiteImportDraft.findFirst") return null
  throw new Error(`DB_ACCESS_FORBIDDEN:${key}`)
}

type Traps = { dbHits: string[]; leaseOps: string[]; stepHits: string[] }

function installTraps(
  opts: {
    /** "trap" : toute opération lease lève ; "memory" : lease canonique mémoire fonctionnelle. */
    lease?: "trap" | "memory"
    busyBy?: string
    assertOwnedThrows?: boolean
  } = {}
): { traps: Traps; restore: () => void } {
  dbHits.length = 0
  dbArgs.length = 0
  dbResponder = opts.lease === "memory" ? TARGET_NOT_FOUND_DB : null
  const leaseOps: string[] = []
  const stepHits: string[] = []
  const lease = acquisitionOrchestratorLeaseRepository
  const mem = new InMemoryAcquisitionOrchestratorLeaseRepository()
  if (opts.busyBy) mem.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, opts.busyBy, 60_000)
  const leaseTrap = (op: "acquire" | "assertOwned" | "renew" | "release") =>
    (async (input: never) => {
      leaseOps.push(op)
      if (opts.lease !== "memory") throw new Error(`LEASE_FORBIDDEN:${op}`)
      if (op === "assertOwned" && opts.assertOwnedThrows) throw new Error("lease lookup failed")
      return (mem[op] as (i: never) => Promise<unknown>)(input)
    }) as never
  const stepTrap = (name: string) => async () => {
    stepHits.push(name)
    throw new Error(`OTHER_STEP_FORBIDDEN:${name}`)
  }
  const restore = [
    patchMethod(lease, "acquire", leaseTrap("acquire")),
    patchMethod(lease, "assertOwned", leaseTrap("assertOwned")),
    patchMethod(lease, "renew", leaseTrap("renew")),
    patchMethod(lease, "release", leaseTrap("release")),
    patchMethod(acquisitionGmailConnectionListingAdapter, "listActiveAcquisitionGmailConnections", stepTrap("gmailSync")),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithReclaimCandidates", stepTrap("attachmentRecovery")),
    patchMethod(acquisitionAttachmentRepository, "listCompanyIdsWithDiscoveredAttachments", stepTrap("attachmentDownload")),
    patchMethod(acquisitionContentFetchStateRepository, "listCompanyIdsWithEligibleContentFetch", stepTrap("contentFetch")),
    patchMethod(acquisitionConsultationDetectionSelectionRepository, "listCompanyIdsNeedingDetection", stepTrap("consultationDetection")),
    patchMethod(acquisitionExtractionCronSelectionRepository, "listCompanyIdsWithEligibleExtraction", stepTrap("extraction")),
  ]
  return {
    traps: { dbHits, leaseOps, stepHits },
    restore: () => {
      dbResponder = null
      for (const fn of restore) fn()
    },
  }
}

/** Appel handler sur la chaîne armée complète (lease mémoire, DB mockée) ; retourne les pièges. */
async function callArmed(
  req: Request,
  opts: Parameters<typeof installTraps>[0] & { env?: Record<string, string | undefined>; auth?: never } = {}
) {
  const { traps, restore } = installTraps({ lease: "memory", ...opts })
  try {
    const res = await handleTargetedStagingAutoDecisionRun(req, {
      env: opts.env ?? { ...RUN_ENV },
      auth: opts.auth ?? sessionAuth(),
    })
    const json = (await res.json()) as Record<string, unknown>
    assert.deepEqual(traps.stepHits, [], "aucune autre étape orchestrateur")
    return { status: res.status, json, traps: { ...traps, dbHits: [...traps.dbHits], dbArgs: [...dbArgs] } }
  } finally {
    restore()
  }
}

/** Appel handler + pièges ; vérifie qu'aucune lease / DB / autre étape n'a été touchée. */
async function call(
  req: Request,
  deps: { env?: Record<string, string | undefined>; auth?: never } = {}
) {
  const { traps, restore } = installTraps()
  try {
    const res = await handleTargetedStagingAutoDecisionRun(req, {
      env: deps.env ?? { ...RUN_ENV },
      auth: deps.auth ?? sessionAuth(),
    })
    const json = (await res.json()) as Record<string, unknown>
    assert.deepEqual(traps.leaseOps, [], "aucune opération lease")
    assert.deepEqual(traps.dbHits, [], "aucune lecture/écriture DB")
    assert.deepEqual(traps.stepHits, [], "aucune autre étape orchestrateur")
    return { status: res.status, json }
  } finally {
    restore()
  }
}

const PROCESS_ENV_KEYS = [
  "ACQUISITION_AUTO_APPROVE_ENABLED",
  "ACQUISITION_AUTO_CONVERT_ENABLED",
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = Object.fromEntries(PROCESS_ENV_KEYS.map((k) => [k, process.env[k]]))
  // Configuration la plus permissive côté process : le hard-stop doit tenir quand même.
  process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
  process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS = "true"
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
  process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
})
afterEach(() => {
  for (const k of PROCESS_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ===========================================================================

describe("targeted staging auto-decision RUN route — pièges", () => {
  it("le piège DB intercepte requêtes modèle et raw (sanity)", async () => {
    const { traps, restore } = installTraps()
    try {
      await assert.rejects(() => prisma.worksiteImportDraft.findFirst({ where: { id: "x" } }), /DB_ACCESS_FORBIDDEN/)
      await assert.rejects(() => prisma.$queryRaw`SELECT 1`, /DB_ACCESS_FORBIDDEN/)
      await assert.rejects(() => prisma.$executeRaw`SELECT 1`, /DB_ACCESS_FORBIDDEN/)
      assert.equal(traps.dbHits.length, 3)
    } finally {
      restore()
    }
  })
})

describe("targeted staging auto-decision RUN route — 1. méthode (convention Next)", () => {
  it("la route n'exporte que POST (+ runtime nodejs) : autres méthodes → 405 par Next", () => {
    assert.deepEqual(Object.keys(runRoute).sort(), ["POST", "runtime"])
    assert.equal(runRoute.runtime, "nodejs")
    for (const m of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      assert.equal((runRoute as Record<string, unknown>)[m], undefined, m)
    }
  })

  it("route = adaptateur minimal vers le handler (aucune logique, aucun deps injecté)", () => {
    const code = readCode(ROUTE_PATH)
    assert.match(code, /return handleTargetedStagingAutoDecisionRun\(req\)/)
    assert.ok(!/env|auth|companyId|draftId|searchParams|headers/.test(code.replace(/import[^\n]*\n/g, "")))
  })
})

describe("targeted staging auto-decision RUN route — 2/3. body et confirmation", () => {
  for (const [label, body] of [
    ["JSON invalide", "{not json"],
    ["body vide", ""],
    ["null", "null"],
    ["tableau", JSON.stringify([{ confirmation: CONFIRM }])],
    ["chaîne", JSON.stringify(CONFIRM)],
    ["nombre", "42"],
  ] as const) {
    it(`${label} → 400 INVALID_BODY`, async () => {
      const { status, json } = await call(request(body))
      assert.equal(status, 400)
      assert.deepEqual(json, { ok: false, code: "INVALID_BODY" })
    })
  }

  for (const confirmation of [
    undefined,
    "",
    "CHECK_TARGETED_STAGING_AUTO_DECISION_PREFLIGHT",
    "run_targeted_staging_auto_decision",
    ` ${CONFIRM}`,
    `${CONFIRM} `,
    "RUN_TARGETED_STAGING_AUTO_DECISION_PREFLIGHT",
    true,
    [CONFIRM],
  ]) {
    it(`confirmation ${JSON.stringify(confirmation)} → 400 CONFIRMATION_REQUIRED`, async () => {
      const { status, json } = await call(request(confirmation === undefined ? {} : { confirmation }))
      assert.equal(status, 400)
      assert.deepEqual(json, { ok: false, code: "CONFIRMATION_REQUIRED" })
    })
  }
})

describe("targeted staging auto-decision RUN route — 4. aucune cible / override depuis la requête", () => {
  for (const extra of [
    { companyId: "co-attacker" },
    { draftId: "draft-attacker" },
    { company_id: COMPANY },
    { draft_id: DRAFT },
    { target: { companyId: COMPANY, draftId: DRAFT } },
    { armed: true },
    { mutationArmed: true },
    { autoApproveEnabled: true },
    { systemActorUserId: "u-sys" },
    { now: "2026-09-29T00:00:00.000Z" },
    { dryRun: false },
  ]) {
    it(`body + ${Object.keys(extra)[0]} → 400 OVERRIDE_FORBIDDEN`, async () => {
      const { status, json } = await call(request({ confirmation: CONFIRM, ...extra }))
      assert.equal(status, 400)
      assert.deepEqual(json, { ok: false, code: "OVERRIDE_FORBIDDEN" })
    })
  }

  it("override sans confirmation → 400 CONFIRMATION_REQUIRED", async () => {
    const { status, json } = await call(request({ companyId: COMPANY, draftId: DRAFT }))
    assert.equal(status, 400)
    assert.deepEqual(json, { ok: false, code: "CONFIRMATION_REQUIRED" })
  })

  for (const query of ["?companyId=co-attacker", "?draftId=d", "?armed=true", "?x=1", "?x"]) {
    it(`query ${JSON.stringify(query)} → 400 QUERY_FORBIDDEN (avant lecture du body)`, async () => {
      const { status, json } = await call(request({ confirmation: CONFIRM }, { url: `${URL_RUN}${query}` }))
      assert.equal(status, 400)
      assert.deepEqual(json, { ok: false, code: "QUERY_FORBIDDEN" })
    })
  }

  it("headers de cible ignorés : la cible reste env-only (tenant env ≠ session → TENANT_MISMATCH)", async () => {
    const { status, json } = await call(
      request(
        { confirmation: CONFIRM },
        { headers: { "x-company-id": "co-attacker", "x-draft-id": "draft-attacker", "x-target": "co-attacker" } }
      ),
      { auth: sessionAuth("ADMIN", "co-attacker") }
    )
    assert.equal(status, 403)
    assert.deepEqual(json, { ok: false, code: "TENANT_MISMATCH" })
  })

  it("le handler ne lit ni headers, ni searchParams comme cible, ni companyId/draftId", () => {
    const code = readCode(HANDLER_PATH)
    assert.ok(!/headers|searchParams|companyId|draftId/.test(code))
    assert.match(code, /runTargetedStagingAutoDecision\(\{ env: deps\.env, auth: deps\.auth \}\)/)
  })
})

describe("targeted staging auto-decision RUN route — armé : worker seulement après toutes les protections", () => {
  it("état armé ; la route et le handler ne touchent pas la constante", () => {
    assert.equal(TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED, true)
    assert.ok(!/MUTATION_ARMED/.test(readCode(HANDLER_PATH)), "handler ne touche pas le verrou")
    assert.ok(!/MUTATION_ARMED/.test(readCode(ROUTE_PATH)))
  })

  for (const role of ["ADMIN", "SUPER_ADMIN"]) {
    it(`contrat exact, toutes gardes passées (${role}) → 200, worker exécuté sous lease, cible exacte uniquement`, async () => {
      const { status, json, traps } = await callArmed(request({ confirmation: CONFIRM }), {
        auth: sessionAuth(role),
      })
      assert.equal(status, 200, JSON.stringify(json))
      assert.equal(json.ok, true)
      assert.equal(json.workerStatus, "SUCCESS")
      assert.equal((json.stats as { selected: number }).selected, 0)
      assert.equal((json.stats as { intentAppended: number }).intentAppended, 0)
      // Ordre : lease + heartbeat wiring, PUIS worker (son heartbeat + sélection), puis release.
      assert.deepEqual(traps.leaseOps, ["acquire", "assertOwned", "renew", "assertOwned", "renew", "release"])
      // Seule requête DB : lecture de la cible exacte (mockée introuvable) ; aucune écriture.
      assert.deepEqual(traps.dbHits, ["WorksiteImportDraft.findFirst"])
      assert.deepEqual((traps.dbArgs[0] as { where: unknown }).where, { id: DRAFT, companyId: COMPANY })
    })
  }

  it("lease occupée par l'orchestrateur → 409 ALREADY_RUNNING, worker jamais appelé", async () => {
    const { status, json, traps } = await callArmed(request({ confirmation: CONFIRM }), { busyBy: "cron-run-live" })
    assert.equal(status, 409)
    assert.deepEqual(json, { ok: false, code: "ALREADY_RUNNING" })
    assert.deepEqual(traps.leaseOps, ["acquire"])
    assert.deepEqual(traps.dbHits, [])
  })

  it("ownership / fence non prouvés (heartbeat en échec) → 409 LEASE_NOT_OWNED, worker jamais appelé", async () => {
    const { status, json, traps } = await callArmed(request({ confirmation: CONFIRM }), { assertOwnedThrows: true })
    assert.equal(status, 409)
    assert.deepEqual(json, { ok: false, code: "LEASE_NOT_OWNED" })
    assert.deepEqual(traps.leaseOps, ["acquire", "assertOwned", "release"])
    assert.deepEqual(traps.dbHits, [])
  })

  it("cible serveur (process) ≠ cible runner → 409 TARGET_NOT_AUTHORIZED, ni lease ni worker", async () => {
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = "draft-other"
    const { status, json, traps } = await callArmed(request({ confirmation: CONFIRM }))
    assert.equal(status, 409)
    assert.deepEqual(json, { ok: false, code: "TARGET_NOT_AUTHORIZED" })
    assert.deepEqual(traps.leaseOps, [])
    assert.deepEqual(traps.dbHits, [])
  })

  it("8. worker jamais appelé : le handler n'importe ni worker ni wiring directement", () => {
    const code = readCode(HANDLER_PATH)
    for (const forbidden of [
      "runAcquisitionAutoDecisionWorker",
      "runTargetedAutoDecisionUnderOrchestratorLease",
      "acquisition-orchestrator-workers",
      "acquisition-auto-decision.worker",
      "prisma",
      "leaseRepository",
      "capability",
    ]) {
      assert.ok(!code.includes(forbidden), `handler ne doit pas référencer ${forbidden}`)
    }
  })
})

describe("targeted staging auto-decision RUN route — protections runner conservées", () => {
  const cases: Array<[string, Parameters<typeof call>[1], number, string]> = [
    ["surface production", { env: { ...RUN_ENV, VERCEL_ENV: "production" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["autre projet", { env: { ...RUN_ENV, VERCEL_PROJECT_ID: "prj_other" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["gate RUN absent", { env: { ...RUN_ENV, [TARGETED_AUTO_DECISION_RUN_GATE]: undefined } }, 403, "TARGETED_RUN_DISABLED"],
    ["gate RUN ≠ true", { env: { ...RUN_ENV, [TARGETED_AUTO_DECISION_RUN_GATE]: "TRUE" } }, 403, "TARGETED_RUN_DISABLED"],
    ["sans session", { auth: (async () => null) as never }, 401, "UNAUTHORIZED"],
    ["rôle USER", { auth: sessionAuth("USER") }, 403, "FORBIDDEN"],
    ["cible env absente", { env: { ...RUN_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "" } }, 403, "HARNESS_TARGET_UNSET"],
    [
      "draft exclu",
      { env: { ...RUN_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID } },
      403,
      "FORBIDDEN_DRAFT",
    ],
    ["tenant différent", { auth: sessionAuth("ADMIN", "co-other") }, 403, "TENANT_MISMATCH"],
    ["tenant null", { auth: sessionAuth("SUPER_ADMIN", null) }, 403, "TENANT_MISMATCH"],
  ]
  for (const [label, deps, status, code] of cases) {
    it(`${label} → ${status} ${code} (chaîne armée fonctionnelle : ni lease, ni DB, ni worker)`, async () => {
      // Lease mémoire fonctionnelle + DB mockée répondante : si une garde était contournée,
      // le worker s'exécuterait et laisserait des traces lease/DB.
      const out = await callArmed(request({ confirmation: CONFIRM }), deps)
      assert.equal(out.status, status)
      assert.deepEqual(out.json, { ok: false, code })
      assert.deepEqual(out.traps.leaseOps, [], "aucune opération lease")
      assert.deepEqual(out.traps.dbHits, [], "aucune lecture/écriture DB")
    })
  }

  it("le flag CHECK preflight n'ouvre pas la route RUN", async () => {
    const env: Record<string, string | undefined> = {
      ...RUN_ENV,
      TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_ENABLED: "true",
    }
    delete env[TARGETED_AUTO_DECISION_RUN_GATE]
    const out = await call(request({ confirmation: CONFIRM }), { env })
    assert.equal(out.status, 403)
    assert.deepEqual(out.json, { ok: false, code: "TARGETED_RUN_DISABLED" })
  })

  it("erreur inattendue (auth throw) → 500 RUN_FAILED générique, sans détail", async () => {
    const out = await call(request({ confirmation: CONFIRM }), {
      auth: (async () => {
        throw new Error("secret-internal-detail")
      }) as never,
    })
    assert.equal(out.status, 500)
    assert.deepEqual(out.json, { ok: false, code: "RUN_FAILED" })
  })
})

describe("targeted staging auto-decision RUN route — isolation", () => {
  it("seule la route RUN atteint le runner ; la route preflight reste CHECK-only", () => {
    const appFiles = listFilesRecursive(path.join(ROOT, "src/app"))
    const reaching = appFiles
      .filter((f) => {
        const s = readFileSync(f, "utf8")
        return (
          s.includes("targeted-staging-auto-decision-run.handler") ||
          s.includes("targeted-staging-auto-decision-runner") ||
          s.includes("targeted-staging-auto-decision-selection") ||
          s.includes("runTargetedAutoDecisionUnderOrchestratorLease")
        )
      })
      .map((f) => path.relative(ROOT, f))
    assert.deepEqual(reaching, [ROUTE_PATH])
    const preflightRoute = readSource("src/app/api/acquisition/targeted-staging-auto-decision-preflight/route.ts")
    assert.ok(!preflightRoute.includes("run.handler"))
  })
})
