/**
 * PLAN-ACQ-ATTACHMENTS-002-L2 — Flux local fake :
 * DISCOVERED → claim → Gmail fake → validate → SHA-256 → storage fake → STORED
 * → bytes → PDF texte → excerpts → re-extract séparée → PENDING_REVIEW
 * Aucun réseau, Cloudinary, Anthropic, Worksite, auto-hook.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import type { AcquisitionAttachmentRepositoryPort } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import type { GmailAttachmentSourcePort } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"
import type {
  AttachmentFailureUpdate,
  AttachmentMessageContext,
  AttachmentRecord,
  MarkFailureResult,
  MarkStoredResult,
  StoredAttachmentUpdate,
} from "@/lib/acquisition/attachments/attachment.types"
import { buildMinimalTextPdf, buildMinimalEmptyPdf } from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  buildAttachmentTextExcerpts,
  appendAttachmentTextToBody,
} from "@/lib/acquisition/extraction/attachment-text-excerpts"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import type {
  DraftExtractionRow,
  MessageContentLite,
  MessageLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
  MarkFailedOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { WorksiteImportDraftStatus } from "@prisma/client"

const BODY = [
  "Consultation structure.",
  "Donneur d'ordre : CONTRACTOR INDUSTRIE",
  "Chantier : SITE DEMO 77",
  "Adresse : 12 Rue des Essais, 75011 Parisville",
  "Période : du 12/11/2026 au 14/11/2026",
  "Travaux : montage 10x20 H4.",
].join("\n")

const PDF_TEXT = "Plan montage : SITE DEMO 77 — hauteur 4m nacelle"
const PDF_BUFFER = buildMinimalTextPdf(PDF_TEXT)

function field(value: unknown, confidence: number, quote: string) {
  return {
    value,
    confidence,
    evidence: { source: "BODY" as const, quote },
  }
}

function strongProviderResult(enrichedHasPdf: boolean): Awaited<
  ReturnType<ExtractionProviderPort["extract"]>
> {
  return {
    fields: {
      worksiteName: field("SITE DEMO 77", 0.85, "SITE DEMO 77"),
      clientName: field("CONTRACTOR INDUSTRIE", 0.8, "CONTRACTOR INDUSTRIE"),
      address: field(
        "12 Rue des Essais, 75011 Parisville",
        0.8,
        "12 Rue des Essais, 75011 Parisville"
      ),
      postalCode: field("75011", 0.85, "75011"),
      city: field("Parisville", 0.85, "Parisville"),
      requestedStartDate: field("2026-11-12", 0.9, "12/11/2026"),
      requestedEndDate: field("2026-11-14", 0.9, "14/11/2026"),
      description: field(
        enrichedHasPdf
          ? "montage 10x20 H4. Plan montage hauteur 4m"
          : "montage 10x20 H4",
        0.75,
        "montage 10x20 H4"
      ),
    },
    warnings: [],
    providerMetadata: { providerId: "deterministic", model: "fake-l2" },
  }
}

type AttState = AttachmentRecord & { category: string }

function createAttachmentHarness(opts?: {
  companyId?: string
  otherCompanyId?: string
}) {
  const companyId = opts?.companyId ?? "co-l2-a"
  const otherCompanyId = opts?.otherCompanyId ?? "co-l2-b"
  const messageId = "msg-l2-1"
  const attachmentId = "att-l2-pdf"
  const contentHash = "hash-l2-body"

  let attachment: AttState = {
    id: attachmentId,
    companyId,
    acquisitionMessageId: messageId,
    externalAttachmentId: "ext-att-redacted",
    filename: "plan-montage.pdf",
    mimeType: "application/pdf",
    sizeBytes: PDF_BUFFER.length,
    status: "DISCOVERED",
    sha256: null,
    storageUrl: null,
    storagePublicId: null,
    storedAt: null,
    lastErrorCode: null,
    downloadClaimedAt: null,
    downloadRetryCount: 0,
    downloadNextRetryAt: null,
    category: "PLAN",
  }

  const message: AttachmentMessageContext = {
    id: messageId,
    companyId,
    externalMessageId: "ext-msg-redacted",
    sourceMailboxKey: "conn-l2-mailbox",
  }

  const stores: Array<{ mimeType: string; pathHint: string }> = []
  const destroys: string[] = []
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
  let worksiteCreates = 0
  let conversionCalls = 0
  let autoHooks = 0
  let extractCalls = 0
  let gmailFetches = 0

  const repository: AcquisitionAttachmentRepositoryPort = {
    async findAttachmentWithMessage(cid, aid) {
      if (cid !== companyId || aid !== attachmentId) return null
      if (message.companyId !== cid) return null
      return { attachment: { ...attachment }, message: { ...message } }
    },
    async claimForDownload(cid, aid) {
      if (cid !== companyId || aid !== attachmentId) return { status: "NOT_FOUND" }
      if (attachment.status === "STORED" && attachment.sha256 && attachment.storagePublicId) {
        return { status: "ALREADY_STORED", attachment: { ...attachment } }
      }
      if (attachment.status === "PENDING_DOWNLOAD") return { status: "ALREADY_IN_PROGRESS" }
      if (attachment.status === "FAILED" || attachment.status === "REJECTED") {
        return { status: "NOT_RETRYABLE", attachment: { ...attachment } }
      }
      if (attachment.status !== "DISCOVERED") return { status: "NOT_FOUND" }
      attachment = {
        ...attachment,
        status: "PENDING_DOWNLOAD",
        downloadClaimedAt: new Date(),
      }
      return { status: "CLAIMED", attachment: { ...attachment } }
    },
    async markStored(cid, aid, update: StoredAttachmentUpdate): Promise<MarkStoredResult> {
      if (cid !== companyId || aid !== attachmentId) return { status: "FAILED" }
      if (attachment.status !== "PENDING_DOWNLOAD") {
        if (attachment.status === "STORED" && attachment.sha256) {
          return { status: "ALREADY_STORED", attachment: { ...attachment } }
        }
        return { status: "FAILED" }
      }
      attachment = {
        ...attachment,
        status: "STORED",
        sha256: update.sha256,
        storageUrl: update.storageUrl,
        storagePublicId: update.storagePublicId,
        storedAt: update.storedAt,
        sizeBytes: update.sizeBytes,
        mimeType: update.mimeType,
        lastErrorCode: null,
        downloadClaimedAt: null,
        downloadNextRetryAt: null,
      }
      return { status: "STORED", attachment: { ...attachment } }
    },
    async markFailure(cid, aid, update: AttachmentFailureUpdate): Promise<MarkFailureResult> {
      if (cid !== companyId || aid !== attachmentId) return { outcome: "NOT_FOUND" }
      attachment = {
        ...attachment,
        status: update.status,
        lastErrorCode: update.errorCode,
        downloadClaimedAt: null,
        downloadNextRetryAt: update.nextRetryAt ?? null,
        downloadRetryCount: attachment.downloadRetryCount + (update.status === "FAILED" ? 1 : 0),
      }
      return update.status === "REJECTED"
        ? { outcome: "MARKED_REJECTED", attachment: { ...attachment } }
        : { outcome: "MARKED_FAILED", attachment: { ...attachment } }
    },
    async listCompanyIdsWithDiscoveredAttachments() {
      return []
    },
    async listDiscoveredAttachmentsForCompany() {
      return []
    },
    async listCompanyIdsWithReclaimCandidates() {
      return []
    },
    async listPendingDownloadsForReclaim() {
      return []
    },
    async listCompanyIdsWithRetryCandidates() {
      return []
    },
    async listFailedAttachmentsForRetry() {
      return []
    },
    async reclaimPendingDownload() {
      return "NOOP"
    },
    async scheduleRetryToDiscovered() {
      return "NOOP"
    },
  }

  const gmailSource: GmailAttachmentSourcePort = {
    async fetchAttachment(input) {
      gmailFetches++
      assert.equal(input.companyId, companyId)
      assert.equal(input.connectionId, message.sourceMailboxKey)
      return { data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }
    },
  }

  const storage: AttachmentStoragePort = {
    async store(input) {
      assert.equal(input.companyId, companyId)
      assert.match(input.generatedFilename, new RegExp(`^${attachmentId}-`))
      const pathHint = `planificator/${input.companyId}/acquisition/${input.acquisitionMessageId}/${input.attachmentId}`
      stores.push({ mimeType: input.mimeType, pathHint })
      return {
        created: true,
        storageUrl: "https://private.test/authenticated/raw/never-log-me",
        storagePublicId: `${pathHint}/obj`,
      }
    },
    async destroy(input) {
      destroys.push(input.storagePublicId)
    },
  }

  let draft: DraftExtractionRow & {
    proposedWorksiteName?: string | null
    proposedClientName?: string | null
    proposedAddress?: string | null
    proposedPostalCode?: string | null
    proposedCity?: string | null
    proposedDescription?: string | null
    proposedStartDate?: Date | null
    proposedEndDate?: Date | null
    extractedData?: Record<string, unknown> | null
  } = {
    id: "draft-l2-1",
    companyId,
    acquisitionMessageId: messageId,
    status: "PENDING_EXTRACTION" as WorksiteImportDraftStatus,
    version: 1,
    extractionAttemptCount: 0,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
  }

  const content: MessageContentLite = {
    normalizedText: BODY,
    contentHash,
  }

  const messageLite: MessageLite = {
    id: messageId,
    subject: "Consultation SITE DEMO 77",
    receivedAt: new Date("2026-09-01T10:00:00.000Z"),
  }

  const persists: PersistExtractionInput[] = []
  const extractionRepo = {
    async findDraft(cid: string, draftId: string) {
      if (cid !== companyId || draftId !== draft.id) return null
      return { ...draft }
    },
    async findContent(cid: string, mid: string) {
      if (cid !== companyId || mid !== messageId) return null
      return { ...content }
    },
    async findMessage(cid: string, mid: string) {
      if (cid !== companyId || mid !== messageId) return null
      return { ...messageLite }
    },
    async listAttachmentMetadata() {
      return [
        {
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          category: attachment.category,
          sizeBytes: attachment.sizeBytes,
          status: attachment.status,
          storagePublicId: attachment.storagePublicId,
        },
      ]
    },
    async claimExtracting(input: {
      companyId: string
      draftId: string
      expectedVersion: number
      now: Date
    }) {
      if (input.companyId !== companyId || input.draftId !== draft.id) return null
      if (draft.version !== input.expectedVersion) return null
      draft = {
        ...draft,
        status: "EXTRACTING" as WorksiteImportDraftStatus,
        version: draft.version + 1,
        extractionAttemptCount: draft.extractionAttemptCount + 1,
        extractionStartedAt: input.now,
      }
      return { ...draft }
    },
    async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
      persists.push(input)
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED"
      if (content.contentHash !== input.expectedContentHash) return "STALE_CONTENT"
      draft = {
        ...draft,
        status: input.status as WorksiteImportDraftStatus,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        extractionSchemaVersion: "3",
        proposedWorksiteName: input.fields.worksiteName,
        proposedClientName: input.fields.clientName,
        proposedAddress: input.fields.address,
        proposedPostalCode: input.fields.postalCode,
        proposedCity: input.fields.city,
        proposedDescription: input.fields.description,
        proposedStartDate: input.fields.requestedStartDate
          ? new Date(`${input.fields.requestedStartDate}T00:00:00.000Z`)
          : null,
        proposedEndDate: input.fields.requestedEndDate
          ? new Date(`${input.fields.requestedEndDate}T00:00:00.000Z`)
          : null,
        extractedData: input.extractedData as Record<string, unknown>,
      }
      return "OK"
    },
    async markFailedWhileExtracting(input: {
      expectedVersion: number
      errorCode: string
    }): Promise<MarkFailedOutcome> {
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED"
      draft = {
        ...draft,
        status: "FAILED" as WorksiteImportDraftStatus,
        version: draft.version + 1,
      }
      return "OK"
    },
    async createWorksite() {
      worksiteCreates++
    },
    async convertDraft() {
      conversionCalls++
    },
  }

  return {
    companyId,
    otherCompanyId,
    attachmentId,
    get attachment() {
      return attachment
    },
    repository,
    gmailSource,
    storage,
    stores,
    destroys,
    logs,
    get gmailFetches() {
      return gmailFetches
    },
    get worksiteCreates() {
      return worksiteCreates
    },
    get conversionCalls() {
      return conversionCalls
    },
    get autoHooks() {
      return autoHooks
    },
    get extractCalls() {
      return extractCalls
    },
    bumpExtract() {
      extractCalls++
    },
    bumpAuto() {
      autoHooks++
    },
    extractionRepo,
    persists,
    get draft() {
      return draft
    },
    /** Prépare une PJ PLAN déjà STORED pour re-extract (sans repasser par download). */
    seedStoredPlan(opts?: { filename?: string; bytesHint?: number }) {
      attachment = {
        ...attachment,
        filename: opts?.filename ?? "plan-montage.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        status: "STORED",
        sha256: "a".repeat(64),
        storagePublicId: `planificator/${companyId}/acquisition/${messageId}/${attachmentId}/obj`,
        storageUrl: "https://private.test/authenticated/raw/seed",
        storedAt: new Date(),
        sizeBytes: opts?.bytesHint ?? 128,
      }
    },
    log: (event: string, payload?: Record<string, unknown>) => {
      logs.push({ event, payload })
    },
  }
}
describe("PLAN-ACQ-ATTACHMENTS-002-L2 — flux download → PDF → re-extract", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_AUTO_APPROVE_ENABLED
    delete process.env.ACQUISITION_AUTO_CONVERT_ENABLED
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("DISCOVERED → STORED → excerpts PDF → re-extract PENDING_REVIEW ; zéro Worksite", async () => {
    const h = createAttachmentHarness()

    const dl = await downloadAcquisitionAttachment(
      { companyId: h.companyId, attachmentId: h.attachmentId },
      {
        repository: h.repository,
        gmailSource: h.gmailSource,
        storage: h.storage,
        log: h.log,
      }
    )

    assert.equal(dl.outcome, "STORED")
    assert.equal(h.attachment.status, "STORED")
    assert.ok(h.attachment.sha256)
    assert.equal(
      h.attachment.sha256,
      createHash("sha256").update(PDF_BUFFER).digest("hex")
    )
    assert.equal(h.stores.length, 1)
    assert.match(h.stores[0]!.pathHint, /planificator\/co-l2-a\/acquisition\//)
    assert.equal(h.gmailFetches, 1)
    assert.equal(h.extractCalls, 0)
    assert.equal(h.worksiteCreates, 0)
    assert.equal(h.conversionCalls, 0)
    assert.equal(h.autoHooks, 0)

    const logBlob = JSON.stringify(h.logs)
    assert.equal(logBlob.includes("never-log-me"), false)
    assert.equal(logBlob.includes("https://private.test"), false)
    assert.equal(logBlob.includes("ext-att-redacted"), false)
    assert.equal(logBlob.includes(PDF_TEXT), false)

    // Idempotence second appel
    const dl2 = await downloadAcquisitionAttachment(
      { companyId: h.companyId, attachmentId: h.attachmentId },
      {
        repository: h.repository,
        gmailSource: h.gmailSource,
        storage: h.storage,
        log: h.log,
      }
    )
    assert.equal(dl2.outcome, "ALREADY_STORED")
    assert.equal(h.stores.length, 1)
    assert.equal(h.gmailFetches, 1)

    // Isolation tenant
    const cross = await downloadAcquisitionAttachment(
      { companyId: h.otherCompanyId, attachmentId: h.attachmentId },
      {
        repository: h.repository,
        gmailSource: h.gmailSource,
        storage: h.storage,
        log: h.log,
      }
    )
    assert.equal(cross.errorCode, "ATTACHMENT_NOT_FOUND")

    // Bytes + PDF (séparé du download)
    const excerpts = await buildAttachmentTextExcerpts([
      {
        filename: h.attachment.filename,
        mimeType: h.attachment.mimeType,
        category: "PLAN",
        bytes: PDF_BUFFER,
      },
    ])
    assert.equal(excerpts.outcomes[0]?.status, "PDF_TEXT_EXTRACTED")
    assert.ok((excerpts.excerpts[0]?.text ?? "").includes("SITE DEMO 77"))

    const provider: ExtractionProviderPort = {
      async extract(input) {
        h.bumpExtract()
        const hasPdf = (input.attachmentTextExcerpts?.length ?? 0) > 0
        assert.ok(hasPdf)
        assert.match(input.normalizedText, /SITE DEMO 77/)
        return strongProviderResult(true)
      },
    }

    const result = await runDraftExtraction(
      {
        actor: { userId: "u1", role: "ADMIN", companyId: h.companyId },
        draftId: "draft-l2-1",
      },
      {
        repository: h.extractionRepo as never,
        provider,
        loadAttachmentBytes: async (att) => {
          assert.equal(att.status, "STORED")
          assert.ok(att.storagePublicId)
          return PDF_BUFFER
        },
        runAutoDecisionAfterExtraction: async () => {
          h.bumpAuto()
          throw new Error("AUTO_FORBIDDEN_L2")
        },
      }
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.status, "PENDING_REVIEW")
      assert.equal(result.outcome, "EXTRACTED")
    }
    assert.equal(h.extractCalls, 1)
    assert.equal(h.autoHooks, 0)
    assert.equal(h.worksiteCreates, 0)
    assert.equal(h.conversionCalls, 0)
    assert.equal(h.draft.proposedWorksiteName, "SITE DEMO 77")
  })

  it("téléchargement seul ne déclenche pas l’extraction", async () => {
    const h = createAttachmentHarness()
    let extractInvoked = false
    const provider: ExtractionProviderPort = {
      async extract() {
        extractInvoked = true
        throw new Error("SHOULD_NOT_RUN")
      },
    }
    await downloadAcquisitionAttachment(
      { companyId: h.companyId, attachmentId: h.attachmentId },
      {
        repository: h.repository,
        gmailSource: h.gmailSource,
        storage: h.storage,
        log: h.log,
      }
    )
    assert.equal(extractInvoked, false)
    assert.equal(h.attachment.status, "STORED")
    // provider jamais branché au download — preuve de séparation
    void provider
  })

  it("PLAN PDF sans texte → REQUIRED_DOCUMENT_UNREADABLE via extraction.service réel", async () => {
    const h = createAttachmentHarness()
    h.seedStoredPlan()
    const emptyPdf = buildMinimalEmptyPdf()
    const readableAnnex = buildMinimalTextPdf("Annexe lisible hors plan")

    // Métadonnées : PLAN + DOCUMENT (le loader ne sert que les PDF ; annex texte via 2e PJ)
    const extractionRepo = {
      ...h.extractionRepo,
      async listAttachmentMetadata() {
        return [
          {
            filename: "plan-montage.pdf",
            mimeType: "application/pdf",
            category: "PLAN",
            sizeBytes: emptyPdf.length,
            status: "STORED",
            storagePublicId: "pid-plan",
          },
          {
            filename: "annexe.pdf",
            mimeType: "application/pdf",
            category: "DOCUMENT",
            sizeBytes: readableAnnex.length,
            status: "STORED",
            storagePublicId: "pid-annexe",
          },
        ]
      },
    }

    const provider: ExtractionProviderPort = {
      async extract() {
        h.bumpExtract()
        return strongProviderResult(true)
      },
    }

    const result = await runDraftExtraction(
      {
        actor: { userId: "u1", role: "ADMIN", companyId: h.companyId },
        draftId: "draft-l2-1",
      },
      {
        repository: extractionRepo as never,
        provider,
        loadAttachmentBytes: async (att) => {
          if (att.filename === "plan-montage.pdf") return emptyPdf
          if (att.filename === "annexe.pdf") return readableAnnex
          return null
        },
        runAutoDecisionAfterExtraction: async () => {
          h.bumpAuto()
          throw new Error("AUTO_FORBIDDEN_L2")
        },
      }
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.status, "PENDING_REVIEW")
    assert.equal(h.autoHooks, 0)
    assert.equal(h.worksiteCreates, 0)

    const last = h.persists.at(-1)
    assert.ok(last)
    const codes = last.warningData.map((w) => w.code)
    assert.ok(
      codes.includes("REQUIRED_DOCUMENT_UNREADABLE"),
      `warnings=${JSON.stringify(codes)}`
    )
    assert.ok(
      codes.includes("PDF_NO_TEXT_LAYER") || codes.includes("PDF_PARSE_FAILED"),
      `warnings=${JSON.stringify(codes)}`
    )
    // Autre PJ lisible n’efface pas le blocking PLAN
    assert.ok(codes.includes("REQUIRED_DOCUMENT_UNREADABLE"))
  })
})

describe("PLAN-ACQ-ATTACHMENTS-002-L2 — PDF texte borné", () => {
  it("PDF texte valide → extrait non vide", async () => {
    const buf = buildMinimalTextPdf("Chantier Alpha Surface 120m2")
    const r = await buildAttachmentTextExcerpts([
      { filename: "a.pdf", mimeType: "application/pdf", category: "PLAN", bytes: buf },
    ])
    assert.equal(r.outcomes[0]?.status, "PDF_TEXT_EXTRACTED")
    assert.match(r.excerpts[0]?.text ?? "", /Chantier Alpha/)
  })

  it("PDF vide → PDF_NO_TEXT_LAYER", async () => {
    const r = await buildAttachmentTextExcerpts([
      {
        filename: "empty.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        bytes: buildMinimalEmptyPdf(),
      },
    ])
    assert.ok(
      r.outcomes[0]?.status === "PDF_NO_TEXT_LAYER" ||
        r.outcomes[0]?.status === "PDF_PARSE_FAILED"
    )
    assert.equal(r.excerpts.length, 0)
  })

  it("PDF corrompu → PDF_PARSE_FAILED", async () => {
    const r = await buildAttachmentTextExcerpts([
      {
        filename: "bad.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        bytes: Buffer.from("%PDF-not-a-real-file"),
      },
    ])
    assert.equal(r.outcomes[0]?.status, "PDF_PARSE_FAILED")
  })

  it("bytes absents → PDF_PARSE_FAILED (DISCOVERED)", async () => {
    const r = await buildAttachmentTextExcerpts([
      {
        filename: "missing.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        bytes: null,
      },
    ])
    assert.equal(r.outcomes[0]?.status, "PDF_PARSE_FAILED")
  })

  it("append excerpts enrichit le corps", () => {
    const out = appendAttachmentTextToBody("corps", [
      { filename: "p.pdf", mimeType: "application/pdf", text: "extrait plan" },
    ])
    assert.match(out, /extrait plan/)
    assert.match(out, /PJ texte/)
  })
})
