/**
 * Harness Preview Staging — preflight validation strictement READ-ONLY.
 * Évalue validateConsultation (pure) pour le draft cible à un instant serveur unique.
 * Aucun journal, worker, mutation draft, approve / reject / convert, cron ou appel provider.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { buildConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import type { ValidationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import { dateToUtcCalendarYmd } from "@/lib/acquisition/policy/work-period-classification"

/**
 * Garde-fous harness copiés à l'identique (V1) pour éviter le graphe runtime
 * extraction → orchestrator → journal. Dérive verrouillée par test de contrat.
 */
/** Draft GL Events déjà extrait — refus absolu. */
export const FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID = "cmtvfqyhm003dz05oq9nbgg5c"

/** planificator-staging (Preview only). */
export const ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isHarnessSurfaceAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === ALLOWED_VERCEL_PROJECT_ID
  )
}

export const TARGETED_STAGING_VALIDATION_PREFLIGHT_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_VALIDATION_PREFLIGHT" as const

const ENABLED_FLAG = "TARGETED_STAGING_VALIDATION_PREFLIGHT_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

const TARGET_OVERRIDE_KEYS = ["companyId", "company_id", "draftId", "draft_id"] as const
const CLOCK_OVERRIDE_KEYS = ["referenceInstant", "reference_instant", "now"] as const

export type TargetedValidationPreflightDeps = {
  auth?: typeof auth
  env?: Record<string, string | undefined>
  now?: () => Date
  buildContext?: typeof buildConsultationEvaluationContext
  validate?: typeof validateConsultation
}

/**
 * Mapping local ValidationDecision → code journal VALIDATION_*.
 * V1 : copie volontaire du mapping worker (pas de dépendance capabilities → orchestrator).
 */
export function preflightValidationDecisionCode(
  decision: ValidationDecision
):
  | "VALIDATION_PASS"
  | "VALIDATION_QUARANTINE"
  | "VALIDATION_FAIL_RETRYABLE"
  | "VALIDATION_FAIL_TERMINAL" {
  switch (decision.code) {
    case "PASS":
      return "VALIDATION_PASS"
    case "QUARANTINE":
      return "VALIDATION_QUARANTINE"
    case "FAIL_RETRYABLE":
      return "VALIDATION_FAIL_RETRYABLE"
    case "FAIL_TERMINAL":
      return "VALIDATION_FAIL_TERMINAL"
    default: {
      const unreachable: never = decision
      throw new Error(`UNKNOWN_VALIDATION_DECISION ${String(unreachable)}`)
    }
  }
}

function refused(status: number, code: string, message: string): Response {
  return NextResponse.json({ ok: false, code, message }, { status })
}

function hasAnyKey(body: unknown, keys: readonly string[]): boolean {
  return Boolean(body && typeof body === "object" && keys.some((k) => k in body))
}

/**
 * Diagnostic AMBIGUOUS_ADDRESS : booléens seuls, jamais le texte adresse/ville.
 * Reflète les conditions de evaluateAutoDecisionRules, qui reste seule autorité.
 */
export function preflightAddressDiagnostic(snapshot: {
  address: string | null
  city: string | null
}): { addressEmpty: boolean; addressTooShort: boolean; cityEmpty: boolean } {
  const address = snapshot.address?.trim() ?? ""
  const city = snapshot.city?.trim() ?? ""
  return {
    addressEmpty: address.length === 0,
    addressTooShort: address.length > 0 && address.length < 5,
    cityEmpty: city.length === 0,
  }
}

export async function handleTargetedStagingValidationPreflight(
  req: Request,
  deps: TargetedValidationPreflightDeps = {}
): Promise<Response> {
  try {
    return await runPreflight(req, deps)
  } catch {
    return refused(500, "PREFLIGHT_FAILED", "Erreur interne")
  }
}

async function runPreflight(
  req: Request,
  deps: TargetedValidationPreflightDeps
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env as NodeJS.ProcessEnv)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée")
  }
  if (env[ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const session = await (deps.auth ?? auth)()
  if (!session?.user) return refused(401, "UNAUTHORIZED", "Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return refused(403, "FORBIDDEN", "Rôle insuffisant")
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return refused(400, "INVALID_BODY", "JSON invalide")
  }

  const confirmation =
    body && typeof body === "object" && "confirmation" in body
      ? (body as { confirmation?: unknown }).confirmation
      : undefined

  if (confirmation !== TARGETED_STAGING_VALIDATION_PREFLIGHT_CHECK_CONFIRMATION) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }
  if (hasAnyKey(body, TARGET_OVERRIDE_KEYS)) {
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "TARGET_OVERRIDE")
  }
  if (hasAnyKey(body, CLOCK_OVERRIDE_KEYS)) {
    return refused(400, "CLOCK_OVERRIDE_FORBIDDEN", "CLOCK_OVERRIDE")
  }

  const companyId = (env[COMPANY_ENV] ?? "").trim()
  const draftId = (env[DRAFT_ENV] ?? "").trim()

  if (!companyId || !draftId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/draft non configurée")
  }
  if (draftId === FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID) {
    return refused(403, "FORBIDDEN_DRAFT", "Draft explicitement exclu")
  }
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "TENANT_MISMATCH")
  }

  const ctx = await (deps.buildContext ?? buildConsultationEvaluationContext)({ companyId, draftId })
  if (!ctx || ctx.draft.id !== draftId || ctx.draft.companyId !== companyId) {
    return refused(409, "EVALUATION_CONTEXT_UNAVAILABLE", "Contexte d'évaluation indisponible")
  }

  const referenceInstant = (deps.now ?? (() => new Date()))()

  const decision = (deps.validate ?? validateConsultation)({
    companyId,
    draftId,
    classification: ctx.classification,
    extractedSnapshot: ctx.snapshot,
    partnerProfile: ctx.partnerProfile,
    referenceInstant,
  })

  return NextResponse.json({
    ok: true,
    mode: "CHECK_READ_ONLY",
    referenceInstant: referenceInstant.toISOString(),
    draft: {
      id: ctx.draft.id,
      status: ctx.draft.status,
      version: ctx.draft.version,
      cycle: ctx.cycle,
      startDate: ctx.draft.proposedStartDate
        ? dateToUtcCalendarYmd(ctx.draft.proposedStartDate)
        : null,
      endDate: ctx.draft.proposedEndDate
        ? dateToUtcCalendarYmd(ctx.draft.proposedEndDate)
        : null,
    },
    classification: ctx.classification,
    validation: {
      code: decision.code,
      decisionCode: preflightValidationDecisionCode(decision),
      reasons: decision.reasons,
      errorCode: "errorCode" in decision ? decision.errorCode : null,
    },
    addressDiagnostic: preflightAddressDiagnostic(ctx.snapshot),
  })
}
