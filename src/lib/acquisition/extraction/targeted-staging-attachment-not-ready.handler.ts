/**
 * Harness temporaire Staging Preview — validation ATTACHMENT_NOT_READY.
 * Fail-closed. Un seul draft via env. Provider bomb + repository fuse (anti-TOCTOU).
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import {
  DraftExtractionRepository,
  draftExtractionRepository,
  type AttachmentMetaRow,
  type ClaimDraftInput,
  type DraftExtractionRow,
  type MarkFailedOutcome,
  type MessageContentLite,
  type MessageLite,
  type PersistExtractionInput,
  type PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"

export const TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION =
  "RUN_TARGETED_ATTACHMENT_NOT_READY_TEST" as const

/** Draft GL Events déjà extrait — refus absolu. */
export const FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID = "cmtvfqyhm003dz05oq9nbgg5c"

/** planificator-staging (Preview only). */
export const ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const HARNESS_PROVIDER_MUST_NEVER_BE_REACHED = "HARNESS_PROVIDER_MUST_NEVER_BE_REACHED"
export const HARNESS_MUTATION_FORBIDDEN = "HARNESS_MUTATION_FORBIDDEN"

const ENABLED_FLAG = "TARGETED_STAGING_ATTACHMENT_NOT_READY_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

export type HarnessDraftSnapshot = {
  draftId: string
  companyId: string
  status: string
  extractionAttemptCount: number
  version: number
  createdWorksiteId: string | null
}

export type HarnessPlanAttachmentMeta = {
  id: string
  filename: string
  mimeType: string
  category: string
  status: string
  hasStoragePublicId: boolean
}

export type HarnessDraftRecord = HarnessDraftSnapshot & {
  acquisitionMessageId: string
}

export type HarnessAttachmentRecord = {
  id: string
  filename: string
  mimeType: string | null
  category: string
  status: string
  storagePublicId: string | null
}

export type HarnessFuseStats = {
  claimCalls: number
  mutationAttempts: number
  providerCalls: number
}

export type TargetedAttachmentNotReadyHandlerDeps = {
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  env?: NodeJS.ProcessEnv
  loadDraft?: (companyId: string, draftId: string) => Promise<HarnessDraftRecord | null>
  listAttachments?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<HarnessAttachmentRecord[]>
  /** Override total — tests. Runtime : fuse+bomb via runDraftExtractionSystem. */
  runExtraction?: (input: {
    companyId: string
    draftId: string
  }) => Promise<ExtractDraftResult>
}

function isPlanPdf(att: {
  category: string
  mimeType: string | null
  filename: string
}): boolean {
  const isPdf =
    (att.mimeType || "").toLowerCase() === "application/pdf" ||
    att.filename.toLowerCase().endsWith(".pdf")
  return att.category === "PLAN" && isPdf
}

function isPlanPdfNotReady(att: HarnessAttachmentRecord): boolean {
  return isPlanPdf(att) && (att.status !== "STORED" || !att.storagePublicId?.trim())
}

/**
 * Runtime fail-closed : uniquement Preview du projet Staging exact.
 * Tests : injecter `{ VERCEL_ENV: "preview", VERCEL_PROJECT_ID: ALLOWED_... }`.
 */
export function isHarnessSurfaceAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === ALLOWED_VERCEL_PROJECT_ID
  )
}

/** Provider inert : si extract() est atteint → erreur explicite (jamais Anthropic). */
export function createHarnessBombProvider(stats?: Pick<HarnessFuseStats, "providerCalls">): ExtractionProviderPort {
  return {
    async extract() {
      if (stats) stats.providerCalls += 1
      throw Object.assign(new Error(HARNESS_PROVIDER_MUST_NEVER_BE_REACHED), {
        code: HARNESS_PROVIDER_MUST_NEVER_BE_REACHED,
      })
    },
  }
}

type ReadOnlyExtractionRepo = Pick<
  DraftExtractionRepository,
  "findDraft" | "findContent" | "findMessage" | "listAttachmentMetadata"
>

/**
 * Lectures déléguées ; claimExtracting → toujours null (aucune mutation).
 * persist / markFailed → throw si jamais atteints.
 */
export function createHarnessFuseRepository(
  inner: ReadOnlyExtractionRepo = draftExtractionRepository,
  stats: HarnessFuseStats = { claimCalls: 0, mutationAttempts: 0, providerCalls: 0 }
): DraftExtractionRepository {
  const fuse = {
    findDraft(companyId: string, draftId: string): Promise<DraftExtractionRow | null> {
      return inner.findDraft(companyId, draftId)
    },
    findContent(companyId: string, acquisitionMessageId: string): Promise<MessageContentLite | null> {
      return inner.findContent(companyId, acquisitionMessageId)
    },
    findMessage(companyId: string, messageId: string): Promise<MessageLite | null> {
      return inner.findMessage(companyId, messageId)
    },
    listAttachmentMetadata(
      companyId: string,
      acquisitionMessageId: string
    ): Promise<AttachmentMetaRow[]> {
      return inner.listAttachmentMetadata(companyId, acquisitionMessageId)
    },
    async claimExtracting(_input: ClaimDraftInput): Promise<DraftExtractionRow | null> {
      stats.claimCalls += 1
      return null
    },
    async persistExtraction(_input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
      stats.mutationAttempts += 1
      throw new Error(HARNESS_MUTATION_FORBIDDEN)
    },
    async markFailedWhileExtracting(): Promise<MarkFailedOutcome> {
      stats.mutationAttempts += 1
      throw new Error(HARNESS_MUTATION_FORBIDDEN)
    },
  }
  return fuse as DraftExtractionRepository
}

export function createHarnessSecureExtractionDeps(stats?: HarnessFuseStats): {
  repository: DraftExtractionRepository
  provider: ExtractionProviderPort
  stats: HarnessFuseStats
} {
  const s = stats ?? { claimCalls: 0, mutationAttempts: 0, providerCalls: 0 }
  return {
    repository: createHarnessFuseRepository(draftExtractionRepository, s),
    provider: createHarnessBombProvider(s),
    stats: s,
  }
}

async function defaultSecureRunExtraction(input: {
  companyId: string
  draftId: string
}): Promise<ExtractDraftResult> {
  const { repository, provider } = createHarnessSecureExtractionDeps()
  return runDraftExtractionSystem(input, { repository, provider })
}

function toSnapshot(row: HarnessDraftRecord): HarnessDraftSnapshot {
  return {
    draftId: row.draftId,
    companyId: row.companyId,
    status: row.status,
    extractionAttemptCount: row.extractionAttemptCount,
    version: row.version,
    createdWorksiteId: row.createdWorksiteId,
  }
}

function toPlanMeta(att: HarnessAttachmentRecord): HarnessPlanAttachmentMeta {
  return {
    id: att.id,
    filename: att.filename,
    mimeType: att.mimeType ?? "",
    category: att.category,
    status: att.status,
    hasStoragePublicId: Boolean(att.storagePublicId?.trim()),
  }
}

async function defaultLoadDraft(
  companyId: string,
  draftId: string
): Promise<HarnessDraftRecord | null> {
  const row = await prisma.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      status: true,
      extractionAttemptCount: true,
      version: true,
      createdWorksiteId: true,
      acquisitionMessageId: true,
    },
  })
  if (!row) return null
  return {
    draftId: row.id,
    companyId: row.companyId,
    status: row.status,
    extractionAttemptCount: row.extractionAttemptCount,
    version: row.version,
    createdWorksiteId: row.createdWorksiteId,
    acquisitionMessageId: row.acquisitionMessageId,
  }
}

async function defaultListAttachments(
  companyId: string,
  acquisitionMessageId: string
): Promise<HarnessAttachmentRecord[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: { companyId, acquisitionMessageId },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      category: true,
      status: true,
      storagePublicId: true,
    },
    take: 50,
    orderBy: { createdAt: "asc" },
  })
  return rows
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status })
}

function buildProof(
  result: ExtractDraftResult,
  before: HarnessDraftSnapshot,
  after: HarnessDraftSnapshot | null
) {
  return {
    attachmentNotReady: !result.ok && result.code === "ATTACHMENT_NOT_READY",
    statusUnchanged: after != null && after.status === before.status,
    attemptCountUnchanged:
      after != null && after.extractionAttemptCount === before.extractionAttemptCount,
    createdWorksiteIdUnchanged:
      after != null && after.createdWorksiteId === before.createdWorksiteId,
    versionUnchanged: after != null && after.version === before.version,
    noCreatedWorksite: after != null && after.createdWorksiteId == null,
  }
}

export function isCompleteAttachmentNotReadyProof(proof: {
  attachmentNotReady: boolean
  statusUnchanged: boolean
  attemptCountUnchanged: boolean
  createdWorksiteIdUnchanged: boolean
  versionUnchanged: boolean
  noCreatedWorksite: boolean
}): boolean {
  return (
    proof.attachmentNotReady &&
    proof.statusUnchanged &&
    proof.attemptCountUnchanged &&
    proof.createdWorksiteIdUnchanged &&
    proof.versionUnchanged &&
    proof.noCreatedWorksite
  )
}

export async function handleTargetedStagingAttachmentNotReady(
  req: Request,
  deps: TargetedAttachmentNotReadyHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env)) {
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

  if (confirmation !== TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  if (
    body &&
    typeof body === "object" &&
    ("draftId" in body || "companyId" in body || "draft_id" in body || "company_id" in body)
  ) {
    return refused(
      400,
      "TARGET_OVERRIDE_FORBIDDEN",
      "draftId/companyId ne peuvent pas être fournis dans la requête"
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
  const listAttachments = deps.listAttachments ?? defaultListAttachments
  const runExtraction = deps.runExtraction ?? defaultSecureRunExtraction

  const draft = await loadDraft(companyId, draftId)
  if (!draft || draft.companyId !== companyId || draft.draftId !== draftId) {
    return refused(404, "DRAFT_NOT_FOUND", "Draft cible introuvable pour ce tenant")
  }

  if (draft.status !== "PENDING_EXTRACTION") {
    return refused(409, "DRAFT_STATUS_INVALID", "Draft doit être PENDING_EXTRACTION")
  }

  if (draft.createdWorksiteId != null) {
    return refused(
      409,
      "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS",
      "Draft déjà lié à un chantier — harness refusé"
    )
  }

  const attachments = await listAttachments(companyId, draft.acquisitionMessageId)
  const pendingPlan = attachments.find(isPlanPdfNotReady)

  if (!attachments.some(isPlanPdf)) {
    return refused(409, "PLAN_PDF_MISSING", "Aucun attachment PLAN PDF")
  }

  if (!pendingPlan) {
    return refused(409, "PLAN_PDF_ALREADY_READY", "PLAN PDF déjà prêt — harness non applicable")
  }

  const before = toSnapshot(draft)
  const planMeta = toPlanMeta(pendingPlan)

  const result = await runExtraction({ companyId, draftId })

  const afterRow = await loadDraft(companyId, draftId)
  const after = afterRow ? toSnapshot(afterRow) : null
  const proof = buildProof(result, before, after)

  const resultPayload = {
    ok: result.ok,
    outcome: result.outcome,
    code: result.ok ? null : result.code,
    message: result.ok ? null : result.message,
  }

  const baseBody = {
    harness: "targeted-staging-attachment-not-ready",
    before: {
      ...before,
      planAttachment: planMeta,
    },
    result: resultPayload,
    after,
    proof,
  }

  if (isCompleteAttachmentNotReadyProof(proof)) {
    return NextResponse.json({ ok: true, ...baseBody })
  }

  const raceLike =
    !result.ok &&
    (result.code === "EXTRACTION_IN_PROGRESS" || result.outcome === "IN_PROGRESS")

  if (raceLike) {
    return refused(
      409,
      "HARNESS_PRECONDITION_RACE",
      "Course possible : PLAN peut être devenu prêt avant claim ; preuve ATTACHMENT_NOT_READY non concluante",
      baseBody
    )
  }

  return refused(
    409,
    "HARNESS_PROOF_FAILED",
    "Preuve ATTACHMENT_NOT_READY incomplète — aucune relance",
    baseBody
  )
}
