/**
 * PLAN-ACQ-005B-2 — ExtractionService : unique autorité métier (R1).
 * Provider résolu AVANT claim. Persist atomique hash+version.
 */

import type { Role } from "@prisma/client"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import {
  contentHashPrefix,
  isAcquisitionContentFetchEnabled,
} from "@/lib/acquisition/content/content-fetch-feature-flag"
import {
  EXTRACTION_SCHEMA_VERSION,
  getExtractionMaxAttempts,
  getExtractionReclaimTtlMs,
  getExtractionTimeoutMs,
  isAcquisitionExtractionEnabled,
} from "@/lib/acquisition/extraction/extraction-feature-flag"
import { isExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { resolveExtractionProvider } from "@/lib/acquisition/extraction/extraction-provider.factory"
import {
  DraftExtractionRepository,
  draftExtractionRepository,
} from "@/lib/acquisition/extraction/extraction.repository"
import {
  buildExtractedDataPayload,
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"
import type {
  ExtractDraftResult,
  ExtractionErrorCode,
  RunDraftExtractionInput,
} from "@/lib/acquisition/extraction/extraction.types"

const LOG_PREFIX = "[acquisition-extraction]"
const ALLOWED_ROLES = new Set<Role>(["ADMIN", "SUPER_ADMIN"])

export interface ExtractionServiceDeps {
  repository?: DraftExtractionRepository
  provider?: ExtractionProviderPort
  /** Override timeout (tests). Prod : getExtractionTimeoutMs(). */
  timeoutMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function fail(
  outcome: Extract<ExtractDraftResult, { ok: false }>["outcome"],
  code: ExtractionErrorCode,
  message: string,
  extra?: Partial<Extract<ExtractDraftResult, { ok: false }>>
): ExtractDraftResult {
  return { ok: false, outcome, code, message, ...extra }
}

function resolveProvider(override?: ExtractionProviderPort): ExtractionProviderPort | null {
  if (override) return override
  return resolveExtractionProvider()
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("PROVIDER_TIMEOUT"), { code: "PROVIDER_TIMEOUT" }))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function mapPersistOutcome(
  outcome: "OK" | "STALE_CONTENT" | "STATE_CHANGED",
  draftId: string
): Extract<ExtractDraftResult, { ok: false }> | null {
  if (outcome === "OK") return null
  if (outcome === "STALE_CONTENT") {
    return fail("STALE_CONTENT", "STALE_CONTENT", "Contenu modifié pendant l'extraction", {
      draftId,
    }) as Extract<ExtractDraftResult, { ok: false }>
  }
  return fail("STATE_CHANGED", "EXTRACTION_STATE_CHANGED", "État draft modifié par un autre worker", {
    draftId,
  }) as Extract<ExtractDraftResult, { ok: false }>
}

export type RunDraftExtractionCoreInput = {
  companyId: string
  draftId: string
  force?: boolean
  now?: () => Date
}

/**
 * Cœur métier 005B — sans AuthZ Role.
 * Appelé par le wrapper UI et le wrapper système OPS-004.
 */
export async function runDraftExtractionCore(
  input: RunDraftExtractionCoreInput,
  deps: ExtractionServiceDeps = {}
): Promise<ExtractDraftResult> {
  const repository = deps.repository ?? draftExtractionRepository
  const log = deps.log ?? defaultLog
  const nowFn = input.now ?? (() => new Date())
  const now = nowFn()

  if (!isAcquisitionEnabled()) {
    return fail("DISABLED", "ACQUISITION_DISABLED", "Acquisition désactivée")
  }
  if (!isAcquisitionContentFetchEnabled()) {
    return fail("DISABLED", "CONTENT_FETCH_DISABLED", "Fetch contenu désactivé")
  }
  if (!isAcquisitionExtractionEnabled()) {
    return fail("DISABLED", "EXTRACTION_DISABLED", "Extraction désactivée")
  }

  // Provider résolu AVANT claim (I2) — anthropic absent n'incrémente pas attemptCount.
  const provider = resolveProvider(deps.provider)
  if (!provider) {
    return fail(
      "FAILED",
      "PROVIDER_NOT_CONFIGURED",
      "Provider extraction non configuré (005B-3)",
    )
  }

  const companyId = input.companyId
  const draft = await repository.findDraft(companyId, input.draftId)
  if (!draft) {
    return fail("NOT_FOUND", "DRAFT_NOT_FOUND", "Brouillon introuvable")
  }

  const maxAttempts = getExtractionMaxAttempts()
  const reclaimTtl = getExtractionReclaimTtlMs()
  const reclaimBefore = new Date(now.getTime() - reclaimTtl)

  if (
    draft.status === "PENDING_REVIEW" &&
    !input.force &&
    draft.contentHashAtExtraction &&
    draft.extractionSchemaVersion === EXTRACTION_SCHEMA_VERSION
  ) {
    const content = await repository.findContent(companyId, draft.acquisitionMessageId)
    if (content && content.contentHash === draft.contentHashAtExtraction) {
      log("ALREADY_EXTRACTED", {
        draftId: draft.id,
        hashPrefix: contentHashPrefix(content.contentHash),
      })
      return {
        ok: true,
        outcome: "ALREADY_EXTRACTED",
        draftId: draft.id,
        status: "PENDING_REVIEW",
        contentHashAtExtraction: draft.contentHashAtExtraction,
        warningCount: 0,
      }
    }
  }

  if (draft.status === "EXTRACTING") {
    const started = draft.extractionStartedAt
    if (started && started >= reclaimBefore) {
      return fail("IN_PROGRESS", "EXTRACTION_IN_PROGRESS", "Extraction en cours", {
        draftId: draft.id,
        status: draft.status,
      })
    }
  }

  const force = Boolean(input.force)
  const reclaimableExtracting =
    draft.status === "EXTRACTING" &&
    draft.extractionStartedAt !== null &&
    draft.extractionStartedAt < reclaimBefore

  const allowed =
    draft.status === "PENDING_EXTRACTION" ||
    draft.status === "FAILED" ||
    (force && draft.status === "PENDING_REVIEW") ||
    reclaimableExtracting

  if (!allowed) {
    return fail(
      "FAILED",
      "EXTRACTION_INVALID_STATUS",
      `Statut non extractible: ${draft.status}`,
      { draftId: draft.id, status: draft.status }
    )
  }

  if (draft.extractionAttemptCount >= maxAttempts && !force) {
    return fail("MAX_ATTEMPTS_REACHED", "EXTRACTION_MAX_ATTEMPTS", "Nombre max de tentatives atteint", {
      draftId: draft.id,
      attemptCount: draft.extractionAttemptCount,
      maxAttempts,
    })
  }

  const content = await repository.findContent(companyId, draft.acquisitionMessageId)
  if (!content || !content.normalizedText.trim()) {
    return fail("CONTENT_MISSING", "CONTENT_MISSING", "Contenu message absent (005A)", {
      draftId: draft.id,
    })
  }

  const message = await repository.findMessage(companyId, draft.acquisitionMessageId)
  const attachments = await repository.listAttachmentMetadata(
    companyId,
    draft.acquisitionMessageId
  )

  const claimed = await repository.claimExtracting({
    companyId,
    draftId: draft.id,
    expectedVersion: draft.version,
    allowedStatuses: force
      ? ["PENDING_EXTRACTION", "FAILED", "PENDING_REVIEW"]
      : ["PENDING_EXTRACTION", "FAILED"],
    now,
    reclaimBefore,
  })

  if (!claimed) {
    return fail("IN_PROGRESS", "EXTRACTION_IN_PROGRESS", "Claim concurrent échoué", {
      draftId: draft.id,
    })
  }

  const claimVersion = claimed.version
  const contentHashAtClaim = content.contentHash

  log("EXTRACTION_STARTED", {
    draftId: draft.id,
    hashPrefix: contentHashPrefix(contentHashAtClaim),
    attemptCount: claimed.extractionAttemptCount,
  })

  try {
    const raw = await withTimeout(
      provider.extract({
        subject: message?.subject ?? null,
        normalizedText: content.normalizedText,
        locale: "fr-FR",
        attachmentMetadata: attachments,
        extractionSchemaVersion: "1",
      }),
      deps.timeoutMs ?? getExtractionTimeoutMs()
    )

    let normalized: ReturnType<typeof normalizeProviderResult>
    try {
      normalized = normalizeProviderResult(raw)
    } catch {
      const marked = await repository.markFailedWhileExtracting({
        companyId,
        draftId: draft.id,
        expectedVersion: claimVersion,
        errorCode: "PROVIDER_INVALID_OUTPUT",
        now: nowFn(),
      })
      if (marked === "STATE_CHANGED") {
        return fail("STATE_CHANGED", "EXTRACTION_STATE_CHANGED", "État draft modifié", {
          draftId: draft.id,
        })
      }
      return fail("FAILED", "PROVIDER_INVALID_OUTPUT", "Sortie provider invalide", {
        draftId: draft.id,
      })
    }

    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    const completedAt = nowFn()
    const extractedData = buildExtractedDataPayload(
      normalized.fields,
      normalized.evidenceData,
      contentHashAtClaim
    )

    if (!gate.pass) {
      const errorCode = gate.failureCode ?? "CONTENT_INSUFFICIENT"
      const persistOutcome = await repository.persistExtraction({
        companyId,
        draftId: draft.id,
        expectedVersion: claimVersion,
        expectedContentHash: contentHashAtClaim,
        status: "FAILED",
        fields: normalized.fields,
        confidenceData: normalized.confidenceData,
        warningData: gate.warnings,
        extractedData,
        providerId: normalized.providerId,
        model: normalized.model,
        errorCode,
        now: completedAt,
      })
      const mapped = mapPersistOutcome(persistOutcome, draft.id)
      if (mapped) {
        log("EXTRACTION_FAILED", {
          draftId: draft.id,
          code: mapped.code,
          hashPrefix: contentHashPrefix(contentHashAtClaim),
        })
        return mapped
      }
      log("EXTRACTION_FAILED", {
        draftId: draft.id,
        code: errorCode,
        hashPrefix: contentHashPrefix(contentHashAtClaim),
      })
      const retryAllowed = claimed.extractionAttemptCount < maxAttempts
      return fail(
        retryAllowed ? "RETRY_ALLOWED" : "FAILED",
        errorCode,
        "Extraction échouée (gate métier)",
        {
          draftId: draft.id,
          status: "FAILED",
          attemptCount: claimed.extractionAttemptCount,
          maxAttempts,
        }
      )
    }

    const persistOutcome = await repository.persistExtraction({
      companyId,
      draftId: draft.id,
      expectedVersion: claimVersion,
      expectedContentHash: contentHashAtClaim,
      status: "PENDING_REVIEW",
      fields: normalized.fields,
      confidenceData: normalized.confidenceData,
      warningData: gate.warnings,
      extractedData,
      providerId: normalized.providerId,
      model: normalized.model,
      errorCode: null,
      now: completedAt,
    })

    const mapped = mapPersistOutcome(persistOutcome, draft.id)
    if (mapped) {
      log("EXTRACTION_FAILED", {
        draftId: draft.id,
        code: mapped.code,
        hashPrefix: contentHashPrefix(contentHashAtClaim),
      })
      return mapped
    }

    log("EXTRACTION_SUCCEEDED", {
      draftId: draft.id,
      hashPrefix: contentHashPrefix(contentHashAtClaim),
      warningCount: gate.warnings.length,
    })

    return {
      ok: true,
      outcome: "EXTRACTED",
      draftId: draft.id,
      status: "PENDING_REVIEW",
      contentHashAtExtraction: contentHashAtClaim,
      warningCount: gate.warnings.length,
    }
  } catch (error) {
    const completedAt = nowFn()
    let code: ExtractionErrorCode = "INTERNAL_ERROR"
    /** Deny-by-default : seule une ExtractionProviderError.retryable=true (ou timeout enveloppe) autorise RETRY_ALLOWED. */
    let errorRetryable = false
    if (isExtractionProviderError(error)) {
      code = error.code
      errorRetryable = error.retryable
    } else if (
      error instanceof Error &&
      (error.message === "PROVIDER_TIMEOUT" ||
        (error as { code?: string }).code === "PROVIDER_TIMEOUT")
    ) {
      code = "PROVIDER_TIMEOUT"
      errorRetryable = true
    }

    const warningCode =
      code === "PROVIDER_TIMEOUT"
        ? "PROVIDER_TIMEOUT"
        : code === "PROVIDER_UNAVAILABLE"
          ? "PROVIDER_UNAVAILABLE"
          : null

    const marked = await repository.markFailedWhileExtracting({
      companyId,
      draftId: draft.id,
      expectedVersion: claimVersion,
      errorCode: code,
      now: completedAt,
      warnings: warningCode ? [catalogWarning(warningCode, { source: "SERVICE" })] : [],
    })

    if (marked === "STATE_CHANGED") {
      log("EXTRACTION_FAILED", {
        draftId: draft.id,
        code: "EXTRACTION_STATE_CHANGED",
        hashPrefix: contentHashPrefix(contentHashAtClaim),
      })
      return fail("STATE_CHANGED", "EXTRACTION_STATE_CHANGED", "État draft modifié", {
        draftId: draft.id,
      })
    }

    log("EXTRACTION_FAILED", {
      draftId: draft.id,
      code,
      hashPrefix: contentHashPrefix(contentHashAtClaim),
    })

    const retryAllowed =
      errorRetryable && claimed.extractionAttemptCount < maxAttempts
    return fail(retryAllowed ? "RETRY_ALLOWED" : "FAILED", code, "Échec provider / timeout", {
      draftId: draft.id,
      status: "FAILED",
      attemptCount: claimed.extractionAttemptCount,
      maxAttempts,
    })
  }
}

/**
 * Wrapper UI — ordre historique : flags capacité → AuthZ ADMIN|SUPER_ADMIN → core.
 * Le wrapper système OPS-004 n’emprunte pas ce chemin.
 */
export async function runDraftExtraction(
  input: RunDraftExtractionInput,
  deps: ExtractionServiceDeps = {}
): Promise<ExtractDraftResult> {
  if (!isAcquisitionEnabled()) {
    return fail("DISABLED", "ACQUISITION_DISABLED", "Acquisition désactivée")
  }
  if (!isAcquisitionContentFetchEnabled()) {
    return fail("DISABLED", "CONTENT_FETCH_DISABLED", "Fetch contenu désactivé")
  }
  if (!isAcquisitionExtractionEnabled()) {
    return fail("DISABLED", "EXTRACTION_DISABLED", "Extraction désactivée")
  }
  if (!ALLOWED_ROLES.has(input.actor.role) || !input.actor.companyId) {
    return fail("FORBIDDEN", "EXTRACTION_FORBIDDEN", "Accès refusé")
  }
  return runDraftExtractionCore(
    {
      companyId: input.actor.companyId,
      draftId: input.draftId,
      force: input.force,
      now: input.now,
    },
    deps
  )
}

/**
 * Wrapper système OPS-004 — aucun Role / faux ADMIN.
 * force toujours false. Appel uniquement après auth cron réussie.
 */
export async function runDraftExtractionSystem(
  input: { companyId: string; draftId: string; now?: () => Date },
  deps: ExtractionServiceDeps = {}
): Promise<ExtractDraftResult> {
  return runDraftExtractionCore(
    {
      companyId: input.companyId,
      draftId: input.draftId,
      force: false,
      now: input.now,
    },
    deps
  )
}
