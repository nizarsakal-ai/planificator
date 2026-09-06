/**
 * PLAN-ACQ-CONSULTATION-TEMPORAL-POLICY — extraction + lifecycle.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { readFileSync } from "node:fs"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type {
  DraftExtractionRow,
  PersistExtractionInput,
  PersistExtractionOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { normalizeProviderResult } from "@/lib/acquisition/extraction/extraction-normalize"
import { extractionCanonicalFieldsSchema } from "@/lib/acquisition/extraction/extraction.schema"

function actor() {
  return { userId: "u1", role: "ADMIN" as const, companyId: "co1" as string | null }
}

function createFakeRepo() {
  let draft: DraftExtractionRow = {
    id: "draft1",
    companyId: "co1",
    acquisitionMessageId: "msg1",
    status: "PENDING_EXTRACTION",
    version: 0,
    extractionAttemptCount: 0,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
  }
  const persists: PersistExtractionInput[] = []
  return {
    persists,
    get draft() {
      return draft
    },
    async findDraft() {
      return { ...draft }
    },
    async findContent() {
      return { normalizedText: "Chantier : Site X\nRéf REF-1", contentHash: "hash-abc" }
    },
    async findMessage() {
      return {
        id: "msg1",
        subject: "Consultation",
        receivedAt: new Date("2026-01-15T12:00:00.000Z"),
      }
    },
    async listAttachmentMetadata() {
      return []
    },
    async claimExtracting() {
      draft = {
        ...draft,
        status: "EXTRACTING",
        version: draft.version + 1,
        extractionAttemptCount: draft.extractionAttemptCount + 1,
        extractionStartedAt: new Date(),
      }
      return { ...draft }
    },
    async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
      persists.push(input)
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        extractionSchemaVersion: "3",
      }
      return "OK"
    },
    async markFailedWhileExtracting() {
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK" as const
    },
  }
}

describe("TEMPORAL extraction lifecycle", () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("clientConsultationDate valide → persistée ; ne copie pas receivedAt", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Site X", confidence: 0.8 },
            requestedStartDate: { value: "2026-10-01", confidence: 0.8 },
            requestedEndDate: { value: "2026-10-15", confidence: 0.8 },
            clientConsultationDate: { value: "2026-08-20", confidence: 0.8 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const result = await runDraftExtraction(
      {
        actor: actor(),
        draftId: "draft1",
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.status, "PENDING_REVIEW")
    const p = repo.persists[0]!
    assert.equal(p.fields.clientConsultationDate, "2026-08-20")
    assert.equal(p.fields.requestedStartDate, "2026-10-01")
    assert.equal(p.fields.requestedEndDate, "2026-10-15")
    // receivedAt message = 2026-01-15 — jamais copié
    assert.notEqual(p.fields.clientConsultationDate, "2026-01-15")
  })

  it("clientConsultationDate absente → NULL", () => {
    const normalized = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Site X", confidence: 0.8 },
        requestedStartDate: { value: "2026-10-01", confidence: 0.8 },
        requestedEndDate: { value: "2026-10-15", confidence: 0.8 },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    assert.equal(normalized.fields.clientConsultationDate, null)
    assert.equal(normalized.fields.requestedStartDate, "2026-10-01")
  })

  it("ne remplace jamais requestedStart/End par clientConsultationDate", () => {
    const fields = extractionCanonicalFieldsSchema.parse({
      worksiteName: "A",
      requestedStartDate: "2026-10-01",
      requestedEndDate: "2026-10-15",
      clientConsultationDate: "2026-08-01",
    })
    assert.equal(fields.requestedStartDate, "2026-10-01")
    assert.equal(fields.requestedEndDate, "2026-10-15")
    assert.equal(fields.clientConsultationDate, "2026-08-01")
  })

  it("extraction réussie endDate passée → OBSOLETE", async () => {
    const repo = createFakeRepo()
    let autoCalls = 0
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Site Old", confidence: 0.8 },
            requestedStartDate: { value: "2026-08-01", confidence: 0.8 },
            requestedEndDate: { value: "2026-08-15", confidence: 0.8 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const result = await runDraftExtraction(
      {
        actor: actor(),
        draftId: "draft1",
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      },
      {
        repository: repo as never,
        provider,
        runAutoDecisionAfterExtraction: async () => {
          autoCalls += 1
        },
      }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.status, "OBSOLETE")
    assert.equal(repo.persists[0]?.status, "OBSOLETE")
    // UI_MANUAL : hook AUTO jamais appelé (défense + statut OBSOLETE hors PENDING_REVIEW)
    assert.equal(autoCalls, 0)
  })

  it("UNKNOWN_DATES → PENDING_REVIEW (pas OBSOLETE)", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Providence", confidence: 0.8 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const result = await runDraftExtraction(
      {
        actor: actor(),
        draftId: "draft1",
        now: () => new Date("2026-09-06T12:00:00.000Z"),
      },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.status, "PENDING_REVIEW")
    assert.equal(repo.persists[0]?.status, "PENDING_REVIEW")
    assert.equal(repo.persists[0]?.fields.requestedStartDate, null)
    assert.equal(repo.persists[0]?.fields.requestedEndDate, null)
  })

  it("ORCHESTRATOR — gate source : AUTO uniquement si successStatus PENDING_REVIEW", () => {
    // createOrchestratorAutoCapability non exporté (fencing) → preuve structurelle
    // du skip AUTO pour OBSOLETE sans mint capability.
    const source = readFileSync(
      "src/lib/acquisition/extraction/extraction.service.ts",
      "utf8"
    )
    assert.match(
      source,
      /successStatus === "PENDING_REVIEW" && isOrchestratorAutoContext\(executionContext\)/
    )
    assert.match(
      source,
      /OBSOLETE : jamais d’auto-decision/
    )
  })
})
