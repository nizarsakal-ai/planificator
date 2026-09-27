/**
 * Harness Preview Staging — preflight auto-decision strictement READ-ONLY.
 * Prédit, pour le draft cible unique, la décision auto de production à un instant
 * serveur unique et explique ce qui bloquerait approbation puis conversion.
 * Lectures uniquement : aucune écriture journal/draft/client/chantier, aucun worker,
 * aucune transaction ni verrou, aucun appel externe.
 * Les helpers purs des workers sont importés sans jamais exécuter leurs chemins d'écriture.
 * Conservateur : en cas de doute sur la parité, sous-prédit la progression.
 */

import type { PrismaClient } from "@prisma/client"
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import type { ConsultationClassification } from "@/lib/acquisition/capabilities/consultation-capability.types"
import {
  buildConsultationEvaluationContext,
  type ConsultationEvaluationContext,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { gateAutoDecisionByDetectionProof } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import {
  isAcquisitionConversionEnabled,
  isAcquisitionConversionFullyEnabled,
} from "@/lib/acquisition/conversion/conversion-feature-flag"
import { convertImportDraftSchema } from "@/lib/acquisition/conversion/conversion.schema"
import {
  buildAutoDecisionPolicyInput,
  computeEffectiveAutoFlags,
  isConsultationCancelledTerminal,
  resolveAutoDecisionApplicationState,
  type AutoDecisionApplicationPhase,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import { isAcquisitionOrchestratorPostExtractionStepsEnabled } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import {
  buildLegacyConvertInput,
  isDuplicateBlockedForConversion,
} from "@/lib/acquisition/orchestrator/acquisition-worksite-creation.worker"
import {
  getAcquisitionAutoMinConfidence,
  isAcquisitionAutoApproveEnabled,
  isAcquisitionAutoConvertEnabled,
} from "@/lib/acquisition/policy/auto-decision-feature-flag"
import {
  evaluateAutoDecision,
  type AutoDecisionResult,
} from "@/lib/acquisition/policy/auto-decision.policy"
import {
  evaluateAutoDecisionSourceFreshness,
  loadCurrentAcquisitionContentHash,
} from "@/lib/acquisition/policy/auto-decision-source-freshness"
import {
  AcquisitionDecisionJournalRepository,
  isPostExtractionStepsPipeline,
  toFrozenValidationCycle,
} from "@/lib/acquisition/policy/decision-journal.repository"
import { resolveValidatedSystemActor } from "@/lib/acquisition/policy/system-actor"
import {
  classifyWorkPeriod,
  dateToUtcCalendarYmd,
} from "@/lib/acquisition/policy/work-period-classification"
import { hasBlockingWarnings } from "@/lib/acquisition/review/consultation-ui"
import { approveImportDraftSchema } from "@/lib/acquisition/review/import-draft-review.schema"

export const TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_AUTO_DECISION_PREFLIGHT" as const

/**
 * Copie exacte du résultat CANCEL construit par le worker auto-decision
 * (pas de fonction exportée). Dérive verrouillée par test.
 */
export const AUTO_DECISION_CANCEL_LITERAL = {
  code: "AUTO_REJECT_CANCELLED",
  reasons: ["CONSULTATION_CANCELLED"],
} as const

const ENABLED_FLAG = "TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_ENABLED"
const COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
const DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

const TARGET_OVERRIDE_KEYS = ["companyId", "company_id", "draftId", "draft_id"] as const
const CLOCK_OVERRIDE_KEYS = ["referenceInstant", "reference_instant", "now"] as const

/** Limite du nom chantier appliquée par la conversion (même valeur que le service). */
const CONVERSION_WORKSITE_NAME_MAX = 100

type JournalReader = Pick<
  AcquisitionDecisionJournalRepository,
  | "findLatestValidationDecisionForCycle"
  | "findLatestAutoIntentForCycle"
  | "findLatestPostExtractionAutoIntentForExtractionIdentity"
>

export type TargetedAutoDecisionPreflightDeps = {
  auth?: typeof auth
  env?: Record<string, string | undefined>
  now?: () => Date
  db?: PrismaClient
  buildContext?: typeof buildConsultationEvaluationContext
  journal?: JournalReader
  resolveSystemActor?: typeof resolveValidatedSystemActor
  isAutoApproveEnabled?: () => boolean
  isAutoConvertEnabled?: () => boolean
  isAcquisitionEnabled?: () => boolean
  isConversionEnabled?: () => boolean
  isConversionFullyEnabled?: () => boolean
}

export type PredictedNextPhase =
  | "OUT_OF_SCOPE"
  | "ALREADY_APPROVED"
  | "PIPELINE_DISABLED"
  | "BLOCKED_ACQUISITION_DISABLED"
  | "AWAITING_VALIDATION"
  | "VALIDATION_NOT_PASS"
  | "STALE_CYCLE"
  | "HUMAN_REVIEW"
  | "BLOCKED_SOURCE_STALE"
  | "BLOCKED_SYSTEM_ACTOR"
  | "WOULD_REJECT_CANCELLED"
  | "BLOCKED_WORK_PERIOD"
  | "BLOCKED_APPROVAL_REFUSAL"
  | "APPROVE_ONLY_NO_WORKSITE"
  | "BLOCKED_INTENT_PROVENANCE"
  | "BLOCKED_CONVERSION_DISABLED"
  | "BLOCKED_DUPLICATE"
  | "BLOCKED_CLIENT"
  | "BLOCKED_CONVERSION_INPUT"
  | "WOULD_APPROVE_AND_CONVERT"

type ValidationStatus = "NONE" | "PASS" | "CANCELLED_TERMINAL" | "NOT_PASS"

type ApprovalRefusal =
  | "VALIDATION_ERROR"
  | "MISSING_WORKSITE_NAME"
  | "MISSING_DATES"
  | "DATE_RANGE_INVALID"
  | "WORK_PERIOD_OBSOLETE"
  | "BLOCKING_WARNINGS"

type ConversionInputRefusal =
  | "CLIENT_UNRESOLVED"
  | "INPUT_SCHEMA_INVALID"
  | "WORKSITE_NAME_INVALID"
  | "MISSING_DATES"
  | "DATE_RANGE_INVALID"
  | "WORK_PERIOD_OBSOLETE"
  | "WORK_PERIOD_INVALID"

function refused(status: number, code: string, message: string): Response {
  return NextResponse.json({ ok: false, code, message }, { status })
}

function hasAnyKey(body: unknown, keys: readonly string[]): boolean {
  return Boolean(body && typeof body === "object" && keys.some((k) => k in body))
}

function resolveMinConfidenceSource(ctx: ConsultationEvaluationContext): {
  value: number
  source: "PARTNER_PROFILE" | "PARTNER" | "ENV_OR_DEFAULT"
} {
  if (ctx.partnerProfile?.minConfidence != null) {
    return { value: ctx.partnerProfile.minConfidence, source: "PARTNER_PROFILE" }
  }
  if (ctx.partner?.minConfidence != null) {
    return { value: ctx.partner.minConfidence, source: "PARTNER" }
  }
  return { value: getAcquisitionAutoMinConfidence(), source: "ENV_OR_DEFAULT" }
}

/** Plage invalide au sens approbation (YMD UTC) OU conversion (comparaison Date). */
function isDateRangeInvalid(start: Date | null, end: Date | null): boolean {
  if (!start || !end) return false
  return dateToUtcCalendarYmd(start) > dateToUtcCalendarYmd(end) || start > end
}

export async function handleTargetedStagingAutoDecisionPreflight(
  req: Request,
  deps: TargetedAutoDecisionPreflightDeps = {}
): Promise<Response> {
  try {
    return await runPreflight(req, deps)
  } catch {
    return refused(500, "PREFLIGHT_FAILED", "Erreur interne")
  }
}

async function runPreflight(
  req: Request,
  deps: TargetedAutoDecisionPreflightDeps
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

  if (confirmation !== TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_CHECK_CONFIRMATION) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }
  if (hasAnyKey(body, TARGET_OVERRIDE_KEYS)) {
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "TARGET_OVERRIDE")
  }
  if (hasAnyKey(body, CLOCK_OVERRIDE_KEYS)) {
    return refused(400, "CLOCK_OVERRIDE_FORBIDDEN", "CLOCK_OVERRIDE")
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

  const db = deps.db ?? prisma
  const ctx = await (deps.buildContext ?? buildConsultationEvaluationContext)({ companyId, draftId })
  if (!ctx || ctx.draft.id !== draftId || ctx.draft.companyId !== companyId) {
    return refused(409, "EVALUATION_CONTEXT_UNAVAILABLE", "Contexte d'évaluation indisponible")
  }

  const referenceInstant = (deps.now ?? (() => new Date()))()

  // Gates production (helpers réels, lecture seule) : approbation/rejet puis conversion.
  const gates = {
    acquisitionEnabled: (deps.isAcquisitionEnabled ?? isAcquisitionEnabled)(),
    conversionFlag: (deps.isConversionEnabled ?? isAcquisitionConversionEnabled)(),
    conversionFullyEnabled: (deps.isConversionFullyEnabled ?? isAcquisitionConversionFullyEnabled)(),
  }

  // Flags auto : global (env production) / partner / effectif — lecture seule.
  const globalAutoApprove = (deps.isAutoApproveEnabled ?? isAcquisitionAutoApproveEnabled)()
  const globalAutoConvert = (deps.isAutoConvertEnabled ?? isAcquisitionAutoConvertEnabled)()
  const partnerAutoApprove = ctx.partner?.autoApproveEnabled === true
  const partnerAutoConvert = ctx.partner?.autoConvertEnabled === true
  const effective = computeEffectiveAutoFlags({
    partnerAutoApprove,
    partnerAutoConvert,
    globalAutoApprove,
    globalAutoConvert,
  })
  const postExtractionSteps = isAcquisitionOrchestratorPostExtractionStepsEnabled(env)
  const flags = {
    postExtractionSteps,
    partnerResolved: ctx.partner != null,
    autoApprove: {
      global: globalAutoApprove,
      partner: partnerAutoApprove,
      effective: effective.effectiveAutoApproveEnabled,
    },
    autoConvert: {
      global: globalAutoConvert,
      partner: partnerAutoConvert,
      effective: effective.effectiveAutoConvertEnabled,
    },
    minConfidence: resolveMinConfidenceSource(ctx),
  }

  // Période : même instant pour policy, approbation et conversion.
  const start = ctx.draft.proposedStartDate
  const end = ctx.draft.proposedEndDate
  const workPeriod = classifyWorkPeriod(start, end, referenceInstant)
  const missingStartWithEnd = !start && end != null
  const dateRangeInvalid = isDateRangeInvalid(start, end)
  const worksiteName = ctx.draft.proposedWorksiteName?.trim() ?? ""

  // Refus déterministes du service d'approbation reproductibles en lecture seule (ordre du service).
  let approvalRefusal: ApprovalRefusal | null = null
  if (!approveImportDraftSchema.safeParse({ draftId, expectedVersion: ctx.draft.version }).success) {
    approvalRefusal = "VALIDATION_ERROR"
  } else if (!worksiteName) approvalRefusal = "MISSING_WORKSITE_NAME"
  else if (missingStartWithEnd) approvalRefusal = "MISSING_DATES"
  else if (dateRangeInvalid) approvalRefusal = "DATE_RANGE_INVALID"
  else if (workPeriod === "OBSOLETE") approvalRefusal = "WORK_PERIOD_OBSOLETE"
  else if (hasBlockingWarnings(ctx.draft.warningData)) approvalRefusal = "BLOCKING_WARNINGS"

  // Entrée conversion générée par le helper production, validée par le schéma production.
  // expectedVersion = version post-approbation (vN+1), comme le worker worksiteCreation.
  const convertInput = buildLegacyConvertInput({
    draftId,
    expectedVersion: ctx.draft.version + 1,
    ctx,
  })
  let conversionInputRefusal: ConversionInputRefusal | null = null
  if (!convertInput) conversionInputRefusal = "CLIENT_UNRESOLVED"
  else if (!convertImportDraftSchema.safeParse(convertInput).success) {
    conversionInputRefusal = "INPUT_SCHEMA_INVALID"
  } else if (!worksiteName || worksiteName.length > CONVERSION_WORKSITE_NAME_MAX) {
    conversionInputRefusal = "WORKSITE_NAME_INVALID"
  } else if (missingStartWithEnd) conversionInputRefusal = "MISSING_DATES"
  else if (dateRangeInvalid) conversionInputRefusal = "DATE_RANGE_INVALID"
  else if (workPeriod === "OBSOLETE") conversionInputRefusal = "WORK_PERIOD_OBSOLETE"
  else if (workPeriod === "INVALID") conversionInputRefusal = "WORK_PERIOD_INVALID"

  const approvalReadiness = { ok: approvalRefusal == null, refusal: approvalRefusal }
  const conversionReadiness = {
    clientMode: convertInput ? convertInput.clientMode : ("BLOCKED" as const),
    clientMatched: ctx.clientMatch.clientId != null,
    clientAmbiguous: ctx.clientMatch.ambiguous === true,
    allowCreateClient: ctx.partner?.allowCreateClient === true,
    duplicateBlocked: isDuplicateBlockedForConversion(ctx),
    duplicateMatchKind: ctx.duplicate.matchKind,
    inputValid: conversionInputRefusal == null,
    inputRefusal: conversionInputRefusal,
  }

  const draftSummary = {
    id: ctx.draft.id,
    status: ctx.draft.status,
    version: ctx.draft.version,
    cycle: ctx.cycle,
    workPeriod,
  }

  const outOfScopePhase: PredictedNextPhase | null =
    ctx.draft.status === "APPROVED"
      ? "ALREADY_APPROVED"
      : ctx.draft.status !== "PENDING_REVIEW"
        ? "OUT_OF_SCOPE"
        : null

  if (outOfScopePhase) {
    return NextResponse.json({
      ok: true,
      mode: "CHECK_READ_ONLY",
      referenceInstant: referenceInstant.toISOString(),
      draft: draftSummary,
      gates,
      validation: null,
      existingIntent: null,
      applicationPhase: null,
      flags,
      predictedDecision: null,
      detection: null,
      sourceFreshness: null,
      systemActor: null,
      approvalReadiness,
      conversionReadiness,
      predictedNextPhase: outOfScopePhase,
    })
  }

  // --- PENDING_REVIEW : lectures journal du cycle courant (méthodes production) ---
  const journal: JournalReader = deps.journal ?? new AcquisitionDecisionJournalRepository(db)
  const frozen = toFrozenValidationCycle(ctx.cycle)
  const validationRow = await journal.findLatestValidationDecisionForCycle({
    companyId,
    draftId,
    cycle: ctx.cycle,
  })
  const intent = await journal.findLatestAutoIntentForCycle({ companyId, draftId, frozen })
  // Lookup exact du worker worksiteCreation (provenance pipeline + identité extraction).
  const latestPostExtractionIntent = intent
    ? await journal.findLatestPostExtractionAutoIntentForExtractionIdentity({
        companyId,
        draftId,
        contentHash: ctx.cycle.contentHash,
        extractionSchemaVersion: ctx.cycle.extractionSchemaVersion,
      })
    : null

  const systemActor = await (deps.resolveSystemActor ?? resolveValidatedSystemActor)(companyId, db)

  const applicationPhase: AutoDecisionApplicationPhase = resolveAutoDecisionApplicationState({
    draftStatus: ctx.draft.status,
    draftContentHash: ctx.draft.contentHashAtExtraction,
    draftExtractionSchemaVersion: ctx.draft.extractionSchemaVersion,
    draftVersion: ctx.draft.version,
    validationForCurrentCycle: validationRow,
    intentForFrozenCycle: intent,
    followUpForIntentCycle: null,
    systemActorOk: systemActor.ok,
  })

  const cancelled = validationRow != null && isConsultationCancelledTerminal(validationRow)
  const validationStatus: ValidationStatus = !validationRow
    ? "NONE"
    : validationRow.decisionCode === "VALIDATION_PASS"
      ? "PASS"
      : cancelled
        ? "CANCELLED_TERMINAL"
        : "NOT_PASS"

  // Décision prédite : PASS-path hypothétique si aucun PASS persisté (jamais présenté comme persisté).
  const basis =
    validationStatus === "PASS"
      ? "PERSISTED_PASS"
      : validationStatus === "CANCELLED_TERMINAL"
        ? "PERSISTED_CANCEL"
        : "HYPOTHETICAL_NO_PERSISTED_PASS"

  const preGate: AutoDecisionResult =
    validationStatus === "CANCELLED_TERMINAL"
      ? {
          code: AUTO_DECISION_CANCEL_LITERAL.code,
          reasons: [...AUTO_DECISION_CANCEL_LITERAL.reasons],
          scores: ctx.snapshot.confidenceData,
        }
      : evaluateAutoDecision({
          ...buildAutoDecisionPolicyInput({
            ctx,
            effectiveAutoApproveEnabled: effective.effectiveAutoApproveEnabled,
            effectiveAutoConvertEnabled: effective.effectiveAutoConvertEnabled,
          }),
          referenceInstant,
        })

  const proof = await db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      detectionClassification: true,
      detectionContentHash: true,
      contentHashAtExtraction: true,
      acquisitionMessageId: true,
    },
  })
  if (!proof) {
    return refused(409, "EVALUATION_CONTEXT_UNAVAILABLE", "Contexte d'évaluation indisponible")
  }
  const currentSourceContentHash = proof.acquisitionMessageId
    ? await loadCurrentAcquisitionContentHash(db, companyId, proof.acquisitionMessageId)
    : null
  const detectionClassification =
    (proof.detectionClassification as ConsultationClassification | null) ?? null
  const freshness = evaluateAutoDecisionSourceFreshness({
    detectionContentHash: proof.detectionContentHash,
    contentHashAtExtraction: proof.contentHashAtExtraction,
    currentSourceContentHash,
  })
  // Parité approve/reject/convert : frais ET égal au hash du cycle figé (sans verrou ici).
  const sourceFreshForMutation = freshness.ok && freshness.contentHash === frozen.contentHash
  const gated = gateAutoDecisionByDetectionProof({
    decision: preGate,
    detectionClassification,
    detectionContentHash: proof.detectionContentHash,
    contentHashAtExtraction: proof.contentHashAtExtraction,
    currentSourceContentHash,
  })

  const intentProvenance = intent
    ? {
        postExtractionPipeline: isPostExtractionStepsPipeline(intent.metadata),
        latestForExtractionIdentity: latestPostExtractionIntent?.id === intent.id,
      }
    : null

  // Le worker agit sur l'intent déjà journalisé s'il existe, sinon sur la décision recalculée.
  const actingCode = intent?.decisionCode ?? gated.code
  const convertProvenanceOk =
    !intentProvenance ||
    (intentProvenance.postExtractionPipeline && intentProvenance.latestForExtractionIdentity)

  let predictedNextPhase: PredictedNextPhase
  if (!postExtractionSteps) predictedNextPhase = "PIPELINE_DISABLED"
  else if (!gates.acquisitionEnabled) predictedNextPhase = "BLOCKED_ACQUISITION_DISABLED"
  else if (applicationPhase === "STALE_CYCLE") predictedNextPhase = "STALE_CYCLE"
  else if (validationStatus === "NONE") predictedNextPhase = "AWAITING_VALIDATION"
  else if (validationStatus === "NOT_PASS") predictedNextPhase = "VALIDATION_NOT_PASS"
  else if (actingCode === "HUMAN_REVIEW_REQUIRED") predictedNextPhase = "HUMAN_REVIEW"
  else if (!sourceFreshForMutation) predictedNextPhase = "BLOCKED_SOURCE_STALE"
  else if (!systemActor.ok) predictedNextPhase = "BLOCKED_SYSTEM_ACTOR"
  else if (actingCode === "AUTO_REJECT_CANCELLED") predictedNextPhase = "WOULD_REJECT_CANCELLED"
  else if (approvalRefusal === "WORK_PERIOD_OBSOLETE") predictedNextPhase = "BLOCKED_WORK_PERIOD"
  else if (approvalRefusal) predictedNextPhase = "BLOCKED_APPROVAL_REFUSAL"
  else if (actingCode === "AUTO_APPROVE_ONLY") predictedNextPhase = "APPROVE_ONLY_NO_WORKSITE"
  else if (!convertProvenanceOk) predictedNextPhase = "BLOCKED_INTENT_PROVENANCE"
  else if (!gates.conversionFullyEnabled) predictedNextPhase = "BLOCKED_CONVERSION_DISABLED"
  else if (conversionReadiness.duplicateBlocked) predictedNextPhase = "BLOCKED_DUPLICATE"
  else if (conversionInputRefusal === "CLIENT_UNRESOLVED") predictedNextPhase = "BLOCKED_CLIENT"
  else if (conversionInputRefusal) predictedNextPhase = "BLOCKED_CONVERSION_INPUT"
  else predictedNextPhase = "WOULD_APPROVE_AND_CONVERT"

  return NextResponse.json({
    ok: true,
    mode: "CHECK_READ_ONLY",
    referenceInstant: referenceInstant.toISOString(),
    draft: draftSummary,
    gates,
    validation: {
      status: validationStatus,
      persisted: validationRow != null,
      decisionCode: validationRow?.decisionCode ?? null,
    },
    existingIntent: intent
      ? { decisionCode: intent.decisionCode, ...intentProvenance }
      : null,
    applicationPhase,
    flags,
    predictedDecision: {
      basis,
      preGateCode: preGate.code,
      code: gated.code,
      reasons: gated.reasons,
    },
    detection: { classification: detectionClassification },
    sourceFreshness: {
      ok: freshness.ok,
      reason: freshness.ok ? null : freshness.reason,
      matchesCycle: sourceFreshForMutation,
    },
    systemActor: systemActor.ok
      ? { ok: true, code: null, reason: null }
      : { ok: false, code: systemActor.code, reason: systemActor.reason },
    approvalReadiness,
    conversionReadiness,
    predictedNextPhase,
  })
}
