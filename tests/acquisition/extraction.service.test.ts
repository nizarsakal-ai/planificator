process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import { runDraftExtraction, runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"
import type {
  AttachmentMetaRow,
  DraftExtractionRow,
  MessageContentLite,
  MessageLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
  MarkFailedOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"

function actor(role: "ADMIN" | "TEAM_LEADER" | "EMPLOYEE" = "ADMIN") {
  return { userId: "u1", role, companyId: "co1" as string | null }
}

type FakeDraft = DraftExtractionRow & {
  proposedWorksiteName?: string | null
  status: WorksiteImportDraftStatus
}

function createFakeRepo(seed?: {
  draft?: FakeDraft | null
  content?: MessageContentLite | null
  message?: MessageLite | null
  attachments?: AttachmentMetaRow[]
}) {
  let draft: FakeDraft | null =
    seed?.draft === undefined
      ? {
          id: "draft1",
          companyId: "co1",
          acquisitionMessageId: "msg1",
          status: "PENDING_EXTRACTION",
          version: 0,
          extractionAttemptCount: 0,
          extractionStartedAt: null,
          contentHashAtExtraction: null,
          extractionSchemaVersion: null,
          detectionClassification: "CONSULTATION",
          detectionContentHash: "hash-abc",
          extractionRetryable: null,
        }
      : seed.draft

  let content: MessageContentLite | null =
    seed?.content === undefined
      ? {
          normalizedText: "Chantier : Tour Alpha\nContact: alice@example.com\nRéférence : REF-99",
          contentHash: "hash-abc",
        }
      : seed.content

  const message: MessageLite | null =
    seed?.message === undefined
      ? { id: "msg1", subject: "Consultation Tour Alpha", receivedAt: new Date("2026-01-15T12:00:00.000Z") }
      : seed.message

  const attachments = seed?.attachments ?? []
  const persists: PersistExtractionInput[] = []
  let claimCount = 0
  let clientCreates = 0
  let worksiteCreates = 0

  const repository = {
    persists,
    get draft() {
      return draft
    },
    get claimCount() {
      return claimCount
    },
    get clientCreates() {
      return clientCreates
    },
    get worksiteCreates() {
      return worksiteCreates
    },
    async findDraft(companyId: string, draftId: string) {
      if (!draft || draft.companyId !== companyId || draft.id !== draftId) return null
      return { ...draft }
    },
    async findContent(companyId: string, acquisitionMessageId: string) {
      if (companyId !== "co1" || acquisitionMessageId !== "msg1") return null
      return content ? { ...content } : null
    },
    async findMessage(companyId: string, messageId: string) {
      if (companyId !== "co1" || messageId !== "msg1") return null
      return message
    },
    async listAttachmentMetadata() {
      return attachments
    },
    async claimExtracting(input: {
      companyId: string
      draftId: string
      expectedVersion: number
      now: Date
    }) {
      claimCount++
      if (!draft || draft.companyId !== input.companyId || draft.id !== input.draftId) return null
      if (draft.version !== input.expectedVersion) return null
      draft = {
        ...draft,
        status: "EXTRACTING",
        version: draft.version + 1,
        extractionAttemptCount: draft.extractionAttemptCount + 1,
        extractionStartedAt: input.now,
      }
      return { ...draft }
    },
    async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
      persists.push(input)
      if (!draft || draft.version !== input.expectedVersion) return "STATE_CHANGED"
      if (content && content.contentHash !== input.expectedContentHash) return "STALE_CONTENT"
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        extractionSchemaVersion: "2",
        proposedWorksiteName: input.fields.worksiteName,
        extractionRetryable:
          input.errorCode == null
            ? null
            : input.extractionRetryable === undefined
              ? false
              : input.extractionRetryable,
      }
      return "OK"
    },
    async markFailedWhileExtracting(input: {
      expectedVersion: number
      errorCode: string
      extractionRetryable?: boolean
    }): Promise<MarkFailedOutcome> {
      if (!draft || draft.version !== input.expectedVersion) return "STATE_CHANGED"
      draft = {
        ...draft,
        status: "FAILED",
        version: draft.version + 1,
        extractionRetryable:
          input.extractionRetryable === undefined ? false : input.extractionRetryable,
      }
      return "OK"
    },
    async createClient() {
      clientCreates++
    },
    async createWorksite() {
      worksiteCreates++
    },
  }

  return repository
}

describe("extraction.service R1", () => {
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    content: process.env.ACQUISITION_CONTENT_FETCH_ENABLED,
    extraction: process.env.ACQUISITION_EXTRACTION_ENABLED,
    provider: process.env.ACQUISITION_EXTRACTION_PROVIDER,
    maxAttempts: process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = envBackup.content
    process.env.ACQUISITION_EXTRACTION_ENABLED = envBackup.extraction
    process.env.ACQUISITION_EXTRACTION_PROVIDER = envBackup.provider
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = envBackup.maxAttempts
  })

  it("SYSTEM : globals OFF sans overrides → bloqué", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "false"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "false"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "false"

    const repo = createFakeRepo()
    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never }
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "ACQUISITION_DISABLED")
    assert.equal(repo.claimCount, 0)
  })

  it("SYSTEM : globals OFF + overrides locaux ON → gates franchies sans mutation env", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "false"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "false"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "false"

    const repo = createFakeRepo()
    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {
            worksiteName: { value: "Chantier test", confidence: 0.9 },
            clientReference: { value: "REF-TEST", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      {
        repository: repo as never,
        provider,
        isAcquisitionEnabled: () => true,
        isAcquisitionContentFetchEnabled: () => true,
        isAcquisitionExtractionEnabled: () => true,
      }
    )

    assert.equal(repo.claimCount, 1)
    assert.equal(providerCalls, 1)
    assert.equal(process.env.PLANIFICATOR_ACQUISITION_ENABLED, "false")
    assert.equal(process.env.ACQUISITION_CONTENT_FETCH_ENABLED, "false")
    assert.equal(process.env.ACQUISITION_EXTRACTION_ENABLED, "false")
    assert.notEqual(result.ok === false ? result.code : null, "ACQUISITION_DISABLED")
    assert.notEqual(result.ok === false ? result.code : null, "CONTENT_FETCH_DISABLED")
    assert.notEqual(result.ok === false ? result.code : null, "EXTRACTION_DISABLED")
  })

  it("refuse si flag extraction OFF", async () => {
    process.env.ACQUISITION_EXTRACTION_ENABLED = "false"
    const result = await runDraftExtraction({ actor: actor(), draftId: "draft1" })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "EXTRACTION_DISABLED")
  })

  it("refuse TEAM_LEADER", async () => {
    const result = await runDraftExtraction({ actor: actor("TEAM_LEADER"), draftId: "draft1" })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "EXTRACTION_FORBIDDEN")
  })

  it("provider=anthropic absent → aucun claim", async () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    const repo = createFakeRepo()
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "PROVIDER_NOT_CONFIGURED")
    assert.equal(repo.claimCount, 0)
    assert.equal(repo.draft?.status, "PENDING_EXTRACTION")
    assert.equal(repo.draft?.extractionAttemptCount, 0)
  })

  it("CONTENT_MISSING sans contenu 005A", async () => {
    const repo = createFakeRepo({ content: null })
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.outcome, "CONTENT_MISSING")
  })

  it("happy path → PENDING_REVIEW via deterministic", async () => {
    const repo = createFakeRepo()
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.outcome, "EXTRACTED")
      assert.equal(result.status, "PENDING_REVIEW")
    }
    assert.equal(repo.draft?.status, "PENDING_REVIEW")
    assert.equal(repo.clientCreates, 0)
    assert.equal(repo.worksiteCreates, 0)
  })

  it("UI_MANUAL : AUTO jamais appelé même flags AUTO ON", async () => {
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
    const repo = createFakeRepo()
    let autoCalls = 0
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.outcome, "EXTRACTED")
      assert.equal(result.status, "PENDING_REVIEW")
    }
    assert.equal(repo.draft?.status, "PENDING_REVIEW")
    assert.equal(autoCalls, 0)
    assert.equal(repo.persists.length, 1)
    assert.equal(repo.persists[0]?.status, "PENDING_REVIEW")
    delete process.env.ACQUISITION_AUTO_APPROVE_ENABLED
    delete process.env.ACQUISITION_AUTO_CONVERT_ENABLED
  })

  it("ALREADY_EXTRACTED si même hash + schema", async () => {
    const repo = createFakeRepo({
      draft: {
        id: "draft1",
        companyId: "co1",
        acquisitionMessageId: "msg1",
        status: "PENDING_REVIEW",
        version: 2,
        extractionAttemptCount: 1,
        extractionStartedAt: new Date(),
        contentHashAtExtraction: "hash-abc",
        detectionClassification: "CONSULTATION",
        detectionContentHash: "hash-abc",
        extractionRetryable: null,
        extractionSchemaVersion: "3",
      },
    })
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, "ALREADY_EXTRACTED")
    assert.equal(repo.persists.length, 0)
  })

  it("double claim → IN_PROGRESS", async () => {
    const repo2 = createFakeRepo()
    repo2.claimExtracting = async () => null
    const second = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo2 as never }
    )
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.outcome, "IN_PROGRESS")
  })

  it("persist perdu → STATE_CHANGED (pas FAILED trompeur)", async () => {
    const repo = createFakeRepo()
    repo.persistExtraction = async () => "STATE_CHANGED"
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "STATE_CHANGED")
      assert.equal(result.code, "EXTRACTION_STATE_CHANGED")
    }
  })

  it("markFailed perdu → STATE_CHANGED", async () => {
    const repo = createFakeRepo()
    repo.markFailedWhileExtracting = async () => "STATE_CHANGED"
    const slow: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "down", true)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider: slow }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.outcome, "STATE_CHANGED")
  })

  it("retryable=true + attempts restantes → RETRY_ALLOWED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "down", true)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "RETRY_ALLOWED")
      assert.equal(result.code, "PROVIDER_UNAVAILABLE")
      assert.equal(result.status, "FAILED")
      assert.equal(result.attemptCount, 1)
    }
  })

  it("retryable=true + plafond atteint → FAILED", async () => {
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = "2"
    const repo = createFakeRepo({
      draft: {
        id: "draft1",
        companyId: "co1",
        acquisitionMessageId: "msg1",
        status: "FAILED",
        version: 1,
        extractionAttemptCount: 1,
        extractionStartedAt: new Date(),
        contentHashAtExtraction: null,
        extractionSchemaVersion: null,
        detectionClassification: "CONSULTATION",
        detectionContentHash: "hash-abc",
        extractionRetryable: null,
      },
    })
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "down", true)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_UNAVAILABLE")
      assert.equal(result.attemptCount, 2)
      assert.equal(result.maxAttempts, 2)
    }
  })

  it("retryable=false + attempts restantes → FAILED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_DISABLED", "auth", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_DISABLED")
      assert.equal(result.attemptCount, 1)
    }
  })

  it("PROVIDER_INTERNAL_ERROR retryable=false → FAILED même si attempts restantes", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_INTERNAL_ERROR", "bug", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_INTERNAL_ERROR")
    }
    assert.equal(repo.draft?.extractionRetryable, false)
  })

  it("R7 gate CONTENT_INSUFFICIENT → extractionRetryable=false + FAILED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: { description: { value: "seul texte", confidence: 0.9 } },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "CONTENT_INSUFFICIENT")
      assert.equal(result.outcome, "FAILED")
    }
    assert.equal(repo.persists[0]?.extractionRetryable, false)
    assert.equal(repo.draft?.extractionRetryable, false)
  })

  it("R7 gate DATE_RANGE_INVALID → FAILED (pas RETRY_ALLOWED)", async () => {
    const repo = createFakeRepo({
      content: {
        normalizedText: "Chantier : Tour Alpha\nContact: alice@example.com\nRéférence : REF-99",
        contentHash: "hash-dat",
      },
    })
    // Align detection hash with content for AUTO not relevant (UI path)
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Tour Alpha", confidence: 0.9 },
            requestedStartDate: { value: "2026-08-10", confidence: 0.9 },
            requestedEndDate: { value: "2026-08-01", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "DATE_RANGE_INVALID")
      assert.equal(result.outcome, "FAILED")
    }
    assert.equal(repo.persists[0]?.extractionRetryable, false)
  })

  it("R7 PROVIDER_TIMEOUT retryable=true → RETRY_ALLOWED si attempts restantes", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_TIMEOUT", "slow", true)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "PROVIDER_TIMEOUT")
      assert.equal(result.outcome, "RETRY_ALLOWED")
    }
    assert.equal(repo.draft?.extractionRetryable, true)
  })

  it("R7 PROVIDER_TIMEOUT retryable=false → FAILED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_TIMEOUT", "abort", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_TIMEOUT")
    }
    assert.equal(repo.draft?.extractionRetryable, false)
  })

  it("R7 PROVIDER_UNAVAILABLE true/false respecté exactement", async () => {
    const repoTrue = createFakeRepo()
    const rTrue = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repoTrue as never,
        provider: {
          async extract() {
            throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "down", true)
          },
        },
      }
    )
    assert.equal(rTrue.ok, false)
    if (!rTrue.ok) assert.equal(rTrue.outcome, "RETRY_ALLOWED")
    assert.equal(repoTrue.draft?.extractionRetryable, true)

    const repoFalse = createFakeRepo()
    const rFalse = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repoFalse as never,
        provider: {
          async extract() {
            throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "down", false)
          },
        },
      }
    )
    assert.equal(rFalse.ok, false)
    if (!rFalse.ok) assert.equal(rFalse.outcome, "FAILED")
    assert.equal(repoFalse.draft?.extractionRetryable, false)
  })

  it("R7 PROVIDER_INTERNAL_ERROR retryable=true respecté → RETRY_ALLOWED", async () => {
    const repo = createFakeRepo()
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        provider: {
          async extract() {
            throw new ExtractionProviderError("PROVIDER_INTERNAL_ERROR", "transient", true)
          },
        },
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "RETRY_ALLOWED")
      assert.equal(result.code, "PROVIDER_INTERNAL_ERROR")
    }
    assert.equal(repo.draft?.extractionRetryable, true)
  })

  it("R7 PROVIDER_INPUT_TOO_LARGE retryable=false → terminal FAILED", async () => {
    const repo = createFakeRepo()
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        provider: {
          async extract() {
            throw new ExtractionProviderError("PROVIDER_INPUT_TOO_LARGE", "too big", false)
          },
        },
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_INPUT_TOO_LARGE")
    }
    assert.equal(repo.draft?.extractionRetryable, false)
  })

  it("R7 max attempts atteint → FAILED même si provider retryable=true", async () => {
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = "2"
    const repo = createFakeRepo({
      draft: {
        id: "draft1",
        companyId: "co1",
        acquisitionMessageId: "msg1",
        status: "FAILED",
        version: 1,
        extractionAttemptCount: 1,
        extractionStartedAt: new Date(),
        contentHashAtExtraction: null,
        extractionSchemaVersion: null,
        detectionClassification: "CONSULTATION",
        detectionContentHash: "hash-abc",
        extractionRetryable: true,
      },
    })
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        provider: {
          async extract() {
            throw new ExtractionProviderError("PROVIDER_TIMEOUT", "again", true)
          },
        },
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.attemptCount, 2)
      assert.equal(result.maxAttempts, 2)
    }
    assert.equal(repo.draft?.extractionRetryable, true)
  })

  it("PROVIDER_INPUT_TOO_LARGE → FAILED même si attempts restantes", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_INPUT_TOO_LARGE", "too big", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_INPUT_TOO_LARGE")
    }
  })

  it("PROVIDER_INVALID_OUTPUT (throw provider) → FAILED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_INVALID_OUTPUT", "bad", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_INVALID_OUTPUT")
    }
  })

  it("APIUserAbort mappé non retryable → FAILED", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        // Aligné sur le mapping adapter Abort → PROVIDER_TIMEOUT retryable=false
        throw new ExtractionProviderError("PROVIDER_TIMEOUT", "abort", false)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "PROVIDER_TIMEOUT")
    }
  })

  it("provider timeout → FAILED / RETRY_ALLOWED", async () => {
    const repo = createFakeRepo()
    const slow: ExtractionProviderPort = {
      async extract() {
        await new Promise((r) => setTimeout(r, 200))
        return { fields: {}, warnings: [], providerMetadata: { providerId: "slow" } }
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider: slow, timeoutMs: 20 }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "PROVIDER_TIMEOUT")
      assert.equal(result.outcome, "RETRY_ALLOWED")
    }
    assert.equal(repo.draft?.status, "FAILED")
  })

  it("dates inversées → FAILED DATE_RANGE_INVALID", async () => {
    const repo = createFakeRepo({
      content: { normalizedText: "Chantier : Beta", contentHash: "hash-dates" },
      message: { id: "msg1", subject: "x", receivedAt: new Date("2026-01-15T12:00:00.000Z") },
    })
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Chantier Beta", confidence: 0.35 },
            requestedStartDate: { value: "2026-09-20", confidence: 0.3 },
            requestedEndDate: { value: "2026-09-01", confidence: 0.3 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DATE_RANGE_INVALID")
  })

  it("max attempts issu de la config", async () => {
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = "2"
    const repo = createFakeRepo({
      draft: {
        id: "draft1",
        companyId: "co1",
        acquisitionMessageId: "msg1",
        status: "FAILED",
        version: 3,
        extractionAttemptCount: 2,
        extractionStartedAt: new Date(),
        contentHashAtExtraction: null,
        extractionSchemaVersion: null,
        detectionClassification: "CONSULTATION",
        detectionContentHash: "hash-abc",
        extractionRetryable: null,
      },
    })
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "MAX_ATTEMPTS_REACHED")
      assert.equal(result.maxAttempts, 2)
    }
  })

  it("STALE_CONTENT si hash change pendant extract (persist)", async () => {
    const repo = createFakeRepo()
    repo.persistExtraction = async () => "STALE_CONTENT"
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.outcome, "STALE_CONTENT")
  })

  it("cross-tenant → NOT_FOUND", async () => {
    const repo = createFakeRepo({
      draft: {
        id: "draft1",
        companyId: "other",
        acquisitionMessageId: "msg1",
        status: "PENDING_EXTRACTION",
        version: 0,
        extractionAttemptCount: 0,
        extractionStartedAt: null,
        contentHashAtExtraction: null,
        extractionSchemaVersion: null,
        detectionClassification: "CONSULTATION",
        detectionContentHash: "hash-abc",
        extractionRetryable: null,
      },
    })
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.outcome, "NOT_FOUND")
  })

  it("warning hostile provider jamais dans logs payload", async () => {
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const repo = createFakeRepo()
    const secret = "LEAK-SENSITIVE-WARNING-BODY"
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: { worksiteName: { value: "Site Z", confidence: 0.35 } },
          warnings: [{ code: "PROVIDER_PARTIAL_RESULT", message: secret }],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        provider,
        log: (event, payload) => logs.push({ event, payload }),
      }
    )
    const dumped = JSON.stringify(logs)
    assert.equal(dumped.includes(secret), false)
    const warningJson = JSON.stringify(repo.persists[0]?.warningData ?? [])
    assert.equal(warningJson.includes(secret), false)
  })


  it("FIX-002 — receivedAt depuis findMessage matérialise S36 sans année", async () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const repo = createFakeRepo({
      message: {
        id: "msg1",
        subject: "Consultation S36",
        receivedAt,
      },
      content: {
        normalizedText: "Chantier : Tour Alpha\nInstallation prévue S36",
        contentHash: "hash-abc",
      },
    })
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Tour Alpha", confidence: 0.7 },
            requestedWeekNumber: { value: 36, confidence: 0.8 },
          },
          warnings: [],
          providerMetadata: { providerId: "test", model: "t" },
        }
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, true)
    assert.equal(repo.persists.length, 1)
    const persisted = repo.persists[0]!
    assert.equal(persisted.fields.requestedWeekNumber, 36)
    assert.equal(persisted.fields.requestedWeekYear, 2026)
    assert.equal(persisted.fields.requestedStartDate, "2026-08-31")
    assert.equal(persisted.fields.requestedEndDate, "2026-09-06")
    assert.ok(!persisted.warningData.some((w) => w.code === "DATE_AMBIGUOUS"))
  })


  it("AUTO : PLAN PDF non stocké → ATTACHMENT_NOT_READY avant claim/provider", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "plan.pdf",
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1234,
          status: "DISCOVERED",
          storagePublicId: null,
        },
      ],
    })

    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {},
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never, provider }
    )

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "FAILED")
      assert.equal(result.code, "ATTACHMENT_NOT_READY")
    }

    assert.equal(repo.claimCount, 0)
    assert.equal(providerCalls, 0)
    assert.equal(repo.draft?.status, "PENDING_EXTRACTION")
    assert.equal(repo.draft?.extractionAttemptCount, 0)
  })


  it("AUTO : PLAN PDF STORED sans storagePublicId → ATTACHMENT_NOT_READY", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "plan.pdf",
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1234,
          status: "STORED",
          storagePublicId: null,
        },
      ],
    })

    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {},
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never, provider }
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "ATTACHMENT_NOT_READY")
    assert.equal(repo.claimCount, 0)
    assert.equal(providerCalls, 0)
    assert.equal(repo.draft?.extractionAttemptCount, 0)
  })


  it("AUTO : PLAN PDF STORED avec storagePublicId espaces → ATTACHMENT_NOT_READY", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "plan.pdf",
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1234,
          status: "STORED",
          storagePublicId: "   ",
        },
      ],
    })

    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {},
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      { repository: repo as never, provider }
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "ATTACHMENT_NOT_READY")
    assert.equal(repo.claimCount, 0)
    assert.equal(providerCalls, 0)
    assert.equal(repo.draft?.extractionAttemptCount, 0)
  })


  it("AUTO : PLAN PDF STORED avec storagePublicId → extraction autorisée", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "plan.pdf",
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1234,
          status: "STORED",
          storagePublicId: "acquisition/test/plan",
        },
      ],
    })

    let providerCalls = 0
    let loaderCalls = 0

    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {
            worksiteName: { value: "Chantier test", confidence: 0.9 },
            clientReference: { value: "REF-TEST", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      {
        repository: repo as never,
        provider,
        loadAttachmentBytes: async () => {
          loaderCalls += 1
          return Buffer.from("%PDF-1.4\n")
        },
      }
    )

    assert.notEqual(
      result.ok === false ? result.code : null,
      "ATTACHMENT_NOT_READY"
    )
    assert.equal(repo.claimCount, 1)
    assert.equal(providerCalls, 1)
    assert.equal(loaderCalls, 1)
  })


  it("AUTO : PDF non-PLAN non stocké → pas de blocage ATTACHMENT_NOT_READY", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "document.pdf",
          mimeType: "application/pdf",
          category: "OTHER",
          sizeBytes: 1234,
          status: "DISCOVERED",
          storagePublicId: null,
        },
      ],
    })

    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {
            worksiteName: { value: "Chantier test", confidence: 0.9 },
            clientReference: { value: "REF-TEST", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    const result = await runDraftExtractionSystem(
      { companyId: "co1", draftId: "draft1" },
      {
        repository: repo as never,
        provider,
        loadAttachmentBytes: async () => null,
      }
    )

    assert.notEqual(
      result.ok === false ? result.code : null,
      "ATTACHMENT_NOT_READY"
    )
    assert.equal(repo.claimCount, 1)
    assert.equal(providerCalls, 1)
  })


  it("UI_MANUAL : PLAN PDF non prêt → comportement historique préservé", async () => {
    const repo = createFakeRepo({
      attachments: [
        {
          filename: "plan.pdf",
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1234,
          status: "DISCOVERED",
          storagePublicId: null,
        },
      ],
    })

    let providerCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        providerCalls += 1
        return {
          fields: {},
          warnings: [],
        }
      },
    }

    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft1" },
      {
        repository: repo as never,
        provider,
      }
    )

    assert.notEqual(
      result.ok === false ? result.code : null,
      "ATTACHMENT_NOT_READY"
    )
    assert.equal(repo.claimCount, 1)
    assert.equal(providerCalls, 1)
  })

})
