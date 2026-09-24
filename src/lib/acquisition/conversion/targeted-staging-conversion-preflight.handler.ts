/**
 * Harness Preview Staging — preflight conversion strictement READ-ONLY.
 * Aucun approve, convert, Worksite/Client create/update, cron ou appel provider.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { buildConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  isClientBlockedForConversion,
  isDuplicateBlockedForConversion,
  resolveWorksiteCreationState,
} from "@/lib/acquisition/orchestrator/acquisition-worksite-creation.worker"
import { acquisitionDecisionJournalRepository } from "@/lib/acquisition/policy/decision-journal.repository"
import { resolveValidatedSystemActor } from "@/lib/acquisition/policy/system-actor"
import {
  classifyWorkPeriod,
  dateToUtcCalendarYmd,
} from "@/lib/acquisition/policy/work-period-classification"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

export const TARGETED_STAGING_CONVERSION_PREFLIGHT_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_CONVERSION_PREFLIGHT" as const

const ENABLED_FLAG = "TARGETED_STAGING_CONVERSION_PREFLIGHT_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export type TargetedConversionPreflightDraft = {
  id: string
  companyId: string
  status: string
  version: number
  createdWorksiteId: string | null
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
}

export type TargetedConversionPreflightDeps = {
  auth?: typeof auth
  env?: Record<string, string | undefined>
  loadDraft?: typeof loadDraft
  buildContext?: typeof buildConsultationEvaluationContext
  findLatestIntent?: typeof acquisitionDecisionJournalRepository.findLatestPostExtractionAutoIntentForExtractionIdentity
  resolveSystemActor?: typeof resolveValidatedSystemActor
}

async function loadDraft(
  companyId: string,
  draftId: string
): Promise<TargetedConversionPreflightDraft | null> {
  return prisma.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      status: true,
      version: true,
      createdWorksiteId: true,
      contentHashAtExtraction: true,
      extractionSchemaVersion: true,
      proposedStartDate: true,
      proposedEndDate: true,
    },
  })
}

function refused(status: number, code: string, message: string): Response {
  return NextResponse.json({ ok: false, code, message }, { status })
}

export async function handleTargetedStagingConversionPreflight(
  req: Request,
  deps: TargetedConversionPreflightDeps = {}
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

  if (confirmation !== TARGETED_STAGING_CONVERSION_PREFLIGHT_CHECK_CONFIRMATION) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  if (
    body &&
    typeof body === "object" &&
    ("draftId" in body || "companyId" in body || "draft_id" in body || "company_id" in body)
  ) {
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "TARGET_OVERRIDE")
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

  const draft = await (deps.loadDraft ?? loadDraft)(companyId, draftId)
  if (!draft) return refused(404, "DRAFT_NOT_FOUND", "Draft cible introuvable")

  const ctx = await (deps.buildContext ?? buildConsultationEvaluationContext)({ companyId, draftId })
  if (!ctx) {
    return refused(409, "EVALUATION_CONTEXT_UNAVAILABLE", "Contexte d'évaluation indisponible")
  }

  const intent = draft.contentHashAtExtraction
    ? await (deps.findLatestIntent ? deps.findLatestIntent.bind(null) : acquisitionDecisionJournalRepository.findLatestPostExtractionAutoIntentForExtractionIdentity.bind(acquisitionDecisionJournalRepository))({
        companyId,
        draftId,
        contentHash: draft.contentHashAtExtraction,
        extractionSchemaVersion: draft.extractionSchemaVersion,
      })
    : null

  const systemActor = await (deps.resolveSystemActor ?? resolveValidatedSystemActor)(companyId)
  const clientBlocked = isClientBlockedForConversion(ctx)
  const duplicateBlocked = isDuplicateBlockedForConversion(ctx)
  const workPeriod = classifyWorkPeriod(
    draft.proposedStartDate,
    draft.proposedEndDate
  )

  const phase = resolveWorksiteCreationState({
    draftStatus: draft.status,
    createdWorksiteId: draft.createdWorksiteId,
    draftVersion: draft.version,
    draftContentHash: draft.contentHashAtExtraction,
    draftExtractionSchemaVersion: draft.extractionSchemaVersion,
    latestIntent: intent,
    systemActorOk: systemActor.ok,
    clientBlocked,
    duplicateBlocked,
  })

  return NextResponse.json({
    ok: true,
    mode: "CHECK_READ_ONLY",
    draft: {
      id: draft.id,
      status: draft.status,
      version: draft.version,
      createdWorksiteId: draft.createdWorksiteId,
      startDate: draft.proposedStartDate
        ? dateToUtcCalendarYmd(draft.proposedStartDate)
        : null,
      endDate: draft.proposedEndDate
        ? dateToUtcCalendarYmd(draft.proposedEndDate)
        : null,
      workPeriod,
    },
    decision: {
      phase,
      intent: intent?.decisionCode ?? null,
      systemActorOk: systemActor.ok,
      clientBlocked,
      duplicateBlocked,
    },
  })
}
