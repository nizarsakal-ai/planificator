/**
 * PLAN-ACQ-MULTIMODAL — Correctifs revue (NO-GO fcd1860).
 * P0 vision → jamais AUTO ; P1-1 homonymes ; P1-2 EXTRACTING orphelin ;
 * P1-3 limite base64 / rejet visuel ; P1-4 échéance ; P2-1 flag ; P2-2 non-écrasement.
 * Aucun appel réel : clients / repos mockés.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BadRequestError } from "@anthropic-ai/sdk"
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages"
import { mapAnthropicRawToProviderResult } from "@/lib/acquisition/extraction/anthropic-extraction.schema"
import { normalizeProviderResult } from "@/lib/acquisition/extraction/extraction-normalize"
import { evaluateAutoDecisionRules } from "@/lib/acquisition/policy/auto-decision.policy"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import { buildAutoDecisionPolicyInput } from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import { AnthropicExtractionAdapter } from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import {
  DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
  EXTRACTION_TOOL_NAME,
  type AnthropicPublicConfig,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import {
  runDraftExtraction,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import type {
  ExtractionProviderPort,
  NormalizedExtractInput,
} from "@/lib/acquisition/extraction/extraction-provider.port"
import {
  getConsultationUiActions,
  getReExtractPolicy,
  isExtractingReclaimable,
} from "@/lib/acquisition/review/consultation-ui"
import { reExtractImportDraftActionImpl, RELAUNCH_DEADLINE_MS } from "@/lib/actions/acquisition-review.actions.core"
import { prepareManualReExtraction } from "@/lib/acquisition/extraction/manual-reextract-preparation"
import { extractXlsxText } from "@/lib/acquisition/extraction/xlsx-text-extract"
import {
  buildMinimalEmptyPdf,
  buildFlateCompressedMultiBlockPdf,
  buildMinimalTextPdf,
  withPdfDocument,
} from "@/lib/acquisition/extraction/pdf-text-extract"
import { buildMinimalJpeg, buildXlsx } from "./helpers/multimodal-fixtures"
import { createFakeExtractionRepo, storedAttachment } from "./helpers/fake-extraction-repo"

const actor = { userId: "u1", role: "ADMIN" as const, companyId: "co1" as string | null }
const FLAG_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_EXTRACTION_ENABLED",
  "ACQUISITION_EXTRACTION_PROVIDER",
  "ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED",
  "ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED",
] as const

function useFlags(values: Partial<Record<(typeof FLAG_KEYS)[number], string>>) {
  const backup: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of FLAG_KEYS) backup[k] = process.env[k]
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED
    delete process.env.ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED
    for (const [k, v] of Object.entries(values)) process.env[k] = v
  })
  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })
}

function anthropicConfig(): AnthropicPublicConfig {
  return {
    providerId: "anthropic",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    maxTokens: 1024,
    timeoutMs: 5_000,
    serviceTimeoutMs: 30_000,
    maxPromptBytes: 32_768,
    maxInputBytes: 32_768,
    maxResponseBytes: 641_024,
    configured: true,
    hasApiKey: true,
  }
}

function toolMessage(input: unknown): Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    stop_reason: "tool_use",
    stop_details: null,
    content: [{ type: "tool_use", id: "t1", name: EXTRACTION_TOOL_NAME, input, caller: { type: "direct" } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Message
}

// Scénario de la repro du reviewer (repro-visual.ts).
const ev = (q: string, s = "BODY") => ({ source: s, quote: q })
const REPRO_BODY =
  "Bonjour, chantier Résidence Les Pins du 2026-11-16 au 2026-11-20. Voir bon de commande joint."
const REPRO_RAW = {
  fields: {
    worksiteName: { value: "Résidence Les Pins", confidence: 0.85, evidence: ev("chantier Résidence Les Pins") },
    requestedStartDate: { value: "2026-11-16", confidence: 0.85, evidence: ev("2026-11-16") },
    requestedEndDate: { value: "2026-11-20", confidence: 0.85, evidence: ev("2026-11-20") },
    address: { value: "12 rue Attaquant", confidence: 0.9, evidence: ev("12 rue Attaquant", "ATTACHMENT_VISUAL") },
    city: { value: "Lyon", confidence: 0.9, evidence: ev("Lyon", "ATTACHMENT_VISUAL") },
    clientName: { value: "ACME Fake", confidence: 0.9, evidence: ev("ACME Fake", "ATTACHMENT_VISUAL") },
  },
  warnings: [],
}

function rulesInputFrom(n: ReturnType<typeof normalizeProviderResult>, extra: Record<string, unknown> = {}) {
  return {
    worksiteName: n.fields.worksiteName ?? null,
    startDate: new Date("2026-11-16T00:00:00Z"),
    endDate: new Date("2026-11-20T00:00:00Z"),
    referenceInstant: new Date("2026-10-27T00:00:00Z"),
    address: n.fields.address ?? null,
    postalCode: null,
    city: n.fields.city ?? null,
    clientName: n.fields.clientName ?? null,
    clientEmail: null,
    confidenceData: n.confidenceData,
    warningData: n.warnings,
    autoApproveEnabled: true,
    autoConvertEnabled: true,
    minConfidence: 0.75,
    potentialDuplicate: false,
    clientAmbiguous: false,
    requiredDocumentUnreadable: false,
    consultationCancelled: false,
    hasResolvedClient: false,
    ...extra,
  }
}

describe("P0 — une valeur lue en vision ne mène jamais à une décision AUTO", () => {
  it("repro reviewer : AUTO_APPROVE_CONVERT → désormais HUMAN_REVIEW_REQUIRED (ATTACHMENT_EVIDENCE_REQUIRES_HUMAN)", () => {
    const r = mapAnthropicRawToProviderResult({ raw: REPRO_RAW, haystack: REPRO_BODY, model: "m", latencyMs: 1, visualEvidenceAllowed: true })
    const n = normalizeProviderResult(r)
    const d = evaluateAutoDecisionRules(rulesInputFrom(n))
    assert.equal(d.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(d.reasons.includes("ATTACHMENT_EVIDENCE_REQUIRES_HUMAN"), d.reasons.join(","))
  })

  it("défense en profondeur : evidence ATTACHMENT_* seule (sans warning) bloque aussi", () => {
    const r = mapAnthropicRawToProviderResult({ raw: REPRO_RAW, haystack: REPRO_BODY, model: "m", latencyMs: 1, visualEvidenceAllowed: true })
    const n = normalizeProviderResult(r)
    const base = rulesInputFrom(n, { warningData: [] })
    assert.equal(evaluateAutoDecisionRules({ ...base, evidenceData: n.evidenceData }).code, "HUMAN_REVIEW_REQUIRED")
    assert.equal(evaluateAutoDecisionRules({ ...base, attachmentDerivedEvidence: true }).code, "HUMAN_REVIEW_REQUIRED")
    // Témoin : sans aucune provenance PJ, le même dossier passerait (règle ciblée).
    assert.equal(
      evaluateAutoDecisionRules({ ...base, evidenceData: { worksiteName: { source: "BODY" } } }).code,
      "AUTO_APPROVE_CONVERT"
    )
  })

  describe("bout en bout : adapter Anthropic mocké + service + décision AUTO / validation / worker", () => {
    useFlags({ ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED: "true", ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

    it("relance MANUELLE avec photo : valeurs visuelles persistées mais toute décision AUTO → revue humaine", async () => {
      const repo = createFakeExtractionRepo({
        content: { normalizedText: REPRO_BODY, contentHash: "hash-text" },
        attachments: [storedAttachment({ filename: "IMG_2635.jpeg", mimeType: "application/octet-stream" })],
      })
      let sentVisual = false
      const adapter = new AnthropicExtractionAdapter({
        config: anthropicConfig(),
        client: {
          async messagesCreate(req) {
            sentVisual = Array.isArray(req.messages[0].content)
            return toolMessage(REPRO_RAW)
          },
        },
      })
      const r = await runDraftExtraction(
        { actor, draftId: "d1" },
        { repository: repo as never, provider: adapter, loadAttachmentBytes: async () => buildMinimalJpeg() }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(sentVisual, true)
      const p = repo.persists[0]
      const codes = p.warningData.map((w) => w.code)
      assert.ok(codes.includes("VISUAL_EVIDENCE_UNVERIFIED"))
      assert.ok(codes.includes("ATTACHMENT_DERIVED_FIELD"))
      const evidence = (p.extractedData as { evidence: Record<string, { source: string }> }).evidence
      assert.equal(evidence.address.source, "ATTACHMENT_VISUAL")

      // 1) policy (chemin legacy auto-decision.service : fields + warnings + evidence persistés)
      const legacy = evaluateAutoDecisionRules({
        worksiteName: p.fields.worksiteName,
        startDate: new Date(`${p.fields.requestedStartDate}T00:00:00Z`),
        endDate: new Date(`${p.fields.requestedEndDate}T00:00:00Z`),
        referenceInstant: new Date("2026-10-27T00:00:00Z"),
        address: p.fields.address,
        postalCode: null,
        city: p.fields.city,
        clientName: p.fields.clientName,
        clientEmail: null,
        confidenceData: p.confidenceData,
        warningData: p.warningData,
        autoApproveEnabled: true,
        autoConvertEnabled: true,
        minConfidence: 0.5,
        evidenceData: evidence,
      })
      assert.equal(legacy.code, "HUMAN_REVIEW_REQUIRED")
      assert.ok(legacy.reasons.includes("ATTACHMENT_EVIDENCE_REQUIRES_HUMAN"))

      // 2) capability de validation (orchestrateur POST_EXTRACTION_STEPS)
      const snapshot = {
        worksiteName: p.fields.worksiteName,
        address: p.fields.address,
        city: p.fields.city,
        postalCode: null,
        clientName: p.fields.clientName,
        clientEmail: null,
        requestedStartDate: p.fields.requestedStartDate,
        requestedEndDate: p.fields.requestedEndDate,
        confidenceData: p.confidenceData,
        warnings: p.warningData.map((w) => ({ code: w.code, blocking: w.blocking, severity: w.severity })),
      }
      const v = validateConsultation({
        companyId: "co1",
        draftId: "d1",
        classification: "CONSULTATION",
        extractedSnapshot: snapshot,
        partnerProfile: { partnerId: "p", partnerCode: "X", minConfidence: 0.5 },
        referenceInstant: new Date("2026-10-27T00:00:00Z"),
      })
      assert.equal(v.code, "QUARANTINE")
      assert.ok(v.reasons.includes("ATTACHMENT_EVIDENCE_REQUIRES_HUMAN"))
      const vSnapOnly = validateConsultation({
        companyId: "co1",
        draftId: "d1",
        classification: "CONSULTATION",
        extractedSnapshot: { ...snapshot, warnings: [], attachmentDerivedEvidence: true },
        partnerProfile: { partnerId: "p", partnerCode: "X", minConfidence: 0.5 },
        referenceInstant: new Date("2026-10-27T00:00:00Z"),
      })
      assert.equal(vSnapOnly.code, "QUARANTINE")

      // 3) worker auto-décision (buildAutoDecisionPolicyInput)
      const policyInput = buildAutoDecisionPolicyInput({
        ctx: { snapshot: { ...snapshot, warnings: [], attachmentDerivedEvidence: true }, partnerProfile: null, partner: null } as never,
        effectiveAutoApproveEnabled: true,
        effectiveAutoConvertEnabled: true,
      })
      const w = evaluateAutoDecisionRules({ ...policyInput, minConfidence: 0.5, referenceInstant: new Date("2026-10-27T00:00:00Z") })
      assert.equal(w.code, "HUMAN_REVIEW_REQUIRED")
    })

    it("contexte AUTO (cron / orchestrateur) : vision désactivée, aucun bloc visuel envoyé, aucun avertissement bruyant", async () => {
      const repo = createFakeExtractionRepo({
        content: { normalizedText: "Chantier : Tour Alpha", contentHash: "hash-text" },
        attachments: [storedAttachment({ filename: "IMG_2635.jpeg", mimeType: "image/jpeg" })],
      })
      const calls: NormalizedExtractInput[] = []
      const provider: ExtractionProviderPort = {
        supportsVisualInputs: true,
        async extract(input) {
          calls.push(input)
          return {
            fields: { worksiteName: { value: "Tour Alpha", confidence: 0.8, evidence: { source: "BODY", quote: "Tour Alpha" } } },
            warnings: [],
            providerMetadata: { providerId: "fake" },
          }
        },
      }
      let loaded = 0
      const r = await runDraftExtractionSystem(
        { companyId: "co1", draftId: "d1" },
        { repository: repo as never, provider, loadAttachmentBytes: async () => (loaded++, buildMinimalJpeg()) }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(calls[0].attachmentVisuals, undefined)
      assert.equal(loaded, 0)
      const p = repo.persists[0]
      assert.deepEqual((p.extractedData as { attachmentReadOutcomes: unknown[] }).attachmentReadOutcomes, [
        { attachmentId: "att-IMG_2635.jpeg", filename: "IMG_2635.jpeg", kind: "image", outcome: "IGNORED_VISION_DISABLED", reason: "AUTO_CONTEXT" },
      ])
      assert.ok(!p.warningData.some((w) => w.code === "ATTACHMENT_NOT_READ"))
      assert.ok(!p.warningData.some((w) => w.code === "ATTACHMENT_DERIVED_FIELD"))
    })

    it("AUTO : un champ issu d'un extrait PDF (non cité dans le mail) est marqué ATTACHMENT_DERIVED_FIELD", async () => {
      const repo = createFakeExtractionRepo({
        content: { normalizedText: "Chantier : Tour Alpha. Voir PJ.", contentHash: "hash-text" },
        attachments: [storedAttachment({ filename: "bc.pdf", mimeType: "application/pdf" })],
      })
      const provider: ExtractionProviderPort = {
        async extract() {
          return {
            fields: {
              worksiteName: { value: "Tour Alpha", confidence: 0.8, evidence: { source: "BODY", quote: "Tour Alpha" } },
              address: { value: "5 avenue Test", confidence: 0.8, evidence: { source: "BODY", quote: "5 avenue Test" } },
            },
            warnings: [],
            providerMetadata: { providerId: "fake" },
          }
        },
      }
      const r = await runDraftExtractionSystem(
        { companyId: "co1", draftId: "d1" },
        { repository: repo as never, provider, loadAttachmentBytes: async () => buildFlateCompressedMultiBlockPdf(["Adresse 5 avenue Test"]) }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      const derived = repo.persists[0].warningData.filter((w) => w.code === "ATTACHMENT_DERIVED_FIELD").map((w) => w.field)
      assert.deepEqual(derived, ["address"])
    })
  })
})

describe("P1-1 — homonymes : association par id de pièce", () => {
  useFlags({ ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED: "true", ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

  it("deux « plan.pdf » PLAN : l'un lu en vision, l'autre illisible → REQUIRED_DOCUMENT_UNREADABLE conservé", async () => {
    const repo = createFakeExtractionRepo({
      content: { normalizedText: "Chantier : Tour Alpha", contentHash: "hash-text" },
      attachments: [
        storedAttachment({ id: "pa", filename: "plan.pdf", mimeType: "application/pdf", category: "PLAN" }),
        storedAttachment({ id: "pb", filename: "plan.pdf", mimeType: "application/pdf", category: "PLAN", storagePublicId: "pid/b" }),
      ],
    })
    const provider: ExtractionProviderPort = {
      supportsVisualInputs: true,
      async extract() {
        return {
          fields: { worksiteName: { value: "Tour Alpha", confidence: 0.8, evidence: { source: "BODY", quote: "Tour Alpha" } } },
          warnings: [],
          providerMetadata: { providerId: "fake" },
        }
      },
    }
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      {
        repository: repo as never,
        provider,
        loadAttachmentBytes: async (a) => (a.storagePublicId === "pid/b" ? Buffer.from("%PDF-1.4 corrompu") : buildMinimalEmptyPdf()),
      }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    const p = repo.persists[0]
    assert.deepEqual(
      (p.extractedData as { attachmentReadOutcomes: Array<{ attachmentId: string; outcome: string }> }).attachmentReadOutcomes.map(
        (o) => [o.attachmentId, o.outcome]
      ),
      [
        ["pa", "READ_VISION"],
        ["pb", "FAILED"],
      ]
    )
    assert.ok(p.warningData.some((w) => w.code === "REQUIRED_DOCUMENT_UNREADABLE"))
  })

  it("UI : le détail associe les issues par id (repli nom de fichier pour l'historique)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/consultations/ConsultationDetail.tsx"), "utf8")
    assert.match(src, /readingById\.get\(a\.id\)/)
    assert.match(src, /legacyByFilename/)
  })
})

describe("P1-2 — brouillon EXTRACTING interrompu : relance manuelle", () => {
  useFlags({ ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

  it("politique : EXTRACTING récent refusé, orphelin (> TTL reclaim) autorisé sans force", () => {
    const now = new Date("2026-10-27T12:00:00Z")
    assert.equal(isExtractingReclaimable("EXTRACTING", new Date(now.getTime() - 60_000), now), false)
    assert.equal(isExtractingReclaimable("EXTRACTING", new Date(now.getTime() - 6 * 60_000), now), true)
    assert.equal(isExtractingReclaimable("FAILED", new Date(0), now), false)
    assert.deepEqual(getReExtractPolicy("EXTRACTING"), { allowed: false })
    assert.deepEqual(getReExtractPolicy("EXTRACTING", { extractingReclaimable: true }), { allowed: true, force: false })
    assert.equal(getConsultationUiActions("EXTRACTING", { extractingReclaimable: true }).canReExtract, true)
    assert.equal(getConsultationUiActions("EXTRACTING").canReExtract, false)
  })

  it("action + service : un brouillon PJ seules bloqué en EXTRACTING est repris puis extrait", async () => {
    const started = new Date(Date.now() - 10 * 60_000)
    const repo = createFakeExtractionRepo({
      content: null,
      attachments: [storedAttachment({ filename: "BC.pdf", mimeType: "application/pdf" })],
      draft: { status: "EXTRACTING", version: 3, extractionStartedAt: started, extractionAttemptCount: 1 },
    })
    const r = await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        auth: async () => ({ user: { id: "u1", role: "ADMIN" as const, companyId: "co1" } }),
        getImportDraftStatusForReview: async () => ({ id: "d1", status: "EXTRACTING" as const, version: 3, extractionStartedAt: started }),
        revalidatePath: () => {},
        prepareManualReExtraction: async () => ({ warnings: [], contentFetched: false, attachmentsStored: 0 }),
        runDraftExtraction: (input) =>
          runDraftExtraction(input, {
            repository: repo as never,
            loadAttachmentBytes: async () => buildFlateCompressedMultiBlockPdf(["Chantier : Residence Les Lilas"]),
          }),
      }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(repo.claims.length, 1)
    assert.ok(repo.claims[0].reclaimBefore && repo.claims[0].reclaimBefore > started)
    assert.equal(repo.draft.status, "PENDING_REVIEW")
  })

  it("EXTRACTING récent : relance refusée (INVALID_STATE), aucune extraction", async () => {
    let ran = false
    const r = await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        auth: async () => ({ user: { id: "u1", role: "ADMIN" as const, companyId: "co1" } }),
        getImportDraftStatusForReview: async () => ({ id: "d1", status: "EXTRACTING" as const, version: 3, extractionStartedAt: new Date() }),
        prepareManualReExtraction: async () => ({ warnings: [], contentFetched: false, attachmentsStored: 0 }),
        runDraftExtraction: async () => {
          ran = true
          throw new Error("ne doit pas être appelé")
        },
      }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INVALID_STATE")
    assert.equal(ran, false)
  })
})

describe("P1-3 — rejet d'un visuel par l'API : jamais d'échec global", () => {
  useFlags({ ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED: "true", ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

  it("adapter : 400 avec visuels → relance texte seul + VISUAL_INPUTS_DROPPED ; service : pièce marquée FAILED (PROVIDER_REJECTED)", async () => {
    const requests: MessageCreateParamsNonStreaming[] = []
    const adapter = new AnthropicExtractionAdapter({
      config: anthropicConfig(),
      client: {
        async messagesCreate(req) {
          requests.push(JSON.parse(JSON.stringify(req)))
          if (requests.length === 1) {
            throw new BadRequestError(400, { type: "error" }, "image exceeds 5 MB maximum", new Headers())
          }
          return toolMessage({
            fields: { worksiteName: { value: "Tour Alpha", confidence: 0.8, evidence: { source: "BODY", quote: "Tour Alpha" } } },
            warnings: [],
          })
        },
      },
    })
    const repo = createFakeExtractionRepo({
      content: { normalizedText: "Chantier : Tour Alpha", contentHash: "hash-text" },
      attachments: [storedAttachment({ filename: "photo.jpg", mimeType: "image/jpeg" })],
    })
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      { repository: repo as never, provider: adapter, loadAttachmentBytes: async () => buildMinimalJpeg() }
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(requests.length, 2)
    assert.ok(Array.isArray(requests[0].messages[0].content))
    assert.equal(typeof requests[1].messages[0].content, "string")
    const p = repo.persists[0]
    assert.ok(p.warningData.some((w) => w.code === "VISUAL_INPUTS_DROPPED"))
    assert.deepEqual(
      (p.extractedData as { attachmentReadOutcomes: Array<{ outcome: string; reason?: string }> }).attachmentReadOutcomes.map((o) => [
        o.outcome,
        o.reason,
      ]),
      [["FAILED", "PROVIDER_REJECTED"]]
    )
  })
})

describe("P1-4 — échéance globale : brouillon toujours libéré", () => {
  useFlags({ ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

  it("échéance trop proche après claim → FAILED retryable (PROVIDER_TIMEOUT), jamais EXTRACTING", async () => {
    const repo = createFakeExtractionRepo({ content: { normalizedText: "Chantier : Tour Alpha", contentHash: "hash-text" } })
    const r = await runDraftExtraction(
      { actor, draftId: "d1", deadlineAt: Date.now() + 500 },
      { repository: repo as never }
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "PROVIDER_TIMEOUT")
      assert.equal(r.outcome, "RETRY_ALLOWED")
    }
    assert.equal(repo.draft.status, "FAILED")
    assert.equal(repo.markFails[0].extractionRetryable, true)
  })

  it("échéance déjà dépassée pendant la lecture des PJ → FAILED retryable", async () => {
    const repo = createFakeExtractionRepo({
      content: null,
      attachments: [storedAttachment({ filename: "BC.pdf", mimeType: "application/pdf" })],
    })
    const deadlineAt = Date.now() + 50
    const r = await runDraftExtraction(
      { actor, draftId: "d1", deadlineAt },
      {
        repository: repo as never,
        loadAttachmentBytes: async () => {
          await new Promise((res) => setTimeout(res, 80))
          return buildMinimalTextPdf("BC")
        },
      }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "PROVIDER_TIMEOUT")
    assert.equal(repo.draft.status, "FAILED")
  })

  it("action : échéance interne transmise à la préparation et à l'extraction", async () => {
    const seen: number[] = []
    await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        auth: async () => ({ user: { id: "u1", role: "ADMIN" as const, companyId: "co1" } }),
        getImportDraftStatusForReview: async () => ({ id: "d1", status: "FAILED" as const, version: 1 }),
        revalidatePath: () => {},
        clock: () => 1_000,
        prepareManualReExtraction: async (i) => {
          seen.push(i.deadlineAt!)
          return { warnings: [], contentFetched: false, attachmentsStored: 0 }
        },
        runDraftExtraction: async (i) => {
          seen.push(i.deadlineAt!)
          return { ok: false, outcome: "FAILED", code: "CONTENT_MISSING", message: "x" }
        },
      }
    )
    assert.deepEqual(seen, [1_000 + RELAUNCH_DEADLINE_MS, 1_000 + RELAUNCH_DEADLINE_MS])
    assert.ok(RELAUNCH_DEADLINE_MS < 300_000)
    const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/consultations/[id]/page.tsx"), "utf8")
    assert.match(page, /export const maxDuration = 300/)
  })

  it("préparation : réserve d'extraction respectée (aucun téléchargement si l'échéance est proche)", async () => {
    let downloads = 0
    const r = await prepareManualReExtraction(
      { companyId: "co1", draftId: "d1", deadlineAt: 50_000 },
      {
        isAcquisitionEnabled: () => true,
        isContentFetchEnabled: () => true,
        isAttachmentDownloadEnabled: () => true,
        findDraftMessageId: async () => "m1",
        findContent: async () => ({ normalizedText: "x" }),
        listAttachments: async () => [{ id: "a1", filename: "a.pdf", status: "DISCOVERED", lastErrorCode: null }],
        downloadAttachment: async () => {
          downloads++
          return { outcome: "STORED", attachmentId: "a1" }
        },
        clock: () => 0,
        log: () => {},
      }
    )
    assert.equal(downloads, 0)
    assert.deepEqual(r.warnings, ["1 pièce(s) restante(s) seront récupérées par la tâche planifiée"])
  })

  it("xlsx : lecture en flux réellement abandonnée à l'échéance", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => [`l${i}`, "x"])
    const buf = await buildXlsx([{ name: "S", rows }])
    const t0 = Date.now()
    const r = await extractXlsxText(buf, { deadlineAt: Date.now() - 1 })
    assert.equal(r.status, "XLSX_PARSE_FAILED")
    assert.ok(Date.now() - t0 < 2_000)
  })

  it("pdf.js : proxy détruit après usage ET à l'échéance", async () => {
    let ref: { loadingTask: { destroyed: boolean } } | null = null
    const ok = await withPdfDocument(buildMinimalTextPdf("x"), 2_000, async (pdf) => {
      ref = pdf as never
      return pdf.numPages
    }, null)
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(ok, 1)
    assert.equal(ref!.loadingTask.destroyed, true)

    const slow = await withPdfDocument<number | "TIMEOUT">(buildMinimalTextPdf("x"), 30, async (pdf) => {
      ref = pdf as never
      await new Promise((res) => setTimeout(res, 300))
      return 1
    }, "TIMEOUT")
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(slow, "TIMEOUT")
    assert.equal(ref!.loadingTask.destroyed, true)
  })
})

describe("P2-1 — flag lecture PJ étendue OFF : comportement historique", () => {
  useFlags({ ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED: "true" })

  it("mail vide + PDF texte, flag OFF → CONTENT_MISSING historique, aucun claim", async () => {
    const repo = createFakeExtractionRepo({
      content: null,
      attachments: [storedAttachment({ filename: "BC.pdf", mimeType: "application/pdf" })],
    })
    const r = await runDraftExtraction({ actor, draftId: "d1" }, { repository: repo as never })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, "CONTENT_MISSING")
      assert.equal(r.message, "Contenu message absent (005A)")
    }
    assert.equal(repo.claims.length, 0)
  })

  it("texte présent, flag OFF → .xlsx non lu (aucun nouveau texte envoyé au provider), pas d'avertissement", async () => {
    const repo = createFakeExtractionRepo({
      content: { normalizedText: "Chantier : Tour Alpha", contentHash: "hash-text" },
      attachments: [storedAttachment({ filename: "croquis.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
    })
    const calls: NormalizedExtractInput[] = []
    let loaded = 0
    const r = await runDraftExtraction(
      { actor, draftId: "d1" },
      {
        repository: repo as never,
        provider: {
          async extract(input) {
            calls.push(input)
            return {
              fields: { worksiteName: { value: "Tour Alpha", confidence: 0.8, evidence: { source: "BODY", quote: "Tour Alpha" } } },
              warnings: [],
              providerMetadata: { providerId: "fake" },
            }
          },
        },
        loadAttachmentBytes: async () => {
          loaded++
          return buildXlsx([{ name: "S", rows: [["SECRET-XLSX"]] }])
        },
      }
    )
    assert.equal(r.ok, true)
    assert.equal(loaded, 0)
    assert.doesNotMatch(calls[0].normalizedText, /SECRET-XLSX/)
    assert.equal(calls[0].normalizedText, "Chantier : Tour Alpha")
    assert.ok(!repo.persists[0].warningData.some((w) => w.code === "ATTACHMENT_NOT_READ"))
  })
})

describe("P2-2 — échec PJ seules sur un brouillon PENDING_REVIEW : champs proposés conservés", () => {
  useFlags({ ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED: "true" })

  it("gate KO en ATTACHMENTS_ONLY → markFailed (fusion des issues), aucun persist de nulls", async () => {
    const repo = createFakeExtractionRepo({
      content: null,
      attachments: [storedAttachment({ filename: "BC.pdf", mimeType: "application/pdf" })],
      draft: {
        status: "PENDING_REVIEW",
        proposedWorksiteName: "Chantier corrigé à la main",
        extractedData: { postalCode: "75011" },
      },
    })
    const r = await runDraftExtraction(
      { actor, draftId: "d1", force: true },
      {
        repository: repo as never,
        provider: {
          async extract() {
            return { fields: {}, warnings: [], providerMetadata: { providerId: "fake" } }
          },
        },
        loadAttachmentBytes: async () => buildMinimalTextPdf("rien d'exploitable"),
      }
    )
    assert.equal(r.ok, false)
    assert.equal(repo.persists.length, 0)
    assert.equal(repo.draft.status, "FAILED")
    assert.equal(repo.draft.proposedWorksiteName, "Chantier corrigé à la main")
    assert.equal(repo.draft.extractedData?.postalCode, "75011")
    assert.ok(Array.isArray(repo.draft.extractedData?.attachmentReadOutcomes))
  })
})
