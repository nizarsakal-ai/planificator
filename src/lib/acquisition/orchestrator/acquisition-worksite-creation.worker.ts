/**
 * PLAN-ACQ-AGENTS-LOT-3F — Worker batch worksiteCreation (restartable).
 * APPROVED + AUTO_APPROVE_CONVERT (association directe vN → APPROVED vN+1)
 * → ImportDraftConversionService.convertImportDraft uniquement.
 * Aucune création Worksite/Client/Document directe. Aucune affectation équipe.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { WorksiteCreationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import {
  buildConsultationEvaluationContext,
  type ConsultationEvaluationContext,
  type ConsultationEvaluationContextDeps,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  ImportDraftConversionService,
  importDraftConversionService,
} from "@/lib/acquisition/conversion/conversion.service"
import type { ConvertImportDraftInput } from "@/lib/acquisition/conversion/conversion.schema"
import type {
  ConversionActorContext,
  ConvertImportDraftResult,
} from "@/lib/acquisition/conversion/conversion.types"
import type {
  ConversionTransactionalOwnershipFence,
  ConvertImportDraftOptions,
} from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  isOrchestratorOwnershipValid,
  type OrchestratorItemOwnershipCheck,
} from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import {
  acquisitionDecisionJournalRepository,
  isDirectApprovalAssociation,
  isPostExtractionStepsPipeline,
  parseFrozenValidationCycle,
  type AcquisitionDecisionJournalRepository,
  type AutoDecisionIntentCode,
  type JournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import {
  resolveValidatedSystemActor,
  type SystemActorResolution,
} from "@/lib/acquisition/policy/system-actor"

const LOG_PREFIX = "[acquisition-worksite-creation-worker]"

export const WORKSITE_CREATION_WORKER_MAX_CANDIDATES = 25
export const WORKSITE_CREATION_WORKER_MAX_SCAN = 500
export const WORKSITE_CREATION_WORKER_MAX_PER_COMPANY = 5

export type WorksiteCreationPhase =
  | "NEEDS_CONVERSION"
  | "ALREADY_CONVERTED"
  | "SKIP_AUTO_APPROVE_ONLY"
  | "SKIP_NO_VALID_INTENT"
  | "SKIP_STALE_APPROVAL"
  | "SKIP_CANCELLED"
  | "BLOCKED_SYSTEM_ACTOR"
  | "BLOCKED_CLIENT"
  | "BLOCKED_DUPLICATE"
  | "STATE_CHANGED"
  | "DONE"

export type WorksiteCreationWorkerCandidate = {
  draftId: string
  companyId: string
  status: string
  version: number
  contentHashAtExtraction: string
  extractionSchemaVersion: string | null
  updatedAt: Date
}

export type WorksiteCreationWorkerSelectionPort = {
  listEligibleCandidates(input: {
    limit: number
    now: Date
    maxPerCompany?: number
  }): Promise<WorksiteCreationWorkerCandidate[]>
}

export type WorksiteCreationWorkerRunStats = {
  selected: number
  scanned: number
  converted: number
  alreadyConverted: number
  skipped: number
  staleApproval: number
  blockedSystemActor: number
  blockedClient: number
  blockedDuplicate: number
  stateChanged: number
  leaseStolen: number
  errors: number
}

export type WorksiteCreationWorkerRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  skipReason?: string
  error?: { code: string; message: string }
  stats: WorksiteCreationWorkerRunStats
}

export type ConvertImportDraftPort = {
  convertImportDraft: (
    ctx: ConversionActorContext,
    raw: unknown,
    options?: ConvertImportDraftOptions
  ) => Promise<ConvertImportDraftResult>
}

export type WorksiteCreationWorkerDeps = {
  db?: PrismaClient
  journal?: AcquisitionDecisionJournalRepository
  selection?: WorksiteCreationWorkerSelectionPort
  evaluationDeps?: ConsultationEvaluationContextDeps
  conversion?: ConvertImportDraftPort | ImportDraftConversionService
  resolveSystemActor?: (
    companyId: string,
    db?: PrismaClient
  ) => Promise<SystemActorResolution>
  ensureOwnership?: OrchestratorItemOwnershipCheck
  /** LOT-3F — fence TX authentique (WeakMap orchestrateur). */
  transactionalOwnershipFence?: ConversionTransactionalOwnershipFence
  now?: () => Date
  maxCandidates?: number
  maxScan?: number
  maxPerCompany?: number
  maxDurationMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function emptyStats(): WorksiteCreationWorkerRunStats {
  return {
    selected: 0,
    scanned: 0,
    converted: 0,
    alreadyConverted: 0,
    skipped: 0,
    staleApproval: 0,
    blockedSystemActor: 0,
    blockedClient: 0,
    blockedDuplicate: 0,
    stateChanged: 0,
    leaseStolen: 0,
    errors: 0,
  }
}

type DraftReloadRow = {
  id: string
  companyId: string
  status: string
  version: number
  createdWorksiteId: string | null
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
}

/**
 * State machine pure — Correction-1 : version === validatedDraftVersion + 1.
 */
export function resolveWorksiteCreationState(input: {
  draftStatus: string
  createdWorksiteId: string | null
  draftVersion: number
  draftContentHash: string | null
  draftExtractionSchemaVersion: string | null
  latestIntent: (JournalRow & { decisionCode: AutoDecisionIntentCode }) | null
  systemActorOk: boolean
  clientBlocked: boolean
  duplicateBlocked: boolean
  stateChanged?: boolean
}): WorksiteCreationPhase {
  if (input.stateChanged) return "STATE_CHANGED"

  if (
    input.draftStatus === "CONVERTED" ||
    (input.createdWorksiteId != null && input.createdWorksiteId !== "")
  ) {
    return "ALREADY_CONVERTED"
  }

  if (input.draftStatus === "REJECTED") return "SKIP_CANCELLED"

  if (input.draftStatus !== "APPROVED") return "STATE_CHANGED"

  if (!input.draftContentHash) return "SKIP_NO_VALID_INTENT"

  const intent = input.latestIntent
  if (!intent) return "SKIP_NO_VALID_INTENT"
  if (!isPostExtractionStepsPipeline(intent.metadata)) {
    return "SKIP_NO_VALID_INTENT"
  }

  if (intent.decisionCode === "AUTO_APPROVE_ONLY") {
    return "SKIP_AUTO_APPROVE_ONLY"
  }
  if (intent.decisionCode === "AUTO_REJECT_CANCELLED") {
    return "SKIP_CANCELLED"
  }
  if (intent.decisionCode !== "AUTO_APPROVE_CONVERT") {
    return "SKIP_NO_VALID_INTENT"
  }

  const frozen = parseFrozenValidationCycle(intent.metadata)
  if (!frozen) return "SKIP_NO_VALID_INTENT"
  if (frozen.contentHash !== input.draftContentHash) {
    return "SKIP_NO_VALID_INTENT"
  }
  if (
    frozen.extractionSchemaVersion !== input.draftExtractionSchemaVersion
  ) {
    return "SKIP_NO_VALID_INTENT"
  }

  if (
    !isDirectApprovalAssociation({
      draftVersion: input.draftVersion,
      validatedDraftVersion: frozen.validatedDraftVersion,
    })
  ) {
    return "SKIP_STALE_APPROVAL"
  }

  if (!input.systemActorOk) return "BLOCKED_SYSTEM_ACTOR"
  if (input.duplicateBlocked) return "BLOCKED_DUPLICATE"
  if (input.clientBlocked) return "BLOCKED_CLIENT"

  return "NEEDS_CONVERSION"
}

/** Mappe skips worker → contrat WorksiteCreationDecision (raisons existantes uniquement). */
export function mapSkipPhaseToWorksiteCreationDecision(
  phase: WorksiteCreationPhase
): WorksiteCreationDecision {
  if (phase === "SKIP_CANCELLED") {
    return { code: "SKIPPED", reason: "CANCELLED" }
  }
  return { code: "SKIPPED", reason: "NOT_APPROVED" }
}

export function mapConvertResultToWorksiteCreationDecision(
  result: ConvertImportDraftResult
): WorksiteCreationDecision {
  if (result.ok) {
    if (result.outcome === "CONVERTED") {
      return {
        code: "CREATED",
        worksiteId: result.worksiteId,
        clientId: result.clientId,
      }
    }
    return {
      code: "ALREADY_CONVERTED",
      worksiteId: result.worksiteId,
      clientId: result.clientId,
    }
  }
  return {
    code: "FAILED",
    outcome: result.outcome,
    errorCode: result.code,
    ...(result.existingWorksiteId
      ? { existingWorksiteId: result.existingWorksiteId }
      : {}),
  }
}

/**
 * Parité exacte auto-decision.service convert input (legacy).
 * Retourne null si NEW impossible → BLOCKED_CLIENT.
 */
export function buildLegacyConvertInput(input: {
  draftId: string
  expectedVersion: number
  ctx: ConsultationEvaluationContext
}): ConvertImportDraftInput | null {
  const { ctx } = input
  const draft = ctx.draft
  const clientMatch = ctx.clientMatch
  const allowCreateClient = ctx.partner?.allowCreateClient === true
  const extractedClientEmail = ctx.snapshot.clientEmail

  if (clientMatch.clientId != null) {
    return {
      draftId: input.draftId,
      expectedVersion: input.expectedVersion,
      clientMode: "EXISTING",
      existingClientId: clientMatch.clientId,
      acknowledgeDuplicateWorksite: false,
    }
  }

  if (
    !allowCreateClient ||
    clientMatch.ambiguous === true ||
    !(draft.proposedClientName?.trim() || extractedClientEmail)
  ) {
    return null
  }

  const name = (draft.proposedClientName ?? "").trim().slice(0, 100)
  if (!name) return null

  return {
    draftId: input.draftId,
    expectedVersion: input.expectedVersion,
    clientMode: "NEW",
    newClient: {
      name,
      email: extractedClientEmail,
      phone: null,
      address:
        [draft.proposedAddress, draft.proposedPostalCode, draft.proposedCity]
          .filter(Boolean)
          .join(", ")
          .slice(0, 500) || null,
    },
    acknowledgeDuplicateWorksite: false,
  }
}

export function isClientBlockedForConversion(
  ctx: ConsultationEvaluationContext
): boolean {
  return buildLegacyConvertInput({
    draftId: ctx.draft.id,
    expectedVersion: ctx.draft.version,
    ctx,
  }) === null
}

export function isDuplicateBlockedForConversion(
  ctx: ConsultationEvaluationContext
): boolean {
  return Boolean(ctx.duplicate.worksiteId)
}

/**
 * Fairness mémoire miroir SQL : ROW_NUMBER PARTITION BY companyId.
 */
export function rankWorksiteCreationCandidatesFairness(
  rows: WorksiteCreationWorkerCandidate[],
  input: { maxPerCompany: number; limit: number }
): WorksiteCreationWorkerCandidate[] {
  const maxPerCompany = Math.max(1, Math.floor(input.maxPerCompany))
  const limit = Math.max(1, Math.floor(input.limit))
  const byCompany = new Map<string, WorksiteCreationWorkerCandidate[]>()
  const sorted = [...rows].sort((a, b) => {
    const t = a.updatedAt.getTime() - b.updatedAt.getTime()
    if (t !== 0) return t
    if (a.draftId < b.draftId) return -1
    if (a.draftId > b.draftId) return 1
    return 0
  })
  const capped: WorksiteCreationWorkerCandidate[] = []
  for (const row of sorted) {
    const n = byCompany.get(row.companyId) ?? []
    if (n.length >= maxPerCompany) continue
    n.push(row)
    byCompany.set(row.companyId, n)
    capped.push(row)
  }
  return capped
    .sort((a, b) => {
      const t = a.updatedAt.getTime() - b.updatedAt.getTime()
      if (t !== 0) return t
      if (a.companyId < b.companyId) return -1
      if (a.companyId > b.companyId) return 1
      if (a.draftId < b.draftId) return -1
      if (a.draftId > b.draftId) return 1
      return 0
    })
    .slice(0, limit)
}

export function createPrismaWorksiteCreationSelectionPort(
  db: PrismaClient = prisma
): WorksiteCreationWorkerSelectionPort {
  return {
    async listEligibleCandidates(input) {
      const limit = Math.max(1, Math.floor(input.limit))
      const maxPerCompany = Math.max(
        1,
        Math.floor(
          input.maxPerCompany ?? WORKSITE_CREATION_WORKER_MAX_PER_COMPANY
        )
      )

      type Row = {
        id: string
        companyId: string
        status: string
        version: number
        contentHashAtExtraction: string
        extractionSchemaVersion: string | null
        updatedAt: Date
      }

      /**
       * Eligibility DB volontairement large : APPROVED + EXISTS intent
       * post-extraction pour hash/schema. Le process vérifie latest = CONVERT
       * + association version === validatedDraftVersion + 1.
       */
      const rows = await db.$queryRaw<Row[]>`
        WITH eligible AS (
          SELECT
            d.id,
            d."companyId",
            d.status::text AS status,
            d.version,
            d."contentHashAtExtraction",
            d."extractionSchemaVersion",
            d."updatedAt"
          FROM "worksite_import_drafts" d
          WHERE d."status" = CAST('APPROVED' AS "WorksiteImportDraftStatus")
            AND d."createdWorksiteId" IS NULL
            AND d."contentHashAtExtraction" IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM "acquisition_decision_journals" j
              WHERE j."companyId" = d."companyId"
                AND j."draftId" = d.id
                AND j."decisionCode" IN (
                  'AUTO_APPROVE_ONLY',
                  'AUTO_APPROVE_CONVERT',
                  'AUTO_REJECT_CANCELLED',
                  'HUMAN_REVIEW_REQUIRED'
                )
                AND j.metadata->>'pipeline' = 'POST_EXTRACTION_STEPS'
                AND j.metadata->'validationCycle'->>'contentHash'
                    = d."contentHashAtExtraction"
                AND j.metadata->'validationCycle'->>'extractionSchemaVersion'
                    IS NOT DISTINCT FROM d."extractionSchemaVersion"
            )
        ),
        ranked AS (
          SELECT
            e.*,
            ROW_NUMBER() OVER (
              PARTITION BY e."companyId"
              ORDER BY e."updatedAt" ASC, e.id ASC
            ) AS tenant_rank
          FROM eligible e
        )
        SELECT
          ranked.id,
          ranked."companyId",
          ranked.status,
          ranked.version,
          ranked."contentHashAtExtraction",
          ranked."extractionSchemaVersion",
          ranked."updatedAt"
        FROM ranked
        WHERE ranked.tenant_rank <= ${maxPerCompany}
        ORDER BY ranked."updatedAt" ASC, ranked."companyId" ASC, ranked.id ASC
        LIMIT ${limit}
      `

      return rows.map((r) => ({
        draftId: r.id,
        companyId: r.companyId,
        status: r.status,
        version: r.version,
        contentHashAtExtraction: r.contentHashAtExtraction,
        extractionSchemaVersion: r.extractionSchemaVersion,
        updatedAt: r.updatedAt,
      }))
    },
  }
}

async function reloadDraft(
  db: PrismaClient,
  companyId: string,
  draftId: string
): Promise<DraftReloadRow | null> {
  return db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      status: true,
      version: true,
      createdWorksiteId: true,
      contentHashAtExtraction: true,
      extractionSchemaVersion: true,
      proposedClientName: true,
      proposedAddress: true,
      proposedPostalCode: true,
      proposedCity: true,
    },
  })
}

function recordPhase(
  stats: WorksiteCreationWorkerRunStats,
  phase: WorksiteCreationPhase
): void {
  switch (phase) {
    case "ALREADY_CONVERTED":
      stats.alreadyConverted++
      break
    case "SKIP_STALE_APPROVAL":
      stats.staleApproval++
      stats.skipped++
      break
    case "BLOCKED_SYSTEM_ACTOR":
      stats.blockedSystemActor++
      break
    case "BLOCKED_CLIENT":
      stats.blockedClient++
      break
    case "BLOCKED_DUPLICATE":
      stats.blockedDuplicate++
      break
    case "STATE_CHANGED":
      stats.stateChanged++
      break
    case "SKIP_AUTO_APPROVE_ONLY":
    case "SKIP_NO_VALID_INTENT":
    case "SKIP_CANCELLED":
      stats.skipped++
      break
    default:
      break
  }
}

export async function runAcquisitionWorksiteCreationWorker(
  input: WorksiteCreationWorkerDeps = {}
): Promise<WorksiteCreationWorkerRunResult> {
  const db = input.db ?? prisma
  const journal = input.journal ?? acquisitionDecisionJournalRepository
  const selection =
    input.selection ?? createPrismaWorksiteCreationSelectionPort(db)
  const conversion: ConvertImportDraftPort =
    input.conversion ?? importDraftConversionService
  const resolveSystemActor =
    input.resolveSystemActor ?? resolveValidatedSystemActor
  const nowFn = input.now ?? (() => new Date())
  const log = input.log ?? defaultLog
  const maxCandidates =
    input.maxCandidates ?? WORKSITE_CREATION_WORKER_MAX_CANDIDATES
  const maxScan = input.maxScan ?? WORKSITE_CREATION_WORKER_MAX_SCAN
  const maxPerCompany =
    input.maxPerCompany ?? WORKSITE_CREATION_WORKER_MAX_PER_COMPANY
  const deadlineMs =
    typeof input.maxDurationMs === "number" && input.maxDurationMs > 0
      ? Date.now() + input.maxDurationMs
      : null

  const stats = emptyStats()

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    stats.leaseStolen++
    return {
      status: "FAILED",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease perdu avant sélection" },
      stats,
    }
  }

  const candidates = await selection.listEligibleCandidates({
    limit: Math.min(maxCandidates, maxScan),
    now: nowFn(),
    maxPerCompany,
  })
  stats.selected = candidates.length
  stats.scanned = candidates.length

  log("RUN_START", {
    selected: candidates.length,
    maxCandidates,
    maxPerCompany,
  })

  for (const candidate of candidates) {
    if (deadlineMs != null && Date.now() >= deadlineMs) {
      log("BUDGET_EXHAUSTED", { processed: stats.converted + stats.skipped })
      break
    }

    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      stats.leaseStolen++
      return {
        status: "FAILED",
        skipReason: "LEASE_STOLEN",
        error: {
          code: "LEASE_STOLEN",
          message: "Lease perdu avant candidat",
        },
        stats,
      }
    }

    try {
      const outcome = await processCandidate({
        candidate,
        db,
        journal,
        conversion,
        resolveSystemActor,
        evaluationDeps: input.evaluationDeps,
        ensureOwnership: input.ensureOwnership,
        transactionalOwnershipFence: input.transactionalOwnershipFence,
        log,
        stats,
      })
      if (outcome?.leaseStolen) {
        return {
          status: "FAILED",
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu pendant candidat",
          },
          stats,
        }
      }
    } catch (err) {
      stats.errors++
      log("CANDIDATE_ERROR", {
        draftId: candidate.draftId,
        companyId: candidate.companyId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const status =
    stats.leaseStolen > 0
      ? "FAILED"
      : stats.errors > 0
        ? "PARTIAL"
        : "SUCCESS"

  log("RUN_DONE", { status, ...stats })
  return { status, stats }
}

async function processCandidate(input: {
  candidate: WorksiteCreationWorkerCandidate
  db: PrismaClient
  journal: AcquisitionDecisionJournalRepository
  conversion: ConvertImportDraftPort
  resolveSystemActor: (
    companyId: string,
    db?: PrismaClient
  ) => Promise<SystemActorResolution>
  evaluationDeps?: ConsultationEvaluationContextDeps
  ensureOwnership?: OrchestratorItemOwnershipCheck
  transactionalOwnershipFence?: ConversionTransactionalOwnershipFence
  log: (event: string, payload?: Record<string, unknown>) => void
  stats: WorksiteCreationWorkerRunStats
}): Promise<{ leaseStolen?: boolean } | void> {
  const { candidate, db, journal, conversion, stats, log } = input

  const draft1 = await reloadDraft(db, candidate.companyId, candidate.draftId)
  if (!draft1) {
    stats.stateChanged++
    return
  }

  if (
    draft1.status !== "APPROVED" ||
    draft1.createdWorksiteId != null ||
    !draft1.contentHashAtExtraction
  ) {
    if (draft1.status === "CONVERTED" || draft1.createdWorksiteId) {
      stats.alreadyConverted++
    } else {
      stats.stateChanged++
    }
    return
  }

  const intent1 =
    await journal.findLatestPostExtractionAutoIntentForExtractionIdentity({
      companyId: candidate.companyId,
      draftId: candidate.draftId,
      contentHash: draft1.contentHashAtExtraction,
      extractionSchemaVersion: draft1.extractionSchemaVersion,
    })

  const systemActor = await input.resolveSystemActor(candidate.companyId, db)

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    stats.leaseStolen++
    return { leaseStolen: true }
  }

  const ctx = await buildConsultationEvaluationContext({
    companyId: candidate.companyId,
    draftId: candidate.draftId,
    deps: input.evaluationDeps ?? { db },
  })

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    stats.leaseStolen++
    return { leaseStolen: true }
  }

  if (!ctx) {
    stats.stateChanged++
    return
  }

  const clientBlocked = isClientBlockedForConversion(ctx)
  const duplicateBlocked = isDuplicateBlockedForConversion(ctx)

  let phase = resolveWorksiteCreationState({
    draftStatus: draft1.status,
    createdWorksiteId: draft1.createdWorksiteId,
    draftVersion: draft1.version,
    draftContentHash: draft1.contentHashAtExtraction,
    draftExtractionSchemaVersion: draft1.extractionSchemaVersion,
    latestIntent: intent1,
    systemActorOk: systemActor.ok,
    clientBlocked,
    duplicateBlocked,
  })

  if (phase !== "NEEDS_CONVERSION") {
    recordPhase(stats, phase)
    log("CANDIDATE_SKIP", {
      draftId: candidate.draftId,
      companyId: candidate.companyId,
      phase,
    })
    return
  }

  // Reload final avant mutation
  const draft2 = await reloadDraft(db, candidate.companyId, candidate.draftId)
  if (
    !draft2 ||
    draft2.status !== "APPROVED" ||
    draft2.createdWorksiteId != null ||
    !draft2.contentHashAtExtraction ||
    draft2.contentHashAtExtraction !== draft1.contentHashAtExtraction ||
    draft2.extractionSchemaVersion !== draft1.extractionSchemaVersion ||
    draft2.version !== draft1.version
  ) {
    recordPhase(stats, "STATE_CHANGED")
    log("CANDIDATE_SKIP", {
      draftId: candidate.draftId,
      phase: "STATE_CHANGED",
      reason: "final_reload_mismatch",
    })
    return
  }

  const intent2 =
    await journal.findLatestPostExtractionAutoIntentForExtractionIdentity({
      companyId: candidate.companyId,
      draftId: candidate.draftId,
      contentHash: draft2.contentHashAtExtraction,
      extractionSchemaVersion: draft2.extractionSchemaVersion,
    })

  phase = resolveWorksiteCreationState({
    draftStatus: draft2.status,
    createdWorksiteId: draft2.createdWorksiteId,
    draftVersion: draft2.version,
    draftContentHash: draft2.contentHashAtExtraction,
    draftExtractionSchemaVersion: draft2.extractionSchemaVersion,
    latestIntent: intent2,
    systemActorOk: systemActor.ok,
    clientBlocked,
    duplicateBlocked,
  })

  if (phase !== "NEEDS_CONVERSION") {
    recordPhase(stats, phase)
    log("CANDIDATE_SKIP", {
      draftId: candidate.draftId,
      phase,
      reason: "post_reload_recheck",
    })
    return
  }

  // Rebuild convert input with MUTATION_EXPECTED_VERSION = draft2.version (pure)
  const convertInput = buildLegacyConvertInput({
    draftId: draft2.id,
    expectedVersion: draft2.version,
    ctx: {
      ...ctx,
      draft: { ...ctx.draft, version: draft2.version },
    },
  })
  if (!convertInput) {
    recordPhase(stats, "BLOCKED_CLIENT")
    return
  }

  // AUTHORIZATION_VERSION ≠ expectedVersion — assert invariant (pure)
  const frozen = intent2 ? parseFrozenValidationCycle(intent2.metadata) : null
  if (
    !frozen ||
    convertInput.expectedVersion === frozen.validatedDraftVersion
  ) {
    recordPhase(stats, "STATE_CHANGED")
    return
  }

  // Correction-1 : revalidation SYSTEM actor IMMÉDIATEMENT avant fence final
  const finalSystemActor = await input.resolveSystemActor(
    candidate.companyId,
    db
  )
  if (!finalSystemActor.ok) {
    recordPhase(stats, "BLOCKED_SYSTEM_ACTOR")
    log("CANDIDATE_SKIP", {
      draftId: candidate.draftId,
      phase: "BLOCKED_SYSTEM_ACTOR",
      reason: "final_actor_invalid",
      code: finalSystemActor.code,
    })
    return
  }

  // Fence FINAL — aucune I/O (DB / journal / actor) entre fence et convert
  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    stats.leaseStolen++
    return { leaseStolen: true }
  }

  const actor: ConversionActorContext = {
    companyId: candidate.companyId,
    actorUserId: finalSystemActor.userId,
    actorRole: "SYSTEM",
  }

  log("CONVERT_CALL", {
    draftId: draft2.id,
    companyId: candidate.companyId,
    expectedVersion: convertInput.expectedVersion,
    authorizationVersion: frozen.validatedDraftVersion,
    clientMode: convertInput.clientMode,
    acknowledgeDuplicateWorksite: convertInput.acknowledgeDuplicateWorksite,
    actorUserId: actor.actorUserId,
  })

  const result = await conversion.convertImportDraft(actor, convertInput, {
    ...(input.transactionalOwnershipFence
      ? { transactionalOwnershipFence: input.transactionalOwnershipFence }
      : {}),
  })

  if (!result.ok && result.code === "LEASE_NOT_OWNED") {
    stats.leaseStolen++
    log("CONVERT_LEASE_STOLEN", {
      draftId: draft2.id,
      code: result.code,
    })
    return { leaseStolen: true }
  }

  const decision = mapConvertResultToWorksiteCreationDecision(result)

  if (result.ok && result.outcome === "CONVERTED") {
    stats.converted++
    log("CONVERT_OK", {
      draftId: draft2.id,
      worksiteId: result.worksiteId,
      clientId: result.clientId,
      decision: decision.code,
    })
    return
  }

  if (result.ok && result.outcome === "ALREADY_CONVERTED") {
    stats.alreadyConverted++
    log("ALREADY_CONVERTED", {
      draftId: draft2.id,
      worksiteId: result.worksiteId,
      decision: decision.code,
    })
    return
  }

  if (!result.ok) {
    if (result.outcome === "DUPLICATE_REQUIRES_ACK") {
      stats.blockedDuplicate++
    } else if (
      result.outcome === "STATE_CHANGED" ||
      result.outcome === "INVALID_STATE"
    ) {
      stats.stateChanged++
    } else if (result.outcome === "CLIENT_NOT_FOUND") {
      stats.blockedClient++
    } else {
      stats.errors++
    }
    log("CONVERT_FAILED", {
      draftId: draft2.id,
      outcome: result.outcome,
      code: result.code,
      decision: decision.code,
    })
  }
}
