import { NextResponse } from "next/server"
import type { Role } from "@prisma/client"
import { auth } from "@/auth"
import { runProductionAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import type { AcquisitionOrchestratorRunResult } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

/**
 * Déclencheur TEMPORAIRE STAGING-ONLY de l'orchestrateur Acquisition permanent.
 *
 * Fail-closed : refuse tout sauf Preview Vercel de la branche release/acquisition-core,
 * flag d'armement dédié, session ADMIN/SUPER_ADMIN du tenant E2E, confirmation exacte.
 * N'ajoute aucune exemption : appelle runProductionAcquisitionOrchestrator, qui applique
 * lui-même master flag, flag cron, lease, fencing et toutes les gates métier.
 */

export const STAGING_ORCHESTRATOR_TRIGGER_FLAG = "ACQUISITION_STAGING_ORCHESTRATOR_TRIGGER_ENABLED"
export const STAGING_ORCHESTRATOR_TRIGGER_CONFIRMATION = "RUN_ACQUISITION_STAGING_ORCHESTRATOR"
export const STAGING_ORCHESTRATOR_TRIGGER_BRANCH = "release/acquisition-core"
/** Tenant E2E unique autorisé (nohisac structures). */
export const STAGING_ORCHESTRATOR_TRIGGER_COMPANY_ID = "cmpqqqyfy0001f5x2blt5qjkh"

const ALLOWED_ROLES: ReadonlyArray<Role> = ["ADMIN", "SUPER_ADMIN"]

type TriggerEnv = Record<string, string | undefined>

type TriggerSession = {
  user: { id: string; role: Role; companyId: string | null }
} | null

export interface StagingOrchestratorTriggerDeps {
  env?: TriggerEnv
  auth?: () => Promise<TriggerSession>
  run?: (input: { runId: string }) => Promise<AcquisitionOrchestratorRunResult>
  createRunId?: () => string
}

function refuse(status: number, code: string): Response {
  return NextResponse.json({ ok: false, code }, { status })
}

/** Preview Vercel de la branche autorisée uniquement — toute absence = refus. */
export function isAuthorizedStagingPreview(env: TriggerEnv): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === STAGING_ORCHESTRATOR_TRIGGER_BRANCH
  )
}

/** Synthèse sans `result` des steps (pas de compteurs/identifiants inter-tenant). */
export function summarizeOrchestratorRun(result: AcquisitionOrchestratorRunResult) {
  const steps: Record<string, { status: string; skipReason?: string; errorCode?: string }> = {}
  for (const [key, step] of Object.entries(result.steps ?? {})) {
    steps[key] = {
      status: step.status,
      ...(step.skipReason ? { skipReason: step.skipReason } : {}),
      ...(step.error?.code ? { errorCode: step.error.code } : {}),
    }
  }
  return {
    status: result.status,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.leaseReleaseFailed ? { leaseReleaseFailed: true } : {}),
    steps,
  }
}

async function readConfirmation(req: Request): Promise<unknown> {
  try {
    const body = (await req.json()) as { confirm?: unknown } | null
    return body && typeof body === "object" ? body.confirm : undefined
  } catch {
    return undefined
  }
}

export async function handleStagingOrchestratorTrigger(
  req: Request,
  deps: StagingOrchestratorTriggerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (req.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED")

  // Surface invisible hors staging armé (404, pas d'indice sur l'existence de la route).
  if (env[STAGING_ORCHESTRATOR_TRIGGER_FLAG] !== "true") return refuse(404, "NOT_FOUND")
  if (!isAuthorizedStagingPreview(env)) return refuse(404, "NOT_FOUND")
  // Le vrai orchestrateur uniquement : refuse un environnement configuré pour les stubs.
  if (env.ACQUISITION_ORCHESTRATOR_ALLOW_STUBS === "true") {
    return refuse(409, "STUBS_ENABLED_REFUSED")
  }

  const session = await (deps.auth ?? auth)()
  if (!session?.user?.id) return refuse(401, "UNAUTHORIZED")
  if (!ALLOWED_ROLES.includes(session.user.role)) return refuse(403, "FORBIDDEN")
  // Tenant issu de la session uniquement ; aucun companyId client n'est lu.
  if (session.user.companyId !== STAGING_ORCHESTRATOR_TRIGGER_COMPANY_ID) {
    return refuse(403, "TENANT_NOT_ALLOWED")
  }

  if ((await readConfirmation(req)) !== STAGING_ORCHESTRATOR_TRIGGER_CONFIRMATION) {
    return refuse(400, "CONFIRMATION_REQUIRED")
  }

  const runId = (deps.createRunId ?? (() => crypto.randomUUID()))()
  const run = deps.run ?? runProductionAcquisitionOrchestrator

  console.info("[acquisition-staging-orchestrator-trigger] RUN_REQUESTED", {
    runId,
    userId: session.user.id,
  })

  try {
    const result = await run({ runId })
    return NextResponse.json({ ok: true, runId, result: summarizeOrchestratorRun(result) })
  } catch {
    return NextResponse.json(
      { ok: false, code: "STAGING_ORCHESTRATOR_TRIGGER_FAILED", runId },
      { status: 500 }
    )
  }
}
