/**
 * Harness Preview Staging — adaptateur HTTP MINIMAL du runner auto-decision ciblé.
 * Aucune logique métier : contrat HTTP strict puis délégation à runTargetedStagingAutoDecision.
 * Aucune cible acceptée depuis la requête (body / query) : la cible reste env-only (runner + wiring).
 * Le hard-stop du runner (TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED = false) n'est pas contourné.
 */

import { NextResponse } from "next/server"
import {
  runTargetedStagingAutoDecision,
  type TargetedAutoDecisionRunnerDeps,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-runner"

export const TARGETED_STAGING_AUTO_DECISION_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_AUTO_DECISION" as const

/** Codes runner → statut HTTP. Code inconnu → 409 (jamais 200). */
const REFUSAL_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  HARNESS_SURFACE_FORBIDDEN: 403,
  TARGETED_RUN_DISABLED: 403,
  FORBIDDEN: 403,
  HARNESS_TARGET_UNSET: 403,
  FORBIDDEN_DRAFT: 403,
  TENANT_MISMATCH: 403,
  TARGETED_RUN_NOT_ARMED: 403,
}

function refused(status: number, code: string): Response {
  return NextResponse.json({ ok: false, code }, { status })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

export async function handleTargetedStagingAutoDecisionRun(
  req: Request,
  deps: Pick<TargetedAutoDecisionRunnerDeps, "env" | "auth"> = {}
): Promise<Response> {
  try {
    // Aucun paramètre de requête accepté (cible / overrides impossibles par l'URL).
    if (new URL(req.url).search !== "") return refused(400, "QUERY_FORBIDDEN")

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return refused(400, "INVALID_BODY")
    }
    if (!isPlainObject(body)) return refused(400, "INVALID_BODY")

    // Body EXACT : { confirmation } uniquement — toute autre clé (companyId, draftId, …) refusée.
    const keys = Object.keys(body)
    if (keys.length !== 1 || keys[0] !== "confirmation") {
      return refused(400, keys.includes("confirmation") ? "OVERRIDE_FORBIDDEN" : "CONFIRMATION_REQUIRED")
    }
    if (body.confirmation !== TARGETED_STAGING_AUTO_DECISION_RUN_CONFIRMATION) {
      return refused(400, "CONFIRMATION_REQUIRED")
    }

    const out = await runTargetedStagingAutoDecision({ env: deps.env, auth: deps.auth })
    if (!out.ok) return refused(REFUSAL_STATUS[out.code] ?? 409, out.code)
    return NextResponse.json({
      ok: true,
      workerStatus: out.workerStatus,
      skipReason: out.skipReason,
      stats: out.stats,
    })
  } catch {
    return refused(500, "RUN_FAILED")
  }
}
