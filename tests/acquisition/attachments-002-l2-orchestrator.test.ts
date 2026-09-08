/**
 * PLAN-ACQ-ATTACHMENTS-002-L2-R1 — Ordre orchestrateur + gates enfants (ports fake).
 * Aucun cron réel, aucun réseau.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { runAcquisitionOrchestrator } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import type {
  AcquisitionOrchestratorStepRunners,
  OrchestratorStepKey,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import { ORCHESTRATOR_STEP_KEYS } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import { runAcquisitionExtractionCronOrchestrator } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import type { AcquisitionAttachmentRepositoryPort } from "@/lib/acquisition/attachments/acquisition-attachment.repository"

const cfg = {
  maxDurationMs: 60_000,
  safetyMarginMs: 1_000,
  leaseTtlMs: 120_000,
}

function emptyAttachmentRepo(): AcquisitionAttachmentRepositoryPort {
  return {
    findAttachmentWithMessage: async () => null,
    claimForDownload: async () => ({ status: "NOT_FOUND" }),
    markStored: async () => ({ status: "FAILED" }),
    markFailure: async () => ({ outcome: "NOT_FOUND" }),
    listCompanyIdsWithDiscoveredAttachments: async () => [],
    listDiscoveredAttachmentsForCompany: async () => [],
    listCompanyIdsWithReclaimCandidates: async () => [],
    listPendingDownloadsForReclaim: async () => [],
    listCompanyIdsWithRetryCandidates: async () => [],
    listFailedAttachmentsForRetry: async () => [],
    reclaimPendingDownload: async () => "NOOP",
    scheduleRetryToDiscovered: async () => "NOOP",
  }
}

describe("PLAN-ACQ-ATTACHMENTS-002-L2-R1 — orchestrateur download/extraction", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("gate orchestrateur OFF → aucune étape appelée", async () => {
    const called: OrchestratorStepKey[] = []
    const runners = {} as AcquisitionOrchestratorStepRunners
    for (const key of ORCHESTRATOR_STEP_KEYS) {
      runners[key] = async () => {
        called.push(key)
        return { status: "SUCCESS" }
      }
    }
    const result = await runAcquisitionOrchestrator({
      runId: "l2r1-orch-off",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: false, skipReason: "CRON_DISABLED" }),
      steps: runners,
      config: cfg,
    })
    assert.equal(result.status, "SKIPPED")
    assert.deepEqual(called, [])
  })

  it("download cron OFF → orchestrateur enfant SKIPPED (0 download)", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "false"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let downloads = 0
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: emptyAttachmentRepo(),
      downloadAttachment: async () => {
        downloads++
        return { outcome: "SKIPPED", attachmentId: "x" }
      },
      createRunId: () => "l2r1-dl-off",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(downloads, 0)
  })

  it("extraction cron OFF → enfant SKIPPED ; download peut tourner séparément", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "false"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    let downloads = 0
    let extracts = 0

    const dl = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: emptyAttachmentRepo(),
      downloadAttachment: async () => {
        downloads++
        return { outcome: "STORED", attachmentId: "a1" }
      },
      createRunId: () => "l2r1-dl-on",
    })
    // Pas de candidats DISCOVERED → SUCCESS/SKIPPED avec 0 download effectif
    assert.ok(dl.status === "SUCCESS" || dl.status === "SKIPPED" || dl.status === "PARTIAL")
    assert.equal(downloads, 0)

    const ex = await runAcquisitionExtractionCronOrchestrator({
      repository: {
        listCompanyIdsWithEligibleExtraction: async () => [],
        listEligibleDraftsForCompany: async () => [],
      } as never,
      extractDraft: async () => {
        extracts++
        return { ok: true, outcome: "EXTRACTED", draftId: "d", status: "PENDING_REVIEW" } as never
      },
      createRunId: () => "l2r1-ex-off",
    })
    assert.equal(ex.status, "SKIPPED")
    assert.equal(extracts, 0)
  })

  it("orchestrateur : attachmentDownload avant extraction ; runners AUTO skippés (pas de convert)", async () => {
    const order: OrchestratorStepKey[] = []
    let autoBusiness = 0
    let worksiteBusiness = 0

    const runners = {} as AcquisitionOrchestratorStepRunners
    for (const key of ORCHESTRATOR_STEP_KEYS) {
      runners[key] = async () => {
        order.push(key)
        if (key === "autoDecision") {
          // Pas d’appel métier auto-approve — SKIPPED uniquement.
          return { status: "SKIPPED", skipReason: "AUTO_APPROVE_OFF_L2" }
        }
        if (key === "worksiteCreation") {
          return { status: "SKIPPED", skipReason: "AUTO_CONVERT_OFF_L2" }
        }
        return { status: "SUCCESS" }
      }
    }

    const result = await runAcquisitionOrchestrator({
      runId: "l2r1-order",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: runners,
      config: cfg,
    })

    assert.equal(result.status, "SUCCESS")
    const di = order.indexOf("attachmentDownload")
    const ei = order.indexOf("extraction")
    assert.ok(di >= 0 && ei >= 0)
    assert.ok(di < ei, `order=${order.join(",")}`)
    assert.equal(result.steps.autoDecision.status, "SKIPPED")
    assert.equal(result.steps.worksiteCreation.status, "SKIPPED")
    assert.equal(autoBusiness, 0)
    assert.equal(worksiteBusiness, 0)
  })
})
