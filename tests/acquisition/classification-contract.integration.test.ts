/**
 * Contrat classification extraction ↔ validation (bout en bout, déterministe).
 * Chaîne réelle : sortie provider → normalizeProviderResult → applyDeterministicPostEnrichment
 * → evaluateExtractionGate / buildExtractedDataPayload → draft persisté
 * → buildConsultationEvaluationContext → validateConsultation.
 * Pas de DB réelle, pas de LLM, pas de réseau.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildConsultationEvaluationContext,
  resolveConsultationClassification,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import {
  applyDeterministicPostEnrichment,
  buildExtractedDataPayload,
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"

const COMPANY = "co-classification-contract"
const DRAFT = "draft-classification-contract"
const HASH = "hash-extracted"
const OTHER_HASH = "hash-other"
const REFERENCE_INSTANT = new Date("2026-09-01T00:00:00.000Z")

type ProviderField = { value: unknown; confidence?: number; quote?: string }

const ORDINARY_SUBJECT = "Consultation montage stand Hall A"
const ORDINARY_BODY = [
  "Bonjour, merci de nous chiffrer le chantier Galya Hall A.",
  "Adresse : 12 rue de la Foire 69002 Lyon.",
  "Période : du 2026-09-10 au 2026-09-12.",
  "Client : Expo Events, contact client@expo.fr.",
].join("\n")

function ordinaryFields(extra: Record<string, ProviderField> = {}): Record<string, ProviderField> {
  return {
    worksiteName: { value: "Chantier Galya Hall A", quote: "chantier Galya Hall A" },
    clientName: { value: "Expo Events", quote: "Expo Events" },
    clientEmail: { value: "client@expo.fr", quote: "client@expo.fr" },
    address: { value: "12 rue de la Foire", quote: "12 rue de la Foire" },
    postalCode: { value: "69002" },
    city: { value: "Lyon" },
    requestedStartDate: { value: "2026-09-10", quote: "2026-09-10" },
    requestedEndDate: { value: "2026-09-12", quote: "2026-09-12" },
    ...extra,
  }
}

function providerOutput(fields: Record<string, ProviderField>) {
  return {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, f]) => [
        k,
        {
          value: f.value,
          confidence: f.confidence ?? 0.85,
          ...(f.quote ? { evidence: { source: "BODY", quote: f.quote } } : {}),
        },
      ])
    ),
    warnings: [],
    providerMetadata: { providerId: "anthropic", model: "test" },
  }
}

type Scenario = {
  fields: Record<string, ProviderField>
  subject?: string
  body?: string
  detectionClassification: string | null
  detectionContentHash: string | null
}

/** Extraction réelle (sans provider) → ligne draft telle que persistExtraction l’écrit. */
function extractToDraft(s: Scenario) {
  const subject = s.subject ?? ORDINARY_SUBJECT
  const body = s.body ?? ORDINARY_BODY
  const normalized = applyDeterministicPostEnrichment(normalizeProviderResult(providerOutput(s.fields)), {
    subject,
    body,
    receivedAt: null,
  })
  const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
  const extractedData = buildExtractedDataPayload(normalized.fields, normalized.evidenceData, HASH)
  const f = normalized.fields
  const draft = {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 2,
    proposedWorksiteName: f.worksiteName,
    proposedClientName: f.clientName,
    proposedAddress: f.address,
    proposedPostalCode: f.postalCode,
    proposedCity: f.city,
    proposedStartDate: f.requestedStartDate ? new Date(`${f.requestedStartDate}T00:00:00.000Z`) : null,
    proposedEndDate: f.requestedEndDate ? new Date(`${f.requestedEndDate}T00:00:00.000Z`) : null,
    proposedClientId: null,
    confidenceData: normalized.confidenceData,
    warningData: gate.warnings,
    extractedData,
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: "2",
    detectionClassification: s.detectionClassification,
    detectionContentHash: s.detectionContentHash,
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: null, threadId: null },
  }
  return { draft, gate, normalized }
}

/** DB stub : seule la lecture draft (respectant id/companyId) répond ; tout le reste jette. */
function readOnlyDb(draft: Record<string, unknown>) {
  return new Proxy(
    {},
    {
      get(_t, model) {
        if (typeof model !== "string") return undefined
        return new Proxy(
          {},
          {
            get(_m, op) {
              return async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> } = {}) => {
                if (model !== "worksiteImportDraft" || op !== "findFirst") {
                  throw new Error(`FORBIDDEN_DB_CALL ${String(model)}.${String(op)}`)
                }
                const where = args.where ?? {}
                if (where.id !== draft.id || where.companyId !== draft.companyId) return null
                // Projection select réelle : prouve que les champs Detection sont bien lus.
                if (!args.select) return draft
                return Object.fromEntries(Object.keys(args.select).map((k) => [k, draft[k]]))
              }
            },
          }
        )
      },
    }
  ) as never
}

async function evaluate(s: Scenario) {
  const extraction = extractToDraft(s)
  const ctx = await buildConsultationEvaluationContext({
    companyId: COMPANY,
    draftId: DRAFT,
    deps: {
      db: readOnlyDb(extraction.draft),
      registry: {
        findPartnerById: async () => ({
          id: "p1",
          code: "partner",
          active: true,
          requireExactEmail: false,
          minConfidence: null,
          autoApproveEnabled: true,
          autoConvertEnabled: true,
          allowCreateClient: false,
          clientId: null,
        }),
        findPartnerByDomain: async () => null,
      } as never,
      findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" }) as never,
      matchClient: async () => ({ clientId: "cli-1", matchKind: "EMAIL" }) as never,
    },
  })
  assert.ok(ctx, "evaluation context must load")
  const decision = validateConsultation({
    companyId: COMPANY,
    draftId: DRAFT,
    classification: ctx.classification,
    extractedSnapshot: ctx.snapshot,
    partnerProfile: ctx.partnerProfile,
    referenceInstant: REFERENCE_INSTANT,
  })
  return { ctx, decision, ...extraction }
}

describe("classification contract — positive detection fallback", () => {
  it("1. provider omits classification + same-content CONSULTATION detection → CONSULTATION, no CLASSIFICATION_NULL", async () => {
    const r = await evaluate({
      fields: ordinaryFields(),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH,
    })
    assert.equal(r.gate.pass, true)
    assert.equal(r.draft.extractedData.requestClassification, null)
    assert.equal(r.ctx.classification, "CONSULTATION")
    assert.ok(!r.decision.reasons.includes("CLASSIFICATION_NULL"))
    assert.deepEqual(r.decision, { code: "PASS", reasons: ["THRESHOLDS_OK"] })
    assert.equal(r.ctx.snapshot.consultationCancelled, false)
  })

  it("2. provider omits classification + same-content CONSULTATION_UPDATE detection → CONSULTATION_UPDATE", async () => {
    const r = await evaluate({
      fields: ordinaryFields(),
      detectionClassification: "CONSULTATION_UPDATE",
      detectionContentHash: HASH,
    })
    assert.equal(r.ctx.classification, "CONSULTATION_UPDATE")
    assert.ok(!r.decision.reasons.includes("CLASSIFICATION_NULL"))
    assert.deepEqual(r.decision, { code: "PASS", reasons: ["THRESHOLDS_OK"] })
  })

  it("3. explicit extraction classification wins regardless of detection", async () => {
    const detections: Array<[string | null, string | null]> = [
      ["CONSULTATION_UPDATE", HASH],
      ["AMBIGUOUS", HASH],
      ["NON_CONSULTATION", HASH],
      ["CANCELLATION", HASH],
      [null, null],
      ["CONSULTATION", OTHER_HASH],
    ]
    for (const [detectionClassification, detectionContentHash] of detections) {
      const consult = await evaluate({
        fields: ordinaryFields({ requestClassification: { value: "CONSULTATION" } }),
        detectionClassification,
        detectionContentHash,
      })
      assert.equal(consult.ctx.classification, "CONSULTATION", String(detectionClassification))

      const travaux = await evaluate({
        fields: ordinaryFields({ requestClassification: { value: "TRAVAUX" } }),
        detectionClassification,
        detectionContentHash,
      })
      assert.equal(travaux.ctx.classification, "CONSULTATION_UPDATE", String(detectionClassification))
    }
  })
})

describe("classification contract — fail-closed preserved", () => {
  it("4. provider omits classification without a positive same-content detection → QUARANTINE / CLASSIFICATION_NULL", async () => {
    const cases: Array<[string, string | null, string | null]> = [
      ["AMBIGUOUS", "AMBIGUOUS", HASH],
      ["NON_CONSULTATION", "NON_CONSULTATION", HASH],
      ["null detection", null, null],
      ["null detection hash", "CONSULTATION", null],
      ["hash mismatch", "CONSULTATION", OTHER_HASH],
      ["hash mismatch (update)", "CONSULTATION_UPDATE", OTHER_HASH],
    ]
    for (const [label, detectionClassification, detectionContentHash] of cases) {
      const r = await evaluate({ fields: ordinaryFields(), detectionClassification, detectionContentHash })
      assert.equal(r.ctx.classification, null, label)
      assert.deepEqual(r.decision, { code: "QUARANTINE", reasons: ["CLASSIFICATION_NULL"] }, label)
    }
  })

  it("4b. out-of-enum provider classification is dropped to null and stays fail-closed without positive detection", async () => {
    for (const bad of ["DEMANDE_DE_PRIX", "consultation", 42]) {
      const r = await evaluate({
        fields: ordinaryFields({ requestClassification: { value: bad } }),
        detectionClassification: "AMBIGUOUS",
        detectionContentHash: HASH,
      })
      assert.equal(r.draft.extractedData.requestClassification, null, String(bad))
      assert.equal(r.ctx.classification, null, String(bad))
      assert.deepEqual(r.decision, { code: "QUARANTINE", reasons: ["CLASSIFICATION_NULL"] }, String(bad))
    }
  })

  it("4c. out-of-enum value dropped at extraction is treated like an omission: only a positive same-content proof resolves it", async () => {
    const r = await evaluate({
      fields: ordinaryFields({ requestClassification: { value: "DEMANDE_DE_PRIX" } }),
      detectionClassification: "CONSULTATION",
      detectionContentHash: HASH,
    })
    assert.equal(r.draft.extractedData.requestClassification, null)
    assert.equal(r.ctx.classification, "CONSULTATION")
  })
})

describe("classification contract — cancellation unchanged", () => {
  const CANCEL_SUBJECT = "CONSULTATION Galya Hall A — ANNULEE"
  const CANCEL_BODY = `${ORDINARY_BODY}\nCette consultation est annulée.`

  it("5a. corroborated extraction cancellation stays CANCELLATION and terminal (even with positive detection)", async () => {
    for (const detectionClassification of ["CANCELLATION", "CONSULTATION"]) {
      const r = await evaluate({
        fields: ordinaryFields({
          requestClassification: { value: "CANCELLED_CONSULTATION", quote: "Cette consultation est annulée" },
        }),
        subject: CANCEL_SUBJECT,
        body: CANCEL_BODY,
        detectionClassification,
        detectionContentHash: HASH,
      })
      assert.equal(r.draft.extractedData.requestClassification, "CANCELLED_CONSULTATION")
      assert.ok(r.normalized.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))
      assert.equal(r.ctx.classification, "CANCELLATION")
      assert.equal(r.ctx.snapshot.consultationCancelled, true)
      assert.deepEqual(r.decision, {
        code: "FAIL_TERMINAL",
        reasons: ["CONSULTATION_CANCELLED"],
        errorCode: "CONSULTATION_CANCELLED",
      })
    }
  })

  it("5b. uncorroborated CANCELLED_CONSULTATION keeps the existing downgrade to CONSULTATION", async () => {
    const r = await evaluate({
      fields: ordinaryFields({
        requestClassification: { value: "CANCELLED_CONSULTATION", quote: "merci de nous chiffrer" },
      }),
      detectionClassification: "CANCELLATION",
      detectionContentHash: HASH,
    })
    assert.equal(r.draft.extractedData.requestClassification, "CONSULTATION")
    assert.ok(
      r.normalized.warnings.some(
        (w) => w.code === "PROVIDER_PARTIAL_RESULT" && w.field === "requestClassification"
      )
    )
    assert.ok(!r.normalized.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
    assert.equal(r.ctx.classification, "CONSULTATION")
    assert.equal(r.ctx.snapshot.consultationCancelled, false)
  })

  it("5c. detection CANCELLATION never creates a cancellation through fallback", async () => {
    const r = await evaluate({
      fields: ordinaryFields(),
      subject: CANCEL_SUBJECT,
      body: CANCEL_BODY,
      detectionClassification: "CANCELLATION",
      detectionContentHash: HASH,
    })
    assert.equal(r.draft.extractedData.requestClassification, null)
    assert.ok(!r.normalized.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
    assert.equal(r.ctx.classification, null)
    assert.equal(r.ctx.snapshot.consultationCancelled, false)
    assert.deepEqual(r.decision, { code: "QUARANTINE", reasons: ["CLASSIFICATION_NULL"] })
  })
})

describe("classification contract — resolveConsultationClassification matrix", () => {
  const DETECTIONS = [
    "CONSULTATION",
    "CONSULTATION_UPDATE",
    "CANCELLATION",
    "NON_CONSULTATION",
    "AMBIGUOUS",
    null,
    undefined,
  ] as const
  const HASH_PAIRS: Array<[string, string | null | undefined, string | null | undefined]> = [
    ["same", HASH, HASH],
    ["different", OTHER_HASH, HASH],
    ["detection hash null", null, HASH],
    ["extraction hash null", HASH, null],
    ["both null", null, null],
    ["both empty", "", ""],
    ["undefined", undefined, undefined],
  ]

  it("6a. explicit extraction values always win, for every detection/hash combination", () => {
    const explicit: Array<[string, boolean, string]> = [
      ["CONSULTATION", false, "CONSULTATION"],
      ["INTERVENTION", false, "CONSULTATION_UPDATE"],
      ["TRAVAUX", false, "CONSULTATION_UPDATE"],
      ["CANCELLED_CONSULTATION", false, "CANCELLATION"],
      ["UNKNOWN_LEGACY_VALUE", false, "AMBIGUOUS"],
    ]
    for (const [requestClassification, cancelWarning, expected] of explicit) {
      for (const detectionClassification of DETECTIONS) {
        for (const [, detectionContentHash, contentHashAtExtraction] of HASH_PAIRS) {
          assert.equal(
            resolveConsultationClassification({
              requestClassification,
              consultationCancelledWarning: cancelWarning,
              detectionClassification,
              detectionContentHash,
              contentHashAtExtraction,
            }),
            expected
          )
        }
      }
    }
  })

  it("6b. cancel SERVICE warning with null classification stays CANCELLATION (extraction authority)", () => {
    for (const detectionClassification of DETECTIONS) {
      assert.equal(
        resolveConsultationClassification({
          requestClassification: null,
          consultationCancelledWarning: true,
          detectionClassification,
          detectionContentHash: HASH,
          contentHashAtExtraction: HASH,
        }),
        "CANCELLATION"
      )
    }
  })

  it("6c. fallback only for CONSULTATION / CONSULTATION_UPDATE with an exact, non-null hash match", () => {
    for (const requestClassification of [null, ""]) {
      for (const detectionClassification of DETECTIONS) {
        for (const [label, detectionContentHash, contentHashAtExtraction] of HASH_PAIRS) {
          const got = resolveConsultationClassification({
            requestClassification,
            consultationCancelledWarning: false,
            detectionClassification,
            detectionContentHash,
            contentHashAtExtraction,
          })
          const positive =
            detectionClassification === "CONSULTATION" || detectionClassification === "CONSULTATION_UPDATE"
          const expected = positive && label === "same" ? detectionClassification : null
          assert.equal(got, expected, `${String(detectionClassification)} / ${label} / ${JSON.stringify(requestClassification)}`)
        }
      }
    }
  })
})
