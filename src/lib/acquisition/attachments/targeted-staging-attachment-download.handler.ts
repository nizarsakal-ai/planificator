/**
 * Harness temporaire Staging Preview — téléchargement ciblé d'un PLAN.
 *
 * Fail-closed :
 * - Preview du projet planificator-staging uniquement
 * - cible unique via env
 * - ADMIN / SUPER_ADMIN du tenant cible
 * - aucun identifiant de cible accepté dans la requête
 * - aucune activation globale des flags Acquisition
 * - aucun cron global
 *
 * Modes :
 * - CHECK_* : préflight strictement READ-ONLY (aucune écriture / download)
 * - RUN_*   : téléchargement mutatif après revalidation complète des préconditions
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import {
  acquisitionAttachmentRepository,
} from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import {
  downloadAcquisitionAttachment,
} from "@/lib/acquisition/attachments/attachment-download.service"
import type {
  AttachmentDownloadResult,
  AttachmentRecord,
} from "@/lib/acquisition/attachments/attachment.types"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

export const TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION =
  "RUN_TARGETED_STAGING_ATTACHMENT_DOWNLOAD" as const

export const TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_ATTACHMENT_DOWNLOAD" as const

const ENABLED_FLAG = "TARGETED_STAGING_ATTACHMENT_DOWNLOAD_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export type TargetedAttachmentDownloadDraft = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: string
  createdWorksiteId: string | null
}

export type TargetedAttachmentDownloadCandidate = {
  id: string
  companyId: string
  acquisitionMessageId: string
  filename: string
  mimeType: string
  category: string
  status: string
  hasStoragePublicId: boolean
}

export type TargetedAttachmentDownloadScopedRecord = {
  attachment: AttachmentRecord
  message: {
    id: string
    companyId: string
    externalMessageId: string
    sourceMailboxKey: string
  }
}

export type TargetedAttachmentDownloadHandlerDeps = {
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  /** Partial env injectable (tests) — runtime utilise process.env. */
  env?: Record<string, string | undefined>
  loadDraft?: (
    companyId: string,
    draftId: string
  ) => Promise<TargetedAttachmentDownloadDraft | null>
  listPlanCandidates?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedAttachmentDownloadCandidate[]>
  findAttachmentWithMessage?: (
    companyId: string,
    attachmentId: string
  ) => Promise<TargetedAttachmentDownloadScopedRecord | null>
  runDownload?: (input: {
    companyId: string
    attachmentId: string
  }) => Promise<AttachmentDownloadResult>
}

type PreparedDownloadTarget = {
  companyId: string
  draftId: string
  draft: TargetedAttachmentDownloadDraft
  candidate: TargetedAttachmentDownloadCandidate
  scopedBefore: TargetedAttachmentDownloadScopedRecord
}

async function defaultLoadDraft(
  companyId: string,
  draftId: string
): Promise<TargetedAttachmentDownloadDraft | null> {
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

  if (!row) return null

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
): Promise<TargetedAttachmentDownloadCandidate[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: {
      companyId,
      acquisitionMessageId,
      category: "PLAN",
      OR: [
        { mimeType: { equals: "application/pdf", mode: "insensitive" } },
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
    hasStoragePublicId: Boolean(row.storagePublicId?.trim()),
  }))
}

async function defaultFindAttachmentWithMessage(
  companyId: string,
  attachmentId: string
): Promise<TargetedAttachmentDownloadScopedRecord | null> {
  return acquisitionAttachmentRepository.findAttachmentWithMessage(
    companyId,
    attachmentId
  )
}

async function defaultRunDownload(input: {
  companyId: string
  attachmentId: string
}): Promise<AttachmentDownloadResult> {
  return downloadAcquisitionAttachment(input, {
    isAcquisitionEnabled: () => true,
    isAttachmentDownloadEnabled: () => true,
  })
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

/**
 * Préconditions communes CHECK/RUN — lectures seules jusqu'à mailbox explicite.
 * Chaque requête (CHECK ou RUN) revalide intégralement ; aucun état CHECK→RUN.
 */
async function prepareTargetedDownloadPreconditions(input: {
  companyId: string
  draftId: string
  loadDraft: NonNullable<TargetedAttachmentDownloadHandlerDeps["loadDraft"]>
  listPlanCandidates: NonNullable<
    TargetedAttachmentDownloadHandlerDeps["listPlanCandidates"]
  >
  findAttachmentWithMessage: NonNullable<
    TargetedAttachmentDownloadHandlerDeps["findAttachmentWithMessage"]
  >
}): Promise<{ ok: true; prepared: PreparedDownloadTarget } | { ok: false; response: Response }> {
  const { companyId, draftId, loadDraft, listPlanCandidates, findAttachmentWithMessage } =
    input

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
        "Draft déjà lié à un chantier — harness refusé"
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
    candidate.status !== "DISCOVERED" ||
    candidate.hasStoragePublicId
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_PRECONDITION_INVALID",
        "État du PLAN incompatible avec le harness"
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

  if (
    scopedBefore.attachment.status !== "DISCOVERED" ||
    Boolean(scopedBefore.attachment.storagePublicId?.trim())
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PRECONDITION_RACE",
        "État de la pièce jointe modifié avant téléchargement"
      ),
    }
  }

  if (!scopedBefore.message.sourceMailboxKey.trim()) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_MAILBOX_LEGACY_FORBIDDEN",
        "Message sans identité de boîte explicite — téléchargement refusé"
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

export async function handleTargetedStagingAttachmentDownload(
  req: Request,
  deps: TargetedAttachmentDownloadHandlerDeps = {}
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

  const isCheck = confirmation === TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION
  const isRun = confirmation === TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION

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

  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const listPlanCandidates = deps.listPlanCandidates ?? defaultListPlanCandidates
  const findAttachmentWithMessage =
    deps.findAttachmentWithMessage ?? defaultFindAttachmentWithMessage
  const runDownload = deps.runDownload ?? defaultRunDownload

  const preparedResult = await prepareTargetedDownloadPreconditions({
    companyId,
    draftId,
    loadDraft,
    listPlanCandidates,
    findAttachmentWithMessage,
  })

  if (!preparedResult.ok) {
    return preparedResult.response
  }

  const { prepared } = preparedResult

  if (isCheck) {
    return NextResponse.json({
      ok: true,
      harness: "targeted-staging-attachment-download",
      mode: "CHECK",
      ready: true,
      proof: {
        draftPendingExtraction: prepared.draft.status === "PENDING_EXTRACTION",
        noCreatedWorksite: prepared.draft.createdWorksiteId == null,
        uniquePlanPdf: true,
        planDiscovered: prepared.candidate.status === "DISCOVERED",
        noStoragePublicId: !prepared.candidate.hasStoragePublicId,
        sameTenant:
          prepared.scopedBefore.attachment.companyId === companyId &&
          prepared.scopedBefore.message.companyId === companyId,
        sameMessage:
          prepared.scopedBefore.attachment.acquisitionMessageId ===
            prepared.draft.acquisitionMessageId &&
          prepared.scopedBefore.message.id === prepared.draft.acquisitionMessageId,
        mailboxProvenanceExplicit: Boolean(
          prepared.scopedBefore.message.sourceMailboxKey.trim()
        ),
      },
    })
  }

  // RUN : revalidation déjà effectuée dans cette requête juste avant runDownload.
  const result = await runDownload({
    companyId,
    attachmentId: prepared.candidate.id,
  })

  const scopedAfter = await findAttachmentWithMessage(
    companyId,
    prepared.candidate.id
  )

  const proof = {
    outcomeStored: result.outcome === "STORED",
    statusStored: scopedAfter?.attachment.status === "STORED",
    hasSha256: Boolean(scopedAfter?.attachment.sha256?.trim()),
    hasStoragePublicId: Boolean(
      scopedAfter?.attachment.storagePublicId?.trim()
    ),
    hasStoredAt: scopedAfter?.attachment.storedAt != null,
    sameTenant:
      scopedAfter?.attachment.companyId === companyId &&
      scopedAfter?.message.companyId === companyId,
    sameMessage:
      scopedAfter?.attachment.acquisitionMessageId ===
        prepared.draft.acquisitionMessageId &&
      scopedAfter?.message.id === prepared.draft.acquisitionMessageId,
  }

  const proofComplete =
    proof.outcomeStored &&
    proof.statusStored &&
    proof.hasSha256 &&
    proof.hasStoragePublicId &&
    proof.hasStoredAt &&
    proof.sameTenant &&
    proof.sameMessage

  if (!proofComplete) {
    return refused(
      409,
      "HARNESS_DOWNLOAD_PROOF_FAILED",
      "Téléchargement ciblé non prouvé",
      {
        outcome: result.outcome,
        errorCode: result.errorCode ?? null,
        proof,
      }
    )
  }

  return NextResponse.json({
    ok: true,
    harness: "targeted-staging-attachment-download",
    outcome: "STORED",
    proof,
  })
}
