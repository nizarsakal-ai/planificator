/**
 * Harness temporaire Staging Preview — extraction ciblée réelle d'un draft.
 *
 * Fail-closed :
 * - Preview du projet planificator-staging uniquement
 * - cible unique via env
 * - ADMIN / SUPER_ADMIN du tenant cible
 * - aucun identifiant de cible accepté dans la requête
 * - aucun flag global Acquisition modifié
 * - aucun cron global
 * - provider Anthropic forcé localement à cet appel uniquement
 *
 * Modes :
 * - CHECK_* : préflight strictement READ-ONLY
 * - RUN_*   : extraction ciblée après revalidation complète
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"
import { createAnthropicExtractionAdapter } from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import {
  getAnthropicAdapterTimeoutMs,
  getAnthropicApiKeyPresent,
  getExtractionMaxTokens,
  getExtractionProviderMaxPromptBytes,
  getExtractionProviderMaxResponseBytes,
  resolveAnthropicExtractionModel,
  type AnthropicPublicConfig,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { getExtractionTimeoutMs } from "@/lib/acquisition/extraction/extraction-feature-flag"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

export const TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_EXTRACTION" as const

export const TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_EXTRACTION" as const

const ENABLED_FLAG = "TARGETED_STAGING_EXTRACTION_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export type TargetedStagingExtractionDraft = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: string
  extractionAttemptCount: number
  version: number
  createdWorksiteId: string | null
  detectionClassification: string | null
  detectionContentHash: string | null
}

export type TargetedStagingExtractionPlan = {
  id: string
  companyId: string
  acquisitionMessageId: string
  filename: string
  status: string
  category: string
  hasStoragePublicId: boolean
}

export type TargetedStagingExtractionMailboxProof = {
  messageId: string
  companyId: string
  sourceMailboxKey: string
}

export type TargetedStagingExtractionHandlerDeps = {
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  env?: Record<string, string | undefined>
  loadDraft?: (
    companyId: string,
    draftId: string
  ) => Promise<TargetedStagingExtractionDraft | null>
  listPlanCandidates?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedStagingExtractionPlan[]>
  loadMailboxProof?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedStagingExtractionMailboxProof | null>
  runExtraction?: (input: {
    companyId: string
    draftId: string
  }) => ReturnType<typeof runDraftExtractionSystem>
}

type PreparedTarget = {
  companyId: string
  draftId: string
  draft: TargetedStagingExtractionDraft
  plan: TargetedStagingExtractionPlan
  mailbox: TargetedStagingExtractionMailboxProof
}

async function defaultLoadDraft(
  companyId: string,
  draftId: string
): Promise<TargetedStagingExtractionDraft | null> {
  const row = await prisma.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      status: true,
      extractionAttemptCount: true,
      version: true,
      createdWorksiteId: true,
      detectionClassification: true,
      detectionContentHash: true,
    },
  })

  if (!row) return null

  return {
    draftId: row.id,
    companyId: row.companyId,
    acquisitionMessageId: row.acquisitionMessageId,
    status: row.status,
    extractionAttemptCount: row.extractionAttemptCount,
    version: row.version,
    createdWorksiteId: row.createdWorksiteId,
    detectionClassification: row.detectionClassification,
    detectionContentHash: row.detectionContentHash,
  }
}

async function defaultListPlanCandidates(
  companyId: string,
  acquisitionMessageId: string
): Promise<TargetedStagingExtractionPlan[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: {
      companyId,
      acquisitionMessageId,
      category: "PLAN",
    },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      filename: true,
      status: true,
      category: true,
      mimeType: true,
      storagePublicId: true,
    },
    orderBy: { createdAt: "asc" },
  })

  return rows
    .filter(
      (row) =>
        row.mimeType?.toLowerCase() === "application/pdf" ||
        row.filename.toLowerCase().endsWith(".pdf")
    )
    .map((row) => ({
      id: row.id,
      companyId: row.companyId,
      acquisitionMessageId: row.acquisitionMessageId,
      filename: row.filename,
      status: row.status,
      category: row.category,
      hasStoragePublicId: Boolean(row.storagePublicId?.trim()),
    }))
}

async function defaultLoadMailboxProof(
  companyId: string,
  acquisitionMessageId: string
): Promise<TargetedStagingExtractionMailboxProof | null> {
  const row = await prisma.acquisitionMessage.findFirst({
    where: { id: acquisitionMessageId, companyId },
    select: {
      id: true,
      companyId: true,
      sourceMailboxKey: true,
    },
  })

  if (!row) return null

  return {
    messageId: row.id,
    companyId: row.companyId,
    sourceMailboxKey: row.sourceMailboxKey ?? "",
  }
}

function buildTargetedAnthropicConfig(): AnthropicPublicConfig | null {
  const model = resolveAnthropicExtractionModel()
  const hasApiKey = getAnthropicApiKeyPresent()
  const serviceTimeoutMs = getExtractionTimeoutMs()

  if (!model || !hasApiKey) return null

  const maxPromptBytes = getExtractionProviderMaxPromptBytes()

  return {
    providerId: "anthropic",
    model,
    maxTokens: getExtractionMaxTokens(),
    timeoutMs: getAnthropicAdapterTimeoutMs(serviceTimeoutMs),
    serviceTimeoutMs,
    maxPromptBytes,
    maxInputBytes: maxPromptBytes,
    maxResponseBytes: getExtractionProviderMaxResponseBytes(),
    configured: true,
    hasApiKey: true,
  }
}

function refused(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return NextResponse.json(
    { ok: false, code, message, ...extra },
    { status }
  )
}

async function prepareTarget(
  companyId: string,
  draftId: string,
  deps: TargetedStagingExtractionHandlerDeps
): Promise<
  | { ok: true; prepared: PreparedTarget }
  | { ok: false; response: Response }
> {
  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const listPlanCandidates =
    deps.listPlanCandidates ?? defaultListPlanCandidates
  const loadMailboxProof =
    deps.loadMailboxProof ?? defaultLoadMailboxProof

  const draft = await loadDraft(companyId, draftId)

  if (
    !draft ||
    draft.companyId !== companyId ||
    draft.draftId !== draftId
  ) {
    return {
      ok: false,
      response: refused(
        404,
        "DRAFT_NOT_FOUND",
        "Draft cible introuvable pour ce tenant"
      ),
    }
  }

  if (draft.status !== "PENDING_EXTRACTION") {
    return {
      ok: false,
      response: refused(
        409,
        "DRAFT_STATUS_INVALID",
        "Draft doit être PENDING_EXTRACTION"
      ),
    }
  }

  if (draft.createdWorksiteId !== null) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS",
        "Draft déjà lié à un chantier — extraction refusée"
      ),
    }
  }

  const plans = await listPlanCandidates(
    companyId,
    draft.acquisitionMessageId
  )

  if (plans.length === 0) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_NOT_FOUND",
        "Aucun PLAN PDF admissible"
      ),
    }
  }

  if (plans.length !== 1) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_AMBIGUOUS",
        "Plusieurs PLAN PDF — sélection refusée",
        { candidateCount: plans.length }
      ),
    }
  }

  const plan = plans[0]

  if (
    plan.companyId !== companyId ||
    plan.acquisitionMessageId !== draft.acquisitionMessageId ||
    plan.category !== "PLAN" ||
    plan.status !== "STORED" ||
    !plan.hasStoragePublicId
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_PRECONDITION_INVALID",
        "PLAN non prêt pour extraction ciblée"
      ),
    }
  }

  const mailbox = await loadMailboxProof(
    companyId,
    draft.acquisitionMessageId
  )

  if (
    !mailbox ||
    mailbox.companyId !== companyId ||
    mailbox.messageId !== draft.acquisitionMessageId
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_MESSAGE_SCOPE_MISMATCH",
        "Message cible hors tenant ou introuvable"
      ),
    }
  }

  if (!mailbox.sourceMailboxKey.trim()) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_MAILBOX_LEGACY_FORBIDDEN",
        "Message sans identité de boîte explicite — extraction refusée"
      ),
    }
  }

  return {
    ok: true,
    prepared: {
      companyId,
      draftId,
      draft,
      plan,
      mailbox,
    },
  }
}

async function defaultRunExtraction(input: {
  companyId: string
  draftId: string
}) {
  const config = buildTargetedAnthropicConfig()

  if (!config) {
    return {
      ok: false as const,
      outcome: "FAILED" as const,
      code: "PROVIDER_NOT_CONFIGURED" as const,
      message: "Provider Anthropic ciblé non configuré",
    }
  }

  const provider = createAnthropicExtractionAdapter({ config })

  return runDraftExtractionSystem(input, {
    provider,
    isAcquisitionEnabled: () => true,
    isAcquisitionContentFetchEnabled: () => true,
    isAcquisitionExtractionEnabled: () => true,
  })
}

export async function handleTargetedStagingExtraction(
  req: Request,
  deps: TargetedStagingExtractionHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env as NodeJS.ProcessEnv)) {
    return refused(
      403,
      "HARNESS_SURFACE_FORBIDDEN",
      "Surface non autorisée pour ce harness"
    )
  }

  if (env[ENABLED_FLAG] !== "true") {
    return refused(
      403,
      "HARNESS_DISABLED",
      "Harness désactivé"
    )
  }

  const authenticate = deps.auth ?? auth
  const session = await authenticate()

  if (!session?.user) {
    return refused(
      401,
      "UNAUTHORIZED",
      "Non authentifié"
    )
  }

  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return refused(
      403,
      "FORBIDDEN",
      "Rôle insuffisant"
    )
  }

  let body: unknown

  try {
    body = await req.json()
  } catch {
    return refused(
      400,
      "INVALID_BODY",
      "JSON invalide"
    )
  }

  const confirmation =
    body &&
    typeof body === "object" &&
    "confirmation" in body
      ? (body as { confirmation?: unknown }).confirmation
      : undefined

  const isCheck =
    confirmation === TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION
  const isRun =
    confirmation === TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION

  if (!isCheck && !isRun) {
    return refused(
      400,
      "CONFIRMATION_REQUIRED",
      "Confirmation exacte requise"
    )
  }

  if (
    body &&
    typeof body === "object" &&
    (
      "draftId" in body ||
      "companyId" in body ||
      "draft_id" in body ||
      "company_id" in body
    )
  ) {
    return refused(
      400,
      "TARGET_OVERRIDE_FORBIDDEN",
      "Les identifiants de cible ne peuvent pas être fournis dans la requête"
    )
  }

  const companyId = (env[COMPANY_ENV] ?? "").trim()
  const draftId = (env[DRAFT_ENV] ?? "").trim()

  if (!companyId || !draftId) {
    return refused(
      403,
      "HARNESS_TARGET_UNSET",
      "Cible company/draft non configurée"
    )
  }

  if (draftId === FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID) {
    return refused(
      403,
      "FORBIDDEN_DRAFT",
      "Draft explicitement exclu"
    )
  }

  if (
    !session.user.companyId ||
    session.user.companyId !== companyId
  ) {
    return refused(
      403,
      "TENANT_MISMATCH",
      "companyId session ≠ cible harness"
    )
  }

  const preparedResult = await prepareTarget(
    companyId,
    draftId,
    deps
  )

  if (!preparedResult.ok) {
    return preparedResult.response
  }

  const { prepared } = preparedResult

  if (isCheck) {
    const config = buildTargetedAnthropicConfig()

    return NextResponse.json({
      ok: true,
      harness: "targeted-staging-extraction",
      mode: "CHECK",
      ready: Boolean(config),
      proof: {
        draftPendingExtraction:
          prepared.draft.status === "PENDING_EXTRACTION",
        noCreatedWorksite:
          prepared.draft.createdWorksiteId === null,
        uniquePlanPdf: true,
        planStored:
          prepared.plan.status === "STORED",
        hasStoragePublicId:
          prepared.plan.hasStoragePublicId,
        sameTenant:
          prepared.draft.companyId === companyId &&
          prepared.plan.companyId === companyId &&
          prepared.mailbox.companyId === companyId,
        sameMessage:
          prepared.plan.acquisitionMessageId ===
            prepared.draft.acquisitionMessageId &&
          prepared.mailbox.messageId ===
            prepared.draft.acquisitionMessageId,
        mailboxProvenanceExplicit:
          Boolean(prepared.mailbox.sourceMailboxKey.trim()),
        anthropicConfigured:
          Boolean(config),
      },
    })
  }

  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const runExtraction =
    deps.runExtraction ?? defaultRunExtraction

  const before = prepared.draft

  const result = await runExtraction({
    companyId,
    draftId,
  })

  const after = await loadDraft(
    companyId,
    draftId
  )

  const proof = {
    extracted:
      result.ok &&
      result.outcome === "EXTRACTED",
    finalStatusAllowed:
      after?.status === "PENDING_REVIEW" ||
      after?.status === "OBSOLETE",
    attemptIncrementedExactlyOnce:
      after !== null &&
      after.extractionAttemptCount ===
        before.extractionAttemptCount + 1,
    versionAdvanced:
      after !== null &&
      after.version > before.version,
    noCreatedWorksite:
      after !== null &&
      after.createdWorksiteId === null,
    sameTenant:
      after !== null &&
      after.companyId === companyId,
    sameDraft:
      after !== null &&
      after.draftId === draftId,
    sameMessage:
      after !== null &&
      after.acquisitionMessageId ===
        before.acquisitionMessageId,
  }

  const proofComplete =
    proof.extracted &&
    proof.finalStatusAllowed &&
    proof.attemptIncrementedExactlyOnce &&
    proof.versionAdvanced &&
    proof.noCreatedWorksite &&
    proof.sameTenant &&
    proof.sameDraft &&
    proof.sameMessage

  if (!proofComplete) {
    return refused(
      409,
      "HARNESS_EXTRACTION_PROOF_FAILED",
      "Extraction ciblée non prouvée",
      {
        result: {
          ok: result.ok,
          outcome: result.outcome,
          code: result.ok ? null : result.code,
          message: result.ok ? null : result.message,
        },
        proof,
        before: {
          status: before.status,
          extractionAttemptCount:
            before.extractionAttemptCount,
          version: before.version,
          createdWorksiteId:
            before.createdWorksiteId,
        },
        after: after
          ? {
              status: after.status,
              extractionAttemptCount:
                after.extractionAttemptCount,
              version: after.version,
              createdWorksiteId:
                after.createdWorksiteId,
            }
          : null,
      }
    )
  }

  return NextResponse.json({
    ok: true,
    harness: "targeted-staging-extraction",
    mode: "RUN",
    outcome: result.outcome,
    status: after?.status ?? null,
    proof,
  })
}
