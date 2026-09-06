/**
 * PLAN-ACQ-AGENTS-LOT-3D — Worker batch validation (restartable).
 * PENDING_REVIEW → validateConsultation → journal VALIDATION_* uniquement.
 * Aucune mutation de statut draft. Aucun approve / reject / convert.
 *
 * CORRECTION-1 : éligibilité avant maxCandidates, fence immédiat avant append,
 * recheck cycle complet (hash + schema + version).
 *
 * CORRECTION-2 : exclusion DB des marqueurs terminaux/retry non-éligibles pour
 * le cycle courant (pas de starvation cross-run sous maxScan). Fairness
 * multi-tenant : round-robin borné par company (maxPerCompany).
 */

import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  buildConsultationEvaluationContext,
  buildValidationCycleIdentity,
  loadConsultationEvaluationDraft,
  type ConsultationEvaluationContextDeps,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import type { ValidationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import {
  isOrchestratorOwnershipValid,
  type OrchestratorItemOwnershipCheck,
} from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  AcquisitionDecisionJournalRepository,
  acquisitionDecisionJournalRepository,
  buildValidationDecisionIdempotencyKey,
  parseValidationCycleIdentity,
  resolveValidationAttemptNumber,
  validationCyclesMatch,
  type ValidationCycleIdentity,
  type ValidationDecisionCode,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

const LOG_PREFIX = "[acquisition-validation-worker]"

/** Bornes Lot 3D — pas d’env dédié. */
export const VALIDATION_WORKER_MAX_CANDIDATES = 25
export const VALIDATION_WORKER_MAX_RETRY_ATTEMPTS = 3
/**
 * Plafond de candidats éligibles demandés / traités par run (borne runtime).
 * Plus un scan de préfixe inéligible : l’exclusion est côté DB.
 */
export const VALIDATION_WORKER_MAX_SCAN = 500
/**
 * Fairness multi-tenant : max drafts éligibles tirés par company avant merge.
 * Empêche un tenant saturé de monopoliser maxCandidates.
 */
export const VALIDATION_WORKER_MAX_PER_COMPANY = 5

/** @deprecated CORRECTION-2 — plus de pagination brute PENDING_REVIEW. */
export const VALIDATION_WORKER_PAGE_SIZE = 50

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

export type ValidationWorkerCandidate = {
  draftId: string
  companyId: string
  version: number
  contentHashAtExtraction: string
  extractionSchemaVersion: string | null
  updatedAt: Date
}

export type ValidationWorkerSelectionPort = {
  /**
   * Candidats PENDING_REVIEW réellement éligibles pour validation auto
   * (cycle courant sans marqueur terminal / retry-wait / retry-exhausted).
   * Fairness : répartition bornée par companyId.
   * Ordre global après merge : updatedAt ASC, id ASC (dans chaque bucket).
   */
  listEligibleCandidates(input: {
    limit: number
    now: Date
    maxPerCompany?: number
  }): Promise<ValidationWorkerCandidate[]>
}

export type ValidationWorkerRunStats = {
  /** Candidats éligibles retenus pour traitement. */
  selected: number
  /** Candidats issus de la sélection DB (éligibles). */
  scanned: number
  validated: number
  skippedIdempotent: number
  skippedRetryWait: number
  skippedMaxRetry: number
  skippedStatus: number
  journalAppended: number
  leaseStolen: number
  errors: number
}

export type ValidationWorkerRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  skipReason?: string
  error?: { code: string; message: string }
  stats: ValidationWorkerRunStats
}

export type ValidationWorkerDeps = {
  db?: PrismaClient
  journal?: AcquisitionDecisionJournalRepository
  selection?: ValidationWorkerSelectionPort
  evaluationDeps?: ConsultationEvaluationContextDeps
  ensureOwnership?: OrchestratorItemOwnershipCheck
  /** LOT-3G — fence TX authentique (WeakMap orchestrateur). Obligatoire chemin AUTO. */
  transactionalOwnershipFence?: TransactionalOwnershipFence
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

function emptyStats(): ValidationWorkerRunStats {
  return {
    selected: 0,
    scanned: 0,
    validated: 0,
    skippedIdempotent: 0,
    skippedRetryWait: 0,
    skippedMaxRetry: 0,
    skippedStatus: 0,
    journalAppended: 0,
    leaseStolen: 0,
    errors: 0,
  }
}

export function validationDecisionToCode(
  decision: ValidationDecision
): ValidationDecisionCode {
  switch (decision.code) {
    case "PASS":
      return "VALIDATION_PASS"
    case "QUARANTINE":
      return "VALIDATION_QUARANTINE"
    case "FAIL_RETRYABLE":
      return "VALIDATION_FAIL_RETRYABLE"
    case "FAIL_TERMINAL":
      return "VALIDATION_FAIL_TERMINAL"
  }
}

export function computeValidationRetryNextAt(input: {
  attempt: number
  now: Date
}): Date | null {
  const idx = input.attempt - 1
  if (idx < 0 || idx >= RETRY_BACKOFF_MS.length) return null
  return new Date(input.now.getTime() + RETRY_BACKOFF_MS[idx]!)
}

function readRetryMeta(row: ValidationJournalRow | null): {
  attempt: number
  nextRetryAt: Date | null
} {
  if (!row || row.decisionCode !== "VALIDATION_FAIL_RETRYABLE") {
    return { attempt: 0, nextRetryAt: null }
  }
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const attempt =
    typeof meta.attempt === "number" && Number.isFinite(meta.attempt)
      ? Math.max(0, Math.floor(meta.attempt))
      : 1
  let nextRetryAt: Date | null = null
  if (typeof meta.nextRetryAt === "string") {
    const d = new Date(meta.nextRetryAt)
    if (!Number.isNaN(d.getTime())) nextRetryAt = d
  }
  return { attempt, nextRetryAt }
}

/**
 * Décide si un cycle déjà journalisé doit être retraité.
 */
export function shouldSkipValidationForExistingMarker(input: {
  existing: ValidationJournalRow | null
  cycle: ValidationCycleIdentity
  now: Date
}): "PROCESS" | "SKIP_IDEMPOTENT" | "SKIP_RETRY_WAIT" | "SKIP_MAX_RETRY" {
  if (!input.existing) return "PROCESS"
  const existingCycle = parseValidationCycleIdentity(input.existing.metadata)
  if (!existingCycle || !validationCyclesMatch(existingCycle, input.cycle)) {
    return "PROCESS"
  }
  if (
    input.existing.decisionCode === "VALIDATION_PASS" ||
    input.existing.decisionCode === "VALIDATION_QUARANTINE" ||
    input.existing.decisionCode === "VALIDATION_FAIL_TERMINAL"
  ) {
    return "SKIP_IDEMPOTENT"
  }
  if (input.existing.decisionCode === "VALIDATION_FAIL_RETRYABLE") {
    const { attempt, nextRetryAt } = readRetryMeta(input.existing)
    if (attempt >= VALIDATION_WORKER_MAX_RETRY_ATTEMPTS) {
      return "SKIP_MAX_RETRY"
    }
    if (nextRetryAt && nextRetryAt.getTime() > input.now.getTime()) {
      return "SKIP_RETRY_WAIT"
    }
    return "PROCESS"
  }
  return "PROCESS"
}

/**
 * Prédicat SQL (paramétré) : draft PENDING_REVIEW sans marqueur bloquant
 * pour le cycle courant (hash + schemaVersion + draft.version).
 *
 * CORRECTION-2 — exclusion DB pour garantir le progrès cross-run sans curseur
 * persistant ni table-scan des inéligibles.
 *
 * Dernier marqueur cycle via sous-requête ORDER BY createdAt DESC, id DESC LIMIT 1.
 * NOT EXISTS = bloqué (terminal / retry-wait / retry-exhausted).
 */
export function validationEligibleDraftPredicateSql(input: {
  now: Date
  maxRetryAttempts: number
}): Prisma.Sql {
  return Prisma.sql`
    d."status" = CAST('PENDING_REVIEW' AS "WorksiteImportDraftStatus")
    AND d."contentHashAtExtraction" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT j."decisionCode", j.metadata
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
      ) latest
      WHERE
        latest."decisionCode" IN (
          'VALIDATION_PASS',
          'VALIDATION_QUARANTINE',
          'VALIDATION_FAIL_TERMINAL'
        )
        OR (
          latest."decisionCode" = 'VALIDATION_FAIL_RETRYABLE'
          AND (
            COALESCE((latest.metadata->>'attempt')::int, 0) >= ${input.maxRetryAttempts}
            OR (
              latest.metadata->>'nextRetryAt' IS NOT NULL
              AND (latest.metadata->>'nextRetryAt')::timestamptz > ${input.now}
            )
          )
        )
    )
  `
}

type EligibleDraftSqlRow = {
  id: string
  companyId: string
  version: number
  contentHashAtExtraction: string
  extractionSchemaVersion: string | null
  updatedAt: Date
}

function mapEligibleRow(r: EligibleDraftSqlRow): ValidationWorkerCandidate {
  return {
    draftId: r.id,
    companyId: r.companyId,
    version: r.version,
    contentHashAtExtraction: r.contentHashAtExtraction,
    extractionSchemaVersion: r.extractionSchemaVersion,
    updatedAt: r.updatedAt,
  }
}

/**
 * Merge round-robin des buckets company pour fairness multi-tenant.
 */
export function mergeCompanyBucketsRoundRobin(
  buckets: ValidationWorkerCandidate[][],
  limit: number
): ValidationWorkerCandidate[] {
  const out: ValidationWorkerCandidate[] = []
  let depth = 0
  while (out.length < limit) {
    let added = false
    for (const bucket of buckets) {
      const row = bucket[depth]
      if (!row) continue
      out.push(row)
      added = true
      if (out.length >= limit) break
    }
    if (!added) break
    depth++
  }
  return out
}

export function createPrismaValidationSelectionPort(
  db: PrismaClient = prisma
): ValidationWorkerSelectionPort {
  return {
    async listEligibleCandidates(input) {
      const limit = Math.max(1, Math.floor(input.limit))
      const maxPerCompany = Math.max(
        1,
        Math.floor(input.maxPerCompany ?? VALIDATION_WORKER_MAX_PER_COMPANY)
      )
      const buildPredicate = () =>
        validationEligibleDraftPredicateSql({
          now: input.now,
          maxRetryAttempts: VALIDATION_WORKER_MAX_RETRY_ATTEMPTS,
        })

      // CORRECTION-3 — fairness inter-runs : tenants triés par plus ancien draft
      // éligible (MIN updatedAt), tie-break companyId ASC. Pas de curseur persistant.
      const companies = await db.$queryRaw<
        Array<{ companyId: string; oldestEligibleAt: Date }>
      >`
        SELECT
          d."companyId" AS "companyId",
          MIN(d."updatedAt") AS "oldestEligibleAt"
        FROM "worksite_import_drafts" d
        WHERE ${buildPredicate()}
        GROUP BY d."companyId"
        ORDER BY "oldestEligibleAt" ASC, d."companyId" ASC
        LIMIT ${limit}
      `
      if (companies.length === 0) return []

      const perCompany = Math.min(
        maxPerCompany,
        Math.max(1, Math.ceil(limit / companies.length))
      )

      const buckets: ValidationWorkerCandidate[][] = []
      for (const { companyId } of companies) {
        const rows = await db.$queryRaw<EligibleDraftSqlRow[]>`
          SELECT
            d.id,
            d."companyId",
            d.version,
            d."contentHashAtExtraction",
            d."extractionSchemaVersion",
            d."updatedAt"
          FROM "worksite_import_drafts" d
          WHERE d."companyId" = ${companyId}
            AND ${buildPredicate()}
          ORDER BY d."updatedAt" ASC, d.id ASC
          LIMIT ${perCompany}
        `
        buckets.push(rows.map(mapEligibleRow))
      }

      return mergeCompanyBucketsRoundRobin(buckets, limit)
    },
  }
}

/**
 * Sélection DB déjà filtrée — re-check journal uniquement pour courses.
 * CORRECTION-2 : plus de scan paginé de préfixe inéligible.
 */
export async function collectEligibleValidationCandidates(input: {
  selection: ValidationWorkerSelectionPort
  journal: AcquisitionDecisionJournalRepository
  now: Date
  maxCandidates: number
  maxScan: number
  maxPerCompany: number
  ensureOwnership?: OrchestratorItemOwnershipCheck
  stats: ValidationWorkerRunStats
}): Promise<
  | { ok: true; eligible: ValidationWorkerCandidate[] }
  | { ok: false; leaseStolen: true }
> {
  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    input.stats.leaseStolen++
    return { ok: false, leaseStolen: true }
  }

  const ask = Math.min(input.maxCandidates, input.maxScan)
  const rows = await input.selection.listEligibleCandidates({
    limit: ask,
    now: input.now,
    maxPerCompany: input.maxPerCompany,
  })
  input.stats.scanned = rows.length

  const eligible: ValidationWorkerCandidate[] = []
  for (const row of rows) {
    if (eligible.length >= input.maxCandidates) break
    if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
      input.stats.leaseStolen++
      return { ok: false, leaseStolen: true }
    }

    const cycle: ValidationCycleIdentity = {
      contentHash: row.contentHashAtExtraction,
      extractionSchemaVersion: row.extractionSchemaVersion,
      draftVersion: row.version,
    }
    const existing = await input.journal.findLatestValidationDecisionForCycle({
      companyId: row.companyId,
      draftId: row.draftId,
      cycle,
    })
    const skip = shouldSkipValidationForExistingMarker({
      existing,
      cycle,
      now: input.now,
    })
    if (skip === "SKIP_IDEMPOTENT") {
      input.stats.skippedIdempotent++
      continue
    }
    if (skip === "SKIP_RETRY_WAIT") {
      input.stats.skippedRetryWait++
      continue
    }
    if (skip === "SKIP_MAX_RETRY") {
      input.stats.skippedMaxRetry++
      continue
    }
    eligible.push(row)
  }

  input.stats.selected = eligible.length
  return { ok: true, eligible }
}

export async function runAcquisitionValidationWorker(
  input: ValidationWorkerDeps = {}
): Promise<ValidationWorkerRunResult> {
  const db =
    input.db ??
    (input.evaluationDeps?.db as PrismaClient | undefined) ??
    prisma
  const journal = input.journal ?? acquisitionDecisionJournalRepository
  const selection = input.selection ?? createPrismaValidationSelectionPort(db)
  const nowFn = input.now ?? (() => new Date())
  const log = input.log ?? defaultLog
  const maxCandidates = input.maxCandidates ?? VALIDATION_WORKER_MAX_CANDIDATES
  const maxScan = input.maxScan ?? VALIDATION_WORKER_MAX_SCAN
  const maxPerCompany =
    input.maxPerCompany ?? VALIDATION_WORKER_MAX_PER_COMPANY
  const startedAt = Date.now()
  const maxDurationMs = input.maxDurationMs
  const stats = emptyStats()
  const evaluationDeps = input.evaluationDeps

  if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
    return {
      status: "SKIPPED",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease non détenu" },
      stats,
    }
  }

  // LOT-3G — chemin AUTO (ensureOwnership) exige fence TX.
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

  const fence = input.transactionalOwnershipFence

  const collected = await collectEligibleValidationCandidates({
    selection,
    journal,
    now: nowFn(),
    maxCandidates,
    maxScan,
    maxPerCompany,
    ensureOwnership: input.ensureOwnership,
    stats,
  })
  if (!collected.ok) {
    return {
      status: "PARTIAL",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease perdu pendant sélection" },
      stats,
    }
  }

  for (const candidate of collected.eligible) {
    if (
      maxDurationMs != null &&
      Date.now() - startedAt >= maxDurationMs
    ) {
      log("VALIDATION_BUDGET_EXHAUSTED", {
        processed: stats.validated,
        selected: stats.selected,
      })
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
      const cycle: ValidationCycleIdentity = {
        contentHash: candidate.contentHashAtExtraction,
        extractionSchemaVersion: candidate.extractionSchemaVersion,
        draftVersion: candidate.version,
      }

      const existing = await journal.findLatestValidationDecisionForCycle({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        cycle,
      })
      const skipAgain = shouldSkipValidationForExistingMarker({
        existing,
        cycle,
        now: nowFn(),
      })
      if (skipAgain !== "PROCESS") {
        if (skipAgain === "SKIP_IDEMPOTENT") stats.skippedIdempotent++
        else if (skipAgain === "SKIP_RETRY_WAIT") stats.skippedRetryWait++
        else if (skipAgain === "SKIP_MAX_RETRY") stats.skippedMaxRetry++
        continue
      }

      if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
        stats.leaseStolen++
        return {
          status: "PARTIAL",
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu avant evaluation context",
          },
          stats,
        }
      }

      const ctx = await buildConsultationEvaluationContext({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        deps: evaluationDeps,
      })
      if (!ctx || ctx.draft.status !== "PENDING_REVIEW") {
        stats.skippedStatus++
        continue
      }

      if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
        stats.leaseStolen++
        return {
          status: "PARTIAL",
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu après evaluation context",
          },
          stats,
        }
      }

      const fresh = await loadConsultationEvaluationDraft({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        db,
      })
      if (!fresh || fresh.status !== "PENDING_REVIEW") {
        stats.skippedStatus++
        continue
      }
      const freshCycle = buildValidationCycleIdentity(fresh)
      if (!freshCycle || !validationCyclesMatch(freshCycle, ctx.cycle)) {
        stats.skippedStatus++
        continue
      }

      const decision = validateConsultation({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        classification: ctx.classification,
        extractedSnapshot: ctx.snapshot,
        partnerProfile: ctx.partnerProfile,
      })
      const decisionCode = validationDecisionToCode(decision)

      const validationAttempt = resolveValidationAttemptNumber(existing)
      const nextRetryAt =
        decisionCode === "VALIDATION_FAIL_RETRYABLE"
          ? computeValidationRetryNextAt({
              attempt: validationAttempt,
              now: nowFn(),
            })
          : null

      const beforeWrite = await loadConsultationEvaluationDraft({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        db,
      })
      if (!beforeWrite || beforeWrite.status !== "PENDING_REVIEW") {
        stats.skippedStatus++
        continue
      }
      const beforeWriteCycle = buildValidationCycleIdentity(beforeWrite)
      if (
        !beforeWriteCycle ||
        !validationCyclesMatch(beforeWriteCycle, freshCycle)
      ) {
        stats.skippedStatus++
        continue
      }

      if (!(await isOrchestratorOwnershipValid(input.ensureOwnership))) {
        stats.leaseStolen++
        return {
          status: "PARTIAL",
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu immédiatement avant journal append",
          },
          stats,
        }
      }

      const idempotencyKey = buildValidationDecisionIdempotencyKey({
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        cycle: beforeWriteCycle,
        validationAttempt,
      })

      const entry = {
        companyId: candidate.companyId,
        draftId: candidate.draftId,
        decisionCode,
        reasons: decision.reasons,
        scores: ctx.snapshot.confidenceData,
        actorUserId: null as string | null,
        idempotencyKey,
        metadata: {
          pipeline: "POST_EXTRACTION_STEPS",
          contentHash: beforeWriteCycle.contentHash,
          extractionSchemaVersion: beforeWriteCycle.extractionSchemaVersion,
          draftVersion: beforeWriteCycle.draftVersion,
          validationCode: decision.code,
          attempt: validationAttempt,
          ...(decision.code === "FAIL_RETRYABLE" || decision.code === "FAIL_TERMINAL"
            ? {
                errorCode:
                  "errorCode" in decision ? decision.errorCode : undefined,
              }
            : {}),
          ...(decisionCode === "VALIDATION_FAIL_RETRYABLE"
            ? {
                nextRetryAt: nextRetryAt?.toISOString() ?? null,
              }
            : {}),
        },
      }

      let appendResult
      if (fence) {
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
      } else {
        appendResult = await journal.appendOnce(entry)
      }

      if (appendResult.outcome === "APPENDED") {
        stats.journalAppended++
        stats.validated++
        log("VALIDATION_JOURNALED", {
          companyId: candidate.companyId,
          draftId: candidate.draftId,
          decisionCode,
          validationAttempt,
        })
      } else {
        stats.skippedIdempotent++
        log("VALIDATION_JOURNAL_IDEMPOTENT", {
          companyId: candidate.companyId,
          draftId: candidate.draftId,
          decisionCode: appendResult.row.decisionCode,
          validationAttempt,
        })
      }
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "LEASE_NOT_OWNED" ||
          err.message === "LEASE_NOT_OWNED")
      ) {
        stats.leaseStolen++
        return {
          status: "PARTIAL",
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu pendant journal TX",
          },
          stats,
        }
      }
      stats.errors++
      log("VALIDATION_CANDIDATE_ERROR", {
        draftId: candidate.draftId,
        message: err instanceof Error ? err.message : "unknown",
      })
    }
  }

  if (stats.leaseStolen > 0 && stats.journalAppended === 0) {
    return {
      status: "FAILED",
      skipReason: "LEASE_STOLEN",
      error: { code: "LEASE_STOLEN", message: "Lease stolen" },
      stats,
    }
  }
  if (stats.errors > 0 && stats.journalAppended === 0) {
    return {
      status: "FAILED",
      error: { code: "VALIDATION_WORKER_ERRORS", message: "Erreurs validation" },
      stats,
    }
  }
  if (stats.errors > 0 || stats.leaseStolen > 0) {
    return { status: "PARTIAL", stats }
  }
  return { status: "SUCCESS", stats }
}
