/**
 * PLAN-ACQ-DETECTION-001 — Tests policy + runtime Detection + gardes extraction.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  classifyConsultationDetection,
  gateAutoDecisionByDetectionProof,
  isExtractionAuthorizedDetectionClassification,
} from "@/lib/acquisition/capabilities/consultation-detection.policy"
import { DefaultConsultationDetectionCapability } from "@/lib/acquisition/capabilities/consultation-detection.capability"
import type { ConsultationDetectionRepository } from "@/lib/acquisition/capabilities/consultation-detection.repository"
import type { DetectionLoadSnapshot } from "@/lib/acquisition/capabilities/consultation-detection.repository"
import {
  resolveExtractionRetryableForError,
  runDraftExtraction,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import type {
  DraftExtractionRow,
  MessageContentLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"

function baseSnapshot(
  overrides: Partial<DetectionLoadSnapshot> = {}
): DetectionLoadSnapshot {
  return {
    draftId: "d1",
    companyId: "co1",
    acquisitionMessageId: "m1",
    draftStatus: "PENDING_EXTRACTION",
    draftVersion: 1,
    detectionClassification: null,
    detectionContentHash: null,
    detectionCompletedAt: null,
    subject: "Consultation chantier Alpha",
    senderEmail: "carlene@lauralu.fr",
    senderDomain: "lauralu.fr",
    resolvedPartnerId: "partner-1",
    partnerActive: true,
    partnerCode: "lauralu",
    partnerPipeline: "consultations",
    normalizedText:
      "Bonjour, consultation pour travaux sur le chantier Alpha, semaine 12, intervention montage.",
    contentHash: "hash-a",
    attachments: [],
    ...overrides,
  }
}

describe("PLAN-ACQ-DETECTION-001 policy", () => {
  it("1. vraie consultation → CONSULTATION", () => {
    const r = classifyConsultationDetection({
      subject: "Dossier de consultation",
      normalizedText:
        "Appel d'offres et dossier de consultation pour la référence AFF-12. Demande de consultation formalisée.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "CONSULTATION")
    assert.equal(r.eligible, true)
  })

  it("2. intervention contextualisée → CONSULTATION_UPDATE", () => {
    const r = classifyConsultationDetection({
      subject: "Intervention site Lyon",
      normalizedText:
        "Merci de prévoir une intervention travaux sur le chantier Lyon semaine 14 montage démontage.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "CONSULTATION_UPDATE")
    assert.equal(r.eligible, true)
  })

  it("3. cancellation → CANCELLATION extractible", () => {
    const r = classifyConsultationDetection({
      subject: "Annulation consultation",
      normalizedText:
        "Nous annulons la consultation pour le chantier Alpha, merci de ne plus donner suite.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "CANCELLATION")
    assert.equal(isExtractionAuthorizedDetectionClassification(r.classification), true)
  })

  it("4. facture → NON_CONSULTATION", () => {
    const r = classifyConsultationDetection({
      subject: "Facture F-2026-01",
      normalizedText: "Veuillez trouver ci-joint la facture pour règlement.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [{ filename: "facture.pdf", mimeType: "application/pdf", category: "DOCUMENT" }],
    })
    assert.equal(r.classification, "NON_CONSULTATION")
  })

  it("5. paiement/règlement → NON_CONSULTATION", () => {
    const r = classifyConsultationDetection({
      subject: "Confirmation de paiement",
      normalizedText: "Le règlement a bien été effectué sur votre compte.",
      senderEmail: "a@x.fr",
      senderDomain: "x.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "NON_CONSULTATION")
  })

  it("6. relance comptable → NON_CONSULTATION", () => {
    const r = classifyConsultationDetection({
      subject: "Relance comptable",
      normalizedText: "Relance comptable concernant la facture impayée.",
      senderEmail: "a@x.fr",
      senderDomain: "x.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "NON_CONSULTATION")
  })

  it("7. auto-reply sans demande métier → NON_CONSULTATION", () => {
    const r = classifyConsultationDetection({
      subject: "Out of office",
      normalizedText: "Réponse automatique : je suis absent du bureau jusqu'au 20.",
      senderEmail: "a@x.fr",
      senderDomain: "x.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "NON_CONSULTATION")
  })

  it('8. "bon de commande" ambigu → AMBIGUOUS', () => {
    const r = classifyConsultationDetection({
      subject: "Bon de commande",
      normalizedText: "Voici le bon de commande.",
      senderEmail: "a@x.fr",
      senderDomain: "x.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "AMBIGUOUS")
  })

  it("9. PDF/PLAN seul → ne prouve pas consultation", () => {
    const r = classifyConsultationDetection({
      subject: "PJ",
      normalizedText: "Voir pièce jointe.",
      senderEmail: "a@x.fr",
      senderDomain: "x.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [
        { filename: "plan.pdf", mimeType: "application/pdf", category: "PLAN" },
      ],
    })
    assert.equal(r.classification, "AMBIGUOUS")
    assert.ok(r.reasons.includes("PLAN_OR_PDF_NOT_PROOF") || r.reasons.includes("INSUFFICIENT_EVIDENCE"))
  })
  it("R1.1 active + pipeline consultations → peut être positif", () => {
    const r = classifyConsultationDetection({
      subject: "Dossier de consultation",
      normalizedText:
        "Appel d'offres et dossier de consultation pour la référence AFF-12. Demande de consultation formalisée.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "CONSULTATION")
    assert.equal(r.eligible, true)
  })

  it("R1.2 active + autre pipeline → fail-closed AMBIGUOUS", () => {
    const r = classifyConsultationDetection({
      subject: "Dossier de consultation",
      normalizedText:
        "Appel d'offres et dossier de consultation pour la référence AFF-12. Demande de consultation formalisée.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: true,
      partnerPipeline: "bookings",
      attachments: [],
    })
    assert.equal(r.classification, "AMBIGUOUS")
    assert.equal(r.eligible, false)
    assert.ok(r.reasons.includes("PARTNER_PIPELINE_NOT_CONSULTATIONS"))
  })

  it("R1.3 inactive + consultations → fail-closed", () => {
    const r = classifyConsultationDetection({
      subject: "Dossier de consultation",
      normalizedText:
        "Appel d'offres et dossier de consultation pour la référence AFF-12. Demande de consultation formalisée.",
      senderEmail: "a@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "p1",
      partnerActive: false,
      partnerPipeline: "consultations",
      attachments: [],
    })
    assert.equal(r.classification, "AMBIGUOUS")
    assert.equal(r.eligible, false)
    assert.ok(r.reasons.includes("PARTNER_INACTIVE"))
  })
})

describe("PLAN-ACQ-DETECTION-001 capability persist", () => {
  it("11. re-detection sur hash B → nouvelle preuve B", async () => {
    let persistedHash: string | null = null
    let version = 1
    const snapshot = baseSnapshot({ contentHash: "hash-b", draftVersion: version })
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => ({ ...snapshot, draftVersion: version }),
      persistDetectionProof: async (input) => {
        persistedHash = input.expectedContentHash
        version += 1
        return "PERSISTED"
      },
    }
    const cap = new DefaultConsultationDetectionCapability({ repository: repo })
    const result = await cap.detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(result.persistOutcome, "PERSISTED")
    assert.equal(persistedHash, "hash-b")
    assert.equal(result.contentHash, "hash-b")
  })

  it("20. contenu modifié pendant Detection → STALE_CONTENT", async () => {
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => baseSnapshot({ contentHash: "hash-a" }),
      persistDetectionProof: async () => "STALE_CONTENT",
    }
    const cap = new DefaultConsultationDetectionCapability({ repository: repo })
    const result = await cap.detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(result.persistOutcome, "STALE_CONTENT")
    assert.equal(result.classification, null)
    assert.equal(result.eligible, false)
  })

  it("R1.8 STATE_CHANGED → aucune preuve écrite côté capability", async () => {
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => baseSnapshot(),
      persistDetectionProof: async () => "STATE_CHANGED",
    }
    const cap = new DefaultConsultationDetectionCapability({ repository: repo })
    const result = await cap.detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(result.persistOutcome, "STATE_CHANGED")
    assert.equal(result.classification, null)
    assert.equal(result.eligible, false)
  })

  it("tenant isolation : companyId A ne charge pas draft B", async () => {
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async (input) => {
        if (input.companyId !== "co-a") return null
        return baseSnapshot({ companyId: "co-a" })
      },
      persistDetectionProof: async () => "PERSISTED",
    }
    const cap = new DefaultConsultationDetectionCapability({ repository: repo })
    const other = await cap.detectConsultation({
      companyId: "co-b",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(other.persistOutcome, "NO_DRAFT")
  })
})

describe("PLAN-ACQ-DETECTION-001 retry matrix", () => {
  it("16. PROVIDER_INVALID_OUTPUT → false", () => {
    assert.equal(resolveExtractionRetryableForError("PROVIDER_INVALID_OUTPUT"), false)
  })
  it("17. timeout retryable provider → true/false exact", () => {
    assert.equal(resolveExtractionRetryableForError("PROVIDER_TIMEOUT", true), true)
    assert.equal(resolveExtractionRetryableForError("PROVIDER_TIMEOUT", false), false)
  })
  it("18. STALE_CONTENT → true (nécessite re-detection pour reselect)", () => {
    assert.equal(resolveExtractionRetryableForError("STALE_CONTENT"), true)
  })
  it("CONTENT_INSUFFICIENT / EMPTY / DATE → false", () => {
    assert.equal(resolveExtractionRetryableForError("CONTENT_INSUFFICIENT"), false)
    assert.equal(resolveExtractionRetryableForError("EMPTY_EXTRACTION"), false)
    assert.equal(resolveExtractionRetryableForError("DATE_RANGE_INVALID"), false)
  })
  it("R7 PROVIDER_INTERNAL_ERROR / INPUT_TOO_LARGE respectent providerRetryable", () => {
    assert.equal(resolveExtractionRetryableForError("PROVIDER_INTERNAL_ERROR", true), true)
    assert.equal(resolveExtractionRetryableForError("PROVIDER_INTERNAL_ERROR", false), false)
    assert.equal(resolveExtractionRetryableForError("PROVIDER_INPUT_TOO_LARGE", true), true)
    assert.equal(resolveExtractionRetryableForError("PROVIDER_INPUT_TOO_LARGE", false), false)
  })
})

describe("PLAN-ACQ-DETECTION-001 extraction AUTO guards", () => {
  function enableFlags() {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
  }

  function fakeRepo(opts: {
    detectionClassification?: string | null
    detectionContentHash?: string | null
    contentHash?: string
    status?: WorksiteImportDraftStatus
  }) {
    const contentHash = opts.contentHash ?? "hash-a"
    let draft: DraftExtractionRow = {
      id: "draft1",
      companyId: "co1",
      acquisitionMessageId: "msg1",
      status: opts.status ?? "PENDING_EXTRACTION",
      version: 0,
      extractionAttemptCount: 0,
      extractionStartedAt: null,
      contentHashAtExtraction: null,
      extractionSchemaVersion: null,
      detectionClassification:
        opts.detectionClassification === undefined
          ? "CONSULTATION"
          : opts.detectionClassification,
      detectionContentHash:
        opts.detectionContentHash === undefined ? contentHash : opts.detectionContentHash,
      extractionRetryable: null,
    }
    const content: MessageContentLite = {
      normalizedText: "Chantier : Tour Alpha\nContact: alice@example.com\nRéférence : REF-99",
      contentHash,
    }
    const persists: PersistExtractionInput[] = []
    let claimCount = 0
    return {
      persists,
      get claimCount() {
        return claimCount
      },
      get draft() {
        return draft
      },
      async findDraft() {
        return { ...draft }
      },
      async findContent() {
        return { ...content }
      },
      async findMessage() {
        return { id: "msg1", subject: "Consultation", receivedAt: new Date() }
      },
      async listAttachmentMetadata() {
        return []
      },
      async claimExtracting(input: { expectedVersion: number; now: Date }) {
        claimCount++
        draft = {
          ...draft,
          status: "EXTRACTING",
          version: draft.version + 1,
          extractionAttemptCount: draft.extractionAttemptCount + 1,
          extractionStartedAt: input.now,
          extractionRetryable: null,
        }
        return { ...draft }
      },
      async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
        persists.push(input)
        draft = { ...draft, status: input.status, version: draft.version + 1 }
        return "OK"
      },
      async markFailedWhileExtracting() {
        return "OK" as const
      },
    }
  }

  it("10. preuve hash A + contenu hash B → extraction AUTO bloquée", async () => {
    enableFlags()
    const repo = fakeRepo({
      detectionClassification: "CONSULTATION",
      detectionContentHash: "hash-a",
      contentHash: "hash-b",
    })
    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never, provider: { extract: async () => {
        throw new Error("should not run")
      } } as ExtractionProviderPort }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DETECTION_NOT_AUTHORIZED")
    assert.equal(repo.claimCount, 0)
  })

  it("12. draft historique detection NULL → extraction AUTO bloquée", async () => {
    enableFlags()
    const repo = fakeRepo({
      detectionClassification: null,
      detectionContentHash: null,
    })
    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DETECTION_REQUIRED")
    assert.equal(repo.claimCount, 0)
  })

  it("4b. NON_CONSULTATION → jamais claim AUTO", async () => {
    enableFlags()
    const repo = fakeRepo({ detectionClassification: "NON_CONSULTATION" })
    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DETECTION_NOT_AUTHORIZED")
    assert.equal(repo.claimCount, 0)
  })

  it("21. UI manual PENDING_REVIEW force:true reste fonctionnel sans preuve", async () => {
    enableFlags()
    const repo = fakeRepo({
      detectionClassification: null,
      detectionContentHash: null,
      status: "PENDING_REVIEW",
    })
    // force path needs contentHashAtExtraction mismatch or force - status PENDING_REVIEW + force
    const draft = repo.draft
    ;(draft as { contentHashAtExtraction: string | null }).contentHashAtExtraction = "old"
    const result = await runDraftExtraction(
      {
        draftId: "draft1",
        force: true,
        actor: { userId: "u1", role: "ADMIN", companyId: "co1" },
      },
      { repository: repo as never }
    )
    // May succeed or fail on provider - but must be allowed past detection (claim attempted)
    assert.ok(repo.claimCount >= 1 || result.ok === true || (result.ok === false && result.code !== "DETECTION_REQUIRED"))
  })

  it("22. UI manual ne contourne pas auto-conversion Detection", () => {
    const gated = gateAutoDecisionByDetectionProof({
      decision: {
        code: "AUTO_APPROVE_CONVERT",
        reasons: ["OK"],
        scores: {},
      },
      detectionClassification: "NON_CONSULTATION",
      detectionContentHash: "h1",
      contentHashAtExtraction: "h1",
      currentSourceContentHash: "h1",
    })
    assert.equal(gated.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(gated.reasons.includes("DETECTION_NOT_AUTHORIZED_FOR_AUTO_CONVERSION"))
  })

  it("PROVIDER_INVALID_OUTPUT persist extractionRetryable false", async () => {
    enableFlags()
    const repo = fakeRepo({})
    const provider: ExtractionProviderPort = {
      id: "test",
      extract: async () => {
        throw new ExtractionProviderError("PROVIDER_INVALID_OUTPUT", "bad", false)
      },
    }
    // Override markFailed to capture retryable
    let capturedRetryable: boolean | undefined
    const repo2 = {
      ...repo,
      async markFailedWhileExtracting(input: { extractionRetryable?: boolean }) {
        capturedRetryable = input.extractionRetryable
        return "OK" as const
      },
    }
    await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo2 as never, provider }
    )
    assert.equal(capturedRetryable, false)
  })

  it("timeout retryable persist extractionRetryable true", async () => {
    enableFlags()
    let capturedRetryable: boolean | undefined
    const repo = {
      ...fakeRepo({}),
      async markFailedWhileExtracting(input: { extractionRetryable?: boolean }) {
        capturedRetryable = input.extractionRetryable
        return "OK" as const
      },
    }
    const provider: ExtractionProviderPort = {
      id: "test",
      extract: async () => {
        throw new ExtractionProviderError("PROVIDER_TIMEOUT", "timeout", true)
      },
    }
    await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(capturedRetryable, true)
  })
})

describe("PLAN-ACQ-DETECTION-001-R1 fencing worker", () => {
  it("R1.4 ensureOwnership sans fence → FAILED LEASE_STOLEN, aucune écriture", async () => {
    const { runConsultationDetectionWorker } = await import(
      "@/lib/acquisition/detection/consultation-detection.worker"
    )
    let detectCalls = 0
    const result = await runConsultationDetectionWorker({
      ensureOwnership: async () => "OWNED",
      // fence absente volontairement
      selection: {
        listCompanyIdsNeedingDetection: async () => ["co1"],
        listCandidatesForCompany: async () => [
          {
            draftId: "d1",
            companyId: "co1",
            acquisitionMessageId: "m1",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      detect: async () => {
        detectCalls += 1
        return {
          eligible: true,
          classification: "CONSULTATION",
          draftId: "d1",
          resolvedPartnerId: "p1",
          partnerCode: "lauralu",
          persistOutcome: "PERSISTED",
          contentHash: "hash-a",
          reasons: [],
        }
      },
    })
    assert.equal(result.status, "FAILED")
    assert.equal(result.skipReason, "LEASE_STOLEN")
    assert.equal(result.errorCode, "LEASE_STOLEN")
    assert.equal(detectCalls, 0)
    assert.equal(result.stats.detected, 0)
  })

  it("R1.5 fence NOT_OWNED dans TX → LEASE_NOT_OWNED, aucune preuve", async () => {
    let wrote = false
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => baseSnapshot(),
      persistDetectionProof: async (input) => {
        if (input.transactionalOwnershipFence) {
          // Simulate repository TX fence path: if fence says NOT_OWNED, no write
          const owned = await input.transactionalOwnershipFence.assertOwnedAndLock(
            {} as never
          )
          if (owned !== "OWNED") return "LEASE_NOT_OWNED"
        }
        wrote = true
        return "PERSISTED"
      },
    }
    const fence = {
      assertOwnedAndLock: async () => "NOT_OWNED" as const,
    }
    const cap = new DefaultConsultationDetectionCapability({
      repository: repo,
      transactionalOwnershipFence: fence,
    })
    const result = await cap.detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(result.persistOutcome, "LEASE_NOT_OWNED")
    assert.equal(wrote, false)
    assert.equal(result.classification, null)

    const { runConsultationDetectionWorker } = await import(
      "@/lib/acquisition/detection/consultation-detection.worker"
    )
    const worker = await runConsultationDetectionWorker({
      ensureOwnership: async () => "OWNED",
      transactionalOwnershipFence: fence,
      selection: {
        listCompanyIdsNeedingDetection: async () => ["co1"],
        listCandidatesForCompany: async () => [
          {
            draftId: "d1",
            companyId: "co1",
            acquisitionMessageId: "m1",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      detect: async () =>
        cap.detectConsultation({
          companyId: "co1",
          acquisitionMessageId: "m1",
          subject: null,
          senderEmail: null,
          senderDomain: null,
        }),
    })
    assert.equal(worker.status, "FAILED")
    assert.equal(worker.skipReason, "LEASE_STOLEN")
    assert.equal(worker.stats.detected, 0)
  })

  it("R1.6 fence OWNED dans TX → preuve persistée", async () => {
    let wrote = false
    let fenceCalled = false
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => baseSnapshot(),
      persistDetectionProof: async (input) => {
        if (input.transactionalOwnershipFence) {
          fenceCalled = true
          const owned = await input.transactionalOwnershipFence.assertOwnedAndLock(
            {} as never
          )
          if (owned !== "OWNED") return "LEASE_NOT_OWNED"
        }
        wrote = true
        return "PERSISTED"
      },
    }
    const fence = {
      assertOwnedAndLock: async () => "OWNED" as const,
    }
    const cap = new DefaultConsultationDetectionCapability({
      repository: repo,
      transactionalOwnershipFence: fence,
    })
    const result = await cap.detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(fenceCalled, true)
    assert.equal(wrote, true)
    assert.equal(result.persistOutcome, "PERSISTED")
    assert.ok(result.classification != null)
  })

  it("R1.7 STALE_CONTENT gagne même avec fence OWNED", async () => {
    const repo: ConsultationDetectionRepository = {
      loadDetectionSnapshot: async () => baseSnapshot(),
      persistDetectionProof: async (input) => {
        if (input.transactionalOwnershipFence) {
          const owned = await input.transactionalOwnershipFence.assertOwnedAndLock(
            {} as never
          )
          if (owned !== "OWNED") return "LEASE_NOT_OWNED"
        }
        return "STALE_CONTENT"
      },
    }
    const result = await new DefaultConsultationDetectionCapability({
      repository: repo,
      transactionalOwnershipFence: {
        assertOwnedAndLock: async () => "OWNED",
      },
    }).detectConsultation({
      companyId: "co1",
      acquisitionMessageId: "m1",
      subject: null,
      senderEmail: null,
      senderDomain: null,
    })
    assert.equal(result.persistOutcome, "STALE_CONTENT")
    assert.equal(result.classification, null)
  })
})

describe("PLAN-ACQ-DETECTION-001 FAILED selector retryable", () => {
  it("13. FAILED + extractionRetryable NULL → non sélectionné", async () => {
    const { isFailedDraftRetrySelectable } = await import(
      "@/lib/acquisition/extraction/extraction-cron.selection.repository"
    )
    assert.equal(isFailedDraftRetrySelectable({ extractionRetryable: null }), false)
  })
  it("14. FAILED + extractionRetryable false → non sélectionné", async () => {
    const { isFailedDraftRetrySelectable } = await import(
      "@/lib/acquisition/extraction/extraction-cron.selection.repository"
    )
    assert.equal(isFailedDraftRetrySelectable({ extractionRetryable: false }), false)
  })
  it("15. FAILED + extractionRetryable true → sélectionnable (sous autres gardes)", async () => {
    const { isFailedDraftRetrySelectable } = await import(
      "@/lib/acquisition/extraction/extraction-cron.selection.repository"
    )
    assert.equal(isFailedDraftRetrySelectable({ extractionRetryable: true }), true)
  })
})

describe("PLAN-ACQ-DETECTION-001 conversion UI signals", () => {
  it("23-25. PLANNED + zéro Assignment = « À affecter » (politique UI)", async () => {
    // Contrats UI existants : PLANNED && assignments===0 → badge « À affecter »
    // Conversion crée status PLANNED sans Assignment — vérifié par code source.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const conversion = readFileSync(
      join(process.cwd(), "src/lib/acquisition/conversion/conversion.service.ts"),
      "utf8"
    )
    assert.match(conversion, /status:\s*"PLANNED"/)
    assert.equal(conversion.includes("assignment.create"), false)
    const ui = readFileSync(
      join(process.cwd(), "src/components/chantiers/ChantiersView.tsx"),
      "utf8"
    )
    assert.match(ui, /À affecter/)
    assert.match(ui, /status === "PLANNED".*_count\.assignments === 0/s)
  })
})
