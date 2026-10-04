/**
 * Déclencheur STAGING-ONLY orchestrateur Acquisition — gates fail-closed.
 * Aucun appel Gmail / Anthropic / Vercel / DB : auth, env et run sont injectés.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  handleStagingOrchestratorTrigger,
  STAGING_ORCHESTRATOR_TRIGGER_COMPANY_ID,
  STAGING_ORCHESTRATOR_TRIGGER_CONFIRMATION,
  type StagingOrchestratorTriggerDeps,
} from "@/lib/acquisition/staging/acquisition-staging-orchestrator-trigger.handler"
import * as route from "@/app/api/acquisition/staging/orchestrator-trigger/route"
import {
  ORCHESTRATOR_STEP_KEYS,
  type AcquisitionOrchestratorRunResult,
  type OrchestratorStepsMap,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const HANDLER_PATH = "src/lib/acquisition/staging/acquisition-staging-orchestrator-trigger.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/staging/orchestrator-trigger/route.ts"
const OTHER_COMPANY = "cmp-other-tenant"

const ARMED_ENV = {
  ACQUISITION_STAGING_ORCHESTRATOR_TRIGGER_ENABLED: "true",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "release/acquisition-core",
}

function fakeResult(runId: string): AcquisitionOrchestratorRunResult {
  const steps = Object.fromEntries(
    ORCHESTRATOR_STEP_KEYS.map((k) => [
      k,
      { status: "SUCCESS", durationMs: 1, result: { companyId: OTHER_COMPANY, count: 3 } },
    ])
  ) as OrchestratorStepsMap
  return {
    status: "SUCCESS",
    runId,
    startedAt: "2026-10-04T00:00:00.000Z",
    finishedAt: "2026-10-04T00:00:01.000Z",
    durationMs: 1000,
    steps,
  }
}

function session(role: Role = "ADMIN", companyId: string | null = STAGING_ORCHESTRATOR_TRIGGER_COMPANY_ID) {
  return async () => ({ user: { id: "user-staging", role, companyId } })
}

function post(body?: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/acquisition/staging/orchestrator-trigger", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
  })
}

function harness(overrides: Partial<StagingOrchestratorTriggerDeps> = {}) {
  const calls: Array<{ runId: string }> = []
  const deps: StagingOrchestratorTriggerDeps = {
    env: { ...ARMED_ENV },
    auth: session(),
    createRunId: () => "run-staging-1",
    run: async (input) => {
      calls.push(input)
      return fakeResult(input.runId)
    },
    ...overrides,
  }
  return { deps, calls }
}

const CONFIRMED = { confirm: STAGING_ORCHESTRATOR_TRIGGER_CONFIRMATION }

describe("handleStagingOrchestratorTrigger", () => {
  it("A. flag absent → refus, aucun run", async () => {
    const { deps, calls } = harness({
      env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "release/acquisition-core" },
    })
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(res.status, 404)
    assert.equal(calls.length, 0)
  })

  it("B. flag false (et toute valeur ≠ 'true') → refus", async () => {
    for (const value of ["false", "TRUE", "1", ""]) {
      const { deps, calls } = harness({
        env: { ...ARMED_ENV, ACQUISITION_STAGING_ORCHESTRATOR_TRIGGER_ENABLED: value },
      })
      const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
      assert.equal(res.status, 404, value)
      assert.equal(calls.length, 0)
    }
  })

  it("C. environnement non Preview autorisé → refus", async () => {
    const variants: Array<Record<string, string | undefined>> = [
      { ...ARMED_ENV, VERCEL_ENV: "production" },
      { ...ARMED_ENV, VERCEL_ENV: "development" },
      { ...ARMED_ENV, VERCEL_ENV: undefined },
      { ...ARMED_ENV, VERCEL_GIT_COMMIT_REF: "main" },
      { ...ARMED_ENV, VERCEL_GIT_COMMIT_REF: undefined },
    ]
    for (const env of variants) {
      const { deps, calls } = harness({ env })
      const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
      assert.equal(res.status, 404, JSON.stringify(env))
      assert.equal(calls.length, 0)
    }
  })

  it("stubs activés → refus (vrai orchestrateur uniquement)", async () => {
    const { deps, calls } = harness({
      env: { ...ARMED_ENV, ACQUISITION_ORCHESTRATOR_ALLOW_STUBS: "true" },
    })
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(res.status, 409)
    assert.equal(calls.length, 0)
  })

  it("D. confirmation absente → 400, aucun run", async () => {
    for (const body of [undefined, {}, null]) {
      const { deps, calls } = harness()
      const res = await handleStagingOrchestratorTrigger(post(body), deps)
      assert.equal(res.status, 400)
      assert.equal(calls.length, 0)
    }
  })

  it("D bis. body non JSON → 400", async () => {
    const { deps, calls } = harness()
    const req = new Request("http://localhost/x", { method: "POST", body: "not-json" })
    const res = await handleStagingOrchestratorTrigger(req, deps)
    assert.equal(res.status, 400)
    assert.equal(calls.length, 0)
  })

  it("E. confirmation incorrecte → 400", async () => {
    for (const confirm of [
      "run_acquisition_staging_orchestrator",
      `${STAGING_ORCHESTRATOR_TRIGGER_CONFIRMATION} `,
      "yes",
      true,
    ]) {
      const { deps, calls } = harness()
      const res = await handleStagingOrchestratorTrigger(post({ confirm }), deps)
      assert.equal(res.status, 400, String(confirm))
      assert.equal(calls.length, 0)
    }
  })

  it("F. non authentifié → 401", async () => {
    const { deps, calls } = harness({ auth: async () => null })
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(res.status, 401)
    assert.equal(calls.length, 0)
  })

  it("G. rôle non ADMIN/SUPER_ADMIN → 403", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"] as Role[]) {
      const { deps, calls } = harness({ auth: session(role) })
      const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
      assert.equal(res.status, 403, String(role))
      assert.equal(calls.length, 0)
    }
  })

  it("H. mauvais tenant → 403 ; companyId client ignoré", async () => {
    for (const companyId of [OTHER_COMPANY, null]) {
      const { deps, calls } = harness({ auth: session("SUPER_ADMIN", companyId) })
      const res = await handleStagingOrchestratorTrigger(
        post({ ...CONFIRMED, companyId: STAGING_ORCHESTRATOR_TRIGGER_COMPANY_ID }),
        deps
      )
      assert.equal(res.status, 403)
      assert.equal(calls.length, 0)
    }
  })

  it("I. toutes gates OK → appelle exactement une fois le run avec runId", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as Role[]) {
      const { deps, calls } = harness({ auth: session(role) })
      const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
      assert.equal(res.status, 200)
      assert.deepEqual(calls, [{ runId: "run-staging-1" }])
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(body.runId, "run-staging-1")
      assert.equal(body.result.status, "SUCCESS")
      assert.equal(body.result.steps.gmailSync.status, "SUCCESS")
      // Pas de `result` brut des steps → aucune donnée inter-tenant.
      assert.equal(JSON.stringify(body).includes(OTHER_COMPANY), false)
    }
  })

  it("I bis. chemin par défaut = runProductionAcquisitionOrchestrator (pas de stubs ni service bas niveau)", () => {
    const src = readFileSync(join(ROOT, HANDLER_PATH), "utf8")
    assert.match(src, /deps\.run \?\? runProductionAcquisitionOrchestrator/)
    assert.doesNotMatch(src, /createDefaultStubStepRunners|runAcquisitionOrchestrator\b|resolveGate/)
  })

  it("J. GET ne peut pas lancer le run", async () => {
    assert.equal("GET" in route, false)
    assert.equal(typeof route.POST, "function")
    const { deps, calls } = harness()
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED, "GET"), deps)
    assert.equal(res.status, 405)
    assert.equal(calls.length, 0)
  })

  it("K. exception orchestrateur → 500 contrôlé sans fuite", async () => {
    const { deps } = harness({
      run: async () => {
        throw new Error("boom postgresql://secret@db/internal stack-detail")
      },
    })
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(res.status, 500)
    const text = await res.text()
    const body = JSON.parse(text)
    assert.equal(body.ok, false)
    assert.equal(body.code, "STAGING_ORCHESTRATOR_TRIGGER_FAILED")
    assert.equal(body.runId, "run-staging-1")
    assert.equal(/boom|postgresql|secret|stack/.test(text), false)
  })

  it("L. aucun TARGETED_STAGING_* utilisé", () => {
    for (const p of [HANDLER_PATH, ROUTE_PATH]) {
      assert.doesNotMatch(readFileSync(join(ROOT, p), "utf8"), /TARGETED_STAGING/)
    }
  })

  it("M. CRON_SECRET ni requis ni exposé", async () => {
    for (const p of [HANDLER_PATH, ROUTE_PATH]) {
      const src = readFileSync(join(ROOT, p), "utf8")
      assert.doesNotMatch(src, /CRON_SECRET|assertCronBearerAuth|authorization/i)
    }
    const { deps, calls } = harness({ env: { ...ARMED_ENV, CRON_SECRET: "should-never-leak" } })
    const res = await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.equal((await res.text()).includes("should-never-leak"), false)
  })

  it("N. AUTO_APPROVE / AUTO_CONVERT jamais modifiés ni référencés", async () => {
    for (const p of [HANDLER_PATH, ROUTE_PATH]) {
      assert.doesNotMatch(readFileSync(join(ROOT, p), "utf8"), /AUTO_APPROVE|AUTO_CONVERT/)
    }
    const before = {
      approve: process.env.ACQUISITION_AUTO_APPROVE_ENABLED,
      convert: process.env.ACQUISITION_AUTO_CONVERT_ENABLED,
    }
    const env = { ...ARMED_ENV }
    const { deps } = harness({ env })
    await handleStagingOrchestratorTrigger(post(CONFIRMED), deps)
    assert.equal(process.env.ACQUISITION_AUTO_APPROVE_ENABLED, before.approve)
    assert.equal(process.env.ACQUISITION_AUTO_CONVERT_ENABLED, before.convert)
    assert.deepEqual(env, ARMED_ENV)
  })
})
