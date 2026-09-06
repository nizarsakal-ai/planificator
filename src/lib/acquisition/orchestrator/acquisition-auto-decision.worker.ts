/**
 * PLAN-ACQ-AGENTS-LOT-3E — Worker batch auto-decision (restartable).
 * VALIDATION_PASS / FAIL_TERMINAL(cancel) → intent → approve|reject|follow-up.
 * AUCUNE conversion. AUCUN import du service de conversion.
 *
 * Cycle figé (Correction-1) :
 * - PRE-MUTATION PENDING_REVIEW : draft.version === validatedDraftVersion
 * - POST-MUTATION REJECTED : follow-up via intent.validationCycle (ignore version courante)
 */

import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  buildConsultationEvaluationContext,
  type ConsultationEvaluationContext,
  type ConsultationEvaluationContextDeps,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  isOrchestratorOwnershipValid,
  type OrchestratorItemOwnershipCheck,
} from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  isAcquisitionAutoApproveEnabled,
  isAcquisitionAutoConvertEnabled,
} from "@/lib/acquisition/policy/auto-decision-feature-flag"
import {
  evaluateAutoDecision,
  type AutoDecisionResult,
} from "@/lib/acquisition/policy/auto-decision.policy"
import {
  applyCancellationFollowUpTransactionally,
  CancellationLeaseNotOwnedError,
} from "@/lib/acquisition/policy/cancellation-followup"
import {
  AcquisitionDecisionJournalRepository,
  acquisitionDecisionJournalRepository,
  buildAutoIntentIdempotencyKey,
  buildSystemActorInvalidIdempotencyKey,
  draftMatchesFrozenCycle,
  parseFrozenValidationCycle,
  toFrozenValidationCycle,
  AUTO_DECISION_INTENT_CODES,
  type AutoDecisionIntentCode,
  type FrozenValidationCycle,
  type JournalRow,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"
import {
  resolveValidatedSystemActor,
  type SystemActorResolution,
} from "@/lib/acquisition/policy/system-actor"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"

const LOG_PREFIX = "[acquisition-auto-decision-worker]"

export const AUTO_DECISION_WORKER_MAX_CANDIDATES = 25
export const AUTO_DECISION_WORKER_MAX_SCAN = 500
export const AUTO_DECISION_WORKER_MAX_PER_COMPANY = 5

export type AutoDecisionApplicationPhase =
  | "NEEDS_DECISION"
  | "NEEDS_APPROVE"
  | "NEEDS_REJECT"
  | "NEEDS_CANCEL_FOLLOWUP"
  | "DONE_HUMAN"
  | "DONE_APPROVED"
  | "DONE_REJECTED"
  | "BLOCKED_SYSTEM_ACTOR"
  | "STALE_CYCLE"
  | "SKIP_INELIGIBLE"

export type AutoDecisionWorkerCandidate = {
  draftId: string
  companyId: string
  status: string
  version: number
  contentHashAtExtraction: string
  extractionSchemaVersion: string | null
  updatedAt: Date
  /** PATH A | PATH B pre-mutation | RECONCILE post-reject */
  selectionPath: "PASS" | "CANCEL" | "RECONCILE_FOLLOWUP"
}

export type AutoDecisionWorkerSelectionPort = {
  listEligibleCandidates(input: {
    limit: number
    now: Date
    maxPerCompany?: number
  }): Promise<AutoDecisionWorkerCandidate[]>
}

export type AutoDecisionWorkerRunStats = {
  selected: number
  scanned: number
  decided: number
  intentAppended: number
  approved: number
  rejected: number
  followUpApplied: number
  human: number
  stale: number
  skipped: number
  blockedSystemActor: number
  leaseStolen: number
  errors: number
}

export type AutoDecisionWorkerRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  skipReason?: string
  error?: { code: string; message: string }
  stats: AutoDecisionWorkerRunStats
}

export type AutoDecisionWorkerDeps = {
  db?: PrismaClient
  journal?: AcquisitionDecisionJournalRepository
  selection?: AutoDecisionWorkerSelectionPort
  evaluationDeps?: ConsultationEvaluationContextDeps
  review?: ImportDraftReviewService
  resolveSystemActor?: (
    companyId: string,
    db?: PrismaClient
  ) => Promise<SystemActorResolution>
  ensureOwnership?: OrchestratorItemOwnershipCheck
  /** LOT-3G — fence TX authentique. Obligatoire chemin AUTO. */
  transactionalOwnershipFence?: TransactionalOwnershipFence
  now?: () => Date
  maxCandidates?: number
  maxScan?: number
  maxPerCompany?: number
  maxDurationMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
  /** Kill-switches injectables (tests). */
  isAutoApproveEnabled?: () => boolean
  isAutoConvertEnabled?: () => boolean
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function emptyStats(): AutoDecisionWorkerRunStats {
  return {
    selected: 0,
    scanned: 0,
    decided: 0,
    intentAppended: 0,
    approved: 0,
    rejected: 0,
    followUpApplied: 0,
    human: 0,
    stale: 0,
    skipped: 0,
    blockedSystemActor: 0,
    leaseStolen: 0,
    errors: 0,
  }
}

export function computeEffectiveAutoFlags(input: {
  partnerAutoApprove: boolean
  partnerAutoConvert: boolean
  globalAutoApprove?: boolean
  globalAutoConvert?: boolean
}): { effectiveAutoApproveEnabled: boolean; effectiveAutoConvertEnabled: boolean } {
  const globalApprove =
    input.globalAutoApprove ?? isAcquisitionAutoApproveEnabled()
  const globalConvert =
    input.globalAutoConvert ?? isAcquisitionAutoConvertEnabled()
  return {
    effectiveAutoApproveEnabled: globalApprove && input.partnerAutoApprove,
    effectiveAutoConvertEnabled: globalConvert && input.partnerAutoConvert,
  }
}

export function isConsultationCancelledTerminal(row: {
  decisionCode: string
  reasons: unknown
  metadata: unknown
}): boolean {
  if (row.decisionCode !== "VALIDATION_FAIL_TERMINAL") return false
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  if (meta.errorCode === "CONSULTATION_CANCELLED") return true
  if (Array.isArray(row.reasons)) {
    return row.reasons.some((r) => r === "CONSULTATION_CANCELLED")
  }
  return false
}

/**
 * State machine pure — Correction-1 pre vs post mutation.
 */
export function resolveAutoDecisionApplicationState(input: {
  draftStatus: string
  draftContentHash: string | null
  draftExtractionSchemaVersion: string | null
  draftVersion: number
  validationForCurrentCycle: ValidationJournalRow | null
  intentForFrozenCycle: (JournalRow & { decisionCode: AutoDecisionIntentCode }) | null
  followUpForIntentCycle: JournalRow | null
  systemActorOk: boolean
}): AutoDecisionApplicationPhase {
  const { draftStatus } = input

  // --- POST-MUTATION RECONCILIATION ---
  if (draftStatus === "APPROVED") {
    if (
      input.intentForFrozenCycle &&
      (input.intentForFrozenCycle.decisionCode === "AUTO_APPROVE_ONLY" ||
        input.intentForFrozenCycle.decisionCode === "AUTO_APPROVE_CONVERT")
    ) {
      return "DONE_APPROVED"
    }
    return "SKIP_INELIGIBLE"
  }

  if (draftStatus === "REJECTED") {
    if (
      input.intentForFrozenCycle?.decisionCode === "AUTO_REJECT_CANCELLED"
    ) {
      if (input.followUpForIntentCycle) return "DONE_REJECTED"
      return "NEEDS_CANCEL_FOLLOWUP"
    }
    return "SKIP_INELIGIBLE"
  }

  // --- PRE-MUTATION ---
  if (draftStatus !== "PENDING_REVIEW") return "SKIP_INELIGIBLE"

  const currentCycle: ValidationCycleIdentity | null =
    input.draftContentHash != null
      ? {
          contentHash: input.draftContentHash,
          extractionSchemaVersion: input.draftExtractionSchemaVersion,
          draftVersion: input.draftVersion,
        }
      : null

  if (!currentCycle) return "SKIP_INELIGIBLE"

  // Intent exists but cycle mismatch vs current draft → STALE (human edited)
  if (input.intentForFrozenCycle) {
    const frozen = parseFrozenValidationCycle(
      input.intentForFrozenCycle.metadata
    )
    if (
      frozen &&
      !draftMatchesFrozenCycle({
        contentHashAtExtraction: input.draftContentHash,
        extractionSchemaVersion: input.draftExtractionSchemaVersion,
        version: input.draftVersion,
        frozen,
      })
    ) {
      return "STALE_CYCLE"
    }
  }

  const v = input.validationForCurrentCycle
  const cancelPath = v != null && isConsultationCancelledTerminal(v)
  const passPath = v?.decisionCode === "VALIDATION_PASS"

  if (!passPath && !cancelPath) return "SKIP_INELIGIBLE"

  if (input.intentForFrozenCycle) {
    const code = input.intentForFrozenCycle.decisionCode
    if (code === "HUMAN_REVIEW_REQUIRED") return "DONE_HUMAN"
    if (code === "AUTO_APPROVE_ONLY" || code === "AUTO_APPROVE_CONVERT") {
      if (!input.systemActorOk) return "BLOCKED_SYSTEM_ACTOR"
      return "NEEDS_APPROVE"
    }
    if (code === "AUTO_REJECT_CANCELLED") {
      if (!input.systemActorOk) return "BLOCKED_SYSTEM_ACTOR"
      return "NEEDS_REJECT"
    }
  }

  return "NEEDS_DECISION"
}

export function buildAutoDecisionPolicyInput(input: {
  ctx: ConsultationEvaluationContext
  effectiveAutoApproveEnabled: boolean
  effectiveAutoConvertEnabled: boolean
}) {
  const { ctx } = input
  const snap = ctx.snapshot
  return {
    worksiteName: snap.worksiteName,
    startDate: snap.requestedStartDate
      ? new Date(`${snap.requestedStartDate}T00:00:00.000Z`)
      : null,
    endDate: snap.requestedEndDate
      ? new Date(`${snap.requestedEndDate}T00:00:00.000Z`)
      : null,
    address: snap.address,
    postalCode: snap.postalCode ?? null,
    city: snap.city,
    clientName: snap.clientName,
    clientEmail: snap.clientEmail,
    confidenceData: snap.confidenceData,
    warningData: snap.warnings,
    autoApproveEnabled: input.effectiveAutoApproveEnabled,
    autoConvertEnabled: input.effectiveAutoConvertEnabled,
    minConfidence:
      ctx.partnerProfile?.minConfidence ??
      ctx.partner?.minConfidence ??
      undefined,
    potentialDuplicate: Boolean(snap.potentialDuplicate),
    clientAmbiguous: Boolean(snap.clientAmbiguous),
    requiredDocumentUnreadable: Boolean(snap.requiredDocumentUnreadable),
    consultationCancelled: Boolean(snap.consultationCancelled),
    hasResolvedClient: Boolean(snap.hasResolvedClient),
  }
}

function intentMetadataBase(input: {
  frozen: FrozenValidationCycle
  validationJournalId: string
  validationDecisionCode: string
  path: "PASS" | "CANCEL"
  partnerId: string | null
  partnerCode: string | null
  systemActorOk: boolean
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    pipeline: "POST_EXTRACTION_STEPS",
    validationCycle: {
      contentHash: input.frozen.contentHash,
      extractionSchemaVersion: input.frozen.extractionSchemaVersion,
      validatedDraftVersion: input.frozen.validatedDraftVersion,
    },
    validationJournalId: input.validationJournalId,
    validationDecisionCode: input.validationDecisionCode,
    path: input.path,
    partnerId: input.partnerId,
    partnerCode: input.partnerCode,
    systemActorOk: input.systemActorOk,
    ...(input.extra ?? {}),
  }
}

/** SQL: preuve cancel exacte (alias j) — alignée sur isConsultationCancelledTerminal. */
export function cancelProofSql(): Prisma.Sql {
  // reasons est Json Prisma → jsonb Postgres : containment exact d'élément string.
  return Prisma.sql`
    (
      j.metadata->>'errorCode' = 'CONSULTATION_CANCELLED'
      OR j.reasons @> ${JSON.stringify(["CONSULTATION_CANCELLED"])}::jsonb
    )
  `
}

/**
 * Latest VALIDATION_* for draft current cycle (alias d), as subquery alias j.
 */
function latestValidationForDraftCycleSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT j.id, j."decisionCode", j.metadata, j.reasons
    FROM "acquisition_decision_journals" j
    WHERE j."companyId" = d."companyId"
      AND j."draftId" = d.id
      AND j."decisionCode" IN (
        'VALIDATION_PASS',
        'VALIDATION_QUARANTINE',
        'VALIDATION_FAIL_RETRYABLE',
        'VALIDATION_FAIL_TERMINAL'
      )
      AND j.metadata->>'contentHash' = d."contentHashAtExtraction"
      AND j.metadata->>'extractionSchemaVersion'
          IS NOT DISTINCT FROM d."extractionSchemaVersion"
      AND (j.metadata->>'draftVersion')::int = d.version
    ORDER BY j."createdAt" DESC, j.id DESC
    LIMIT 1
  `
}

/**
 * Fairness mémoire miroir SQL : ROW_NUMBER PARTITION BY companyId
 * puis ORDER BY updatedAt, companyId, id — PAS de préfiltre companyId LIMIT.
 */
export function rankAutoDecisionCandidatesFairness(
  rows: AutoDecisionWorkerCandidate[],
  input: { maxPerCompany: number; limit: number }
): AutoDecisionWorkerCandidate[] {
  const maxPerCompany = Math.max(1, Math.floor(input.maxPerCompany))
  const limit = Math.max(1, Math.floor(input.limit))
  const byCompany = new Map<string, AutoDecisionWorkerCandidate[]>()
  const sorted = [...rows].sort((a, b) => {
    const t = a.updatedAt.getTime() - b.updatedAt.getTime()
    if (t !== 0) return t
    if (a.draftId < b.draftId) return -1
    if (a.draftId > b.draftId) return 1
    return 0
  })
  const capped: AutoDecisionWorkerCandidate[] = []
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

export function createPrismaAutoDecisionSelectionPort(
  db: PrismaClient = prisma
): AutoDecisionWorkerSelectionPort {
  return {
    async listEligibleCandidates(input) {
      const limit = Math.max(1, Math.floor(input.limit))
      const maxPerCompany = Math.max(
        1,
        Math.floor(input.maxPerCompany ?? AUTO_DECISION_WORKER_MAX_PER_COMPANY)
      )

      type Row = {
        id: string
        companyId: string
        status: string
        version: number
        contentHashAtExtraction: string
        extractionSchemaVersion: string | null
        updatedAt: Date
        selectionPath: string
      }

      /**
       * Set-based fairness : ROW_NUMBER par tenant puis ordre global updatedAt.
       * Pas de SELECT DISTINCT companyId ORDER BY companyId LIMIT (starvation lexico).
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
            d."updatedAt",
            CASE
              WHEN EXISTS (
                SELECT 1 FROM (
                  ${latestValidationForDraftCycleSql()}
                ) j
                WHERE j."decisionCode" = 'VALIDATION_FAIL_TERMINAL'
                  AND ${cancelProofSql()}
              ) THEN 'CANCEL'
              ELSE 'PASS'
            END AS "selectionPath"
          FROM "worksite_import_drafts" d
          WHERE d."status" = CAST('PENDING_REVIEW' AS "WorksiteImportDraftStatus")
            AND d."contentHashAtExtraction" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM (
                ${latestValidationForDraftCycleSql()}
              ) j
              WHERE j."decisionCode" = 'VALIDATION_PASS'
                 OR (
                   j."decisionCode" = 'VALIDATION_FAIL_TERMINAL'
                   AND ${cancelProofSql()}
                 )
            )
          UNION ALL
          SELECT
            d.id,
            d."companyId",
            d.status::text AS status,
            d.version,
            COALESCE(d."contentHashAtExtraction", '') AS "contentHashAtExtraction",
            d."extractionSchemaVersion",
            d."updatedAt",
            'RECONCILE_FOLLOWUP' AS "selectionPath"
          FROM "worksite_import_drafts" d
          WHERE d."status" = CAST('REJECTED' AS "WorksiteImportDraftStatus")
            AND EXISTS (
              SELECT 1
              FROM "acquisition_decision_journals" intent
              WHERE intent."companyId" = d."companyId"
                AND intent."draftId" = d.id
                AND intent."decisionCode" = 'AUTO_REJECT_CANCELLED'
                AND intent.metadata->'validationCycle' IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM "acquisition_decision_journals" fu
                  WHERE fu."companyId" = d."companyId"
                    AND fu."draftId" = d.id
                    AND fu."decisionCode" IN (
                      'CANCELLATION_FOLLOWUP_APPLIED',
                      'CANCELLATION_AFTER_CONVERSION',
                      'CANCELLATION_TARGET_AMBIGUOUS',
                      'CANCELLATION_NO_LINK'
                    )
                    AND fu.metadata->'validationCycle'->>'contentHash'
                        = intent.metadata->'validationCycle'->>'contentHash'
                    AND fu.metadata->'validationCycle'->>'extractionSchemaVersion'
                        IS NOT DISTINCT FROM
                        intent.metadata->'validationCycle'->>'extractionSchemaVersion'
                    AND (fu.metadata->'validationCycle'->>'validatedDraftVersion')::int
                        = (intent.metadata->'validationCycle'->>'validatedDraftVersion')::int
                )
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
          ranked."updatedAt",
          ranked."selectionPath"
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
        selectionPath: r.selectionPath as AutoDecisionWorkerCandidate["selectionPath"],
      }))
    },
  }
}

export async function runAcquisitionAutoDecisionWorker(
  input: AutoDecisionWorkerDeps = {}
): Promise<AutoDecisionWorkerRunResult> {
  const db = input.db ?? prisma
  const journal = input.journal ?? acquisitionDecisionJournalRepository
  const selection =
    input.selection ?? createPrismaAutoDecisionSelectionPort(db)
  const review = input.review ?? new ImportDraftReviewService({ db })
  const resolveSystemActor =
    input.resolveSystemActor ?? resolveValidatedSystemActor
  const nowFn = input.now ?? (() => new Date())
  const log = input.log ?? defaultLog
  const maxCandidates =
    input.maxCandidates ?? AUTO_DECISION_WORKER_MAX_CANDIDATES
  const maxScan = input.maxScan ?? AUTO_DECISION_WORKER_MAX_SCAN
  const maxPerCompany =
    input.maxPerCompany ?? AUTO_DECISION_WORKER_MAX_PER_COMPANY
  const isApproveOn =
    input.isAutoApproveEnabled ?? isAcquisitionAutoApproveEnabled
  const isConvertOn =
    input.isAutoConvertEnabled ?? isAcquisitionAutoConvertEnabled
  const startedAt = Date.now()
  const maxDurationMs = input.maxDurationMs
  const stats = emptyStats()

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    return {
      status: "SKIPPED",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease non détenu" },
      stats,
    }
  }

  if (input.ensureOwnership && !input.transactionalOwnershipFence) {
    stats.leaseStolen++
    return {
      status: "FAILED",
      skipReason: "LEASE_STOLEN",
      error: {
        code: "LEASE_STOLEN",
        message: "Fence transactionnel absent",
      },
      stats,
    }
  }

  if (!isApproveOn()) {
    return {
      status: "SKIPPED",
      skipReason: "AUTO_APPROVE_DISABLED",
      stats,
    }
  }

  const ask = Math.min(maxCandidates, maxScan)
  const candidates = await selection.listEligibleCandidates({
    limit: ask,
    now: nowFn(),
    maxPerCompany,
  })
  stats.scanned = candidates.length
  stats.selected = candidates.length

  for (const candidate of candidates) {
    if (maxDurationMs != null && Date.now() - startedAt >= maxDurationMs) {
      log("AUTO_DECISION_BUDGET_EXHAUSTED", { processed: stats.decided })
      break
    }

    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      stats.leaseStolen++
      return {
        status: "PARTIAL",
        skipReason: "LEASE_STOLEN",
        error: { code: "LEASE_STOLEN", message: "Lease perdu avant candidat" },
        stats,
      }
    }

    try {
      const r = await processCandidate({
        candidate,
        db,
        journal,
        review,
        resolveSystemActor,
        evaluationDeps: input.evaluationDeps,
        ensureOwnership: input.ensureOwnership,
        transactionalOwnershipFence: input.transactionalOwnershipFence,
        isConvertOn: isConvertOn(),
        isApproveOn: isApproveOn(),
        stats,
        log,
      })
      if (r?.leaseStolen) {
        stats.leaseStolen++
        return {
          status: "PARTIAL",
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
      log("AUTO_DECISION_CANDIDATE_ERROR", {
        draftId: candidate.draftId,
        message: err instanceof Error ? err.message : "unknown",
      })
    }
  }

  if (stats.leaseStolen > 0 && stats.decided === 0 && stats.intentAppended === 0) {
    return {
      status: "FAILED",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease stolen" },
      stats,
    }
  }
  if (stats.errors > 0 && stats.approved + stats.rejected + stats.human === 0) {
    return {
      status: "FAILED",
      error: { code: "AUTO_DECISION_ERRORS", message: "Erreurs auto-decision" },
      stats,
    }
  }
  if (stats.errors > 0 || stats.leaseStolen > 0) {
    return { status: "PARTIAL", stats }
  }
  return { status: "SUCCESS", stats }
}

async function processCandidate(input: {
  candidate: AutoDecisionWorkerCandidate
  db: PrismaClient
  journal: AcquisitionDecisionJournalRepository
  review: ImportDraftReviewService
  resolveSystemActor: (
    companyId: string,
    db?: PrismaClient
  ) => Promise<SystemActorResolution>
  evaluationDeps?: ConsultationEvaluationContextDeps
  ensureOwnership?: OrchestratorItemOwnershipCheck
  transactionalOwnershipFence?: TransactionalOwnershipFence
  isConvertOn: boolean
  isApproveOn: boolean
  stats: AutoDecisionWorkerRunStats
  log: (event: string, payload?: Record<string, unknown>) => void
}): Promise<{ leaseStolen?: boolean } | void> {
  const { candidate, journal, review, db, stats, log } = input
  const fence = input.transactionalOwnershipFence

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    return { leaseStolen: true }
  }

  // Reload draft status/version
  const draftRow = await db.worksiteImportDraft.findFirst({
    where: { id: candidate.draftId, companyId: candidate.companyId },
    select: {
      status: true,
      version: true,
      contentHashAtExtraction: true,
      extractionSchemaVersion: true,
    },
  })
  if (!draftRow) {
    stats.skipped++
    return
  }

  const currentCycle: ValidationCycleIdentity | null =
    draftRow.contentHashAtExtraction
      ? {
          contentHash: draftRow.contentHashAtExtraction,
          extractionSchemaVersion: draftRow.extractionSchemaVersion,
          draftVersion: draftRow.version,
        }
      : null

  // Resolve intent + validation for state machine
  let validationForCurrent: ValidationJournalRow | null = null
  if (currentCycle && draftRow.status === "PENDING_REVIEW") {
    validationForCurrent = await journal.findLatestValidationDecisionForCycle({
      companyId: candidate.companyId,
      draftId: candidate.draftId,
      cycle: currentCycle,
    })
  }

  // For REJECTED reconcile: find latest AUTO_REJECT intent (any frozen), then follow-up
  let intent:
    | (JournalRow & { decisionCode: AutoDecisionIntentCode })
    | null = null
  let frozenForWork: FrozenValidationCycle | null = null

  if (draftRow.status === "REJECTED") {
    // Find latest AUTO_REJECT with frozen cycle (paginate via journal helper using soft match)
    intent = await findLatestAutoRejectIntent(journal, {
      companyId: candidate.companyId,
      draftId: candidate.draftId,
    })
    frozenForWork = intent
      ? parseFrozenValidationCycle(intent.metadata)
      : null
  } else if (currentCycle) {
    frozenForWork = toFrozenValidationCycle(currentCycle)
    intent = await journal.findLatestAutoIntentForCycle({
      companyId: candidate.companyId,
      draftId: candidate.draftId,
      frozen: frozenForWork,
    })
  }

  const followUp =
    frozenForWork && intent?.decisionCode === "AUTO_REJECT_CANCELLED"
      ? await journal.findLatestCancellationFollowUpForCycle({
          companyId: candidate.companyId,
          draftId: candidate.draftId,
          frozen: frozenForWork,
        })
      : null

  const systemActor = await input.resolveSystemActor(
    candidate.companyId,
    db
  )

  let phase = resolveAutoDecisionApplicationState({
    draftStatus: draftRow.status,
    draftContentHash: draftRow.contentHashAtExtraction,
    draftExtractionSchemaVersion: draftRow.extractionSchemaVersion,
    draftVersion: draftRow.version,
    validationForCurrentCycle: validationForCurrent,
    intentForFrozenCycle: intent,
    followUpForIntentCycle: followUp,
    systemActorOk: systemActor.ok,
  })

  if (phase === "STALE_CYCLE") {
    stats.stale++
    return
  }
  if (phase === "SKIP_INELIGIBLE") {
    stats.skipped++
    return
  }
  if (phase === "DONE_HUMAN") {
    stats.human++
    stats.decided++
    return
  }
  if (phase === "DONE_APPROVED") {
    stats.decided++
    return
  }
  if (phase === "DONE_REJECTED") {
    stats.decided++
    return
  }

  // Context after ownership (long reads)
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

  // --- NEEDS_DECISION ---
  if (phase === "NEEDS_DECISION") {
    if (!ctx || !currentCycle || !validationForCurrent || !frozenForWork) {
      stats.skipped++
      return
    }

    const path: "PASS" | "CANCEL" = isConsultationCancelledTerminal(
      validationForCurrent
    )
      ? "CANCEL"
      : "PASS"

    let decision: AutoDecisionResult
    if (path === "CANCEL") {
      decision = {
        code: "AUTO_REJECT_CANCELLED",
        reasons: ["CONSULTATION_CANCELLED"],
        scores: ctx.snapshot.confidenceData,
      }
    } else {
      const flags = computeEffectiveAutoFlags({
        partnerAutoApprove: ctx.partner?.autoApproveEnabled === true,
        partnerAutoConvert: ctx.partner?.autoConvertEnabled === true,
        globalAutoApprove: input.isApproveOn,
        globalAutoConvert: input.isConvertOn,
      })
      decision = evaluateAutoDecision(
        buildAutoDecisionPolicyInput({
          ctx,
          effectiveAutoApproveEnabled: flags.effectiveAutoApproveEnabled,
          effectiveAutoConvertEnabled: flags.effectiveAutoConvertEnabled,
        })
      )
    }

    // Payload préparé AVANT recheck/fence (pas de lecture DB ici)
    const intentPayload = intentMetadataBase({
      frozen: frozenForWork,
      validationJournalId: validationForCurrent.id,
      validationDecisionCode: validationForCurrent.decisionCode,
      path,
      partnerId: ctx.partner?.id ?? null,
      partnerCode: ctx.partner?.code ?? null,
      systemActorOk: systemActor.ok,
    })

    // FINAL DRAFT/CYCLE RECHECK immédiatement avant race + fence intent
    const beforeIntent = await db.worksiteImportDraft.findFirst({
      where: { id: candidate.draftId, companyId: candidate.companyId },
      select: {
        companyId: true,
        status: true,
        version: true,
        contentHashAtExtraction: true,
        extractionSchemaVersion: true,
      },
    })
    if (
      !beforeIntent ||
      beforeIntent.companyId !== candidate.companyId ||
      beforeIntent.status !== "PENDING_REVIEW" ||
      !draftMatchesFrozenCycle({
        contentHashAtExtraction: beforeIntent.contentHashAtExtraction,
        extractionSchemaVersion: beforeIntent.extractionSchemaVersion,
        version: beforeIntent.version,
        frozen: frozenForWork,
      })
    ) {
      stats.stale++
      return
    }

    // Race check intent (dernière lecture avant fence)
    const existingIntent = await journal.findLatestAutoIntentForCycle({
      companyId: candidate.companyId,
      draftId: candidate.draftId,
      frozen: frozenForWork,
    })
    if (existingIntent) {
      intent = existingIntent
    } else {
      // FINAL OWNERSHIP — fence TX autour de appendOnceInTransaction (AUTO)
      if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
        return { leaseStolen: true }
      }
      if (input.ensureOwnership && !fence) {
        return { leaseStolen: true }
      }
      const idempotencyKey = buildAutoIntentIdempotencyKey({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        frozen: frozenForWork,
      })
      const entry = {
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        decisionCode: decision.code,
        reasons: decision.reasons,
        scores: decision.scores,
        actorUserId: systemActor.ok ? systemActor.userId : null,
        idempotencyKey,
        metadata: intentPayload,
      }
      let appendResult
      if (fence) {
        try {
          appendResult = await db.$transaction(async (tx) => {
            const owned = await fence.assertOwnedAndLock(tx)
            if (owned !== "OWNED") {
              throw Object.assign(new Error("LEASE_NOT_OWNED"), {
                code: "LEASE_NOT_OWNED",
              })
            }
            return new AcquisitionDecisionJournalRepository(
              tx
            ).appendOnceInTransaction(entry)
          })
        } catch (err) {
          if (
            err instanceof Error &&
            ((err as { code?: string }).code === "LEASE_NOT_OWNED" ||
              err.message === "LEASE_NOT_OWNED")
          ) {
            return { leaseStolen: true }
          }
          throw err
        }
      } else {
        appendResult = await journal.appendOnce(entry)
      }
      if (appendResult.outcome === "APPENDED") {
        stats.intentAppended++
      }
      const winnerCode = appendResult.row.decisionCode
      if (
        !(AUTO_DECISION_INTENT_CODES as readonly string[]).includes(winnerCode)
      ) {
        throw new Error(
          `AUTO_INTENT_WINNER_INVALID_CODE:${winnerCode}`
        )
      }
      intent = {
        id: appendResult.row.id,
        companyId: appendResult.row.companyId,
        draftId: appendResult.row.draftId,
        decisionCode: winnerCode as AutoDecisionIntentCode,
        reasons: appendResult.row.reasons,
        scores: appendResult.row.scores,
        actorUserId: appendResult.row.actorUserId,
        metadata: appendResult.row.metadata,
        createdAt: appendResult.row.createdAt,
      }
    }

    // Sync draftRow for subsequent phase resolution
    draftRow.status = beforeIntent.status
    draftRow.version = beforeIntent.version
    draftRow.contentHashAtExtraction = beforeIntent.contentHashAtExtraction
    draftRow.extractionSchemaVersion = beforeIntent.extractionSchemaVersion

    stats.decided++
    // CORRECTION-4A-R1 — intent persisté / winner DB = seule autorité (jamais decision.code local).
    if (intent.decisionCode === "HUMAN_REVIEW_REQUIRED") {
      stats.human++
      return
    }

    phase = resolveAutoDecisionApplicationState({
      draftStatus: "PENDING_REVIEW",
      draftContentHash: beforeIntent.contentHashAtExtraction,
      draftExtractionSchemaVersion: beforeIntent.extractionSchemaVersion,
      draftVersion: beforeIntent.version,
      validationForCurrentCycle: validationForCurrent,
      intentForFrozenCycle: intent,
      followUpForIntentCycle: null,
      systemActorOk: systemActor.ok,
    })
  }

  if (phase === "BLOCKED_SYSTEM_ACTOR") {
    stats.blockedSystemActor++
    if (frozenForWork) {
      const existingSa = await journal.findLatestSystemActorInvalidForCycle({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        frozen: frozenForWork,
      })
      if (!existingSa && !systemActor.ok) {
        if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
          stats.leaseStolen++
          return { leaseStolen: true }
        }
        if (input.ensureOwnership && !fence) return { leaseStolen: true }
        const saEntry = {
          companyId: candidate.companyId,
          draftId: candidate.draftId,
          decisionCode: "SYSTEM_ACTOR_INVALID",
          reasons: [systemActor.code, systemActor.reason],
          scores: {},
          actorUserId: null as string | null,
          idempotencyKey: buildSystemActorInvalidIdempotencyKey({
            companyId: candidate.companyId,
            draftId: candidate.draftId,
            frozen: frozenForWork,
          }),
          metadata: {
            pipeline: "POST_EXTRACTION_STEPS",
            validationCycle: frozenForWork,
            systemActorCode: systemActor.code,
            systemActorReason: systemActor.reason,
          },
        }
        if (fence) {
          try {
            await db.$transaction(async (tx) => {
              const owned = await fence.assertOwnedAndLock(tx)
              if (owned !== "OWNED") {
                throw Object.assign(new Error("LEASE_NOT_OWNED"), {
                  code: "LEASE_NOT_OWNED",
                })
              }
              await new AcquisitionDecisionJournalRepository(
                tx
              ).appendOnceInTransaction(saEntry)
            })
          } catch (err) {
            if (
              err instanceof Error &&
              ((err as { code?: string }).code === "LEASE_NOT_OWNED" ||
                err.message === "LEASE_NOT_OWNED")
            ) {
              return { leaseStolen: true }
            }
            throw err
          }
        } else {
          await journal.appendOnce(saEntry)
        }
      }
    }
    return
  }

  if (!intent || !frozenForWork) {
    stats.skipped++
    return
  }

  const actor = systemActor.ok
    ? {
        actorUserId: systemActor.userId,
        actorRole: "SYSTEM" as const,
        companyId: candidate.companyId,
      }
    : null

  // --- NEEDS_APPROVE ---
  if (phase === "NEEDS_APPROVE") {
    if (!actor) {
      stats.blockedSystemActor++
      return
    }
    // Pre-mutation stale check
    if (
      !draftMatchesFrozenCycle({
        contentHashAtExtraction: draftRow.contentHashAtExtraction,
        extractionSchemaVersion: draftRow.extractionSchemaVersion,
        version: draftRow.version,
        frozen: frozenForWork,
      })
    ) {
      stats.stale++
      return
    }

    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      stats.leaseStolen++
      return { leaseStolen: true }
    }
    if (input.ensureOwnership && !fence) return { leaseStolen: true }

    const approve = await review.approveImportDraft(
      actor,
      {
        draftId: candidate.draftId,
        expectedVersion: frozenForWork.validatedDraftVersion,
      },
      fence ? { transactionalOwnershipFence: fence } : undefined
    )
    if (!approve.ok && approve.code === "LEASE_NOT_OWNED") {
      stats.leaseStolen++
      return { leaseStolen: true }
    }
    if (approve.ok) {
      stats.approved++
      log("AUTO_APPROVE_OK", {
        draftId: candidate.draftId,
        code: intent.decisionCode,
      })
      return
    }
    const reload = await db.worksiteImportDraft.findFirst({
      where: { id: candidate.draftId, companyId: candidate.companyId },
      select: { status: true },
    })
    if (reload?.status === "APPROVED") {
      stats.approved++
      return
    }
    log("AUTO_APPROVE_FAILED", {
      draftId: candidate.draftId,
      code: approve.code,
    })
    return
  }

  // --- NEEDS_REJECT ---
  if (phase === "NEEDS_REJECT") {
    if (!actor) {
      stats.blockedSystemActor++
      return
    }
    if (
      !draftMatchesFrozenCycle({
        contentHashAtExtraction: draftRow.contentHashAtExtraction,
        extractionSchemaVersion: draftRow.extractionSchemaVersion,
        version: draftRow.version,
        frozen: frozenForWork,
      })
    ) {
      stats.stale++
      return
    }

    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      stats.leaseStolen++
      return { leaseStolen: true }
    }
    if (input.ensureOwnership && !fence) return { leaseStolen: true }

    const reject = await review.rejectImportDraft(
      actor,
      {
        draftId: candidate.draftId,
        expectedVersion: frozenForWork.validatedDraftVersion,
        rejectionReason: "CANCELLED_INITIAL",
      },
      fence ? { transactionalOwnershipFence: fence } : undefined
    )
    if (!reject.ok && reject.code === "LEASE_NOT_OWNED") {
      stats.leaseStolen++
      return { leaseStolen: true }
    }
    if (reject.ok) {
      stats.rejected++
    } else {
      const reload = await db.worksiteImportDraft.findFirst({
        where: { id: candidate.draftId, companyId: candidate.companyId },
        select: { status: true },
      })
      if (reload?.status !== "REJECTED") {
        log("AUTO_REJECT_FAILED", {
          draftId: candidate.draftId,
          code: reject.code,
        })
        return
      }
      stats.rejected++
    }
    phase = "NEEDS_CANCEL_FOLLOWUP"
  }

  // --- NEEDS_CANCEL_FOLLOWUP ---
  if (phase === "NEEDS_CANCEL_FOLLOWUP") {
    if (!frozenForWork) {
      stats.skipped++
      return
    }
    // Ownership early-exit ; preuve commit = fence dans la TX 4B.
    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      stats.leaseStolen++
      return { leaseStolen: true }
    }
    if (input.ensureOwnership && !fence) return { leaseStolen: true }

    const threadId = ctx?.draft.acquisitionMessage?.threadId ?? null
    try {
      const follow = await applyCancellationFollowUpTransactionally({
        companyId: candidate.companyId,
        sourceDraftId: candidate.draftId,
        threadId,
        frozen: frozenForWork,
        actorUserId: actor?.actorUserId ?? null,
        db,
        reasons: ["CONSULTATION_CANCELLED"],
        ...(fence ? { transactionalOwnershipFence: fence } : {}),
      })
      if (follow.outcome === "APPENDED") {
        stats.followUpApplied++
      }
    } catch (err) {
      if (err instanceof CancellationLeaseNotOwnedError) {
        stats.leaseStolen++
        return { leaseStolen: true }
      }
      throw err
    }
  }
}

/** Scan intents AUTO_REJECT for REJECTED reconcile (latest with frozen cycle). */
async function findLatestAutoRejectIntent(
  journal: AcquisitionDecisionJournalRepository,
  input: { companyId: string; draftId: string }
): Promise<(JournalRow & { decisionCode: AutoDecisionIntentCode }) | null> {
  return journal.findLatestAutoRejectIntentAny(input)
}
