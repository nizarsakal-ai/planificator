/**
 * PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1
 * Extraction intelligente (corps) via provider mock — aucune création Worksite,
 * aucun appel Anthropic réel, aucune écriture distante.
 *
 * Fixture « retail-site-like » assainie (noms génériques de test uniquement).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/acquisition/extraction/extraction-feature-flag"
import {
  buildExtractedDataPayload,
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"
import { ANTHROPIC_EXTRACTION_SYSTEM_PROMPT } from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import type {
  AttachmentMetaRow,
  DraftExtractionRow,
  MessageContentLite,
  MessageLite,
  PersistExtractionInput,
  PersistExtractionOutcome,
  MarkFailedOutcome,
} from "@/lib/acquisition/extraction/extraction.repository"
import type {
  ExtractionProviderPort,
  ExtractionProviderResult,
} from "@/lib/acquisition/extraction/extraction-provider.port"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"

/** Corps assaini — ne pas coller de message production réel. */
const SANITIZED_BODY = [
  "Bonjour,",
  "Suite à notre échange, merci de chiffrer l'installation d'une structure.",
  "Donneur d'ordre / client contractuel : CONTRACTOR INDUSTRIES",
  "Client final / enseigne : RETAIL SITE BRAND",
  "Chantier : RETAIL SITE BRAND 77 CITYZONE",
  "Adresse : Parc d'Activité de l'A5, Rue des Ateliers, 77550 Cityzone",
  "Période de prestation : du 05/10/2026 au 07/10/2026",
  "Intervention : montage structure 15x30 H5, accès camion requis, zone sécurisée.",
  "Coordonnées GPS (WGS84) : 48.601234, 2.623456",
  "Pièces jointes : plans PDF (non joints dans ce test).",
  "Cordialement,",
].join("\n")

const SUBJECT = "Consultation — RETAIL SITE BRAND 77 CITYZONE"

function actor(companyId: string = "co-tenant-a") {
  return { userId: "u-admin", role: "ADMIN" as const, companyId }
}

function field(
  value: unknown,
  confidence = 0.72,
  quote?: string
): { value: unknown; confidence: number; evidence?: { source: "BODY"; quote: string } } {
  return {
    value,
    confidence,
    evidence: quote ? { source: "BODY", quote: quote.slice(0, 120) } : undefined,
  }
}

/** Réponse provider structurée attendue pour le cas assaini (mock déterministe). */
function intelligentProviderResult(over: Partial<ExtractionProviderResult["fields"]> = {}): ExtractionProviderResult {
  return {
    fields: {
      worksiteName: field("RETAIL SITE BRAND 77 CITYZONE", 0.78, "RETAIL SITE BRAND 77 CITYZONE"),
      // Client contractuel si explicitement dans le corps — pas l'enseigne site.
      clientName: field("CONTRACTOR INDUSTRIES", 0.7, "CONTRACTOR INDUSTRIES"),
      endClientName: field("RETAIL SITE BRAND", 0.74, "Client final / enseigne : RETAIL SITE BRAND"),
      address: field(
        "Parc d'Activité de l'A5, Rue des Ateliers, 77550 Cityzone",
        0.76,
        "Parc d'Activité de l'A5, Rue des Ateliers, 77550 Cityzone"
      ),
      postalCode: field("77550", 0.8, "77550 Cityzone"),
      city: field("Cityzone", 0.78, "77550 Cityzone"),
      requestedStartDate: field("2026-10-05", 0.82, "du 05/10/2026 au 07/10/2026"),
      requestedEndDate: field("2026-10-07", 0.82, "du 05/10/2026 au 07/10/2026"),
      description: field(
        "Montage structure 15x30 H5, accès camion, zone sécurisée. GPS WGS84: 48.601234, 2.623456",
        0.7,
        "montage structure 15x30 H5"
      ),
      // Absents du message → omis (pas d'hallucination).
      contactName: undefined,
      contactEmail: undefined,
      contactPhone: undefined,
      clientEmail: undefined,
      clientPhone: undefined,
      consultationReference: undefined,
      clientConsultationDate: undefined,
      ...over,
    },
    warnings: [],
    providerMetadata: { providerId: "anthropic", model: "mock-haiku-test" },
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
  status: WorksiteImportDraftStatus
}

function createFakeRepo(seed?: {
  draft?: FakeDraft | null
  content?: MessageContentLite | null
  message?: MessageLite | null
  attachments?: AttachmentMetaRow[]
  companyId?: string
  messageId?: string
}) {
  const companyId = seed?.companyId ?? "co-tenant-a"
  const messageId = seed?.messageId ?? "msg-sanitized-1"

  let draft: FakeDraft | null =
    seed?.draft === undefined
      ? {
          id: "draft-sanitized-1",
          companyId,
          acquisitionMessageId: messageId,
          status: "FAILED",
          version: 2,
          extractionAttemptCount: 2,
          extractionStartedAt: null,
          contentHashAtExtraction: null,
          extractionSchemaVersion: null,
        }
      : seed.draft

  let content: MessageContentLite | null =
    seed?.content === undefined
      ? { normalizedText: SANITIZED_BODY, contentHash: "hash-sanitized-l1" }
      : seed.content

  const message: MessageLite | null =
    seed?.message === undefined
      ? { id: messageId, subject: SUBJECT, receivedAt: new Date("2026-09-01T10:00:00.000Z") }
      : seed.message

  const attachments =
    seed?.attachments ??
    Array.from({ length: 7 }, (_, i) => ({
      id: `att-meta-${i + 1}`,
      filename: `plan-meta-${i + 1}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 12_000 + i,
      category: "PLAN" as const,
      status: "DISCOVERED" as const,
      storagePublicId: null,
    }))

  const persists: PersistExtractionInput[] = []
  let claimCount = 0
  let clientCreates = 0
  let worksiteCreates = 0
  let conversionCalls = 0

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
    get conversionCalls() {
      return conversionCalls
    },
    async findDraft(cid: string, draftId: string) {
      if (!draft || draft.companyId !== cid || draft.id !== draftId) return null
      return { ...draft }
    },
    async findContent(cid: string, acquisitionMessageId: string) {
      if (cid !== companyId || acquisitionMessageId !== messageId) return null
      return content ? { ...content } : null
    },
    async findMessage(cid: string, mid: string) {
      if (cid !== companyId || mid !== messageId) return null
      return message
    },
    async listAttachmentMetadata() {
      return attachments.map((a) => ({ ...a }))
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
      }
      return "OK"
    },
    async markFailedWhileExtracting(input: {
      expectedVersion: number
      errorCode: string
    }): Promise<MarkFailedOutcome> {
      if (!draft || draft.version !== input.expectedVersion) return "STATE_CHANGED"
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK"
    },
    async createClient() {
      clientCreates++
    },
    async createWorksite() {
      worksiteCreates++
    },
    async convertDraft() {
      conversionCalls++
    },
  }

  return repository
}

describe("PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1", () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    // Sélection globale mockée via deps.provider — pas d'appel live.
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it("prompt distingue worksite / endClient / client contractuel + GPS dans description", () => {
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /endClientName/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /clientName/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /worksiteName/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /donneur d'ordre/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /GPS/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /Ne jamais copier une date de réception/)
  })

  it("normalize + gate : extraction complète du cas assaini", () => {
    const normalized = normalizeProviderResult(intelligentProviderResult())
    assert.equal(normalized.fields.worksiteName, "RETAIL SITE BRAND 77 CITYZONE")
    assert.equal(normalized.fields.endClientName, "RETAIL SITE BRAND")
    assert.equal(normalized.fields.clientName, "CONTRACTOR INDUSTRIES")
    assert.notEqual(normalized.fields.clientName, normalized.fields.endClientName)
    assert.notEqual(normalized.fields.clientName, normalized.fields.worksiteName)
    assert.match(normalized.fields.address ?? "", /Rue des Ateliers/)
    assert.equal(normalized.fields.postalCode, "77550")
    assert.equal(normalized.fields.city, "Cityzone")
    assert.equal(normalized.fields.requestedStartDate, "2026-10-05")
    assert.equal(normalized.fields.requestedEndDate, "2026-10-07")
    assert.match(normalized.fields.description ?? "", /15x30/)
    assert.match(normalized.fields.description ?? "", /48\.601234/)
    assert.equal(normalized.fields.contactName, null)
    assert.equal(normalized.fields.contactEmail, null)
    assert.equal(normalized.fields.consultationReference, null)
    assert.equal(normalized.fields.clientConsultationDate, null)

    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, true)
    assert.equal(gate.failureCode, null)
  })

  it("schemaVersion payload aligné sur EXTRACTION_SCHEMA_VERSION", () => {
    const normalized = normalizeProviderResult(intelligentProviderResult())
    const payload = buildExtractedDataPayload(normalized.fields, normalized.evidenceData, "hash-x")
    assert.equal(payload.schemaVersion, EXTRACTION_SCHEMA_VERSION)
    assert.equal(payload.schemaVersion, "3")
    assert.equal(payload.endClientName, "RETAIL SITE BRAND")
  })

  it("PJ DISCOVERED + REQUIRED_DOCUMENT_UNREADABLE n'empêchent pas PENDING_REVIEW si signal fort", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return intelligentProviderResult()
      },
    }

    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft-sanitized-1", force: false },
      {
        repository: repo as never,
        provider,
        // Pas de bytes PJ — simule DISCOVERED sans téléchargement.
        loadAttachmentBytes: async () => null,
        runAutoDecisionAfterExtraction: async () => {
          throw new Error("AUTO_MUST_NOT_RUN_IN_L1")
        },
      }
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.outcome, "EXTRACTED")
      assert.equal(result.status, "PENDING_REVIEW")
    }
    assert.equal(repo.draft?.status, "PENDING_REVIEW")
    assert.equal(repo.draft?.proposedWorksiteName, "RETAIL SITE BRAND 77 CITYZONE")
    assert.equal(repo.draft?.proposedClientName, "CONTRACTOR INDUSTRIES")
    assert.equal(repo.draft?.proposedPostalCode, "77550")
    assert.equal(repo.draft?.proposedCity, "Cityzone")
    assert.match(repo.draft?.proposedAddress ?? "", /Rue des Ateliers/)
    assert.match(repo.draft?.proposedDescription ?? "", /15x30/)
    assert.equal(repo.draft?.extractionSchemaVersion, EXTRACTION_SCHEMA_VERSION)

    const last = repo.persists.at(-1)
    assert.ok(last)
    assert.equal(last.status, "PENDING_REVIEW")
    assert.equal(last.errorCode, null)
    const warningCodes = (last.warningData ?? []).map((w) => w.code)
    // PDF non lisibles → warnings ; gate passe car severity WARNING (pas ERROR).
    assert.ok(warningCodes.includes("PDF_PARSE_FAILED") || warningCodes.includes("REQUIRED_DOCUMENT_UNREADABLE"))
    assert.ok(!warningCodes.includes("CONTENT_INSUFFICIENT"))

    assert.equal(repo.worksiteCreates, 0)
    assert.equal(repo.clientCreates, 0)
    assert.equal(repo.conversionCalls, 0)
  })

  it("gate conserve FAILED (CONTENT_INSUFFICIENT) si dates seules + PJ illisibles", () => {
    const datesOnly = normalizeProviderResult({
      fields: {
        requestedStartDate: field("2026-10-05", 0.8),
        requestedEndDate: field("2026-10-07", 0.8),
      },
      warnings: [],
      providerMetadata: { providerId: "anthropic", model: "mock" },
    })
    const warnings = [
      ...datesOnly.warnings,
      catalogWarning("PDF_PARSE_FAILED", { field: "PLAN", source: "SERVICE" }),
      catalogWarning("REQUIRED_DOCUMENT_UNREADABLE", { field: "PLAN", source: "SERVICE" }),
    ]
    const gate = evaluateExtractionGate(datesOnly.fields, warnings)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "CONTENT_INSUFFICIENT")
  })

  it("provider indisponible → échec sûr, aucun claim Worksite", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        throw new ExtractionProviderError("PROVIDER_UNAVAILABLE", "mock down", true)
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft-sanitized-1" },
      { repository: repo as never, provider, loadAttachmentBytes: async () => null }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "PROVIDER_UNAVAILABLE")
    assert.equal(repo.draft?.status, "FAILED")
    assert.equal(repo.worksiteCreates, 0)
    assert.equal(repo.conversionCalls, 0)
  })

  it("sortie provider invalide → PROVIDER_INVALID_OUTPUT, pas de chantier", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return { totally: "wrong" } as never
      },
    }
    const result = await runDraftExtraction(
      { actor: actor(), draftId: "draft-sanitized-1" },
      { repository: repo as never, provider, loadAttachmentBytes: async () => null }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "PROVIDER_INVALID_OUTPUT")
    assert.equal(repo.worksiteCreates, 0)
  })

  it("contenu contradictoire (dates inversées) → DATE_RANGE_INVALID", () => {
    const normalized = normalizeProviderResult(
      intelligentProviderResult({
        requestedStartDate: field("2026-10-07", 0.8),
        requestedEndDate: field("2026-10-05", 0.8),
      })
    )
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "DATE_RANGE_INVALID")
  })

  it("isolation tenant : autre companyId → draft introuvable", async () => {
    const repo = createFakeRepo()
    const provider: ExtractionProviderPort = {
      async extract() {
        return intelligentProviderResult()
      },
    }
    const result = await runDraftExtraction(
      { actor: actor("co-other-tenant"), draftId: "draft-sanitized-1" },
      { repository: repo as never, provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DRAFT_NOT_FOUND")
    assert.equal(repo.claimCount, 0)
    assert.equal(repo.worksiteCreates, 0)
  })

  it("ne mappe jamais l'enseigne site sur clientName (contrat vs final)", () => {
    const normalized = normalizeProviderResult(intelligentProviderResult())
    assert.equal(normalized.fields.endClientName, "RETAIL SITE BRAND")
    assert.equal(normalized.fields.worksiteName, "RETAIL SITE BRAND 77 CITYZONE")
    assert.equal(normalized.fields.clientName, "CONTRACTOR INDUSTRIES")
    // Preuve négative : pas de confusion enseigne → client contractuel.
    assert.notEqual(normalized.fields.clientName, "RETAIL SITE BRAND")
    assert.ok(!(normalized.fields.clientName ?? "").includes("RETAIL SITE BRAND 77"))
  })

  it("clientConsultationDate non dérivée de receivedAt (omise si absente)", () => {
    const normalized = normalizeProviderResult(intelligentProviderResult())
    assert.equal(normalized.fields.clientConsultationDate, null)
  })
})
