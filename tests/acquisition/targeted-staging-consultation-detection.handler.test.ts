/**
 * Harness détection ciblée (Penven) — deps injectées : auth, env, lectures draft / message / contenu /
 * PLAN, détection. Aucun accès réel DB / Gmail / Anthropic. Un test câble la VRAIE capability
 * DefaultConsultationDetectionCapability (politique réelle) sur un repository mémoire.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  TARGETED_DETECTION_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_DETECTION_CHECK_CONFIRMATION,
  TARGETED_DETECTION_RUN_CONFIRMATION,
  handleTargetedStagingConsultationDetection,
  type DetectionHarnessContentProof,
  type DetectionHarnessDetectResult,
  type DetectionHarnessDraft,
  type DetectionHarnessPlan,
  type DetectionHarnessSession,
  type TargetedConsultationDetectionHandlerDeps,
} from "@/lib/acquisition/capabilities/targeted-staging-consultation-detection.handler"
import { DefaultConsultationDetectionCapability } from "@/lib/acquisition/capabilities/consultation-detection.capability"
import {
  CONSULTATION_DETECTION_REQUIRED_PIPELINE,
  classifyConsultationDetection,
  isExtractionAuthorizedDetectionClassification,
} from "@/lib/acquisition/capabilities/consultation-detection.policy"

const ROOT = path.resolve(__dirname, "../..")
const HANDLER_PATH = "src/lib/acquisition/capabilities/targeted-staging-consultation-detection.handler.ts"
const ROUTE_PATH = "src/app/api/acquisition/targeted-staging-consultation-detection/route.ts"

const COMPANY = "cmpqqqyfy0001f5x2blt5qjkh"
const DRAFT = "cmuqzaj380005iz1usjsfb7q4"
const MESSAGE = "cmuqzairp0002iz1u6wk7jqw0"
const CONTENT_HASH = "sha256-fict-content-hash"
const NORMALIZED_TEXT = "TEXTE-SENSIBLE consultation démontage biscuiterie"

const ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: TARGETED_DETECTION_ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_CONSULTATION_DETECTION_ENABLED: "true",
  TARGETED_STAGING_CONSULTATION_DETECTION_COMPANY_ID: COMPANY,
  TARGETED_STAGING_CONSULTATION_DETECTION_DRAFT_ID: DRAFT,
  TARGETED_STAGING_CONSULTATION_DETECTION_MESSAGE_ID: MESSAGE,
}
const ADMIN: DetectionHarnessSession = { user: { id: "u1", role: "ADMIN", companyId: COMPANY } }
const CHECK = { confirmation: TARGETED_DETECTION_CHECK_CONFIRMATION }
const RUN = { confirmation: TARGETED_DETECTION_RUN_CONFIRMATION }

function draftRow(over: Partial<DetectionHarnessDraft> = {}): DetectionHarnessDraft {
  return {
    draftId: DRAFT,
    companyId: COMPANY,
    acquisitionMessageId: MESSAGE,
    status: "PENDING_EXTRACTION",
    version: 0,
    createdWorksiteId: null,
    extractionAttemptCount: 0,
    detectionClassification: null,
    detectionContentHash: null,
    ...over,
  }
}
function content(over: Partial<DetectionHarnessContentProof> = {}): DetectionHarnessContentProof {
  return { companyId: COMPANY, acquisitionMessageId: MESSAGE, hasNormalizedText: true, contentHash: CONTENT_HASH, ...over }
}
function plan(over: Partial<DetectionHarnessPlan> = {}): DetectionHarnessPlan {
  return { id: "att-plan", companyId: COMPANY, acquisitionMessageId: MESSAGE, category: "PLAN", status: "STORED", hasStoragePublicId: true, ...over }
}

function bomb(name: string) {
  return async (): Promise<never> => {
    throw new Error(`${name} MUST NOT BE CALLED`)
  }
}

/** Stockage mémoire du draft : la détection simulée persiste la preuve comme le repository réel. */
function setup(opts: {
  draft?: DetectionHarnessDraft | null
  content?: DetectionHarnessContentProof | null
  plans?: DetectionHarnessPlan[]
  detectResult?: Partial<DetectionHarnessDetectResult>
  persistInStore?: boolean
  over?: Partial<TargetedConsultationDetectionHandlerDeps>
} = {}) {
  let store: DetectionHarnessDraft | null = opts.draft === undefined ? draftRow() : opts.draft
  const calls = { loadDraft: 0, detect: [] as unknown[] }
  const d: TargetedConsultationDetectionHandlerDeps = {
    auth: async () => ADMIN,
    env: { ...ENV },
    loadDraft: async (companyId, draftId) => {
      calls.loadDraft++
      assert.deepEqual([companyId, draftId], [COMPANY, DRAFT])
      return store ? { ...store } : null
    },
    loadMessage: async (companyId, messageId) => {
      assert.deepEqual([companyId, messageId], [COMPANY, MESSAGE])
      return { id: MESSAGE, companyId: COMPANY }
    },
    loadContentProof: async () => (opts.content === undefined ? content() : opts.content),
    listPlanCandidates: async () => opts.plans ?? [plan()],
    detect: async (input) => {
      calls.detect.push(input)
      const result: DetectionHarnessDetectResult = {
        persistOutcome: "PERSISTED",
        classification: "CONSULTATION",
        draftId: DRAFT,
        ...opts.detectResult,
      }
      if (result.persistOutcome === "PERSISTED" && opts.persistInStore !== false && store) {
        store = {
          ...store,
          detectionClassification: result.classification,
          detectionContentHash: CONTENT_HASH,
          version: store.version + 1,
        }
      }
      return result
    },
    ...opts.over,
  }
  return { d, calls, getStore: () => store }
}

async function call(body: unknown, d: TargetedConsultationDetectionHandlerDeps) {
  const res = await handleTargetedStagingConsultationDetection(
    new Request("http://localhost/api/acquisition/targeted-staging-consultation-detection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d
  )
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text, cache: res.headers.get("cache-control") }
}

const NO_IO: Partial<TargetedConsultationDetectionHandlerDeps> = {
  loadDraft: bomb("loadDraft"),
  loadMessage: bomb("loadMessage"),
  loadContentProof: bomb("loadContentProof"),
  listPlanCandidates: bomb("listPlanCandidates"),
  detect: bomb("detect"),
}

describe("gardes d'accès — refus avant toute lecture ou détection", () => {
  const cases: Array<[string, Partial<TargetedConsultationDetectionHandlerDeps>, unknown, number, string]> = [
    ["non Preview", { env: { ...ENV, VERCEL_ENV: "production" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["mauvais project", { env: { ...ENV, VERCEL_PROJECT_ID: "prj_other" } }, RUN, 403, "HARNESS_SURFACE_FORBIDDEN"],
    ["flag désactivé (absent)", { env: { ...ENV, TARGETED_STAGING_CONSULTATION_DETECTION_ENABLED: undefined } }, RUN, 403, "HARNESS_DISABLED"],
    ["flag ≠ true", { env: { ...ENV, TARGETED_STAGING_CONSULTATION_DETECTION_ENABLED: "TRUE" } }, RUN, 403, "HARNESS_DISABLED"],
    ["auth refusée (null)", { auth: async () => null }, RUN, 401, "UNAUTHORIZED"],
    ["auth lève", { auth: async () => { throw new Error("x") } }, RUN, 401, "UNAUTHORIZED"],
    ["mauvais rôle", { auth: async () => ({ user: { id: "u", role: "USER", companyId: COMPANY } }) }, RUN, 403, "FORBIDDEN"],
    ["mauvais tenant", { auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "co-other" } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["session sans companyId", { auth: async () => ({ user: { id: "u", role: "SUPER_ADMIN", companyId: null } }) }, RUN, 403, "TENANT_MISMATCH"],
    ["cible draft absente", { env: { ...ENV, TARGETED_STAGING_CONSULTATION_DETECTION_DRAFT_ID: undefined } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["cible message blanche", { env: { ...ENV, TARGETED_STAGING_CONSULTATION_DETECTION_MESSAGE_ID: " " } }, RUN, 403, "HARNESS_TARGET_UNSET"],
    ["confirmation absente", {}, {}, 400, "CONFIRMATION_REQUIRED"],
    ["RUN mauvaise confirmation", {}, { confirmation: `${TARGETED_DETECTION_RUN_CONFIRMATION} ` }, 400, "CONFIRMATION_REQUIRED"],
    ["confirmation d'un autre harness", {}, { confirmation: "RUN_TARGETED_STAGING_EXTRACTION" }, 400, "CONFIRMATION_REQUIRED"],
    ["body invalide", {}, "{bad", 400, "INVALID_BODY"],
    ["champ inconnu", {}, { ...RUN, force: true }, 400, "UNKNOWN_FIELD"],
  ]
  for (const [label, over, body, status, code] of cases) {
    it(`${label} → ${status} ${code}, zéro lecture, zéro detectConsultation`, async () => {
      const { d } = setup({ over: { ...NO_IO, ...over } })
      const r = await call(body, d)
      assert.equal(r.status, status)
      assert.equal(r.json.code, code)
      assert.equal(r.cache, "no-store")
    })
  }

  for (const key of ["companyId", "draft_id", "messageId", "acquisitionMessageId", "subject", "senderEmail", "classification", "contentHash", "target"]) {
    it(`override « ${key} » → TARGET_OVERRIDE_FORBIDDEN`, async () => {
      const { d } = setup({ over: NO_IO })
      const r = await call({ ...RUN, [key]: "x" }, d)
      assert.equal(r.json.code, "TARGET_OVERRIDE_FORBIDDEN")
    })
  }
})

describe("préconditions (CHECK et RUN) — fail-closed, zéro detectConsultation", () => {
  const cases: Array<[string, Parameters<typeof setup>[0], number, string]> = [
    ["draft introuvable", { draft: null }, 404, "DRAFT_NOT_FOUND"],
    ["mauvais draft (id retourné)", { draft: draftRow({ draftId: "other" }) }, 404, "DRAFT_NOT_FOUND"],
    ["draft d'un autre tenant", { draft: draftRow({ companyId: "co-other" }) }, 404, "DRAFT_NOT_FOUND"],
    ["mauvais message (draft lié ailleurs)", { draft: draftRow({ acquisitionMessageId: "msg-other" }) }, 409, "DRAFT_MESSAGE_MISMATCH"],
    ["mauvais status", { draft: draftRow({ status: "PENDING_REVIEW" }) }, 409, "DRAFT_STATUS_INVALID"],
    ["worksite déjà créé", { draft: draftRow({ createdWorksiteId: "ws-1" }) }, 409, "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS"],
    ["contenu absent", { content: null }, 409, "CONTENT_MISSING"],
    ["contenu sans texte", { content: content({ hasNormalizedText: false }) }, 409, "CONTENT_MISSING"],
    ["contenu sans hash", { content: content({ contentHash: null }) }, 409, "CONTENT_MISSING"],
    ["contenu d'un autre message", { content: content({ acquisitionMessageId: "msg-other" }) }, 409, "CONTENT_MISSING"],
    ["PLAN absent", { plans: [] }, 409, "HARNESS_PLAN_NOT_FOUND"],
    ["PLAN multiple", { plans: [plan(), plan({ id: "att-2" })] }, 409, "HARNESS_PLAN_AMBIGUOUS"],
    ["PLAN non STORED", { plans: [plan({ status: "DISCOVERED" })] }, 409, "HARNESS_PLAN_PRECONDITION_INVALID"],
    ["storagePublicId absent", { plans: [plan({ hasStoragePublicId: false })] }, 409, "HARNESS_PLAN_PRECONDITION_INVALID"],
    ["PLAN d'un autre message", { plans: [plan({ acquisitionMessageId: "msg-other" })] }, 409, "HARNESS_PLAN_PRECONDITION_INVALID"],
  ]
  for (const mode of [CHECK, RUN]) {
    for (const [label, opts, status, code] of cases) {
      it(`${label} (${mode === CHECK ? "CHECK" : "RUN"}) → ${status} ${code}`, async () => {
        const { d, calls } = setup({ ...opts, over: { detect: bomb("detect") } })
        const r = await call(mode, d)
        assert.equal(r.status, status)
        assert.equal(r.json.code, code)
        assert.equal(calls.detect.length, 0)
      })
    }
  }

  it("message introuvable → MESSAGE_NOT_FOUND", async () => {
    const { d } = setup({ over: { loadMessage: async () => null, detect: bomb("detect") } })
    assert.equal((await call(RUN, d)).json.code, "MESSAGE_NOT_FOUND")
  })

  it("lecture en erreur → PRECONDITION_READ_FAILED, code seul", async () => {
    const { d } = setup({ over: { loadDraft: async () => { throw new Error("prisma secret") }, detect: bomb("detect") } })
    const r = await call(RUN, d)
    assert.equal(r.json.code, "PRECONDITION_READ_FAILED")
    assert.ok(!r.text.includes("prisma"))
  })
})

describe("CHECK — read-only absolu", () => {
  it("prérequis OK → ready:true, zéro detectConsultation, zéro mutation, aucun contenu exposé", async () => {
    const { d, calls, getStore } = setup({ over: { detect: bomb("detect") } })
    const before = JSON.stringify(getStore())
    const r = await call(CHECK, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ready, true)
    assert.equal(r.json.mode, "CHECK")
    assert.equal(r.json.detectCalled, false)
    assert.deepEqual(r.json.draft, {
      status: "PENDING_EXTRACTION",
      version: 0,
      extractionAttemptCount: 0,
      createdWorksiteId: null,
      detectionClassification: null,
      detectionProofPresent: false,
    })
    assert.equal(calls.detect.length, 0)
    assert.equal(JSON.stringify(getStore()), before)
    for (const s of [CONTENT_HASH, NORMALIZED_TEXT, "normalizedText", "storagePublicId"]) assert.ok(!r.text.includes(s), s)
  })
})

describe("RUN", () => {
  it("detectConsultation appelé exactement une fois, cible exacte, subject/sender null", async () => {
    const { d, calls } = setup()
    await call(RUN, d)
    assert.deepEqual(calls.detect, [
      { companyId: COMPANY, acquisitionMessageId: MESSAGE, subject: null, senderEmail: null, senderDomain: null },
    ])
  })

  for (const outcome of ["STALE_CONTENT", "STATE_CHANGED", "LEASE_NOT_OWNED", "NO_CONTENT", "NO_DRAFT"]) {
    it(`persistOutcome ${outcome} → DETECTION_NOT_PERSISTED, aucun appel supplémentaire`, async () => {
      const { d, calls } = setup({ detectResult: { persistOutcome: outcome, classification: null } })
      const r = await call(RUN, d)
      assert.equal(r.status, 409)
      assert.equal(r.json.code, "DETECTION_NOT_PERSISTED")
      assert.equal(calls.detect.length, 1)
    })
  }

  for (const classification of ["NOT_CONSULTATION", "UNKNOWN", null] as const) {
    it(`classification non autorisée (${classification}) → DETECTION_NOT_AUTHORIZED`, async () => {
      const { d } = setup({ detectResult: { classification: classification as never } })
      const r = await call(RUN, d)
      assert.equal(r.status, 409)
      assert.equal(r.json.code, "DETECTION_NOT_AUTHORIZED")
    })
  }

  it("détection sur un autre draft → DETECTION_DRAFT_MISMATCH", async () => {
    const { d } = setup({ detectResult: { draftId: "other-draft" } })
    assert.equal((await call(RUN, d)).json.code, "DETECTION_DRAFT_MISMATCH")
  })

  it("preuve finale absente (PERSISTED annoncé mais draft non mis à jour) → DETECTION_PROOF_INCOMPLETE", async () => {
    const { d } = setup({ persistInStore: false })
    const r = await call(RUN, d)
    assert.equal(r.status, 409)
    assert.equal(r.json.code, "DETECTION_PROOF_INCOMPLETE")
    const proof = r.json.proof as Record<string, boolean>
    assert.equal(proof.classificationAuthorized, false)
    assert.equal(proof.detectionContentHashPresent, false)
  })

  it("preuve finale incohérente (chantier / extraction / status apparus) → DETECTION_PROOF_INCOMPLETE", async () => {
    for (const after of [
      { createdWorksiteId: "ws-1" },
      { extractionAttemptCount: 1 },
      { status: "EXTRACTING" },
      { detectionContentHash: "other-hash" },
    ]) {
      let n = 0
      const { d } = setup({
        over: {
          loadDraft: async () => {
            n++
            return n === 1 ? draftRow() : draftRow({ detectionClassification: "CONSULTATION", detectionContentHash: CONTENT_HASH, ...after })
          },
        },
      })
      const r = await call(RUN, d)
      assert.equal(r.json.code, "DETECTION_PROOF_INCOMPLETE", JSON.stringify(after))
    }
  })

  it("détection qui lève → DETECTION_FAILED, code seul", async () => {
    const { d } = setup({ over: { detect: async () => { throw new Error("prisma P2002 secret") } } })
    const r = await call(RUN, d)
    assert.equal(r.status, 500)
    assert.equal(r.json.code, "DETECTION_FAILED")
    assert.ok(!r.text.includes("prisma"))
  })

  it("succès → preuve détection présente, status PENDING_EXTRACTION, aucun chantier, aucune extraction", async () => {
    const { d, calls } = setup()
    const r = await call(RUN, d)
    assert.equal(r.status, 200, r.text)
    assert.equal(calls.detect.length, 1)
    assert.deepEqual(r.json.detection, { persistOutcome: "PERSISTED", classification: "CONSULTATION" })
    assert.ok(Object.values(r.json.proof as Record<string, boolean>).every(Boolean))
    assert.deepEqual(r.json.after, {
      status: "PENDING_EXTRACTION",
      version: 1,
      extractionAttemptCount: 0,
      createdWorksiteId: null,
      detectionClassification: "CONSULTATION",
    })
    for (const s of [CONTENT_HASH, NORMALIZED_TEXT]) assert.ok(!r.text.includes(s), s)
  })
})

describe("intégration — VRAIE DefaultConsultationDetectionCapability (politique réelle), repository mémoire", () => {
  function realDetect(policyInput: { subject: string; normalizedText: string }) {
    const persisted: unknown[] = []
    const snapshot = {
      draftId: DRAFT,
      companyId: COMPANY,
      acquisitionMessageId: MESSAGE,
      draftStatus: "PENDING_EXTRACTION",
      draftVersion: 0,
      detectionClassification: null,
      detectionContentHash: null,
      detectionCompletedAt: null,
      subject: policyInput.subject,
      senderEmail: "jeanlaurentcazala@lauralu.fr",
      senderDomain: "lauralu.fr",
      resolvedPartnerId: "partner-lauralu",
      partnerActive: true,
      partnerCode: "LAURALU",
      partnerPipeline: CONSULTATION_DETECTION_REQUIRED_PIPELINE,
      normalizedText: policyInput.normalizedText,
      contentHash: CONTENT_HASH,
      attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", category: "PLAN" }],
    }
    const repository = {
      loadDetectionSnapshot: async () => snapshot,
      persistDetectionProof: async (input: unknown) => {
        persisted.push(input)
        return "PERSISTED" as const
      },
    }
    const capability = new DefaultConsultationDetectionCapability({ repository: repository as never, now: () => new Date(0) })
    const expected = classifyConsultationDetection({
      subject: snapshot.subject,
      normalizedText: snapshot.normalizedText,
      senderEmail: snapshot.senderEmail,
      senderDomain: snapshot.senderDomain,
      resolvedPartnerId: snapshot.resolvedPartnerId,
      partnerActive: snapshot.partnerActive,
      partnerPipeline: snapshot.partnerPipeline,
      attachments: snapshot.attachments as never,
    }).classification
    return { capability, persisted, expected }
  }

  for (const sample of [
    { subject: "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10", normalizedText: "Bonjour, consultation pour le démontage du stand, merci de nous transmettre votre devis." },
    { subject: "Facture", normalizedText: "Veuillez trouver ci-joint la facture du mois." },
  ]) {
    it(`sujet « ${sample.subject} » : le harness suit exactement la classification de la politique réelle`, async () => {
      const { capability, persisted, expected } = realDetect(sample)
      let store = draftRow()
      const { d } = setup({
        over: {
          loadDraft: async () => ({ ...store }),
          detect: async (input) => {
            const res = await capability.detectConsultation(input)
            if (res.persistOutcome === "PERSISTED") {
              store = { ...store, detectionClassification: res.classification, detectionContentHash: CONTENT_HASH, version: store.version + 1 }
            }
            return { persistOutcome: res.persistOutcome, classification: res.classification, draftId: res.draftId }
          },
        },
      })
      const r = await call(RUN, d)
      assert.equal(persisted.length, 1, "persistance normale via le repository de la capability")
      assert.equal((persisted[0] as { expectedContentHash: string }).expectedContentHash, CONTENT_HASH)
      assert.equal((persisted[0] as { classification: string }).classification, expected)
      if (isExtractionAuthorizedDetectionClassification(expected)) {
        assert.equal(r.status, 200, r.text)
        assert.equal((r.json.detection as { classification: string }).classification, expected)
      } else {
        assert.equal(r.json.code, "DETECTION_NOT_AUTHORIZED")
      }
    })
  }
})

describe("source / route", () => {
  const src = readFileSync(path.join(ROOT, HANDLER_PATH), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("aucune extraction, worksite, Gmail, Anthropic, orchestrateur, worker global, écriture directe ou log", () => {
    for (const forbidden of [
      /runDraftExtraction/, /extraction\.service/, /conversion/i, /worksite\.create/, /gmail/i, /anthropic/i,
      /orchestrator/i, /consultation-detection\.worker/, /runConsultationDetectionWorker/,
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, /\$executeRaw|\$queryRaw|\$transaction/,
      /console\./, /transactionalOwnershipFence/,
    ]) {
      assert.ok(!forbidden.test(code), String(forbidden))
    }
    assert.equal((code.match(/\.detectConsultation\(/g) ?? []).length, 1)
    assert.match(code, /new DefaultConsultationDetectionCapability\(\)\.detectConsultation\(input\)/)
    assert.equal((code.match(/await detect\(/g) ?? []).length, 1)
  })

  it("route mince, POST uniquement", () => {
    const route = readFileSync(path.join(ROOT, ROUTE_PATH), "utf8")
    assert.match(route, /return handleTargetedStagingConsultationDetection\(req\)/)
    assert.ok(!/export async function (GET|PUT|PATCH|DELETE)/.test(route))
  })
})
