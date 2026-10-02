/**
 * Harness temporaire Staging Preview — preuve de DÉTECTION ciblée (un seul draft) via la vraie
 * capability DefaultConsultationDetectionCapability, sans toucher à l'état du PLAN.
 * Fail-closed. Cible (company + draft + message) via env uniquement.
 *
 * CHECK : lectures seules (draft, message, présence du contenu 005A, PLAN PDF). Aucune persistance,
 *         aucun Gmail, aucun Anthropic, aucune extraction, aucun chantier, aucun orchestrateur.
 * RUN   : mêmes gardes, puis UN appel detectConsultation({ companyId, acquisitionMessageId, subject:null,
 *         senderEmail:null, senderDomain:null }) — chemin non-AUTO (sans fence), même câblage que le
 *         harness attachment-not-ready. Seule mutation : la persistance normale de la preuve de détection
 *         (detectionClassification / detectionContentHash / detectionCompletedAt / version+1) par le
 *         repository de la capability. Exige PERSISTED + classification autorisée, puis relit le draft.
 * Sortie : statuts, classification, booléens de preuve. Jamais de contenu, de hash brut ni de secret.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { DefaultConsultationDetectionCapability } from "@/lib/acquisition/capabilities/consultation-detection.capability"
import { isExtractionAuthorizedDetectionClassification } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import type { ConsultationClassification } from "@/lib/acquisition/capabilities/consultation-capability.types"

export const TARGETED_DETECTION_CHECK_CONFIRMATION = "CHECK_TARGETED_STAGING_CONSULTATION_DETECTION" as const
export const TARGETED_DETECTION_RUN_CONFIRMATION = "RUN_TARGETED_STAGING_CONSULTATION_DETECTION" as const

/** planificator-staging (Preview only). */
export const TARGETED_DETECTION_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const TARGETED_DETECTION_ENABLED_FLAG = "TARGETED_STAGING_CONSULTATION_DETECTION_ENABLED"
export const TARGETED_DETECTION_COMPANY_ENV = "TARGETED_STAGING_CONSULTATION_DETECTION_COMPANY_ID"
export const TARGETED_DETECTION_DRAFT_ENV = "TARGETED_STAGING_CONSULTATION_DETECTION_DRAFT_ID"
export const TARGETED_DETECTION_MESSAGE_ENV = "TARGETED_STAGING_CONSULTATION_DETECTION_MESSAGE_ID"

const HARNESS = "targeted-staging-consultation-detection"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
const FORBIDDEN_TARGET_KEYS = new Set(
  [
    "companyId",
    "draftId",
    "messageId",
    "acquisitionMessageId",
    "subject",
    "senderEmail",
    "senderDomain",
    "classification",
    "contentHash",
    "target",
  ].map(normalizeKey)
)

export type DetectionHarnessSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type DetectionHarnessDraft = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: string
  version: number
  createdWorksiteId: string | null
  extractionAttemptCount: number
  detectionClassification: string | null
  detectionContentHash: string | null
}

export type DetectionHarnessMessage = { id: string; companyId: string }

/** Preuve de contenu 005A : booléens + hash (jamais exposé), jamais le texte. */
export type DetectionHarnessContentProof = {
  companyId: string
  acquisitionMessageId: string
  hasNormalizedText: boolean
  contentHash: string | null
}

export type DetectionHarnessPlan = {
  id: string
  companyId: string
  acquisitionMessageId: string
  category: string
  status: string
  hasStoragePublicId: boolean
}

export type DetectionHarnessDetectResult = {
  persistOutcome: string
  classification: ConsultationClassification | null
  draftId: string | null
}

export type TargetedConsultationDetectionHandlerDeps = {
  auth?: () => Promise<DetectionHarnessSession>
  env?: Record<string, string | undefined>
  loadDraft?: (companyId: string, draftId: string) => Promise<DetectionHarnessDraft | null>
  loadMessage?: (companyId: string, messageId: string) => Promise<DetectionHarnessMessage | null>
  loadContentProof?: (companyId: string, messageId: string) => Promise<DetectionHarnessContentProof | null>
  listPlanCandidates?: (companyId: string, messageId: string) => Promise<DetectionHarnessPlan[]>
  /** RUN uniquement — défaut : DefaultConsultationDetectionCapability (chemin non-AUTO). */
  detect?: (input: {
    companyId: string
    acquisitionMessageId: string
    subject: null
    senderEmail: null
    senderDomain: null
  }) => Promise<DetectionHarnessDetectResult>
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isTargetedDetectionSurfaceAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === TARGETED_DETECTION_ALLOWED_VERCEL_PROJECT_ID
}

async function defaultLoadDraft(companyId: string, draftId: string): Promise<DetectionHarnessDraft | null> {
  const row = await prisma.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      status: true,
      version: true,
      createdWorksiteId: true,
      extractionAttemptCount: true,
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
    version: row.version,
    createdWorksiteId: row.createdWorksiteId,
    extractionAttemptCount: row.extractionAttemptCount,
    detectionClassification: row.detectionClassification,
    detectionContentHash: row.detectionContentHash,
  }
}

async function defaultLoadMessage(companyId: string, messageId: string): Promise<DetectionHarnessMessage | null> {
  return prisma.acquisitionMessage.findFirst({
    where: { id: messageId, companyId },
    select: { id: true, companyId: true },
  })
}

async function defaultLoadContentProof(
  companyId: string,
  messageId: string
): Promise<DetectionHarnessContentProof | null> {
  const row = await prisma.acquisitionMessageContent.findFirst({
    where: { companyId, acquisitionMessageId: messageId },
    select: { companyId: true, acquisitionMessageId: true, normalizedText: true, contentHash: true },
  })
  if (!row) return null
  return {
    companyId: row.companyId,
    acquisitionMessageId: row.acquisitionMessageId,
    hasNormalizedText: typeof row.normalizedText === "string" && row.normalizedText.trim().length > 0,
    contentHash: row.contentHash || null,
  }
}

async function defaultListPlanCandidates(companyId: string, messageId: string): Promise<DetectionHarnessPlan[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: { companyId, acquisitionMessageId: messageId, category: "PLAN" },
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
    .filter((r) => r.mimeType?.toLowerCase() === "application/pdf" || r.filename.toLowerCase().endsWith(".pdf"))
    .map((r) => ({
      id: r.id,
      companyId: r.companyId,
      acquisitionMessageId: r.acquisitionMessageId,
      category: r.category,
      status: r.status,
      hasStoragePublicId: Boolean(r.storagePublicId?.trim()),
    }))
}

async function defaultDetect(input: {
  companyId: string
  acquisitionMessageId: string
  subject: null
  senderEmail: null
  senderDomain: null
}): Promise<DetectionHarnessDetectResult> {
  const result = await new DefaultConsultationDetectionCapability().detectConsultation(input)
  return { persistOutcome: result.persistOutcome, classification: result.classification, draftId: result.draftId }
}

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return respond(status, { ok: false, code, message, ...extra })
}

type Prepared = {
  draft: DetectionHarnessDraft
  contentHash: string
}

/** Préconditions communes CHECK / RUN — lectures seules, fail-closed. */
async function prepare(
  ids: { companyId: string; draftId: string; messageId: string },
  deps: TargetedConsultationDetectionHandlerDeps
): Promise<{ ok: true; prepared: Prepared } | { ok: false; response: Response }> {
  const { companyId, draftId, messageId } = ids
  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  const loadMessage = deps.loadMessage ?? defaultLoadMessage
  const loadContentProof = deps.loadContentProof ?? defaultLoadContentProof
  const listPlanCandidates = deps.listPlanCandidates ?? defaultListPlanCandidates

  const draft = await loadDraft(companyId, draftId)
  if (!draft || draft.draftId !== draftId || draft.companyId !== companyId) {
    return { ok: false, response: refused(404, "DRAFT_NOT_FOUND", "Draft cible introuvable pour ce tenant") }
  }
  if (draft.acquisitionMessageId !== messageId) {
    return { ok: false, response: refused(409, "DRAFT_MESSAGE_MISMATCH", "Draft non lié au message cible") }
  }
  if (draft.status !== "PENDING_EXTRACTION") {
    return { ok: false, response: refused(409, "DRAFT_STATUS_INVALID", "Draft doit être PENDING_EXTRACTION") }
  }
  if (draft.createdWorksiteId !== null) {
    return {
      ok: false,
      response: refused(409, "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS", "Draft déjà lié à un chantier — refusé"),
    }
  }

  const message = await loadMessage(companyId, messageId)
  if (!message || message.id !== messageId || message.companyId !== companyId) {
    return { ok: false, response: refused(404, "MESSAGE_NOT_FOUND", "AcquisitionMessage cible introuvable pour ce tenant") }
  }

  const content = await loadContentProof(companyId, messageId)
  if (
    !content ||
    content.companyId !== companyId ||
    content.acquisitionMessageId !== messageId ||
    !content.hasNormalizedText ||
    typeof content.contentHash !== "string" ||
    !content.contentHash
  ) {
    return { ok: false, response: refused(409, "CONTENT_MISSING", "Contenu 005A absent ou incomplet") }
  }

  const plans = await listPlanCandidates(companyId, messageId)
  if (plans.length === 0) {
    return { ok: false, response: refused(409, "HARNESS_PLAN_NOT_FOUND", "Aucun PLAN PDF") }
  }
  if (plans.length !== 1) {
    return {
      ok: false,
      response: refused(409, "HARNESS_PLAN_AMBIGUOUS", "Plusieurs PLAN PDF — refusé", { candidateCount: plans.length }),
    }
  }
  const plan = plans[0]!
  if (
    plan.companyId !== companyId ||
    plan.acquisitionMessageId !== messageId ||
    plan.category !== "PLAN" ||
    plan.status !== "STORED" ||
    !plan.hasStoragePublicId
  ) {
    return { ok: false, response: refused(409, "HARNESS_PLAN_PRECONDITION_INVALID", "PLAN PDF non STORED ou sans stockage") }
  }

  return { ok: true, prepared: { draft, contentHash: content.contentHash } }
}

export async function handleTargetedStagingConsultationDetection(
  req: Request,
  deps: TargetedConsultationDetectionHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isTargetedDetectionSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[TARGETED_DETECTION_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<DetectionHarnessSession>)
  let session: DetectionHarnessSession
  try {
    session = await authenticate()
  } catch {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refused(400, "INVALID_BODY", "Objet JSON attendu")
  }
  const keys = Object.keys(body)
  if (keys.some((k) => FORBIDDEN_TARGET_KEYS.has(normalizeKey(k)))) {
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "La cible ne peut pas être fournie dans la requête")
  }
  if (keys.some((k) => !ALLOWED_BODY_KEYS.has(k))) {
    return refused(400, "UNKNOWN_FIELD", "Champ non autorisé dans la requête")
  }

  const confirmation = (body as { confirmation?: unknown }).confirmation
  const mode =
    confirmation === TARGETED_DETECTION_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_DETECTION_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")

  const companyId = (env[TARGETED_DETECTION_COMPANY_ENV] ?? "").trim()
  const draftId = (env[TARGETED_DETECTION_DRAFT_ENV] ?? "").trim()
  const messageId = (env[TARGETED_DETECTION_MESSAGE_ENV] ?? "").trim()
  if (!companyId || !draftId || !messageId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/draft/message non configurée")
  }
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  let pre: Awaited<ReturnType<typeof prepare>>
  try {
    pre = await prepare({ companyId, draftId, messageId }, deps)
  } catch {
    return refused(500, "PRECONDITION_READ_FAILED", "Lecture des préconditions impossible")
  }
  if (!pre.ok) return pre.response
  const { draft: before, contentHash } = pre.prepared

  const detectionProofPresent =
    isExtractionAuthorizedDetectionClassification(before.detectionClassification as ConsultationClassification | null) &&
    before.detectionContentHash === contentHash

  if (mode === "CHECK") {
    return respond(200, {
      ok: true,
      harness: HARNESS,
      mode: "CHECK",
      ready: true,
      detectCalled: false,
      draft: {
        status: before.status,
        version: before.version,
        extractionAttemptCount: before.extractionAttemptCount,
        createdWorksiteId: before.createdWorksiteId,
        detectionClassification: before.detectionClassification,
        detectionProofPresent,
      },
    })
  }

  // ---- RUN ---- une seule détection, via la vraie capability.
  const detect = deps.detect ?? defaultDetect
  let detection: DetectionHarnessDetectResult
  try {
    detection = await detect({
      companyId,
      acquisitionMessageId: messageId,
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
  } catch {
    return refused(500, "DETECTION_FAILED", "Détection ciblée échouée", { detectCalled: true })
  }

  const detectionView = {
    persistOutcome: detection?.persistOutcome ?? null,
    classification: detection?.classification ?? null,
  }
  if (detection?.persistOutcome !== "PERSISTED") {
    return refused(409, "DETECTION_NOT_PERSISTED", "Preuve de détection non persistée", {
      detectCalled: true,
      detection: detectionView,
    })
  }
  if (!isExtractionAuthorizedDetectionClassification(detection.classification)) {
    return refused(409, "DETECTION_NOT_AUTHORIZED", "Classification non autorisée pour extraction AUTO", {
      detectCalled: true,
      detection: detectionView,
    })
  }
  if (detection.draftId !== draftId) {
    return refused(409, "DETECTION_DRAFT_MISMATCH", "La détection a porté sur un autre draft", {
      detectCalled: true,
      detection: detectionView,
    })
  }

  // Relecture : preuve persistée, aucune extraction, aucun chantier.
  const loadDraft = deps.loadDraft ?? defaultLoadDraft
  let after: DetectionHarnessDraft | null
  try {
    after = await loadDraft(companyId, draftId)
  } catch {
    return refused(500, "POST_DETECTION_READ_FAILED", "Relecture du draft impossible", { detectCalled: true })
  }
  const proof = {
    draftFound: Boolean(after && after.draftId === draftId && after.companyId === companyId),
    classificationAuthorized: isExtractionAuthorizedDetectionClassification(
      (after?.detectionClassification ?? null) as ConsultationClassification | null
    ),
    classificationMatches: after?.detectionClassification === detection.classification,
    detectionContentHashPresent: typeof after?.detectionContentHash === "string" && after.detectionContentHash.length > 0,
    detectionContentHashMatchesContent: after?.detectionContentHash === contentHash,
    statusStillPendingExtraction: after?.status === "PENDING_EXTRACTION",
    noCreatedWorksite: after?.createdWorksiteId === null,
    noExtractionAttempt: after?.extractionAttemptCount === before.extractionAttemptCount,
  }
  const complete = Object.values(proof).every(Boolean)
  if (!complete) {
    return refused(409, "DETECTION_PROOF_INCOMPLETE", "Preuve finale de détection incomplète", {
      detectCalled: true,
      detection: detectionView,
      proof,
    })
  }

  return respond(200, {
    ok: true,
    harness: HARNESS,
    mode: "RUN",
    detectCalled: true,
    detection: detectionView,
    proof,
    after: {
      status: after!.status,
      version: after!.version,
      extractionAttemptCount: after!.extractionAttemptCount,
      createdWorksiteId: after!.createdWorksiteId,
      detectionClassification: after!.detectionClassification,
    },
  })
}
