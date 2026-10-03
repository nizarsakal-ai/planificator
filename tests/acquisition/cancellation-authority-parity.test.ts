/**
 * FIX 4 — Autorité d’annulation : service legacy ≡ worker permanent.
 *
 * Contrat : AUTO_REJECT_CANCELLED exige extraction corroborée (CANCELLED_CONSULTATION
 * ou warning bloquant CONSULTATION_CANCELLED) ET Detection CANCELLATION fraîche
 * (hash detection = extraction = source) ET flags global ∩ partenaire.
 * Detection CANCELLATION seule n’est jamais une autorité.
 *
 * Chaîne réelle : sortie provider → normalizeProviderResult → applyDeterministicPostEnrichment
 * → gate → draft ; puis les DEUX chemins AUTO sur la même ligne draft.
 * Pas de DB réelle, pas de LLM, pas de réseau.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  applyDeterministicPostEnrichment,
  buildExtractedDataPayload,
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import { classifyConsultationDetection } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import { buildConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import { validationDecisionToCode } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"
import { runAcquisitionAutoDecisionWorker } from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import { maybeRunAutoDecisionAfterExtraction } from "@/lib/acquisition/policy/auto-decision.service"
import {
  parseFrozenValidationCycle,
  type DecisionJournalEntry,
  type FrozenValidationCycle,
  type ValidationCycleIdentity,
} from "@/lib/acquisition/policy/decision-journal.repository"

const COMPANY = "co-cancel-parity"
const DRAFT = "draft-cancel-parity"
const MESSAGE = "msg-cancel-parity"
const HASH = "hash-cancel-parity"
const SCHEMA = "2"
const VERSION = 2
/** Validation : horloge injectée. Worker : pas d’horloge injectable → dates lointaines (FUTURE). */
const REFERENCE_INSTANT = new Date("2026-09-01T00:00:00.000Z")

type ProviderField = { value: unknown; confidence?: number; quote?: string }

const ORDINARY_SUBJECT = "Consultation montage stand Hall A"
const ORDINARY_BODY = [
  "Bonjour, merci de nous chiffrer le chantier Galya Hall A.",
  "Adresse : 12 rue de la Foire 69002 Lyon.",
  "Période : du 2099-09-10 au 2099-09-12.",
  "Client : Expo Events, contact client@expo.fr.",
].join("\n")
const CANCEL_SUBJECT = "CONSULTATION Galya Hall A — ANNULEE"
const CANCEL_BODY = `${ORDINARY_BODY}\nCette consultation est annulée.`
const NEGATION_BODY = `${ORDINARY_BODY}\nLa consultation n'est pas annulée, merci de chiffrer.`

function ordinaryFields(extra: Record<string, ProviderField> = {}): Record<string, ProviderField> {
  return {
    worksiteName: { value: "Chantier Galya Hall A", quote: "chantier Galya Hall A" },
    clientName: { value: "Expo Events", quote: "Expo Events" },
    clientEmail: { value: "client@expo.fr", quote: "client@expo.fr" },
    address: { value: "12 rue de la Foire", quote: "12 rue de la Foire" },
    postalCode: { value: "69002" },
    city: { value: "Lyon" },
    requestedStartDate: { value: "2099-09-10", quote: "2099-09-10" },
    requestedEndDate: { value: "2099-09-12", quote: "2099-09-12" },
    ...extra,
  }
}

const CORROBORATED_CANCEL = {
  requestClassification: { value: "CANCELLED_CONSULTATION", quote: "Cette consultation est annulée" },
}
const EXTRACTION_CONSULTATION = { requestClassification: { value: "CONSULTATION" } }

type Scenario = {
  fields: Record<string, ProviderField>
  subject: string
  body: string
  detectionClassification: string
  partnerAutoApprove?: boolean
}

function providerOutput(fields: Record<string, ProviderField>) {
  return {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, f]) => [
        k,
        {
          value: f.value,
          confidence: f.confidence ?? 0.9,
          ...(f.quote ? { evidence: { source: "BODY", quote: f.quote } } : {}),
        },
      ])
    ),
    warnings: [],
    providerMetadata: { providerId: "anthropic", model: "test" },
  }
}

/** Extraction réelle → ligne draft PENDING_REVIEW (preuve Detection fraîche sur HASH). */
function extractToDraft(s: Scenario) {
  const normalized = applyDeterministicPostEnrichment(
    normalizeProviderResult(providerOutput(s.fields)),
    { subject: s.subject, body: s.body, receivedAt: null }
  )
  const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
  assert.equal(gate.pass, true, "fixture doit persister PENDING_REVIEW")
  const f = normalized.fields
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: VERSION,
    proposedWorksiteName: f.worksiteName,
    proposedClientName: f.clientName,
    proposedAddress: f.address,
    proposedPostalCode: f.postalCode,
    proposedCity: f.city,
    proposedStartDate: f.requestedStartDate ? new Date(`${f.requestedStartDate}T00:00:00.000Z`) : null,
    proposedEndDate: f.requestedEndDate ? new Date(`${f.requestedEndDate}T00:00:00.000Z`) : null,
    proposedContactEmail: null,
    proposedClientId: null,
    confidenceData: normalized.confidenceData,
    warningData: gate.warnings,
    extractedData: buildExtractedDataPayload(normalized.fields, normalized.evidenceData, HASH),
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: SCHEMA,
    detectionClassification: s.detectionClassification,
    detectionContentHash: HASH,
    acquisitionMessageId: MESSAGE,
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: "expo.fr", threadId: null },
  }
}

type Draft = ReturnType<typeof extractToDraft>

function partnerRecord(autoApproveEnabled: boolean) {
  return {
    id: "p1",
    companyId: COMPANY,
    code: "partner",
    name: "Partner",
    active: true,
    requireExactEmail: false,
    minConfidence: 0.75,
    autoApproveEnabled,
    autoConvertEnabled: true,
    allowCreateClient: false,
    clientId: null,
  }
}

/** Observateur de mutations commun aux deux chemins. */
type World = {
  draft: Draft
  entries: DecisionJournalEntry[]
  rejectCalls: number
  approveCalls: number
  convertCalls: number
}

function makeWorld(s: Scenario): World {
  return { draft: extractToDraft(s), entries: [], rejectCalls: 0, approveCalls: 0, convertCalls: 0 }
}

/** DB fake : draft + contenu source (hash courant = HASH) + journal partagé. */
function makeDb(w: World) {
  const base = {
    worksiteImportDraft: {
      findFirst: async (args: { where?: { id?: string; companyId?: string } } = {}) => {
        const where = args.where ?? {}
        if (where.id && where.id !== w.draft.id) return null
        if (where.companyId && where.companyId !== w.draft.companyId) return null
        return { ...w.draft }
      },
    },
    acquisitionMessageContent: {
      findFirst: async () => ({ contentHash: HASH }),
    },
    $queryRaw: async () => [{ contentHash: HASH }],
    acquisitionDecisionJournal: {
      findUnique: async (args: { where: { idempotencyKey: string } }) => {
        const i = w.entries.findIndex((e) => e.idempotencyKey === args.where.idempotencyKey)
        if (i < 0) return null
        const e = w.entries[i]!
        return { id: `j${i}`, ...e, metadata: e.metadata ?? null, createdAt: new Date() }
      },
      create: async (args: { data: DecisionJournalEntry }) => {
        w.entries.push(args.data)
        return {
          id: `j${w.entries.length - 1}`,
          ...args.data,
          metadata: args.data.metadata ?? null,
          createdAt: new Date(),
        }
      },
    },
  }
  return Object.assign(base, {
    async $transaction<T>(fn: (tx: typeof base) => Promise<T>): Promise<T> {
      return fn(base)
    },
  })
}

function makeReview(w: World) {
  return {
    approveImportDraft: async () => {
      w.approveCalls++
      w.draft = { ...w.draft, status: "APPROVED", version: w.draft.version + 1 }
      return { ok: true, outcome: "APPROVED", draftId: DRAFT, version: w.draft.version }
    },
    rejectImportDraft: async () => {
      w.rejectCalls++
      w.draft = { ...w.draft, status: "REJECTED", version: w.draft.version + 1 }
      return { ok: true, outcome: "REJECTED", draftId: DRAFT, version: w.draft.version }
    },
  }
}

const ownedFence = { assertOwnedAndLock: async () => "OWNED" as const }
const systemActor = async () => ({ ok: true as const, userId: "sys1", role: "ADMIN" as const })
const noDuplicate = async () => ({ worksiteId: null, matchKind: "NONE" as const })
const clientMatch = async () => ({ clientId: "cli-1", matchKind: "EMAIL" as const, ambiguous: false })

function registryFor(autoApprove: boolean) {
  return {
    findPartnerById: async () => partnerRecord(autoApprove),
    findPartnerByDomain: async () => null,
  }
}

function followUps(w: World): DecisionJournalEntry[] {
  return w.entries.filter((e) => String(e.decisionCode).startsWith("CANCELLATION_"))
}

/** Chemin legacy (hook post-extraction ORCHESTRATOR_AUTO, fence authentique). */
async function runService(s: Scenario): Promise<World & { decisionCode: string; reasons: string[] }> {
  const w = makeWorld(s)
  const db = makeDb(w)
  await maybeRunAutoDecisionAfterExtraction({
    companyId: COMPANY,
    draftId: DRAFT,
    transactionalOwnershipFence: ownedFence,
    deps: {
      db: db as never,
      journal: { append: async (e: DecisionJournalEntry) => void w.entries.push(e) } as never,
      review: makeReview(w) as never,
      conversion: {
        convertImportDraft: async () => {
          w.convertCalls++
          return { ok: true, outcome: "CONVERTED" }
        },
      } as never,
      registry: registryFor(s.partnerAutoApprove ?? true) as never,
      resolveSystemActor: systemActor,
      findDuplicate: noDuplicate as never,
      matchClient: clientMatch as never,
      log: () => {},
      referenceInstant: REFERENCE_INSTANT,
    },
  })
  const decision = w.entries.find((e) =>
    ["AUTO_APPROVE_CONVERT", "AUTO_APPROVE_ONLY", "AUTO_REJECT_CANCELLED", "HUMAN_REVIEW_REQUIRED"].includes(
      String(e.decisionCode)
    )
  )
  assert.ok(decision, "service doit journaliser une décision")
  return { ...w, decisionCode: String(decision.decisionCode), reasons: decision.reasons }
}

/** Journal fake (lectures) pour le worker, sur le tableau partagé. */
function workerJournal(w: World) {
  const isIntent = (c: string) =>
    ["AUTO_APPROVE_ONLY", "AUTO_APPROVE_CONVERT", "AUTO_REJECT_CANCELLED", "HUMAN_REVIEW_REQUIRED"].includes(c)
  const row = (e: DecisionJournalEntry, i: number) => ({
    id: `j${i}`,
    ...e,
    metadata: e.metadata ?? null,
    createdAt: new Date(),
  })
  const latest = (pred: (e: DecisionJournalEntry) => boolean) => {
    for (let i = w.entries.length - 1; i >= 0; i--) {
      const e = w.entries[i]!
      if (e.companyId === COMPANY && e.draftId === DRAFT && pred(e)) return row(e, i)
    }
    return null
  }
  const sameFrozen = (e: DecisionJournalEntry, f: FrozenValidationCycle) => {
    const p = parseFrozenValidationCycle(e.metadata)
    return (
      !!p &&
      p.contentHash === f.contentHash &&
      p.extractionSchemaVersion === f.extractionSchemaVersion &&
      p.validatedDraftVersion === f.validatedDraftVersion
    )
  }
  return {
    async append(e: DecisionJournalEntry) {
      w.entries.push(e)
    },
    async findLatestValidationDecisionForCycle(input: { cycle: ValidationCycleIdentity }) {
      return latest((e) => {
        const m = (e.metadata ?? {}) as Record<string, unknown>
        return (
          String(e.decisionCode).startsWith("VALIDATION_") &&
          m.contentHash === input.cycle.contentHash &&
          m.extractionSchemaVersion === input.cycle.extractionSchemaVersion &&
          m.draftVersion === input.cycle.draftVersion
        )
      })
    },
    async findLatestAutoIntentForCycle(input: { frozen: FrozenValidationCycle }) {
      return latest((e) => isIntent(String(e.decisionCode)) && sameFrozen(e, input.frozen))
    },
    async findLatestCancellationFollowUpForCycle(input: { frozen: FrozenValidationCycle }) {
      return latest((e) => String(e.decisionCode).startsWith("CANCELLATION_") && sameFrozen(e, input.frozen))
    },
    async findLatestSystemActorInvalidForCycle() {
      return null
    },
    async findLatestAutoRejectIntentAny() {
      return latest(
        (e) => e.decisionCode === "AUTO_REJECT_CANCELLED" && !!parseFrozenValidationCycle(e.metadata)
      )
    },
  }
}

/** Chemin permanent : validation réelle journalisée, puis worker auto-decision. */
async function runWorker(s: Scenario): Promise<World & { decisionCode: string; reasons: string[] }> {
  const w = makeWorld(s)
  const db = makeDb(w)
  const evaluationDeps = {
    db: db as never,
    registry: registryFor(s.partnerAutoApprove ?? true) as never,
    findDuplicate: noDuplicate as never,
    matchClient: clientMatch as never,
  }

  const ctx = await buildConsultationEvaluationContext({ companyId: COMPANY, draftId: DRAFT, deps: evaluationDeps })
  assert.ok(ctx)
  const validation = validateConsultation({
    companyId: COMPANY,
    draftId: DRAFT,
    classification: ctx.classification,
    extractedSnapshot: ctx.snapshot,
    partnerProfile: ctx.partnerProfile,
    referenceInstant: REFERENCE_INSTANT,
  })
  w.entries.push({
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode: validationDecisionToCode(validation),
    reasons: validation.reasons,
    scores: {},
    actorUserId: null,
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      contentHash: HASH,
      extractionSchemaVersion: SCHEMA,
      draftVersion: VERSION,
      validationCode: validation.code,
      ...("errorCode" in validation ? { errorCode: validation.errorCode } : {}),
    },
  })

  const result = await runAcquisitionAutoDecisionWorker({
    journal: workerJournal(w) as never,
    selection: {
      async listEligibleCandidates() {
        return [
          {
            draftId: DRAFT,
            companyId: COMPANY,
            status: "PENDING_REVIEW",
            version: VERSION,
            contentHashAtExtraction: HASH,
            extractionSchemaVersion: SCHEMA,
            updatedAt: new Date(),
            selectionPath: validation.code === "FAIL_TERMINAL" ? "CANCEL" : "PASS",
          },
        ]
      },
    },
    isAutoApproveEnabled: () => true,
    isAutoConvertEnabled: () => true,
    ensureOwnership: async () => "OWNED",
    transactionalOwnershipFence: ownedFence,
    resolveSystemActor: systemActor,
    review: makeReview(w) as never,
    evaluationDeps,
    db: db as never,
    log: () => {},
  })
  assert.notEqual(result.status, "FAILED", JSON.stringify(result))
  const intent = w.entries.find((e) =>
    ["AUTO_APPROVE_CONVERT", "AUTO_APPROVE_ONLY", "AUTO_REJECT_CANCELLED", "HUMAN_REVIEW_REQUIRED"].includes(
      String(e.decisionCode)
    )
  )
  assert.ok(intent, `worker doit journaliser un intent (validation=${validation.code})`)
  return { ...w, decisionCode: String(intent.decisionCode), reasons: intent.reasons }
}

function assertNoDestructiveMutation(r: World, label: string) {
  assert.equal(r.rejectCalls, 0, `${label}: rejectImportDraft`)
  assert.equal(followUps(r).length, 0, `${label}: cancellation follow-up`)
  assert.notEqual(r.draft.status, "REJECTED", `${label}: draft rejeté`)
  assert.equal(r.approveCalls, 0, `${label}: approve`)
  assert.equal(r.convertCalls, 0, `${label}: convert`)
}

describe("FIX 4 — autorité d’annulation (service legacy ≡ worker permanent)", () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
  })
  afterEach(() => {
    process.env = { ...env }
  })

  for (const [label, run] of [
    ["service", runService],
    ["worker", runWorker],
  ] as const) {
    it(`A [${label}] — Detection CANCELLATION seule + extraction CONSULTATION → HUMAN, aucune mutation`, async () => {
      const r = await run({
        fields: ordinaryFields(EXTRACTION_CONSULTATION),
        subject: ORDINARY_SUBJECT,
        body: ORDINARY_BODY,
        detectionClassification: "CANCELLATION",
      })
      assert.equal(r.draft.warningData.some((x) => x.code === "CONSULTATION_CANCELLED"), false)
      assert.equal(r.decisionCode, "HUMAN_REVIEW_REQUIRED")
      assertNoDestructiveMutation(r, label)
    })

    it(`B [${label}] — annulation non corroborée (déclassée CONSULTATION) + Detection CANCELLATION → aucun AUTO_REJECT`, async () => {
      const r = await run({
        fields: ordinaryFields({
          requestClassification: { value: "CANCELLED_CONSULTATION", quote: "merci de nous chiffrer" },
        }),
        subject: CANCEL_SUBJECT,
        body: ORDINARY_BODY,
        detectionClassification: "CANCELLATION",
      })
      assert.equal(
        (r.draft.extractedData as { requestClassification: unknown }).requestClassification,
        "CONSULTATION"
      )
      assert.notEqual(r.decisionCode, "AUTO_REJECT_CANCELLED")
      assert.equal(r.decisionCode, "HUMAN_REVIEW_REQUIRED")
      assertNoDestructiveMutation(r, label)
    })

    it(`C [${label}] — extraction corroborée + Detection CONSULTATION → HUMAN, aucun rejet`, async () => {
      const r = await run({
        fields: ordinaryFields(CORROBORATED_CANCEL),
        subject: CANCEL_SUBJECT,
        body: CANCEL_BODY,
        detectionClassification: "CONSULTATION",
      })
      assert.ok(r.draft.warningData.some((x) => x.code === "CONSULTATION_CANCELLED" && x.blocking))
      assert.equal(r.decisionCode, "HUMAN_REVIEW_REQUIRED")
      assertNoDestructiveMutation(r, label)
    })

    it(`D [${label}] — preuve complète (extraction corroborée + Detection CANCELLATION fraîche + flags) → AUTO_REJECT_CANCELLED`, async () => {
      const r = await run({
        fields: ordinaryFields(CORROBORATED_CANCEL),
        subject: CANCEL_SUBJECT,
        body: CANCEL_BODY,
        detectionClassification: "CANCELLATION",
      })
      assert.equal(r.decisionCode, "AUTO_REJECT_CANCELLED")
      assert.equal(r.rejectCalls, 1)
      assert.equal(r.draft.status, "REJECTED")
      assert.equal(followUps(r).length, 1)
      assert.equal(r.approveCalls, 0)
      assert.equal(r.convertCalls, 0)
    })

    it(`E [${label}] — preuve complète mais partner.autoApproveEnabled=false → HUMAN / AUTO_APPROVE_DISABLED`, async () => {
      const r = await run({
        fields: ordinaryFields(CORROBORATED_CANCEL),
        subject: CANCEL_SUBJECT,
        body: CANCEL_BODY,
        detectionClassification: "CANCELLATION",
        partnerAutoApprove: false,
      })
      assert.equal(r.decisionCode, "HUMAN_REVIEW_REQUIRED")
      assert.ok(r.reasons.includes("AUTO_APPROVE_DISABLED"), r.reasons.join(","))
      assertNoDestructiveMutation(r, label)
    })

    it(`F [${label}] — négation « n'est pas annulée » : Detection seule ne provoque jamais AUTO_REJECT`, async () => {
      // Documentaire : heuristique Detection inchangée (peut classer CANCELLATION).
      const detection = classifyConsultationDetection({
        subject: ORDINARY_SUBJECT,
        normalizedText: NEGATION_BODY,
        senderEmail: "client@expo.fr",
        senderDomain: "expo.fr",
        resolvedPartnerId: "p1",
        partnerActive: true,
        partnerPipeline: "consultations",
        attachments: [],
      })
      const r = await run({
        fields: ordinaryFields({
          requestClassification: { value: "CANCELLED_CONSULTATION", quote: "n'est pas annulée" },
        }),
        subject: ORDINARY_SUBJECT,
        body: NEGATION_BODY,
        detectionClassification: detection.classification,
      })
      assert.equal(r.draft.warningData.some((x) => x.code === "CONSULTATION_CANCELLED"), false)
      assert.notEqual(r.decisionCode, "AUTO_REJECT_CANCELLED")
      assertNoDestructiveMutation(r, label)
    })
  }

  it("PARITÉ — matrice detection × extraction : même autorité service / worker", async () => {
    const matrix: Array<{ name: string; s: Scenario; rejects: boolean }> = [
      {
        name: "CANCELLATION × corroborée",
        s: { fields: ordinaryFields(CORROBORATED_CANCEL), subject: CANCEL_SUBJECT, body: CANCEL_BODY, detectionClassification: "CANCELLATION" },
        rejects: true,
      },
      {
        name: "CANCELLATION × CONSULTATION",
        s: { fields: ordinaryFields(EXTRACTION_CONSULTATION), subject: ORDINARY_SUBJECT, body: ORDINARY_BODY, detectionClassification: "CANCELLATION" },
        rejects: false,
      },
      {
        name: "CONSULTATION × corroborée",
        s: { fields: ordinaryFields(CORROBORATED_CANCEL), subject: CANCEL_SUBJECT, body: CANCEL_BODY, detectionClassification: "CONSULTATION" },
        rejects: false,
      },
      {
        name: "CANCELLATION × corroborée × partenaire OFF",
        s: { fields: ordinaryFields(CORROBORATED_CANCEL), subject: CANCEL_SUBJECT, body: CANCEL_BODY, detectionClassification: "CANCELLATION", partnerAutoApprove: false },
        rejects: false,
      },
    ]
    for (const row of matrix) {
      const service = await runService(row.s)
      const worker = await runWorker(row.s)
      assert.equal(service.rejectCalls > 0, row.rejects, `service ${row.name}`)
      assert.equal(worker.rejectCalls > 0, row.rejects, `worker ${row.name}`)
      assert.equal(
        service.decisionCode === "AUTO_REJECT_CANCELLED",
        worker.decisionCode === "AUTO_REJECT_CANCELLED",
        `parité décision ${row.name}`
      )
    }
  })
})
