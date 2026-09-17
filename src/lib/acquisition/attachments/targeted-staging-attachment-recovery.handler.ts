import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import {
  acquisitionAttachmentRepository,
  type AcquisitionAttachmentRepositoryPort,
} from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { getAttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import {
  isRetryableAttachmentErrorCode,
  RETRYABLE_ATTACHMENT_ERROR_CODES,
} from "@/lib/acquisition/attachments/attachment-retry.policy"
import type {
  AttachmentRecord,
  ScheduleRetryToDiscoveredResult,
} from "@/lib/acquisition/attachments/attachment.types"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

export const TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION =
  "RUN_TARGETED_STAGING_ATTACHMENT_RECOVERY" as const
export const TARGETED_ATTACHMENT_RECOVERY_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_ATTACHMENT_RECOVERY" as const

const ENABLED_FLAG = "TARGETED_STAGING_ATTACHMENT_RECOVERY_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export interface TargetedAttachmentRecoveryDraft {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: string
  createdWorksiteId: string | null
}

export interface TargetedAttachmentRecoveryCandidate {
  id: string
  companyId: string
  acquisitionMessageId: string
  filename: string
  mimeType: string
  category: string
  status: string
  hasStoragePublicId: boolean
}

export interface TargetedAttachmentRecoveryScopedRecord {
  attachment: AttachmentRecord
  message: {
    id: string
    companyId: string
    externalMessageId: string
    sourceMailboxKey: string
  }
}

type ScheduleRetryInput = {
  companyId: string
  attachmentId: string
  now: Date
  maxRetries: number
  retryableErrorCodes: string[]
}

export interface TargetedAttachmentRecoveryDeps {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  now?: () => Date
  getRecoveryConfig?: typeof getAttachmentRecoveryCronConfig
  loadDraft?: (
    companyId: string,
    draftId: string
  ) => Promise<TargetedAttachmentRecoveryDraft | null>
  listPlanCandidates?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedAttachmentRecoveryCandidate[]>
  findAttachmentWithMessage?: AcquisitionAttachmentRepositoryPort["findAttachmentWithMessage"]
  scheduleRetryToDiscovered?: (
    input: ScheduleRetryInput
  ) => Promise<ScheduleRetryToDiscoveredResult>
}

async function defaultLoadDraft(
  companyId: string,
  draftId: string
): Promise<TargetedAttachmentRecoveryDraft | null> {
  const row = await prisma.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      status: true,
      createdWorksiteId: true,
    },
  })

  if (!row?.acquisitionMessageId) return null

  return {
    draftId: row.id,
    companyId: row.companyId,
    acquisitionMessageId: row.acquisitionMessageId,
    status: row.status,
    createdWorksiteId: row.createdWorksiteId,
  }
}

async function defaultListPlanCandidates(
  companyId: string,
  acquisitionMessageId: string
): Promise<TargetedAttachmentRecoveryCandidate[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: {
      companyId,
      acquisitionMessageId,
      category: "PLAN",
      OR: [
        { mimeType: "application/pdf" },
        { filename: { endsWith: ".pdf", mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      filename: true,
      mimeType: true,
      category: true,
      status: true,
      storagePublicId: true,
    },
    orderBy: { createdAt: "asc" },
  })

  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    acquisitionMessageId: row.acquisitionMessageId,
    filename: row.filename,
    mimeType: row.mimeType,
    category: row.category,
    status: row.status,
    hasStoragePublicId: Boolean(row.storagePublicId),
  }))
}

type PreparedRecoveryTarget = {
  companyId: string
  draftId: string
  draft: TargetedAttachmentRecoveryDraft
  candidate: TargetedAttachmentRecoveryCandidate
  scopedBefore: TargetedAttachmentRecoveryScopedRecord
}

async function defaultFindAttachmentWithMessage(
  companyId: string,
  attachmentId: string
): Promise<TargetedAttachmentRecoveryScopedRecord | null> {
  return acquisitionAttachmentRepository.findAttachmentWithMessage(
    companyId,
    attachmentId
  )
}

async function defaultScheduleRetryToDiscovered(
  input: ScheduleRetryInput
): Promise<ScheduleRetryToDiscoveredResult> {
  return acquisitionAttachmentRepository.scheduleRetryToDiscovered(input)
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

async function prepareTargetedRecoveryPreconditions(input: {
  companyId: string
  draftId: string
  now: Date
  maxRetries: number
  loadDraft: NonNullable<TargetedAttachmentRecoveryDeps["loadDraft"]>
  listPlanCandidates: NonNullable<TargetedAttachmentRecoveryDeps["listPlanCandidates"]>
  findAttachmentWithMessage: NonNullable<
    TargetedAttachmentRecoveryDeps["findAttachmentWithMessage"]
  >
}): Promise<
  { ok: true; prepared: PreparedRecoveryTarget } |
  { ok: false; response: Response }
> {
  const {
    companyId,
    draftId,
    now,
    maxRetries,
    loadDraft,
    listPlanCandidates,
    findAttachmentWithMessage,
  } = input

  const draft = await loadDraft(companyId, draftId)
  if (!draft || draft.companyId !== companyId || draft.draftId !== draftId) {
    return {
      ok: false,
      response: refused(404, "DRAFT_NOT_FOUND", "Draft cible introuvable pour ce tenant"),
    }
  }

  if (draft.status !== "PENDING_EXTRACTION") {
    return {
      ok: false,
      response: refused(409, "DRAFT_STATUS_INVALID", "Draft doit être PENDING_EXTRACTION"),
    }
  }

  if (draft.createdWorksiteId != null) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS",
        "Draft déjà lié à un chantier — recovery refusé"
      ),
    }
  }

  const candidates = await listPlanCandidates(companyId, draft.acquisitionMessageId)

  if (candidates.length === 0) {
    return {
      ok: false,
      response: refused(409, "HARNESS_PLAN_NOT_FOUND", "Aucun PLAN PDF admissible"),
    }
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_AMBIGUOUS",
        "Plusieurs PLAN PDF — sélection refusée",
        { candidateCount: candidates.length }
      ),
    }
  }

  const candidate = candidates[0]
  if (
    candidate.companyId !== companyId ||
    candidate.acquisitionMessageId !== draft.acquisitionMessageId ||
    candidate.category !== "PLAN" ||
    candidate.status !== "FAILED" ||
    candidate.hasStoragePublicId
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_PRECONDITION_INVALID",
        "État du PLAN incompatible avec le recovery"
      ),
    }
  }

  const scopedBefore = await findAttachmentWithMessage(companyId, candidate.id)

  if (
    !scopedBefore ||
    scopedBefore.attachment.companyId !== companyId ||
    scopedBefore.attachment.acquisitionMessageId !== draft.acquisitionMessageId ||
    scopedBefore.message.companyId !== companyId ||
    scopedBefore.message.id !== draft.acquisitionMessageId
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_ATTACHMENT_SCOPE_MISMATCH",
        "Pièce jointe hors cible ou état modifié"
      ),
    }
  }

  const attachment = scopedBefore.attachment
  if (
    attachment.status !== candidate.status ||
    attachment.status !== "FAILED" ||
    Boolean(attachment.storagePublicId?.trim())
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PRECONDITION_RACE",
        "État de la pièce jointe modifié avant recovery"
      ),
    }
  }

  if (!scopedBefore.message.sourceMailboxKey.trim()) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_MAILBOX_LEGACY_FORBIDDEN",
        "Message sans identité de boîte explicite — recovery refusé"
      ),
    }
  }

  if (!isRetryableAttachmentErrorCode(attachment.lastErrorCode)) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_RETRY_ERROR_NOT_ALLOWED",
        "Erreur FAILED non autorisée pour retry"
      ),
    }
  }

  if (attachment.downloadNextRetryAt == null) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_RETRY_NOT_SCHEDULED",
        "Retry non programmé"
      ),
    }
  }

  if (attachment.downloadNextRetryAt.getTime() > now.getTime()) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_RETRY_NOT_DUE",
        "Retry pas encore échu"
      ),
    }
  }

  if (attachment.downloadRetryCount > maxRetries) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_RETRY_LIMIT_EXCEEDED",
        "Limite de retry dépassée"
      ),
    }
  }

  return {
    ok: true,
    prepared: {
      companyId,
      draftId,
      draft,
      candidate,
      scopedBefore,
    },
  }
}

export async function handleTargetedStagingAttachmentRecovery(
  req: Request,
  deps: TargetedAttachmentRecoveryDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env as NodeJS.ProcessEnv)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }

  if (env[ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? auth
  const session = await authenticate()
  if (!session?.user) {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }

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

  const isCheck = confirmation === TARGETED_ATTACHMENT_RECOVERY_CHECK_CONFIRMATION
  const isRun = confirmation === TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION

  if (!isCheck && !isRun) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  if (
    body &&
    typeof body === "object" &&
    (
      "draftId" in body ||
      "companyId" in body ||
      "attachmentId" in body ||
      "draft_id" in body ||
      "company_id" in body ||
      "attachment_id" in body
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
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/draft non configurée")
  }

  if (draftId === FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID) {
    return refused(403, "FORBIDDEN_DRAFT", "Draft explicitement exclu")
  }

  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const now = (deps.now ?? (() => new Date()))()
  const getRecoveryConfig = deps.getRecoveryConfig ?? getAttachmentRecoveryCronConfig
  const recoveryConfig = getRecoveryConfig()

  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const listPlanCandidates = deps.listPlanCandidates ?? defaultListPlanCandidates
  const findAttachmentWithMessage =
    deps.findAttachmentWithMessage ?? defaultFindAttachmentWithMessage

  const preparedResult = await prepareTargetedRecoveryPreconditions({
    companyId,
    draftId,
    now,
    maxRetries: recoveryConfig.maxRetries,
    loadDraft,
    listPlanCandidates,
    findAttachmentWithMessage,
  })

  if (!preparedResult.ok) {
    return preparedResult.response
  }

  const { prepared } = preparedResult
  const beforeAttachment = prepared.scopedBefore.attachment

  if (isCheck) {
    return NextResponse.json({
      ok: true,
      harness: "targeted-staging-attachment-recovery",
      mode: "CHECK",
      ready: true,
      proof: {
        draftPendingExtraction: prepared.draft.status === "PENDING_EXTRACTION",
        noCreatedWorksite: prepared.draft.createdWorksiteId == null,
        uniquePlanPdf: true,
        planFailed: beforeAttachment.status === "FAILED",
        retryableError: isRetryableAttachmentErrorCode(beforeAttachment.lastErrorCode),
        retryScheduled: beforeAttachment.downloadNextRetryAt != null,
        retryDue:
          beforeAttachment.downloadNextRetryAt != null &&
          beforeAttachment.downloadNextRetryAt.getTime() <= now.getTime(),
        retryWithinLimit:
          beforeAttachment.downloadRetryCount <= recoveryConfig.maxRetries,
        retryCount: beforeAttachment.downloadRetryCount,
        noStoragePublicId: !beforeAttachment.storagePublicId,
        sameTenant: beforeAttachment.companyId === companyId,
        sameMessage:
          beforeAttachment.acquisitionMessageId === prepared.draft.acquisitionMessageId,
        mailboxProvenanceExplicit:
          Boolean(prepared.scopedBefore.message.sourceMailboxKey.trim()),
      },
    })
  }

  const scheduleRetryToDiscovered =
    deps.scheduleRetryToDiscovered ?? defaultScheduleRetryToDiscovered

  const transition = await scheduleRetryToDiscovered({
    companyId,
    attachmentId: prepared.candidate.id,
    now,
    maxRetries: recoveryConfig.maxRetries,
    retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
  })

  if (transition !== "TRANSITIONED") {
    return refused(
      409,
      "HARNESS_RECOVERY_TRANSITION_NOOP",
      "Transition recovery non appliquée — état concurrent ou préconditions modifiées",
      { transitioned: false }
    )
  }

  const scopedAfter = await findAttachmentWithMessage(
    companyId,
    prepared.candidate.id
  )
  const draftAfter = await loadDraft(companyId, draftId)

  if (!scopedAfter || !draftAfter) {
    return refused(
      409,
      "HARNESS_RECOVERY_PROOF_FAILED",
      "Transition appliquée mais preuve post-recovery incomplète",
      { transitioned: true }
    )
  }

  const afterAttachment = scopedAfter.attachment

  const proof = {
    transitioned: true,
    statusDiscovered: afterAttachment.status === "DISCOVERED",
    retryScheduleCleared: afterAttachment.downloadNextRetryAt == null,
    claimCleared: afterAttachment.downloadClaimedAt == null,
    retryCountUnchanged:
      afterAttachment.downloadRetryCount === beforeAttachment.downloadRetryCount,
    noStoragePublicId: !afterAttachment.storagePublicId,
    sameTenant:
      afterAttachment.id === prepared.candidate.id &&
      afterAttachment.companyId === companyId &&
      scopedAfter.message.companyId === companyId &&
      draftAfter.companyId === companyId,
    sameMessage:
      afterAttachment.acquisitionMessageId === prepared.draft.acquisitionMessageId &&
      scopedAfter.message.id === prepared.draft.acquisitionMessageId &&
      draftAfter.acquisitionMessageId === prepared.draft.acquisitionMessageId,
    sameDraft: draftAfter.draftId === draftId,
    draftStillPendingExtraction: draftAfter.status === "PENDING_EXTRACTION",
    noCreatedWorksite: draftAfter.createdWorksiteId == null,
  }

  const proofComplete = Object.values(proof).every((value) => value === true)

  if (!proofComplete) {
    return refused(
      409,
      "HARNESS_RECOVERY_PROOF_FAILED",
      "Transition appliquée mais preuve post-recovery incomplète",
      { transitioned: true, proof }
    )
  }

  return NextResponse.json({
    ok: true,
    harness: "targeted-staging-attachment-recovery",
    mode: "RUN",
    outcome: "TRANSITIONED",
    proof,
  })
}
