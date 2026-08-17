/**
 * PLAN-ACQ-V2-001 Lot B / PLAN-ACQ-012-4 — Wiring des 5 workers réels.
 * Capability AUTO créée uniquement ici. Pas de factory publique.
 * Budgets enfants bornés par remainingMs. Gmail : clamp + heartbeat lease.
 */

import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { getAttachmentDownloadCronConfig } from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import { getAttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import { runAcquisitionAttachmentRecoveryOrchestrator } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import {
  runAcquisitionGmailSyncDriver,
  type AcquisitionGmailCronRunResult,
} from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import { createGmailMailProviderAdapter } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { getContentCronConfig } from "@/lib/acquisition/content/content-cron-feature-flag"
import { runAcquisitionContentCronOrchestratorDefault } from "@/lib/acquisition/content/message-content-cron.orchestrator"
import { getExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import { runAcquisitionExtractionCronOrchestrator } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import { acquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { runDraftExtractionOrchestrated } from "@/lib/acquisition/extraction/extraction.service"
import { acquisitionIngestionAdapter } from "@/lib/acquisition/ports/acquisition-ingestion.adapter"
import { acquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { gmailConnectionListingAdapter } from "@/lib/acquisition/persistence/gmail-connection-listing.adapter"
import {
  ACQUISITION_ORCHESTRATOR_LEASE_KEY,
  getAcquisitionOrchestratorConfig,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { acquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { runAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import type {
  AcquisitionOrchestratorLeaseRepositoryPort,
  AcquisitionOrchestratorRunResult,
  AcquisitionOrchestratorStepRunners,
  OrchestratorStepRunnerResult,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import {
  checkOrchestratorLeaseHeartbeat,
  type OrchestratorItemOwnershipCheck,
  type OrchestratorOwnershipState,
} from "@/lib/acquisition/orchestrator/orchestrator-ownership"

const ORCHESTRATOR_AUTO_BRAND: unique symbol = Symbol(
  "ORCHESTRATOR_AUTO_CAPABILITY"
)

/**
 * Token opaque : unique symbol non exporté. PAS de méthode ensureOwned.
 * Membership WeakMap = seule preuve d’authenticité (pas la forme de l’objet).
 */
export type OrchestratorAutoCapability = {
  readonly [ORCHESTRATOR_AUTO_BRAND]: true
}

type OrchestratorAutoInternals = {
  heartbeat: () => Promise<OrchestratorOwnershipState>
}

const autoCapabilityInternals = new WeakMap<
  OrchestratorAutoCapability,
  OrchestratorAutoInternals
>()

/**
 * Factory AUTO interne au wiring orchestrateur. Non exportée.
 */
function createOrchestratorAutoCapability(input: {
  leaseRepository: AcquisitionOrchestratorLeaseRepositoryPort
  ownerRunId: string
}): OrchestratorAutoCapability {
  const capability: OrchestratorAutoCapability = {
    [ORCHESTRATOR_AUTO_BRAND]: true,
  }
  autoCapabilityInternals.set(capability, {
    heartbeat: () =>
      checkOrchestratorLeaseHeartbeat({
        leaseRepository: input.leaseRepository,
        ownerRunId: input.ownerRunId,
      }),
  })
  return capability
}

/**
 * Autorité privée : heartbeat WeakMap uniquement.
 * Un objet { ensureOwned } n’est jamais OWNED.
 */
export async function resolveOrchestratorAutoOwnership(
  capability: OrchestratorAutoCapability
): Promise<OrchestratorOwnershipState> {
  const ops = autoCapabilityInternals.get(capability)
  if (!ops) return "NOT_OWNED"
  try {
    return await ops.heartbeat()
  } catch {
    return "NOT_OWNED"
  }
}

function ownershipCheckFrom(
  capability: OrchestratorAutoCapability
): OrchestratorItemOwnershipCheck {
  return () => resolveOrchestratorAutoOwnership(capability)
}

function mapWorkerStatus(
  status: string
): OrchestratorStepRunnerResult["status"] {
  if (status === "SUCCESS") return "SUCCESS"
  if (status === "PARTIAL") return "PARTIAL"
  if (status === "SKIPPED") return "SKIPPED"
  return "FAILED"
}

function publicWorkerResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return { ok: true }
  const r = result as Record<string, unknown>
  return {
    status: r.status,
    skipReason: r.skipReason,
    durationMs: r.durationMs,
    runId: r.runId,
    errorCode: typeof r.errorCode === "string" ? r.errorCode : undefined,
    companiesTotal: r.companiesTotal,
    companiesSucceeded: r.companiesSucceeded,
    companiesFailed: r.companiesFailed,
    companiesPartial: r.companiesPartial,
  }
}

function mapChildWorkerResult(result: {
  status: string
  skipReason?: string
  error?: { code: string; message: string }
  errorCode?: string
}): OrchestratorStepRunnerResult {
  const stolen =
    result.skipReason === "LEASE_STOLEN" || result.errorCode === "LEASE_STOLEN"
  const mapped = mapWorkerStatus(result.status)
  return {
    status: stolen && mapped === "SUCCESS" ? "FAILED" : mapped,
    result: publicWorkerResult(result),
    ...(stolen
      ? {
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease perdu pendant le worker",
          },
        }
      : {
          ...(result.skipReason ? { skipReason: result.skipReason } : {}),
          ...(result.error
            ? { error: result.error }
            : result.errorCode
              ? { error: { code: result.errorCode, message: result.errorCode } }
              : {}),
        }),
  }
}

function clampChildBudget(remainingMs: number, childDefault: number): number {
  return Math.max(1_000, Math.min(childDefault, Math.floor(remainingMs * 0.9)))
}

async function runGmailSync(input: {
  runId: string
  remainingMs: number
  leaseRepository: AcquisitionOrchestratorLeaseRepositoryPort
}): Promise<OrchestratorStepRunnerResult> {
  const budgetMs = clampChildBudget(input.remainingMs, input.remainingMs)
  const deadlineAtMs = Date.now() + budgetMs
  const leaseTtlMs = getAcquisitionOrchestratorConfig().leaseTtlMs

  const shouldContinue = async () => {
    if (Date.now() >= deadlineAtMs) return false
    const owned = await input.leaseRepository.assertOwned({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: input.runId,
    })
    if (owned.outcome !== "OWNED") return false
    if (typeof input.leaseRepository.renew === "function") {
      const renewed = await input.leaseRepository.renew({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: input.runId,
        leaseTtlMs,
      })
      if (renewed.outcome !== "OWNED") return false
    }
    return true
  }

  const result: AcquisitionGmailCronRunResult = await runAcquisitionGmailSyncDriver({
    listCompanyIds: () =>
      gmailConnectionListingAdapter.listCompanyIdsWithGmailConnection(),
    runSyncForCompany: (companyId) =>
      syncAcquisitionMailForCompany({
        companyId,
        provider: createGmailMailProviderAdapter(),
        ingestion: acquisitionIngestionAdapter,
        cursorRepository: acquisitionScanCursorRepository,
        deadlineAtMs,
        shouldContinue,
      }),
    log: (event, payload) => {
      console.log("[acquisition-orchestrator:gmail]", event, {
        ...payload,
        remainingMs: input.remainingMs,
        budgetMs,
      })
    },
  })

  // Fence final : ne pas finaliser SUCCESS si lease perdu
  const finalOwn = await input.leaseRepository.assertOwned({
    key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
    ownerRunId: input.runId,
  })
  if (finalOwn.outcome !== "OWNED") {
    return {
      status: "FAILED",
      skipReason: "LEASE_STOLEN",
      error: {
        code: "LEASE_STOLEN",
        message: "Lease perdu avant finalisation Gmail",
      },
      result: publicWorkerResult(result),
    }
  }

  return {
    status: mapWorkerStatus(result.status),
    result: publicWorkerResult(result),
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    ...(result.error
      ? { error: { code: result.error.code, message: result.error.message } }
      : {}),
  }
}

/**
 * Workers AUTO internes. leaseRepository imposé par l’appelant unique
 * `runProductionAcquisitionOrchestrator` — jamais exporté.
 */
function createProductionStepRunners(
  leaseRepository: AcquisitionOrchestratorLeaseRepositoryPort
): AcquisitionOrchestratorStepRunners {
  return {
    gmailSync: async ({ runId, remainingMs }) =>
      runGmailSync({ runId, remainingMs, leaseRepository }),

    attachmentRecovery: async ({ runId, remainingMs }) => {
      const capability = createOrchestratorAutoCapability({
        leaseRepository,
        ownerRunId: runId,
      })
      const base = getAttachmentRecoveryCronConfig()
      const result = await runAcquisitionAttachmentRecoveryOrchestrator({
        repository: acquisitionAttachmentRepository,
        createRunId: () => `${runId}:recovery`,
        config: {
          ...base,
          maxDurationMs: clampChildBudget(remainingMs, base.maxDurationMs),
        },
        ensureOwnership: ownershipCheckFrom(capability),
      })
      return mapChildWorkerResult(result)
    },

    attachmentDownload: async ({ runId, remainingMs }) => {
      const capability = createOrchestratorAutoCapability({
        leaseRepository,
        ownerRunId: runId,
      })
      const base = getAttachmentDownloadCronConfig()
      const result = await runAcquisitionAttachmentDownloadOrchestrator({
        repository: acquisitionAttachmentRepository,
        downloadAttachment: (input) => downloadAcquisitionAttachment(input),
        createRunId: () => `${runId}:download`,
        config: {
          ...base,
          maxDurationMs: clampChildBudget(remainingMs, base.maxDurationMs),
        },
        ensureOwnership: ownershipCheckFrom(capability),
      })
      return mapChildWorkerResult(result)
    },

    contentFetch: async ({ runId, remainingMs }) => {
      const capability = createOrchestratorAutoCapability({
        leaseRepository,
        ownerRunId: runId,
      })
      const base = getContentCronConfig()
      const result = await runAcquisitionContentCronOrchestratorDefault({
        createRunId: () => `${runId}:content`,
        config: {
          ...base,
          maxDurationMs: clampChildBudget(remainingMs, base.maxDurationMs),
        },
        ensureOwnership: ownershipCheckFrom(capability),
      })
      return mapChildWorkerResult(result)
    },

    extraction: async ({ runId, remainingMs }) => {
      const capability = createOrchestratorAutoCapability({
        leaseRepository,
        ownerRunId: runId,
      })
      const base = getExtractionCronConfig()
      const result = await runAcquisitionExtractionCronOrchestrator({
        repository: acquisitionExtractionCronSelectionRepository,
        extractDraft: ({ companyId, draftId, now }) =>
          runDraftExtractionOrchestrated({ companyId, draftId, now }, capability),
        createRunId: () => `${runId}:extraction`,
        config: {
          ...base,
          maxDurationMs: clampChildBudget(remainingMs, base.maxDurationMs),
        },
        ensureOwnership: ownershipCheckFrom(capability),
      })
      return mapChildWorkerResult(result)
    },
  }
}

/**
 * Unique entrée production AUTO.
 * Une seule autorité : `acquisitionOrchestratorLeaseRepository` pour
 * acquire / assertOwned / renew / release / capability workers.
 * Aucun paramètre leaseRepository ou steps.
 */
export async function runProductionAcquisitionOrchestrator(input: {
  runId: string
}): Promise<AcquisitionOrchestratorRunResult> {
  const leaseRepository = acquisitionOrchestratorLeaseRepository
  return runAcquisitionOrchestrator({
    runId: input.runId,
    leaseRepository,
    steps: createProductionStepRunners(leaseRepository),
    config: getAcquisitionOrchestratorConfig(),
  })
}
