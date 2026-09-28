/**
 * Harness Preview Staging — enregistrement ciblé d'une validation VALIDATION_PASS (Option C).
 *
 * Fail-closed :
 * - Preview du projet planificator-staging uniquement + flag dédié exact
 * - ADMIN / SUPER_ADMIN du tenant cible, cible unique via env (aucun override requête)
 * - CHECK_* : strictement READ-ONLY (aucune transaction, aucun verrou, aucune écriture)
 * - RECORD_* : UNE transaction interactive REPEATABLE READ possédée par ce harness :
 *   lease orchestrateur (ligne IDLE garantie + FOR UPDATE, refus si run actif) →
 *   verrou SELECT … FOR UPDATE du draft (id + companyId) → relecture état + cycle →
 *   marqueur du cycle → contexte + validateConsultation (db = tx) → PASS exigé →
 *   append VALIDATION_PASS (attempt = 1) sur le même client tx.
 *   Tout refus avant commit = rollback, zéro ligne.
 * - aucun worker, orchestrateur, auto-decision, approve / reject / convert, chantier, provider
 */

import { Prisma, type PrismaClient } from "@prisma/client"
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import {
  buildConsultationEvaluationContext,
  buildValidationCycleIdentity,
  type ConsultationEvaluationContextDeps,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import type { ValidationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { validationDecisionToCode } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"
import {
  AcquisitionDecisionJournalRepository,
  buildValidationDecisionIdempotencyKey,
  parseValidationCycleIdentity,
  validationCyclesMatch,
  type DecisionJournalEntry,
  type ValidationCycleIdentity,
  type ValidationJournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

export const TARGETED_STAGING_VALIDATION_RECORD_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_VALIDATION_RECORD" as const

export const TARGETED_STAGING_VALIDATION_RECORD_CONFIRMATION =
  "RECORD_TARGETED_STAGING_VALIDATION_PASS" as const

/** Seule tentative enregistrable par ce harness (jamais de progression retry). */
export const TARGETED_VALIDATION_RECORD_ATTEMPT = 1 as const

const ENABLED_FLAG = "TARGETED_STAGING_VALIDATION_RECORD_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

/** Cible, horloge et identité de cycle : jamais pilotables par la requête. */
const FORBIDDEN_BODY_KEYS = [
  "companyId",
  "company_id",
  "draftId",
  "draft_id",
  "referenceInstant",
  "reference_instant",
  "now",
  "cycle",
  "version",
  "draftVersion",
  "draft_version",
  "expectedVersion",
  "expected_version",
  "contentHash",
  "content_hash",
  "contentHashAtExtraction",
  "content_hash_at_extraction",
  "extractionSchemaVersion",
  "extraction_schema_version",
  "schemaVersion",
  "schema_version",
  "attempt",
] as const

type DbClient = PrismaClient | Prisma.TransactionClient

type RecordJournal = Pick<
  AcquisitionDecisionJournalRepository,
  "findLatestValidationDecisionForCycle" | "appendOnceInTransaction" | "findByIdempotencyKey"
>

export type TargetedValidationRecordDraft = {
  id: string
  companyId: string
  status: string
  version: number
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
  createdWorksiteId: string | null
}

export type TargetedValidationRecordDeps = {
  auth?: () => Promise<{
    user: { id: string; role: string; companyId: string | null }
  } | null>
  env?: Record<string, string | undefined>
  now?: () => Date
  db?: PrismaClient
  /** Journal lié au client fourni (root pour CHECK, tx pour RECORD). */
  journalFor?: (client: DbClient) => RecordJournal
  /** Surcharges de contexte (tests) ; `db` est toujours imposé (root ou tx). */
  evaluationDeps?: Omit<ConsultationEvaluationContextDeps, "db">
}

/** Refus décidé dans la transaction : levé pour forcer le rollback. */
class RecordRefusal extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(code)
  }
}

function refused(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status })
}

function hasAnyKey(body: unknown, keys: readonly string[]): boolean {
  return Boolean(body && typeof body === "object" && keys.some((k) => k in body))
}

function defaultJournalFor(client: DbClient): RecordJournal {
  return new AcquisitionDecisionJournalRepository(client)
}

async function loadTargetDraft(
  db: DbClient,
  companyId: string,
  draftId: string
): Promise<TargetedValidationRecordDraft | null> {
  const row = await db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      id: true,
      companyId: true,
      status: true,
      version: true,
      contentHashAtExtraction: true,
      extractionSchemaVersion: true,
      createdWorksiteId: true,
    },
  })
  return row ?? null
}

/** Verrou ligne draft (id + companyId paramétrés) jusqu'au COMMIT / ROLLBACK. */
async function lockTargetDraft(
  tx: Prisma.TransactionClient,
  companyId: string,
  draftId: string
): Promise<TargetedValidationRecordDraft | null> {
  const rows = await tx.$queryRaw<TargetedValidationRecordDraft[]>`
    SELECT
      d.id,
      d."companyId",
      d.status::text AS status,
      d.version,
      d."contentHashAtExtraction",
      d."extractionSchemaVersion",
      d."createdWorksiteId"
    FROM "worksite_import_drafts" d
    WHERE d.id = ${draftId}
      AND d."companyId" = ${companyId}
    FOR UPDATE
  `
  return rows.length === 1 ? rows[0]! : null
}

/**
 * Ligne de coordination orchestrateur : même INSERT idempotent (ligne IDLE) que
 * AcquisitionOrchestratorLeaseRepository.acquire — même table, même clé canonique,
 * mêmes colonnes / valeurs. Verrouillée ensuite jusqu'au COMMIT / ROLLBACK.
 */
async function ensureOrchestratorLeaseRow(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`
        INSERT INTO "acquisition_orchestrator_leases" (
          "key",
          "ownerRunId",
          "leaseExpiresAt",
          "acquiredAt",
          "updatedAt"
        )
        VALUES (
          ${ACQUISITION_ORCHESTRATOR_LEASE_KEY},
          NULL,
          NULL,
          NULL,
          clock_timestamp()
        )
        ON CONFLICT ("key") DO NOTHING
      `
}

/**
 * Verrou de la lease orchestrateur. Harness ciblé : disponible UNIQUEMENT si
 * aucun propriétaire (ownerRunId IS NULL). Plus strict que acquire : une lease
 * possédée est refusée même expirée ou sans expiration (preuve PostgreSQL 16).
 * Aucune mutation de la lease (ni vol, ni renouvellement, ni libération).
 */
async function lockOrchestratorLease(
  tx: Prisma.TransactionClient
): Promise<{ present: boolean; available: boolean }> {
  const rows = await tx.$queryRaw<Array<{ key: string; available: boolean }>>`
    SELECT
      "key",
      ("ownerRunId" IS NULL) AS "available"
    FROM "acquisition_orchestrator_leases"
    WHERE "key" = ${ACQUISITION_ORCHESTRATOR_LEASE_KEY}
    FOR UPDATE
  `
  const row = rows.length === 1 ? rows[0]! : null
  return { present: row != null, available: row?.available === true }
}

/** Conflit de sérialisation / deadlock PostgreSQL tel qu'exposé par Prisma. */
function isSerializationConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code === "P2034") return true
  const dbCode = (err.meta as { code?: unknown } | undefined)?.code
  return err.code === "P2010" && (dbCode === "40001" || dbCode === "40P01")
}

function isRecordedPassForCycle(
  row: ValidationJournalRow | null,
  cycle: ValidationCycleIdentity
): boolean {
  if (!row || row.decisionCode !== "VALIDATION_PASS") return false
  const rowCycle = parseValidationCycleIdentity(row.metadata)
  return rowCycle != null && validationCyclesMatch(rowCycle, cycle)
}

/**
 * Entrée VALIDATION_PASS — même forme que le worker de validation production
 * (verrouillée par test de parité), tentative fixée à 1.
 */
export function buildTargetedValidationPassEntry(input: {
  companyId: string
  draftId: string
  cycle: ValidationCycleIdentity
  decision: Extract<ValidationDecision, { code: "PASS" }>
  scores: Record<string, number>
}): DecisionJournalEntry {
  return {
    companyId: input.companyId,
    draftId: input.draftId,
    decisionCode: "VALIDATION_PASS",
    reasons: input.decision.reasons,
    scores: input.scores,
    actorUserId: null,
    idempotencyKey: buildValidationDecisionIdempotencyKey({
      companyId: input.companyId,
      draftId: input.draftId,
      cycle: input.cycle,
      validationAttempt: TARGETED_VALIDATION_RECORD_ATTEMPT,
    }),
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      contentHash: input.cycle.contentHash,
      extractionSchemaVersion: input.cycle.extractionSchemaVersion,
      draftVersion: input.cycle.draftVersion,
      validationCode: input.decision.code,
      attempt: TARGETED_VALIDATION_RECORD_ATTEMPT,
    },
  }
}

type Evaluation = {
  contextMatchesCycle: boolean
  prediction: { code: string; decisionCode: string; reasons: string[] } | null
  passDecision: Extract<ValidationDecision, { code: "PASS" }> | null
  scores: Record<string, number>
}

/** Contexte + validation production, au même instant, sur le client fourni (root ou tx). */
async function evaluateCurrentCycle(input: {
  client: DbClient
  companyId: string
  draftId: string
  cycle: ValidationCycleIdentity
  referenceInstant: Date
  evaluationDeps?: TargetedValidationRecordDeps["evaluationDeps"]
}): Promise<Evaluation> {
  const ctx = await buildConsultationEvaluationContext({
    companyId: input.companyId,
    draftId: input.draftId,
    deps: { ...input.evaluationDeps, db: input.client as PrismaClient },
  })
  const contextMatchesCycle =
    ctx != null &&
    ctx.draft.id === input.draftId &&
    ctx.draft.companyId === input.companyId &&
    validationCyclesMatch(ctx.cycle, input.cycle)
  if (!ctx || !contextMatchesCycle) {
    return { contextMatchesCycle: false, prediction: null, passDecision: null, scores: {} }
  }
  const decision = validateConsultation({
    companyId: input.companyId,
    draftId: input.draftId,
    classification: ctx.classification,
    extractedSnapshot: ctx.snapshot,
    partnerProfile: ctx.partnerProfile,
    referenceInstant: input.referenceInstant,
  })
  return {
    contextMatchesCycle,
    prediction: {
      code: decision.code,
      decisionCode: validationDecisionToCode(decision),
      reasons: decision.reasons,
    },
    passDecision: decision.code === "PASS" ? decision : null,
    scores: ctx.snapshot.confidenceData,
  }
}

export async function handleTargetedStagingValidationRecord(
  req: Request,
  deps: TargetedValidationRecordDeps = {}
): Promise<Response> {
  try {
    return await runHarness(req, deps)
  } catch {
    return refused(500, "VALIDATION_RECORD_FAILED", "Erreur interne")
  }
}

async function runHarness(
  req: Request,
  deps: TargetedValidationRecordDeps
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env as NodeJS.ProcessEnv)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée")
  }
  if (env[ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const session = await (deps.auth ?? auth)()
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

  const confirmation =
    body && typeof body === "object" && "confirmation" in body
      ? (body as { confirmation?: unknown }).confirmation
      : undefined
  const isCheck = confirmation === TARGETED_STAGING_VALIDATION_RECORD_CHECK_CONFIRMATION
  const isRecord = confirmation === TARGETED_STAGING_VALIDATION_RECORD_CONFIRMATION
  if (!isCheck && !isRecord) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }
  if (hasAnyKey(body, FORBIDDEN_BODY_KEYS)) {
    return refused(400, "REQUEST_OVERRIDE_FORBIDDEN", "Cible, horloge et cycle non pilotables")
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
    return refused(403, "TENANT_MISMATCH", "TENANT_MISMATCH")
  }

  // Horloge : un seul instant par requête (prédiction CHECK et évaluation RECORD en tx).
  const referenceInstant = (deps.now ?? (() => new Date()))()
  const db = deps.db ?? prisma
  const journalFor = deps.journalFor ?? defaultJournalFor

  // Lecture hors transaction : cible du CHECK et cycle autorisé pour RECORD.
  const draft = await loadTargetDraft(db, companyId, draftId)
  if (!draft || draft.id !== draftId || draft.companyId !== companyId) {
    return refused(404, "DRAFT_NOT_FOUND", "Draft cible introuvable pour ce tenant")
  }
  const authorizedCycle = buildValidationCycleIdentity(draft)

  if (isCheck) {
    return runCheck({ db, journalFor, deps, draft, cycle: authorizedCycle, companyId, draftId, referenceInstant })
  }

  if (!authorizedCycle) {
    return refused(409, "CYCLE_UNAVAILABLE", "Cycle d'extraction courant absent")
  }
  return runRecord({ db, journalFor, deps, cycle: authorizedCycle, companyId, draftId, referenceInstant })
}

async function runCheck(input: {
  db: PrismaClient
  journalFor: (client: DbClient) => RecordJournal
  deps: TargetedValidationRecordDeps
  draft: TargetedValidationRecordDraft
  cycle: ValidationCycleIdentity | null
  companyId: string
  draftId: string
  referenceInstant: Date
}): Promise<Response> {
  const { draft, cycle, companyId, draftId } = input
  const draftPendingReview = draft.status === "PENDING_REVIEW"
  const noCreatedWorksite = draft.createdWorksiteId === null

  const existing = cycle
    ? await input.journalFor(input.db).findLatestValidationDecisionForCycle({ companyId, draftId, cycle })
    : null
  const alreadyRecorded = cycle != null && isRecordedPassForCycle(existing, cycle)
  const noBlockingMarker = existing == null || alreadyRecorded

  const evaluation =
    cycle && draftPendingReview
      ? await evaluateCurrentCycle({
          client: input.db,
          companyId,
          draftId,
          cycle,
          referenceInstant: input.referenceInstant,
          evaluationDeps: input.deps.evaluationDeps,
        })
      : null
  const predictionIsPass = evaluation?.passDecision != null

  return NextResponse.json({
    ok: true,
    mode: "CHECK",
    referenceInstant: input.referenceInstant.toISOString(),
    ready:
      draftPendingReview &&
      noCreatedWorksite &&
      cycle != null &&
      evaluation?.contextMatchesCycle === true &&
      noBlockingMarker &&
      !alreadyRecorded &&
      predictionIsPass,
    alreadyRecorded,
    cycle: cycle ? { draftVersion: cycle.draftVersion } : null,
    predictedValidation: evaluation?.prediction ?? null,
    existingDecisionCode: existing?.decisionCode ?? null,
    proof: {
      draftPendingReview,
      noCreatedWorksite,
      currentCyclePresent: cycle != null,
      contextMatchesCycle: evaluation?.contextMatchesCycle === true,
      noBlockingTerminalMarker: noBlockingMarker,
      predictionIsPass,
      sameTenant: draft.companyId === companyId,
    },
  })
}

type RecordOutcome = {
  journalAppended: boolean
  alreadyRecorded: boolean
  proof: {
    leaseAvailable: boolean
    lockedScope: boolean
    statusPendingReview: boolean
    noCreatedWorksite: boolean
    cycleMatchesAuthorized: boolean
    noBlockingMarker: boolean
    contextMatchesCycle: boolean
    predictionIsPass: boolean
    passBelongsToAuthorizedCycle: boolean
  }
}

type Reconciliation = "PRESENT" | "NOT_OBSERVED" | "UNAVAILABLE"

/** Lecture exacte du slot attempt-1 du cycle autorisé (aucune écriture). */
async function reconcileAttemptOneSlot(input: {
  journal: RecordJournal
  companyId: string
  draftId: string
  cycle: ValidationCycleIdentity
}): Promise<Reconciliation> {
  try {
    const key = buildValidationDecisionIdempotencyKey({
      companyId: input.companyId,
      draftId: input.draftId,
      cycle: input.cycle,
      validationAttempt: TARGETED_VALIDATION_RECORD_ATTEMPT,
    })
    const row = await input.journal.findByIdempotencyKey(key)
    const exactPass =
      row != null &&
      row.companyId === input.companyId &&
      row.draftId === input.draftId &&
      isRecordedPassForCycle(row as unknown as ValidationJournalRow, input.cycle) &&
      (row.metadata as { attempt?: unknown } | null)?.attempt === TARGETED_VALIDATION_RECORD_ATTEMPT
    return exactPass ? "PRESENT" : "NOT_OBSERVED"
  } catch {
    return "UNAVAILABLE"
  }
}

async function runRecord(input: {
  db: PrismaClient
  journalFor: (client: DbClient) => RecordJournal
  deps: TargetedValidationRecordDeps
  cycle: ValidationCycleIdentity
  companyId: string
  draftId: string
  referenceInstant: Date
}): Promise<Response> {
  const { db, cycle, companyId, draftId, referenceInstant } = input

  // Vrai seulement si le callback a terminé sans lever : tout rejet ultérieur (COMMIT) est indéterminé.
  let callbackCompleted = false
  let outcome: RecordOutcome
  try {
    outcome = await db.$transaction(
      async (tx) => {
        // 0. Coordination orchestrateur (même protocole de lease) : ligne IDLE garantie, puis verrou.
        await ensureOrchestratorLeaseRow(tx)
        const lease = await lockOrchestratorLease(tx)
        const leaseAvailable = lease.present && lease.available
        if (!lease.present) throw new RecordRefusal("ORCHESTRATOR_LEASE_UNAVAILABLE")
        if (!leaseAvailable) {
          throw new RecordRefusal("ORCHESTRATOR_RUN_ACTIVE", { proof: { leaseAvailable } })
        }

        // A. Verrou exact du draft (paramétré, id + companyId) — après la lease.
        const locked = await lockTargetDraft(tx, companyId, draftId)
        const lockedScope =
          locked != null && locked.id === draftId && locked.companyId === companyId
        if (!locked || !lockedScope) throw new RecordRefusal("DRAFT_NOT_FOUND")

        // B. État autoritatif sous verrou.
        const statusPendingReview = locked.status === "PENDING_REVIEW"
        const noCreatedWorksite = locked.createdWorksiteId === null
        const lockedCycle = buildValidationCycleIdentity(locked)
        const cycleMatchesAuthorized =
          lockedCycle != null && validationCyclesMatch(lockedCycle, cycle)
        const stateProof = {
          leaseAvailable,
          lockedScope,
          statusPendingReview,
          noCreatedWorksite,
          cycleMatchesAuthorized,
        }
        if (!statusPendingReview) throw new RecordRefusal("DRAFT_STATUS_INVALID", { proof: stateProof })
        if (!noCreatedWorksite) throw new RecordRefusal("WORKSITE_ALREADY_CREATED", { proof: stateProof })
        if (!cycleMatchesAuthorized) throw new RecordRefusal("CYCLE_CHANGED", { proof: stateProof })

        // C. Marqueur du cycle exact, puis évaluation production sur le client tx (même snapshot).
        const journal = input.journalFor(tx)
        const existing = await journal.findLatestValidationDecisionForCycle({ companyId, draftId, cycle })
        const existingPass = isRecordedPassForCycle(existing, cycle)
        const noBlockingMarker = existing == null || existingPass
        if (!noBlockingMarker) {
          throw new RecordRefusal("EXISTING_MARKER_BLOCKS_RECORD", {
            existingDecisionCode: existing?.decisionCode ?? null,
            proof: { ...stateProof, noBlockingMarker },
          })
        }

        const evaluation = await evaluateCurrentCycle({
          client: tx,
          companyId,
          draftId,
          cycle,
          referenceInstant,
          evaluationDeps: input.deps.evaluationDeps,
        })
        const predictionIsPass = evaluation.passDecision != null
        const evaluationProof = {
          ...stateProof,
          noBlockingMarker,
          contextMatchesCycle: evaluation.contextMatchesCycle,
          predictionIsPass,
        }
        if (!evaluation.contextMatchesCycle) {
          throw new RecordRefusal("CYCLE_CHANGED", { proof: evaluationProof })
        }
        if (!evaluation.passDecision) {
          throw new RecordRefusal(existingPass ? "EXISTING_PASS_STATE_MISMATCH" : "PREDICTION_NOT_PASS", {
            predictedValidation: evaluation.prediction,
            proof: evaluationProof,
          })
        }

        let result: RecordOutcome
        if (existingPass) {
          // Idempotence : PASS déjà enregistré pour ce cycle, revérifié sous verrous.
          result = {
            journalAppended: false,
            alreadyRecorded: true,
            proof: { ...evaluationProof, passBelongsToAuthorizedCycle: existingPass },
          }
        } else {
          // D. Append sur le même client tx (VALIDATION_PASS, attempt = 1, cycle autorisé).
          const entry = buildTargetedValidationPassEntry({
            companyId,
            draftId,
            cycle,
            decision: evaluation.passDecision,
            scores: evaluation.scores,
          })
          const appended = await journal.appendOnceInTransaction(entry)
          const passBelongsToAuthorizedCycle = isRecordedPassForCycle(
            appended.row as unknown as ValidationJournalRow,
            cycle
          )
          if (!passBelongsToAuthorizedCycle) {
            // Slot idempotent (cycle + attempt 1) déjà occupé par une autre décision.
            throw new RecordRefusal("IDEMPOTENCY_SLOT_CONFLICT", {
              proof: { ...evaluationProof, passBelongsToAuthorizedCycle },
            })
          }
          result = {
            journalAppended: appended.outcome === "APPENDED",
            alreadyRecorded: appended.outcome === "ALREADY_EXISTS",
            proof: { ...evaluationProof, passBelongsToAuthorizedCycle },
          }
        }
        callbackCompleted = true
        return result
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    )
  } catch (err) {
    if (!callbackCompleted) {
      // Échec avant la fin du callback : COMMIT jamais émis → rollback certain.
      if (err instanceof RecordRefusal) {
        return refused(409, err.code, "Enregistrement refusé — aucune écriture (rollback)", {
          commitOutcome: "ROLLED_BACK",
          committed: false,
          ...err.detail,
        })
      }
      if (isSerializationConflict(err)) {
        return refused(409, "SERIALIZATION_CONFLICT", "Conflit de sérialisation — relancer RECORD explicitement", {
          commitOutcome: "ROLLED_BACK",
          committed: false,
        })
      }
      return refused(409, "RECORD_TRANSACTION_FAILED", "Transaction annulée — aucune écriture", {
        commitOutcome: "ROLLED_BACK",
        committed: false,
      })
    }

    // Rejet après la fin du callback : issue du COMMIT indéterminée (jamais présentée comme rollback).
    const reconciliation = await reconcileAttemptOneSlot({
      journal: input.journalFor(db),
      companyId,
      draftId,
      cycle,
    })
    if (reconciliation === "PRESENT") {
      return NextResponse.json({
        ok: true,
        mode: "RECORD",
        referenceInstant: referenceInstant.toISOString(),
        record: {
          commitOutcome: "UNKNOWN",
          reconciliation,
          passPresentForAuthorizedCycle: true,
          cycle: { draftVersion: cycle.draftVersion },
        },
      })
    }
    return refused(409, "RECORD_OUTCOME_UNKNOWN", "Issue du COMMIT indéterminée — relancer CHECK", {
      commitOutcome: "UNKNOWN",
      reconciliation,
    })
  }

  // Post-commit : diagnostic informatif uniquement, jamais requalifié en échec.
  let postCommit: { available: boolean; stillCurrentAfterCommit: boolean | null }
  try {
    const after = await loadTargetDraft(db, companyId, draftId)
    const afterCycle = after ? buildValidationCycleIdentity(after) : null
    postCommit = {
      available: true,
      stillCurrentAfterCommit:
        after != null &&
        after.status === "PENDING_REVIEW" &&
        after.createdWorksiteId === null &&
        afterCycle != null &&
        validationCyclesMatch(afterCycle, cycle),
    }
  } catch {
    postCommit = { available: false, stillCurrentAfterCommit: null }
  }

  return NextResponse.json({
    ok: true,
    mode: "RECORD",
    referenceInstant: referenceInstant.toISOString(),
    record: {
      commitOutcome: "COMMITTED",
      committed: true,
      journalAppended: outcome.journalAppended,
      alreadyRecorded: outcome.alreadyRecorded,
      cycle: { draftVersion: cycle.draftVersion },
      proof: outcome.proof,
    },
    postCommit,
  })
}
