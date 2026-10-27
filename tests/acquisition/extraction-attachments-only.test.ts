/**
 * PLAN-ACQ-MULTIMODAL — Barrière 005A, extraction « pièces jointes seules »
 * (mode MANUEL), vision, et non-affaiblissement des barrières AUTO / staleness.
 * Repos injectés, provider mocké : aucun appel réel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { WorksiteImportDraftStatus } from "@prisma/client"
import {
  runDraftExtraction,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import {
  DraftExtractionRepository,
  type AttachmentMetaRow,
  type DraftExtractionRow,
  type MessageContentLite,
  type PersistExtractionInput,
} from "@/lib/acquisition/extraction/extraction.repository"
import type {
  ExtractionProviderPort,
  NormalizedExtractInput,
} from "@/lib/acquisition/extraction/extraction-provider.port"
import {
  computeAttachmentsOnlyFingerprint,
  hasExploitableMessageText,
  isAttachmentsOnlyFingerprint,
} from "@/lib/acquisition/extraction/extraction-source-fingerprint"
import {
  assertAutoDecisionSourceFreshInTransaction,
  evaluateAutoDecisionSourceFreshness,
} from "@/lib/acquisition/policy/auto-decision-source-freshness"
import { gateAutoDecisionByDetectionProof } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import { buildMinimalEmptyPdf, buildMinimalTextPdf } from "@/lib/acquisition/extraction/pdf-text-extract"
import { buildMinimalJpeg, buildXlsx } from "./helpers/multimodal-fixtures"

const actor = { userId: "u1", role: "ADMIN" as const, companyId: "co1" as string | null }

type Seed = {
  content?: MessageContentLite | null
  attachments?: AttachmentMetaRow[]
  draft?: Partial<DraftExtractionRow>
}

function createRepo(seed: Seed = {}) {
  let draft: DraftExtractionRow & { status: WorksiteImportDraftStatus } = {
    id: "d1",
    companyId: "co1",
    acquisitionMessageId: "m1",
    status: "PENDING_EXTRACTION",
    version: 0,
    extractionAttemptCount: 0,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
    detectionClassification: "CONSULTATION",
    detectionContentHash: "hash-text",
    extractionRetryable: null,
    ...seed.draft,
  }
  const state = {
    content: seed.content === undefined ? null : seed.content,
    attachments: seed.attachments ?? [],
  }
  const persists: PersistExtractionInput[] = []
  let claimCount = 0
  const repo = {
    state,
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
      return state.content ? { ...state.content } : null
    },
    async findMessage() {
      return { id: "m1", subject: "Commande", receivedAt: new Date("2026-01-15T12:00:00Z") }
    },
    async listAttachmentMetadata() {
      return state.attachments.map((a) => ({ ...a }))
    },
    async claimExtracting(input: { expectedVersion: number; now: Date }) {
      claimCount++
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
    async persistExtraction(input: PersistExtractionInput) {
      persists.push(input)
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED" as const
      // Même règle de fraîcheur que le repository Prisma.
      const fresh =
        input.sourceKind === "ATTACHMENTS_ONLY"
          ? !hasExploitableMessageText(state.content) &&
            computeAttachmentsOnlyFingerprint({
              contentHash: state.content?.contentHash ?? null,
              attachments: state.attachments,
            }) === input.expectedContentHash
          : state.content?.contentHash === input.expectedContentHash
      if (!fresh) {
        draft = { ...draft, status: "FAILED", version: draft.version + 1 }
        return "STALE_CONTENT" as const
      }
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
      }
      return "OK" as const
    },
    async markFailedWhileExtracting(input: { expectedVersion: number }) {
      if (draft.version !== input.expectedVersion) return "STATE_CHANGED" as const
      draft = { ...draft, status: "FAILED", version: draft.version + 1 }
      return "OK" as const
    },
  }
  return repo
}

function recordingProvider(opts: { vision?: boolean } = {}) {
  const calls: NormalizedExtractInput[] = []
  const provider: ExtractionProviderPort & { calls: NormalizedExtractInput[] } = {
    calls,
    ...(opts.vision ? { supportsVisualInputs: true } : {}),
    async extract(input) {
      calls.push(input)
      return {
        fields: {
          worksiteName: { value: "Commande ACME Lilas", confidence: 0.8, evidence: { source: "ATTACHMENT_TEXT", quote: "ACME" } },
          clientName: { value: "ACME BTP", confidence: 0.6, evidence: { source: "ATTACHMENT_VISUAL", quote: "ACME BTP" } },
        },
        warnings: [],
        providerMetadata: { providerId: "fake", model: "m" },
      }
    },
  }
  return provider
}

function stored(over: Partial<AttachmentMetaRow> & { filename: string }): AttachmentMetaRow {
  return {
    id: `att-${over.filename}`,
    sha256: `sha-${over.filename}`,
    mimeType: "application/octet-stream",
    category: "UNKNOWN",
    sizeBytes: 1000,
    status: "STORED",
    storagePublicId: `pid/${over.filename}`,
    ...over,
  }
}

function bytesLoader(map: Record<string, Buffer>) {
  const loaded: string[] = []
  const fn = async (a: { filename: string }) => {
    loaded.push(a.filename)
    return map[a.filename] ?? null
  }
  return Object.assign(fn, { loaded })
}

const FLAG_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_EXTRACTION_ENABLED",
  "ACQUISITION_EXTRACTION_PROVIDER",
  "ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED",
] as const

describe("extraction — barrière 005A & pièces jointes seules", () => {
  const backup: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of FLAG_KEYS) backup[k] = process.env[k]
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED
  })
  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  it("MANUEL : mail vide + bon de commande PDF texte → extrait, empreinte att1:, issue « lu texte »", async () => {
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "BC-2026.pdf", mimeType: "application/pdf", category: "PLAN" })],
    })
    const provider = recordingProvider()
    const loader = bytesLoader({ "BC-2026.pdf": buildMinimalTextPdf("Bon de commande ACME 12 rue des Lilas") })
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider, loadAttachmentBytes: loader }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(provider.calls.length, 1)
    assert.match(provider.calls[0].normalizedText, /--- PJ texte: BC-2026\.pdf ---/)
    assert.match(provider.calls[0].normalizedText, /Bon de commande ACME/)
    assert.equal(provider.calls[0].attachmentVisuals, undefined)
    const persisted = repo.persists[0]
    assert.equal(persisted.sourceKind, "ATTACHMENTS_ONLY")
    assert.ok(isAttachmentsOnlyFingerprint(persisted.expectedContentHash))
    assert.equal(
      persisted.expectedContentHash,
      computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: repo.state.attachments })
    )
    assert.equal(persisted.extractedData.sourceKind, "ATTACHMENTS_ONLY")
    assert.deepEqual(persisted.extractedData.attachmentReadOutcomes, [
      { filename: "BC-2026.pdf", kind: "pdf", outcome: "READ_TEXT" },
    ])
    assert.equal(repo.draft.status, "PENDING_REVIEW")
  })

  it("MANUEL : contenu vide sans pièce lisible → CONTENT_MISSING sans claim", async () => {
    const repo = createRepo({
      content: { normalizedText: "   ", contentHash: "h-empty" },
      attachments: [
        stored({ filename: "photo.jpg", mimeType: "image/jpeg" }), // vision OFF
        stored({ filename: "IMG.HEIC", mimeType: "image/heic" }),
        stored({ filename: "plan.pdf", mimeType: "application/pdf", status: "DISCOVERED", storagePublicId: null }),
      ],
    })
    const r = await runDraftExtraction({ actor, draftId: "d1" }, { repository: repo as never, provider: recordingProvider() })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "CONTENT_MISSING")
      assert.match(r.message, /aucune pièce jointe lisible/)
    }
    assert.equal(repo.claimCount, 0)
  })

  it("MANUEL : PDF scanné + vision OFF → claim puis FAILED CONTENT_MISSING, issue persistée « vision désactivée »", async () => {
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "scan.pdf", mimeType: "application/pdf", category: "PLAN" })],
    })
    const provider = recordingProvider()
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider, loadAttachmentBytes: bytesLoader({ "scan.pdf": buildMinimalEmptyPdf() }) }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "CONTENT_MISSING")
    assert.equal(provider.calls.length, 0)
    const p = repo.persists[0]
    assert.equal(p.status, "FAILED")
    assert.equal(p.errorCode, "CONTENT_MISSING")
    assert.equal(p.extractionRetryable, false)
    assert.deepEqual(p.extractedData.attachmentReadOutcomes, [
      { filename: "scan.pdf", kind: "pdf", outcome: "IGNORED_VISION_DISABLED", reason: "FLAG_OFF" },
    ])
    assert.ok(p.warningData.some((w) => w.code === "REQUIRED_DOCUMENT_UNREADABLE"))
  })

  it("MANUEL : PDF scanné + vision ON + provider vision → bloc document transmis, pas de REQUIRED_DOCUMENT_UNREADABLE", async () => {
    process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED = "true"
    const pdf = buildMinimalEmptyPdf()
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "scan.pdf", mimeType: "application/pdf", category: "PLAN" })],
    })
    const provider = recordingProvider({ vision: true })
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider, loadAttachmentBytes: bytesLoader({ "scan.pdf": pdf }) }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    const visuals = provider.calls[0].attachmentVisuals ?? []
    assert.equal(visuals.length, 1)
    assert.equal(visuals[0].kind, "pdf")
    assert.equal(visuals[0].base64, pdf.toString("base64"))
    const p = repo.persists[0]
    assert.ok(!p.warningData.some((w) => w.code === "REQUIRED_DOCUMENT_UNREADABLE"))
    assert.deepEqual(p.extractedData.attachmentReadOutcomes, [
      { filename: "scan.pdf", kind: "pdf", outcome: "READ_VISION" },
    ])
  })

  it("vision ON mais provider déterministe → aucun visuel, issue PROVIDER_NOT_VISION", async () => {
    process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED = "true"
    const repo = createRepo({
      content: { normalizedText: "Chantier : Tour Alpha, client ACME, 12 rue des Lilas", contentHash: "hash-text" },
      attachments: [stored({ filename: "IMG_2635.jpeg", mimeType: "application/octet-stream" })],
    })
    const provider = recordingProvider() // pas de supportsVisualInputs
    const loader = bytesLoader({ "IMG_2635.jpeg": buildMinimalJpeg() })
    const r = await runDraftExtraction({ actor, draftId: "d1" }, { repository: repo as never, provider, loadAttachmentBytes: loader })
    assert.equal(r.ok, true)
    assert.equal(provider.calls[0].attachmentVisuals, undefined)
    assert.deepEqual(loader.loaded, [], "octets image non chargés inutilement")
    assert.deepEqual(repo.persists[0].extractedData.attachmentReadOutcomes, [
      { filename: "IMG_2635.jpeg", kind: "image", outcome: "IGNORED_VISION_DISABLED", reason: "PROVIDER_NOT_VISION" },
    ])
  })

  it("cas réel 1 : texte complet + xlsx + PDF plans + JPEG octet-stream (vision ON) → empreinte = contentHash inchangée", async () => {
    process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED = "true"
    const repo = createRepo({
      content: { normalizedText: "Client ACME, chantier Tour Alpha, 12 rue des Lilas, GPS 48.85,2.35, du 02/03 au 06/03", contentHash: "hash-text" },
      attachments: [
        stored({ filename: "TEMPLATE_CROQUIS_A.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", category: "DOCUMENT" }),
        stored({ filename: "plans.pdf", mimeType: "application/pdf", category: "PLAN" }),
        stored({ filename: "IMG_2635.jpeg", mimeType: "application/octet-stream", category: "UNKNOWN" }),
      ],
    })
    const provider = recordingProvider({ vision: true })
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      {
        repository: repo as never,
        provider,
        loadAttachmentBytes: bytesLoader({
          "TEMPLATE_CROQUIS_A.xlsx": await buildXlsx([{ name: "Croquis", rows: [["Hauteur", "12 m"]] }]),
          "plans.pdf": buildMinimalTextPdf("Plan RDC niveau 0"),
          "IMG_2635.jpeg": buildMinimalJpeg(),
        }),
      }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    const call = provider.calls[0]
    assert.match(call.normalizedText, /^Client ACME/)
    assert.match(call.normalizedText, /Hauteur \| 12 m/)
    assert.match(call.normalizedText, /Plan RDC/)
    assert.equal(call.attachmentVisuals?.length, 1)
    assert.equal(call.attachmentVisuals?.[0].mediaType, "image/jpeg")
    const p = repo.persists[0]
    assert.equal(p.sourceKind, "MESSAGE_CONTENT")
    assert.equal(p.expectedContentHash, "hash-text")
    assert.deepEqual(
      (p.extractedData.attachmentReadOutcomes as Array<{ outcome: string }>).map((o) => o.outcome),
      ["READ_TEXT", "READ_TEXT", "READ_VISION"]
    )
  })

  it("HEIC → avertissement explicite dans les warnings", async () => {
    const repo = createRepo({
      content: { normalizedText: "Chantier Tour Alpha", contentHash: "hash-text" },
      attachments: [stored({ filename: "IMG_1.HEIC", mimeType: "image/heic", category: "PHOTO" })],
    })
    const r = await runDraftExtraction({ actor, draftId: "d1" }, { repository: repo as never, provider: recordingProvider() })
    assert.equal(r.ok, true)
    const w = repo.persists[0].warningData.find((x) => x.code === "ATTACHMENT_HEIC_UNSUPPORTED")
    assert.ok(w)
    assert.equal(w?.blocking, false)
  })

  it("staleness : texte de mail apparu pendant l'extraction PJ seules → STALE_CONTENT", async () => {
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "BC.pdf", mimeType: "application/pdf" })],
    })
    const provider: ExtractionProviderPort = {
      async extract() {
        repo.state.content = { normalizedText: "Texte arrivé entre-temps", contentHash: "h-new" }
        return recordingProvider().extract({} as NormalizedExtractInput)
      },
    }
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider, loadAttachmentBytes: bytesLoader({ "BC.pdf": buildMinimalTextPdf("BC ACME") }) }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "STALE_CONTENT")
  })

  it("staleness : pièce re-stockée (sha différent) pendant l'extraction → STALE_CONTENT", async () => {
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "BC.pdf", mimeType: "application/pdf" })],
    })
    const provider: ExtractionProviderPort = {
      async extract() {
        repo.state.attachments = [stored({ filename: "BC.pdf", mimeType: "application/pdf", sha256: "autre" })]
        return recordingProvider().extract({} as NormalizedExtractInput)
      },
    }
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider, loadAttachmentBytes: bytesLoader({ "BC.pdf": buildMinimalTextPdf("BC ACME") }) }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "STALE_CONTENT")
  })
})

describe("extraction — mode AUTO inchangé", () => {
  const backup: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of FLAG_KEYS) backup[k] = process.env[k]
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED = "true"
  })
  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  it("AUTO (cron) : mail vide + PDF texte lisible → toujours CONTENT_MISSING, aucun claim", async () => {
    const repo = createRepo({
      content: null,
      attachments: [stored({ filename: "BC.pdf", mimeType: "application/pdf" })],
    })
    const provider = recordingProvider({ vision: true })
    const r = await runDraftExtractionSystem({ companyId: "co1", draftId: "d1" }, { repository: repo as never, provider })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "CONTENT_MISSING")
      assert.equal(r.message, "Contenu message absent (005A)")
    }
    assert.equal(repo.claimCount, 0)
    assert.equal(provider.calls.length, 0)
  })

  it("AUTO : texte présent mais sans preuve Detection → toujours bloqué (DETECTION_REQUIRED)", async () => {
    const repo = createRepo({
      content: { normalizedText: "Chantier Tour Alpha", contentHash: "hash-text" },
      draft: { detectionClassification: null, detectionContentHash: null },
    })
    const r = await runDraftExtractionSystem({ companyId: "co1", draftId: "d1" }, { repository: repo as never, provider: recordingProvider() })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "DETECTION_REQUIRED")
    assert.equal(repo.claimCount, 0)
  })

  it("AUTO : preuve Detection d'un autre hash → DETECTION_NOT_AUTHORIZED", async () => {
    const repo = createRepo({
      content: { normalizedText: "Chantier Tour Alpha", contentHash: "hash-text" },
      draft: { detectionClassification: "CONSULTATION", detectionContentHash: "hash-old" },
    })
    const r = await runDraftExtractionSystem({ companyId: "co1", draftId: "d1" }, { repository: repo as never, provider: recordingProvider() })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "DETECTION_NOT_AUTHORIZED")
  })
})

describe("empreinte source PJ seules", () => {
  const rows = [
    stored({ filename: "b.pdf" }),
    stored({ filename: "a.xlsx" }),
    stored({ filename: "c.jpg", status: "DISCOVERED", storagePublicId: null }),
  ]

  it("déterministe, indépendante de l'ordre, ignore les pièces non STORED", () => {
    const h1 = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: rows })
    const h2 = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: [...rows].reverse() })
    const h3 = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: rows.slice(0, 2) })
    assert.equal(h1, h2)
    assert.equal(h1, h3)
    assert.match(h1, /^att1:[0-9a-f]{64}$/)
  })

  it("change si sha / pièce / contenu changent ; ne peut égaler un contentHash hex", () => {
    const base = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: rows })
    assert.notEqual(base, computeAttachmentsOnlyFingerprint({ contentHash: "x", attachments: rows }))
    assert.notEqual(
      base,
      computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: [{ ...rows[0], sha256: "zz" }, rows[1]] })
    )
    assert.notEqual(base, computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: [rows[0]] }))
    assert.equal(/^[0-9a-f]{64}$/.test(base), false)
  })
})

describe("barrières AUTO / conversion non affaiblies par l'empreinte att1:", () => {
  const att1 = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments: [stored({ filename: "BC.pdf" })] })

  it("fraîcheur AUTO : extraction PJ seules jamais FRESH (detection/source ≠ att1:)", () => {
    for (const current of [null, "hash-text", att1]) {
      const f = evaluateAutoDecisionSourceFreshness({
        detectionContentHash: "hash-text",
        contentHashAtExtraction: att1,
        currentSourceContentHash: current,
      })
      assert.equal(f.ok, false)
    }
  })

  it("décision AUTO_APPROVE_CONVERT sur draft PJ seules → HUMAN_REVIEW_REQUIRED", () => {
    const d = gateAutoDecisionByDetectionProof({
      decision: { code: "AUTO_APPROVE_CONVERT", reasons: [] as string[], scores: {} },
      detectionClassification: "CONSULTATION",
      detectionContentHash: "hash-text",
      contentHashAtExtraction: att1,
      currentSourceContentHash: null,
    })
    assert.equal(d.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(d.reasons.includes("SOURCE_CONTENT_STALE"))
  })

  it("conversion/approbation AUTO (requireSourceContentHash) → STALE en transaction", async () => {
    const tx = {
      worksiteImportDraft: {
        async findFirst() {
          return { detectionContentHash: "hash-text", contentHashAtExtraction: att1, acquisitionMessageId: "m1" }
        },
      },
      async $queryRaw() {
        return []
      },
    }
    const r = await assertAutoDecisionSourceFreshInTransaction(tx as never, {
      companyId: "co1",
      draftId: "d1",
      expectedContentHash: att1,
    })
    assert.equal(r, "STALE")
  })
})

describe("DraftExtractionRepository.persistExtraction — ATTACHMENTS_ONLY (TX recalculée)", () => {
  function fakeDb(state: {
    content: { contentHash: string; normalizedText: string } | null
    attachments: Array<{ id: string; filename: string; sha256: string | null; storagePublicId: string | null; sizeBytes: number; status: string }>
  }) {
    const updates: Array<Record<string, unknown>> = []
    const tx = {
      worksiteImportDraft: {
        async findFirst() {
          return { acquisitionMessageId: "m1" }
        },
        async updateMany(args: { data: Record<string, unknown> }) {
          updates.push(args.data)
          return { count: 1 }
        },
      },
      acquisitionMessageContent: {
        async findFirst() {
          return state.content
        },
      },
      acquisitionAttachment: {
        async findMany() {
          return state.attachments
        },
      },
    }
    return {
      updates,
      db: { async $transaction(cb: (t: typeof tx) => Promise<unknown>) { return cb(tx) } },
    }
  }
  const attachments = [{ id: "a1", filename: "BC.pdf", sha256: "s1", storagePublicId: "p1", sizeBytes: 10, status: "STORED" }]
  const fp = computeAttachmentsOnlyFingerprint({ contentHash: null, attachments })
  const input = (expected: string): PersistExtractionInput => ({
    companyId: "co1",
    draftId: "d1",
    expectedVersion: 1,
    expectedContentHash: expected,
    sourceKind: "ATTACHMENTS_ONLY",
    status: "PENDING_REVIEW",
    fields: {} as never,
    confidenceData: {},
    warningData: [],
    extractedData: {},
    providerId: "fake",
    model: null,
    errorCode: null,
    now: new Date(),
  })

  it("empreinte identique → OK et contentHashAtExtraction = att1:", async () => {
    const f = fakeDb({ content: null, attachments })
    const out = await new DraftExtractionRepository(f.db as never).persistExtraction(input(fp))
    assert.equal(out, "OK")
    assert.equal(f.updates[0].contentHashAtExtraction, fp)
  })

  it("texte apparu → STALE_CONTENT ; pièce changée → STALE_CONTENT", async () => {
    const withText = fakeDb({ content: { contentHash: "h", normalizedText: "Bonjour" }, attachments })
    assert.equal(await new DraftExtractionRepository(withText.db as never).persistExtraction(input(fp)), "STALE_CONTENT")
    assert.equal(withText.updates[0].lastExtractionErrorCode, "STALE_CONTENT")
    const changed = fakeDb({ content: null, attachments: [{ ...attachments[0], sha256: "s2" }] })
    assert.equal(await new DraftExtractionRepository(changed.db as never).persistExtraction(input(fp)), "STALE_CONTENT")
  })

  it("défaut MESSAGE_CONTENT inchangé : contenu absent → STALE_CONTENT", async () => {
    const f = fakeDb({ content: null, attachments })
    const legacy = { ...input("hash-text"), sourceKind: undefined }
    assert.equal(await new DraftExtractionRepository(f.db as never).persistExtraction(legacy), "STALE_CONTENT")
  })
})
