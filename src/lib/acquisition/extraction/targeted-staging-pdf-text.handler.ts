/**
 * Harness temporaire Staging Preview — lecture ciblée de la couche texte
 * d'un unique PLAN PDF déjà STORED.
 *
 * Fail-closed :
 * - Preview du projet planificator-staging uniquement
 * - cible company/draft uniquement via env
 * - ADMIN / SUPER_ADMIN du tenant cible
 * - aucun identifiant de cible accepté dans la requête
 * - aucun flag Acquisition global modifié
 * - aucune mutation draft / attachment / worksite
 * - aucun appel Anthropic
 * - aucun cron
 *
 * Modes :
 * - CHECK_* : préflight strictement READ-ONLY
 * - RUN_*   : téléchargement en mémoire + extraction couche texte PDF uniquement
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { defaultAttachmentBytesLoader } from "@/lib/acquisition/extraction/attachment-bytes-loader"
import {
  extractPdfTextLayer,
  type PdfTextExtractResult,
} from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

export const TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_PDF_TEXT" as const

export const TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_PDF_TEXT" as const

const ENABLED_FLAG = "TARGETED_STAGING_PDF_TEXT_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export type TargetedStagingPdfTextDraft = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: string
  createdWorksiteId: string | null
}

export type TargetedStagingPdfTextPlan = {
  id: string
  companyId: string
  acquisitionMessageId: string
  filename: string
  mimeType: string
  category: string
  status: string
  storagePublicId: string | null
}

export type TargetedStagingPdfTextMailbox = {
  messageId: string
  companyId: string
  sourceMailboxKey: string
}

export type TargetedStagingPdfTextHandlerDeps = {
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  env?: Record<string, string | undefined>
  loadDraft?: (
    companyId: string,
    draftId: string
  ) => Promise<TargetedStagingPdfTextDraft | null>
  listPlanCandidates?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedStagingPdfTextPlan[]>
  loadMailbox?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<TargetedStagingPdfTextMailbox | null>
  loadBytes?: typeof defaultAttachmentBytesLoader
  extractText?: (
    bytes: Buffer | Uint8Array,
    opts?: { maxChars?: number; timeoutMs?: number; maxBytes?: number }
  ) => Promise<PdfTextExtractResult>
}

type PreparedTarget = {
  companyId: string
  draftId: string
  draft: TargetedStagingPdfTextDraft
  plan: TargetedStagingPdfTextPlan
  mailbox: TargetedStagingPdfTextMailbox
}

function refused(
  status: number,
  code: string,
  message: string
): Response {
  return NextResponse.json(
    { ok: false, code, message },
    { status }
  )
}

async function defaultLoadDraft(
  companyId: string,
  draftId: string
): Promise<TargetedStagingPdfTextDraft | null> {
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
): Promise<TargetedStagingPdfTextPlan[]> {
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
      mimeType: true,
      category: true,
      status: true,
      storagePublicId: true,
    },
    orderBy: { createdAt: "asc" },
  })

  return rows
    .filter(
      (row) =>
        row.mimeType.toLowerCase() === "application/pdf" ||
        row.filename.toLowerCase().endsWith(".pdf")
    )
    .map((row) => ({
      id: row.id,
      companyId: row.companyId,
      acquisitionMessageId: row.acquisitionMessageId,
      filename: row.filename,
      mimeType: row.mimeType,
      category: row.category,
      status: row.status,
      storagePublicId: row.storagePublicId,
    }))
}

async function defaultLoadMailbox(
  companyId: string,
  acquisitionMessageId: string
): Promise<TargetedStagingPdfTextMailbox | null> {
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

async function prepareTarget(
  companyId: string,
  draftId: string,
  deps: TargetedStagingPdfTextHandlerDeps
): Promise<
  | { ok: true; prepared: PreparedTarget }
  | { ok: false; response: Response }
> {
  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const listPlanCandidates =
    deps.listPlanCandidates ?? defaultListPlanCandidates
  const loadMailbox = deps.loadMailbox ?? defaultLoadMailbox

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

  if (draft.status !== "PENDING_REVIEW") {
    return {
      ok: false,
      response: refused(
        409,
        "DRAFT_STATUS_INVALID",
        "Draft cible doit être PENDING_REVIEW"
      ),
    }
  }

  if (draft.createdWorksiteId !== null) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS",
        "Draft déjà lié à un chantier"
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
        "Plusieurs PLAN PDF — lecture refusée"
      ),
    }
  }

  const plan = plans[0]

  if (
    plan.companyId !== companyId ||
    plan.acquisitionMessageId !== draft.acquisitionMessageId ||
    plan.category !== "PLAN" ||
    plan.status !== "STORED" ||
    !plan.storagePublicId?.trim()
  ) {
    return {
      ok: false,
      response: refused(
        409,
        "HARNESS_PLAN_PRECONDITION_INVALID",
        "PLAN non prêt pour lecture ciblée"
      ),
    }
  }

  const mailbox = await loadMailbox(
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
        "Message sans identité de boîte explicite"
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

export async function handleTargetedStagingPdfText(
  req: Request,
  deps: TargetedStagingPdfTextHandlerDeps = {}
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
    body &&
    typeof body === "object" &&
    "confirmation" in body
      ? (body as { confirmation?: unknown }).confirmation
      : undefined

  const isCheck =
    confirmation === TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION
  const isRun =
    confirmation === TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION

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
    return NextResponse.json({
      ok: true,
      harness: "targeted-staging-pdf-text",
      mode: "CHECK",
      ready: true,
      proof: {
        draftPendingReview:
          prepared.draft.status === "PENDING_REVIEW",
        noCreatedWorksite:
          prepared.draft.createdWorksiteId === null,
        uniquePlanPdf: true,
        planStored:
          prepared.plan.status === "STORED",
        hasStoragePublicId:
          Boolean(prepared.plan.storagePublicId?.trim()),
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
      },
    })
  }

  const loadBytes =
    deps.loadBytes ?? defaultAttachmentBytesLoader
  const extractText =
    deps.extractText ?? extractPdfTextLayer

  const bytes = await loadBytes({
    filename: prepared.plan.filename,
    mimeType: prepared.plan.mimeType,
    storagePublicId: prepared.plan.storagePublicId,
    status: prepared.plan.status,
  })

  if (!bytes || bytes.byteLength === 0) {
    return refused(
      502,
      "HARNESS_PDF_FETCH_FAILED",
      "Impossible de charger le PDF ciblé"
    )
  }

  const result = await extractText(bytes, {
    maxChars: 8_000,
    timeoutMs: 3_000,
    maxBytes: 10 * 1024 * 1024,
  })

  if (
    result.status !== "PDF_TEXT_EXTRACTED" &&
    result.status !== "PDF_TEXT_TRUNCATED"
  ) {
    return NextResponse.json(
      {
        ok: false,
        harness: "targeted-staging-pdf-text",
        mode: "RUN",
        code: result.status,
        text: "",
        truncated: result.truncated,
      },
      { status: 422 }
    )
  }

  return NextResponse.json({
    ok: true,
    harness: "targeted-staging-pdf-text",
    mode: "RUN",
    status: result.status,
    truncated: result.truncated,
    text: result.text,
  })
}
