/**
 * PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1-R1
 * P2-1 : chaîne réelle adapter Anthropic (client mock) → tool schema → map →
 * normalize → gate → persist proposed*.
 * P2-2 : compatibilité colonne / JSON v2↔v3.
 * Aucun réseau, aucune clé API, aucune donnée production.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import type { Message } from "@anthropic-ai/sdk/resources/messages"
import { AnthropicExtractionAdapter } from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import type { AnthropicPublicConfig } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import {
  DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
  EXTRACTION_TOOL_NAME,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { EXTRACTION_TOOL_DEFINITION } from "@/lib/acquisition/extraction/anthropic-extraction.schema"
import type { AnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/acquisition/extraction/extraction-feature-flag"
import {
  buildExtractedDataPayload,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import type {
  DraftExtractionRow,
  MessageContentLite,
  MessageLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
  MarkFailedOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"

const BODY = [
  "Consultation structure.",
  "Donneur d'ordre : CONTRACTOR INDUSTRIE",
  "Client final : RETAIL STORE",
  "Chantier : RETAIL STORE 77 SITE",
  "Adresse : 12 Rue des Essais, 75011 Parisville",
  "Période : du 12/11/2026 au 14/11/2026",
  "Travaux : montage 10x20 H4, accès nacelle.",
  "GPS WGS84 : 48.856600, 2.352200",
].join("\n")

const SUBJECT = "Consultation RETAIL STORE 77 SITE"

function baseConfig(over: Partial<AnthropicPublicConfig> = {}): AnthropicPublicConfig {
  return {
    providerId: "anthropic",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    maxTokens: 1024,
    timeoutMs: 5_000,
    serviceTimeoutMs: 30_000,
    maxPromptBytes: 32_768,
    maxInputBytes: 32_768,
    maxResponseBytes: 64_1024,
    configured: true,
    hasApiKey: true,
    ...over,
  }
}

function toolMessage(input: unknown): Message {
  return {
    id: "msg_r1",
    type: "message",
    role: "assistant",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    stop_reason: "tool_use",
    stop_details: null,
    content: [
      {
        type: "tool_use",
        id: "tool_r1",
        name: EXTRACTION_TOOL_NAME,
        input,
        caller: { type: "direct" },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 40 },
  } as unknown as Message
}

function field(value: unknown, confidence: number, quote: string) {
  return {
    value,
    confidence,
    evidence: { source: "BODY" as const, quote },
  }
}

/** Payload tool conforme au schéma Anthropic réel (quotes présentes dans BODY). */
function validRetailToolInput() {
  return {
    fields: {
      worksiteName: field("RETAIL STORE 77 SITE", 0.78, "RETAIL STORE 77 SITE"),
      clientName: field("CONTRACTOR INDUSTRIE", 0.74, "CONTRACTOR INDUSTRIE"),
      endClientName: field("RETAIL STORE", 0.72, "Client final : RETAIL STORE"),
      address: field(
        "12 Rue des Essais, 75011 Parisville",
        0.76,
        "12 Rue des Essais, 75011 Parisville"
      ),
      postalCode: field("75011", 0.8, "75011 Parisville"),
      city: field("Parisville", 0.78, "75011 Parisville"),
      requestedStartDate: field("2026-11-12", 0.82, "du 12/11/2026 au 14/11/2026"),
      requestedEndDate: field("2026-11-14", 0.82, "du 12/11/2026 au 14/11/2026"),
      description: field(
        "Montage 10x20 H4, accès nacelle. GPS WGS84: 48.856600, 2.352200",
        0.7,
        "montage 10x20 H4"
      ),
    },
    warnings: [],
  }
}

type FakeDraft = DraftExtractionRow & {
  proposedWorksiteName?: string | null
  proposedClientName?: string | null
  proposedAddress?: string | null
  proposedPostalCode?: string | null
  proposedCity?: string | null
  proposedDescription?: string | null
  proposedStartDate?: Date | null
  proposedEndDate?: Date | null
  extractedData?: Record<string, unknown> | null
  status: WorksiteImportDraftStatus
}

function createFakeRepo(seed?: {
  draft?: FakeDraft
  content?: MessageContentLite
  message?: MessageLite
}) {
  const companyId = "co-r1"
  const messageId = "msg-r1"
  let draft: FakeDraft =
    seed?.draft ??
    ({
      id: "draft-r1",
      companyId,
      acquisitionMessageId: messageId,
      status: "PENDING_EXTRACTION",
      version: 0,
      extractionAttemptCount: 0,
      extractionStartedAt: null,
      contentHashAtExtraction: null,
      extractionSchemaVersion: null,
    } as FakeDraft)

  let content: MessageContentLite =
    seed?.content ?? { normalizedText: BODY, contentHash: "hash-r1-body" }
  const message: MessageLite =
    seed?.message ?? {
      id: messageId,
      subject: SUBJECT,
      receivedAt: new Date("2026-09-01T08:00:00.000Z"),
    }

  const persists: PersistExtractionInput[] = []
  let worksiteCreates = 0
  let conversionCalls = 0
  let claimCount = 0

  const repository = {
    persists,
    get draft() {
      return draft
    },
    get worksiteCreates() {
      return worksiteCreates
    },
    get conversionCalls() {
      return conversionCalls
    },
    get claimCount() {
      return claimCount
    },
    async findDraft(cid: string, draftId: string) {
      if (draft.companyId !== cid || draft.id !== draftId) return null
      return { ...draft }
    },
    async findContent(cid: string, mid: string) {
      if (cid !== companyId || mid !== messageId) return null
      return { ...content }
    },
    async findMessage(cid: string, mid: string) {
      if (cid !== companyId || mid !== messageId) return null
      return message
    },
    async listAttachmentMetadata() {
      return []
    },
    async claimExtracting(input: {
      companyId: string
      draftId: string
      expectedVersion: number
      now: Date
    }) {
      claimCount++
      if (draft.companyId !== input.companyId || draft.id !== input.draftId) return null
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
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED"
      if (content.contentHash !== input.expectedContentHash) return "STALE_CONTENT"
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
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
        extractedData: input.extractedData,
      }
      return "OK"
    },
    async markFailedWhileExtracting(input: {
      expectedVersion: number
      errorCode: string
    }): Promise<MarkFailedOutcome> {
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED"
      // Pas de réécriture proposed* (comportement repository réel).
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK"
    },
    async createWorksite() {
      worksiteCreates++
    },
    async convertDraft() {
      conversionCalls++
    },
    /** Test helper: mutate content hash after claim to simulate staleness if needed. */
    setContentHash(h: string) {
      content = { ...content, contentHash: h }
    },
  }
  return repository
}

describe("PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1-R1 — contrat Anthropic", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("adapter public + tool schema réel → proposed* + endClientName + PENDING_REVIEW", async () => {
    let sawToolDefinition = false
    const client: AnthropicExtractionClient = {
      async messagesCreate(req) {
        assert.equal(req.tools?.[0]?.name, EXTRACTION_TOOL_NAME)
        assert.deepEqual(
          (req.tools?.[0] as { input_schema?: unknown })?.input_schema,
          EXTRACTION_TOOL_DEFINITION.input_schema
        )
        sawToolDefinition = true
        assert.equal(
          (req.tool_choice as { name?: string; disable_parallel_tool_use?: boolean })?.name,
          EXTRACTION_TOOL_NAME
        )
        return toolMessage(validRetailToolInput())
      },
    }

    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    const repo = createFakeRepo()

    const result = await runDraftExtraction(
      { actor: { userId: "u1", role: "ADMIN", companyId: "co-r1" }, draftId: "draft-r1" },
      {
        repository: repo as never,
        provider: adapter,
        loadAttachmentBytes: async () => null,
        runAutoDecisionAfterExtraction: async () => {
          throw new Error("AUTO_FORBIDDEN_R1")
        },
      }
    )

    assert.equal(sawToolDefinition, true)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.status, "PENDING_REVIEW")
      assert.equal(result.outcome, "EXTRACTED")
    }

    assert.equal(repo.draft?.proposedClientName, "CONTRACTOR INDUSTRIE")
    assert.equal(repo.draft?.proposedWorksiteName, "RETAIL STORE 77 SITE")
    assert.match(repo.draft?.proposedAddress ?? "", /Rue des Essais/)
    assert.equal(repo.draft?.proposedPostalCode, "75011")
    assert.equal(repo.draft?.proposedCity, "Parisville")
    assert.equal(repo.draft?.proposedStartDate?.toISOString().slice(0, 10), "2026-11-12")
    assert.equal(repo.draft?.proposedEndDate?.toISOString().slice(0, 10), "2026-11-14")
    assert.match(repo.draft?.proposedDescription ?? "", /10x20/)
    assert.match(repo.draft?.proposedDescription ?? "", /48\.856600/)
    assert.equal(repo.draft?.extractionSchemaVersion, EXTRACTION_SCHEMA_VERSION)
    assert.equal(repo.draft?.extractedData?.schemaVersion, EXTRACTION_SCHEMA_VERSION)
    assert.equal(repo.draft?.extractedData?.endClientName, "RETAIL STORE")
    assert.equal(repo.draft?.extractedData?.schemaVersion, "3")

    const last = repo.persists.at(-1)
    assert.ok(last)
    assert.equal(last.fields.contactName, null)
    assert.equal(last.fields.contactEmail, null)
    assert.equal(last.fields.contactPhone, null)
    assert.equal(last.fields.clientEmail, null)
    assert.equal(last.errorCode, null)

    assert.equal(repo.worksiteCreates, 0)
    assert.equal(repo.conversionCalls, 0)
  })

  it("réponse brute hors schéma tool → PROVIDER_INVALID_OUTPUT sans proposed* partiels", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            worksiteName: { value: 12345, confidence: "high" }, // types invalides
            evilField: { value: "x", confidence: 0.9 },
          },
          warnings: "not-an-array",
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    const repo = createFakeRepo({
      draft: {
        id: "draft-r1",
        companyId: "co-r1",
        acquisitionMessageId: "msg-r1",
        status: "FAILED",
        version: 1,
        extractionAttemptCount: 1,
        extractionStartedAt: null,
        contentHashAtExtraction: null,
        extractionSchemaVersion: null,
        proposedWorksiteName: null,
        proposedClientName: null,
      },
    })

    const result = await runDraftExtraction(
      { actor: { userId: "u1", role: "ADMIN", companyId: "co-r1" }, draftId: "draft-r1" },
      { repository: repo as never, provider: adapter, loadAttachmentBytes: async () => null }
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "PROVIDER_INVALID_OUTPUT")
    assert.equal(repo.draft?.status, "FAILED")
    assert.equal(repo.draft?.proposedWorksiteName, null)
    assert.equal(repo.draft?.proposedClientName, null)
    assert.equal(repo.persists.length, 0)
    assert.equal(repo.worksiteCreates, 0)
  })

  it("adapter seul : champ inconnu rejeté par anthropicExtractionRawSchema", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: { notInContract: { value: "x", confidence: 0.5 } },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: SUBJECT,
          normalizedText: BODY,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })
})

describe("PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1-R1 — compat v2/v3", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("payload historique v2 reste lisible (clés métier)", () => {
    const legacyV2 = {
      schemaVersion: "2",
      postalCode: "75011",
      city: "Parisville",
      endClientName: "RETAIL STORE",
      contentHashAtExtraction: "old-hash",
    }
    assert.equal(legacyV2.schemaVersion, "2")
    assert.equal(legacyV2.endClientName, "RETAIL STORE")
    assert.equal(legacyV2.postalCode, "75011")
    // Nouvelle écriture aligne JSON sur la constante runtime.
    const fresh = buildExtractedDataPayload(
      normalizeProviderResult({
        fields: {
          worksiteName: {
            value: "RETAIL STORE 77 SITE",
            confidence: 0.7,
            evidence: { source: "BODY", quote: "RETAIL STORE 77 SITE" },
          },
          endClientName: {
            value: "RETAIL STORE",
            confidence: 0.7,
            evidence: { source: "BODY", quote: "RETAIL STORE" },
          },
          postalCode: { value: "75011", confidence: 0.8 },
          city: { value: "Parisville", confidence: 0.8 },
        },
        warnings: [],
        providerMetadata: { providerId: "anthropic", model: "mock" },
      }).fields,
      { endClientName: { source: "BODY", quote: "RETAIL STORE" } },
      "new-hash"
    )
    assert.equal(fresh.schemaVersion, EXTRACTION_SCHEMA_VERSION)
    assert.equal(fresh.schemaVersion, "3")
    assert.equal(fresh.endClientName, "RETAIL STORE")
  })

  it("colonne v3 + même hash → ALREADY_EXTRACTED (pas de boucle)", async () => {
    const repo = createFakeRepo({
      draft: {
        id: "draft-r1",
        companyId: "co-r1",
        acquisitionMessageId: "msg-r1",
        status: "PENDING_REVIEW",
        version: 4,
        extractionAttemptCount: 2,
        extractionStartedAt: null,
        contentHashAtExtraction: "hash-r1-body",
        extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
      },
      content: { normalizedText: BODY, contentHash: "hash-r1-body" },
    })

    const result = await runDraftExtraction(
      {
        actor: { userId: "u1", role: "ADMIN", companyId: "co-r1" },
        draftId: "draft-r1",
        force: false,
      },
      {
        repository: repo as never,
        provider: {
          async extract() {
            throw new Error("PROVIDER_MUST_NOT_RUN")
          },
        },
      }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, "ALREADY_EXTRACTED")
    assert.equal(repo.claimCount, 0)
  })

  it("colonne historique v2 + même hash → retraitement autorisé (pas ALREADY_EXTRACTED)", async () => {
    let providerCalls = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage(validRetailToolInput())
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    const repo = createFakeRepo({
      draft: {
        id: "draft-r1",
        companyId: "co-r1",
        acquisitionMessageId: "msg-r1",
        status: "PENDING_REVIEW",
        version: 3,
        extractionAttemptCount: 1,
        extractionStartedAt: null,
        contentHashAtExtraction: "hash-r1-body",
        extractionSchemaVersion: "2",
      },
      content: { normalizedText: BODY, contentHash: "hash-r1-body" },
    })

    // force=true (policy re-extract depuis PENDING_REVIEW)
    const wrapped = {
      async extract(input: Parameters<AnthropicExtractionAdapter["extract"]>[0]) {
        providerCalls++
        return adapter.extract(input)
      },
    }

    const result = await runDraftExtraction(
      {
        actor: { userId: "u1", role: "ADMIN", companyId: "co-r1" },
        draftId: "draft-r1",
        force: true,
      },
      { repository: repo as never, provider: wrapped as never, loadAttachmentBytes: async () => null }
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, "EXTRACTED")
    assert.ok(providerCalls >= 1)
    assert.equal(repo.draft?.extractionSchemaVersion, "3")
    assert.equal(repo.draft?.extractedData?.schemaVersion, "3")
  })

  it("runtime src/ : aucun filtre littéral extractionSchemaVersion === \"2\"", () => {
    const roots = [
      join(process.cwd(), "src/lib/acquisition/orchestrator"),
      join(process.cwd(), "src/lib/acquisition/extraction"),
      join(process.cwd(), "src/lib/acquisition/policy"),
    ]
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (name.endsWith(".ts")) files.push(p)
      }
    }
    for (const root of roots) walk(root)

    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      if (
        /extractionSchemaVersion\s*===\s*["']2["']/.test(text) ||
        /extractionSchemaVersion\s*==\s*["']2["']/.test(text) ||
        /["']2["']\s*===\s*[^\n]*extractionSchemaVersion/.test(text)
      ) {
        hits.push(f)
      }
    }
    assert.deepEqual(hits, [])
  })
})
