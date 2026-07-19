/**
 * PLAN-ACQ-005C — Cœur testable des actions revue (hors "use server").
 * Les Server Actions exposées n’acceptent que `input` (pas de deps client).
 */

import { revalidatePath as nextRevalidatePath } from "next/cache"
import { auth as nextAuth } from "@/auth"
import type { Role, WorksiteImportDraftStatus } from "@prisma/client"
import { isAcquisitionEnabled as defaultIsAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { isAcquisitionExtractionEnabled as defaultIsExtractionEnabled } from "@/lib/acquisition/extraction/extraction-feature-flag"
import { runDraftExtraction as defaultRunDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"
import { importDraftReadRepository } from "@/lib/acquisition/review/import-draft-read.repository"
import { importDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import { getReExtractPolicy } from "@/lib/acquisition/review/consultation-ui"
import { reExtractImportDraftSchema } from "@/lib/acquisition/review/import-draft-review.schema"
import type {
  ApproveOutcome,
  ImportDraftStatusSnapshot,
  RejectOutcome,
  ReviewActorContext,
  SaveCorrectionsOutcome,
} from "@/lib/acquisition/review/import-draft-review.types"

type AuthSession = {
  user: { id: string; role: Role; companyId: string | null }
} | null

export type AcquisitionReviewActionDeps = {
  auth?: () => Promise<AuthSession>
  isAcquisitionEnabled?: () => boolean
  isAcquisitionExtractionEnabled?: () => boolean
  saveImportDraftCorrections?: (
    ctx: ReviewActorContext,
    input: unknown
  ) => Promise<SaveCorrectionsOutcome>
  approveImportDraft?: (ctx: ReviewActorContext, input: unknown) => Promise<ApproveOutcome>
  rejectImportDraft?: (ctx: ReviewActorContext, input: unknown) => Promise<RejectOutcome>
  getImportDraftStatusForReview?: (input: {
    companyId: string
    draftId: string
  }) => Promise<ImportDraftStatusSnapshot | null>
  runDraftExtraction?: (input: {
    actor: { userId: string; role: Role; companyId: string }
    draftId: string
    force?: boolean
  }) => Promise<ExtractDraftResult>
  revalidatePath?: (path: string) => void
}

async function requireReviewContext(
  deps: AcquisitionReviewActionDeps
): Promise<
  | { ok: true; ctx: ReviewActorContext }
  | { ok: false; outcome: "FORBIDDEN"; code: string; message: string }
> {
  const authenticate = deps.auth ?? nextAuth
  const session = await authenticate()
  if (!session?.user?.id) {
    return { ok: false, outcome: "FORBIDDEN", code: "UNAUTHENTICATED", message: "Non authentifié" }
  }
  const role = session.user.role as Role
  const companyId = session.user.companyId
  if (!["ADMIN", "SUPER_ADMIN"].includes(role) || !companyId) {
    return { ok: false, outcome: "FORBIDDEN", code: "REVIEW_FORBIDDEN", message: "Accès refusé" }
  }
  return {
    ok: true,
    ctx: {
      actorUserId: session.user.id,
      actorRole: role,
      companyId,
    },
  }
}

function revalidateConsultation(draftId: string, deps: AcquisitionReviewActionDeps) {
  const revalidate = deps.revalidatePath ?? nextRevalidatePath
  revalidate("/consultations")
  revalidate(`/consultations/${draftId}`)
}

export async function saveImportDraftCorrectionsActionImpl(
  input: unknown,
  deps: AcquisitionReviewActionDeps = {}
) {
  const authz = await requireReviewContext(deps)
  if (!authz.ok) {
    return { ok: false as const, outcome: authz.outcome, code: authz.code, message: authz.message }
  }
  const isEnabled = deps.isAcquisitionEnabled ?? defaultIsAcquisitionEnabled
  if (!isEnabled()) {
    return {
      ok: false as const,
      outcome: "DISABLED" as const,
      code: "ACQUISITION_DISABLED",
      message: "Acquisition désactivée",
    }
  }
  const save =
    deps.saveImportDraftCorrections ??
    ((ctx, raw) => importDraftReviewService.saveImportDraftCorrections(ctx, raw))
  const result = await save(authz.ctx, input)
  if (result.ok) revalidateConsultation(result.draftId, deps)
  return result
}

export async function approveImportDraftActionImpl(
  input: unknown,
  deps: AcquisitionReviewActionDeps = {}
) {
  const authz = await requireReviewContext(deps)
  if (!authz.ok) {
    return { ok: false as const, outcome: authz.outcome, code: authz.code, message: authz.message }
  }
  const isEnabled = deps.isAcquisitionEnabled ?? defaultIsAcquisitionEnabled
  if (!isEnabled()) {
    return {
      ok: false as const,
      outcome: "DISABLED" as const,
      code: "ACQUISITION_DISABLED",
      message: "Acquisition désactivée",
    }
  }
  const approve =
    deps.approveImportDraft ??
    ((ctx, raw) => importDraftReviewService.approveImportDraft(ctx, raw))
  const result = await approve(authz.ctx, input)
  if (result.ok) revalidateConsultation(result.draftId, deps)
  return result
}

export async function rejectImportDraftActionImpl(
  input: unknown,
  deps: AcquisitionReviewActionDeps = {}
) {
  const authz = await requireReviewContext(deps)
  if (!authz.ok) {
    return { ok: false as const, outcome: authz.outcome, code: authz.code, message: authz.message }
  }
  const isEnabled = deps.isAcquisitionEnabled ?? defaultIsAcquisitionEnabled
  if (!isEnabled()) {
    return {
      ok: false as const,
      outcome: "DISABLED" as const,
      code: "ACQUISITION_DISABLED",
      message: "Acquisition désactivée",
    }
  }
  const reject =
    deps.rejectImportDraft ?? ((ctx, raw) => importDraftReviewService.rejectImportDraft(ctx, raw))
  const result = await reject(authz.ctx, input)
  if (result.ok) revalidateConsultation(result.draftId, deps)
  return result
}

export async function reExtractImportDraftActionImpl(
  input: unknown,
  deps: AcquisitionReviewActionDeps = {}
) {
  const authz = await requireReviewContext(deps)
  if (!authz.ok) {
    return { ok: false as const, outcome: "FORBIDDEN" as const, code: authz.code, message: authz.message }
  }
  const isEnabled = deps.isAcquisitionEnabled ?? defaultIsAcquisitionEnabled
  const isExtractionEnabled =
    deps.isAcquisitionExtractionEnabled ?? defaultIsExtractionEnabled
  if (!isEnabled() || !isExtractionEnabled()) {
    return {
      ok: false as const,
      outcome: "DISABLED" as const,
      code: "EXTRACTION_DISABLED",
      message: "Extraction désactivée",
    }
  }

  const parsed = reExtractImportDraftSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false as const,
      outcome: "VALIDATION_ERROR" as const,
      code: "VALIDATION_ERROR",
      message: "Identifiant invalide",
    }
  }

  const getStatus =
    deps.getImportDraftStatusForReview ??
    ((args: { companyId: string; draftId: string }) =>
      importDraftReadRepository.getImportDraftStatusForReview(args))
  const snapshot = await getStatus({
    companyId: authz.ctx.companyId,
    draftId: parsed.data.draftId,
  })
  if (!snapshot) {
    return {
      ok: false as const,
      outcome: "NOT_FOUND" as const,
      code: "NOT_FOUND",
      message: "Consultation introuvable",
    }
  }

  const status = snapshot.status as WorksiteImportDraftStatus
  const policy = getReExtractPolicy(status)
  if (!policy.allowed) {
    return {
      ok: false as const,
      outcome: "INVALID_STATE" as const,
      code: "INVALID_STATE",
      message: "Extraction non autorisée pour ce statut",
    }
  }

  const runExtraction = deps.runDraftExtraction ?? defaultRunDraftExtraction
  const result = await runExtraction({
    actor: {
      userId: authz.ctx.actorUserId,
      role: authz.ctx.actorRole,
      companyId: authz.ctx.companyId,
    },
    draftId: parsed.data.draftId,
    force: policy.force,
  })

  if (result.ok) {
    revalidateConsultation(parsed.data.draftId, deps)
    return {
      ok: true as const,
      outcome: result.outcome,
      draftId: parsed.data.draftId,
      status: result.status,
    }
  }

  return {
    ok: false as const,
    outcome: result.outcome,
    code: result.code,
    message: result.message,
  }
}
