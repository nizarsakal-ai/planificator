process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { buildConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import {
  AUTO_DECISION_CANCEL_LITERAL,
  TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_CHECK_CONFIRMATION,
  handleTargetedStagingAutoDecisionPreflight,
  type TargetedAutoDecisionPreflightDeps,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-preflight.handler"

const COMPANY = "co-auto-decision-preflight"
const DRAFT = "draft-auto-decision-preflight"
const HASH = "hash-1"
const CONFIRM = TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_CHECK_CONFIRMATION

const BEFORE_PERIOD = new Date("2026-09-05T00:00:00.000Z")
const AFTER_PERIOD = new Date("2026-09-26T00:00:00.000Z")

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
  ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS: "true",
} as const

// Secrets / identifiants qui ne doivent jamais apparaître dans une réponse.
const SECRETS = [
  "client@expo.fr",
  "12 rue de la Foire",
  "Lyon",
  "69002",
  "Client Expo",
  "cli-secret-1",
  "ws-secret-1",
  "msg-secret-1",
  "sys-user-secret-1",
  "0.95",
]

function sessionAuth(role = "ADMIN", companyId: string | null = COMPANY) {
  return (async () => ({ user: { id: "u1", role, companyId } })) as never
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-auto-decision-preflight",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  )
}

type Row = Record<string, unknown>

type Fixture = {
  draft?: Row
  draftMissing?: boolean
  user?: Row | null
  partner?: Row | null
  clientMatch?: { clientId: string | null; matchKind: string; ambiguous?: boolean }
  duplicate?: { worksiteId: string | null; matchKind: string }
  journal?: Row[]
  sourceHash?: string | null
}

function draftRow(over: Row = {}): Row {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "PENDING_REVIEW",
    version: 3,
    proposedWorksiteName: "Chantier Galya Hall A",
    proposedClientName: "Client Expo",
    proposedAddress: "12 rue de la Foire",
    proposedPostalCode: "69002",
    proposedCity: "Lyon",
    proposedStartDate: new Date("2026-09-10T00:00:00.000Z"),
    proposedEndDate: new Date("2026-09-12T00:00:00.000Z"),
    proposedClientId: null,
    confidenceData: { worksiteName: 0.95, requestedStartDate: 0.95, requestedEndDate: 0.95 },
    warningData: [],
    extractedData: {
      requestClassification: "CONSULTATION",
      clientEmail: "client@expo.fr",
      consultationReference: "REF-001",
    },
    contentHashAtExtraction: HASH,
    extractionSchemaVersion: "2",
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: null, threadId: null },
    // Champs preuve détection (lecture séparée, comme le worker).
    detectionClassification: "CONSULTATION",
    detectionContentHash: HASH,
    acquisitionMessageId: "msg-secret-1",
    ...over,
  }
}

function partnerRow(over: Row = {}): Row {
  return {
    id: "p1",
    code: "partner-code",
    active: true,
    requireExactEmail: false,
    autoApproveEnabled: true,
    autoConvertEnabled: true,
    allowCreateClient: false,
    minConfidence: null,
    clientId: null,
    ...over,
  }
}

let rowSeq = 0
function validationRow(decisionCode: string, reasons: string[] = [], meta: Row = {}): Row {
  rowSeq += 1
  return {
    id: `val-${rowSeq}`,
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode,
    reasons,
    scores: {},
    actorUserId: null,
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      contentHash: HASH,
      extractionSchemaVersion: "2",
      draftVersion: 3,
      ...meta,
    },
    createdAt: new Date(`2026-09-04T00:00:${String(rowSeq % 60).padStart(2, "0")}.000Z`),
  }
}

function intentRow(
  decisionCode: string,
  opts: { pipeline?: string | null; validatedDraftVersion?: number } = {}
): Row {
  rowSeq += 1
  const pipeline = opts.pipeline === undefined ? "POST_EXTRACTION_STEPS" : opts.pipeline
  return {
    id: `intent-${rowSeq}`,
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode,
    reasons: [],
    scores: {},
    actorUserId: null,
    metadata: {
      ...(pipeline ? { pipeline } : {}),
      validationCycle: {
        contentHash: HASH,
        extractionSchemaVersion: "2",
        validatedDraftVersion: opts.validatedDraftVersion ?? 3,
      },
    },
    createdAt: new Date(`2026-09-04T01:00:${String(rowSeq % 60).padStart(2, "0")}.000Z`),
  }
}

const SYSTEM_USER = { id: "sys-user-secret-1", companyId: COMPANY, role: "ADMIN", active: true }

const ALLOWED_DB_READS = new Set([
  "worksiteImportDraft.findFirst",
  "acquisitionMessageContent.findFirst",
  "user.findFirst",
  "acquisitionDecisionJournal.findMany",
])

/**
 * DB strict : seules les lectures autorisées répondent, en respectant leurs prédicats
 * (company/draft/message/user) ; tout le reste (écriture, $transaction, raw) jette.
 */
function recordingDb(fx: Fixture) {
  const calls: string[] = []
  const draft = fx.draftMissing ? null : draftRow(fx.draft)
  const user = fx.user === undefined ? SYSTEM_USER : fx.user
  const journalRows = fx.journal ?? [validationRow("VALIDATION_PASS", ["THRESHOLDS_OK"])]
  const db = new Proxy(
    {},
    {
      get(_t, model) {
        if (typeof model !== "string") return undefined
        if (model.startsWith("$")) {
          return async () => {
            calls.push(model)
            throw new Error(`FORBIDDEN_DB_CALL ${model}`)
          }
        }
        return new Proxy(
          {},
          {
            get(_m, op) {
              if (typeof op !== "string") return undefined
              return async (args: { where?: Row } = {}) => {
                const key = `${model}.${op}`
                calls.push(key)
                if (!ALLOWED_DB_READS.has(key)) throw new Error(`FORBIDDEN_DB_CALL ${key}`)
                const where = args.where ?? {}
                if (key === "worksiteImportDraft.findFirst") {
                  return draft && where.id === draft.id && where.companyId === draft.companyId
                    ? draft
                    : null
                }
                if (key === "acquisitionMessageContent.findFirst") {
                  const h = fx.sourceHash === undefined ? HASH : fx.sourceHash
                  const matches =
                    draft != null &&
                    where.companyId === draft.companyId &&
                    where.acquisitionMessageId === draft.acquisitionMessageId
                  return matches && h ? { contentHash: h } : null
                }
                if (key === "user.findFirst") {
                  return user && where.id === user.id ? user : null
                }
                // acquisitionDecisionJournal.findMany — filtre where comme Postgres (sans pagination curseur).
                if ("OR" in where) return []
                const codes = (where.decisionCode as { in?: string[] } | undefined)?.in
                return journalRows
                  .filter(
                    (r) =>
                      r.companyId === where.companyId &&
                      r.draftId === where.draftId &&
                      (!codes || codes.includes(r.decisionCode as string))
                  )
                  .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
              }
            },
          }
        )
      },
    }
  )
  return { db: db as never, calls }
}

function harness(fx: Fixture = {}, over: Partial<TargetedAutoDecisionPreflightDeps> = {}) {
  const rec = recordingDb(fx)
  let nowCalls = 0
  const deps: TargetedAutoDecisionPreflightDeps = {
    auth: sessionAuth(),
    env: PREVIEW_ENV,
    now: () => {
      nowCalls += 1
      return BEFORE_PERIOD
    },
    db: rec.db,
    buildContext: (input) =>
      buildConsultationEvaluationContext({
        companyId: input.companyId,
        draftId: input.draftId,
        deps: {
          db: rec.db,
          registry: {
            findPartnerById: async () =>
              fx.partner === undefined ? partnerRow() : fx.partner,
            findPartnerByDomain: async () => null,
          } as never,
          findDuplicate: async () =>
            (fx.duplicate ?? { worksiteId: null, matchKind: "NONE" }) as never,
          matchClient: async () =>
            (fx.clientMatch ?? { clientId: "cli-secret-1", matchKind: "EMAIL" }) as never,
        },
      }),
    resolveSystemActor: async () => ({ ok: true, userId: "sys-user-secret-1", role: "ADMIN" }),
    isAutoApproveEnabled: () => true,
    isAutoConvertEnabled: () => true,
    isAcquisitionEnabled: () => true,
    isConversionEnabled: () => true,
    isConversionFullyEnabled: () => true,
    ...over,
  }
  return {
    deps,
    calls: rec.calls,
    get nowCalls() {
      return nowCalls
    },
  }
}

async function run(fx: Fixture = {}, over: Partial<TargetedAutoDecisionPreflightDeps> = {}) {
  const h = harness(fx, over)
  const res = await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), h.deps)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text), h }
}

function assertNoSecrets(text: string) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `response leaks ${s}`)
}

async function refusedWith(response: Response, status: number, code: string) {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, code)
}

describe("auto-decision preflight — guards", () => {
  function unreachable(): TargetedAutoDecisionPreflightDeps & { reached: string[] } {
    const reached: string[] = []
    return {
      reached,
      now: () => {
        reached.push("now")
        return BEFORE_PERIOD
      },
      buildContext: async () => {
        reached.push("buildContext")
        return null
      },
      journal: {
        findLatestValidationDecisionForCycle: async () => {
          reached.push("journal")
          return null
        },
        findLatestAutoIntentForCycle: async () => {
          reached.push("journal")
          return null
        },
        findLatestPostExtractionAutoIntentForExtractionIdentity: async () => {
          reached.push("journal")
          return null
        },
      },
      resolveSystemActor: async () => {
        reached.push("systemActor")
        return { ok: false, code: "SYSTEM_ACTOR_MISSING", reason: "env_unset" }
      },
    }
  }

  it("1. rejects outside the allowed Preview project", async () => {
    const d = unreachable()
    for (const env of [
      { ...PREVIEW_ENV, VERCEL_ENV: "production" },
      { ...PREVIEW_ENV, VERCEL_PROJECT_ID: "prj_other" },
    ]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
          ...d,
          auth: sessionAuth(),
          env,
        }),
        403,
        "HARNESS_SURFACE_FORBIDDEN"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("2. rejects when the dedicated flag is not exactly true", async () => {
    const d = unreachable()
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
          ...d,
          auth: sessionAuth(),
          env: { ...PREVIEW_ENV, TARGETED_STAGING_AUTO_DECISION_PREFLIGHT_ENABLED: flag },
        }),
        403,
        "HARNESS_DISABLED"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("3. rejects unauthenticated requests", async () => {
    const d = unreachable()
    await refusedWith(
      await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
        ...d,
        auth: (async () => null) as never,
        env: PREVIEW_ENV,
      }),
      401,
      "UNAUTHORIZED"
    )
    assert.deepEqual(d.reached, [])
  })

  it("4. rejects non-admin roles", async () => {
    const d = unreachable()
    await refusedWith(
      await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
        ...d,
        auth: sessionAuth("USER"),
        env: PREVIEW_ENV,
      }),
      403,
      "FORBIDDEN"
    )
    assert.deepEqual(d.reached, [])
  })

  it("5. rejects malformed JSON", async () => {
    const d = unreachable()
    await refusedWith(
      await handleTargetedStagingAutoDecisionPreflight(request("{not json"), {
        ...d,
        auth: sessionAuth(),
        env: PREVIEW_ENV,
      }),
      400,
      "INVALID_BODY"
    )
    assert.deepEqual(d.reached, [])
  })

  it("6. rejects missing / wrong / RUN-style confirmation", async () => {
    const d = unreachable()
    for (const body of [
      {},
      null,
      { confirmation: "" },
      { confirmation: "CHECK_TARGETED_STAGING_VALIDATION_PREFLIGHT" },
      { confirmation: "RUN_TARGETED_STAGING_AUTO_DECISION_PREFLIGHT" },
      { confirmation: "RUN_TARGETED_STAGING_AUTO_DECISION" },
    ]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(request(body), {
          ...d,
          auth: sessionAuth(),
          env: PREVIEW_ENV,
        }),
        400,
        "CONFIRMATION_REQUIRED"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("7. rejects company/draft target overrides", async () => {
    const d = unreachable()
    for (const key of ["companyId", "company_id", "draftId", "draft_id"]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(
          request({ confirmation: CONFIRM, [key]: "other" }),
          { ...d, auth: sessionAuth(), env: PREVIEW_ENV }
        ),
        400,
        "TARGET_OVERRIDE_FORBIDDEN"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("8. rejects clock overrides", async () => {
    const d = unreachable()
    for (const key of ["referenceInstant", "reference_instant", "now"]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(
          request({ confirmation: CONFIRM, [key]: "2026-09-05T00:00:00.000Z" }),
          { ...d, auth: sessionAuth(), env: PREVIEW_ENV }
        ),
        400,
        "CLOCK_OVERRIDE_FORBIDDEN"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("9. rejects when the target env is missing", async () => {
    const d = unreachable()
    for (const env of [
      { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: undefined },
      { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "  " },
    ]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
          ...d,
          auth: sessionAuth(),
          env,
        }),
        403,
        "HARNESS_TARGET_UNSET"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("10. rejects the explicitly forbidden draft", async () => {
    const d = unreachable()
    await refusedWith(
      await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
        ...d,
        auth: sessionAuth(),
        env: {
          ...PREVIEW_ENV,
          TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
        },
      }),
      403,
      "FORBIDDEN_DRAFT"
    )
    assert.deepEqual(d.reached, [])
  })

  it("11. rejects cross-tenant sessions, including a session without company", async () => {
    const d = unreachable()
    for (const companyId of ["co-other", null]) {
      await refusedWith(
        await handleTargetedStagingAutoDecisionPreflight(request({ confirmation: CONFIRM }), {
          ...d,
          auth: sessionAuth("ADMIN", companyId),
          env: PREVIEW_ENV,
        }),
        403,
        "TENANT_MISMATCH"
      )
    }
    assert.deepEqual(d.reached, [])
  })

  it("12. fails closed when the context is unavailable or out of scope", async () => {
    for (const fx of [
      { draftMissing: true },
      { draft: { contentHashAtExtraction: null } },
      { draft: { companyId: "co-other" } },
      { draft: { id: "draft-other" } },
    ] as Fixture[]) {
      const r = await run(fx)
      assert.equal(r.status, 409)
      assert.equal(r.body.code, "EVALUATION_CONTEXT_UNAVAILABLE")
      assert.equal(r.h.nowCalls, 0)
      assert.ok(!r.h.calls.includes("acquisitionDecisionJournal.findMany"))
    }
  })
})

describe("auto-decision preflight — validation prerequisite", () => {
  it("13. no current-cycle validation → AWAITING_VALIDATION with a hypothetical (never persisted) basis", async () => {
    const r = await run({ journal: [validationRow("VALIDATION_PASS", [], { draftVersion: 2 })] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.validation, { status: "NONE", persisted: false, decisionCode: null })
    assert.equal(r.body.predictedDecision.basis, "HYPOTHETICAL_NO_PERSISTED_PASS")
    assert.equal(r.body.predictedDecision.code, "AUTO_APPROVE_CONVERT")
    assert.equal(r.body.applicationPhase, "SKIP_INELIGIBLE")
    assert.equal(r.body.predictedNextPhase, "AWAITING_VALIDATION")
  })

  it("14. persisted VALIDATION_PASS for the current cycle", async () => {
    const r = await run()
    assert.deepEqual(r.body.validation, {
      status: "PASS",
      persisted: true,
      decisionCode: "VALIDATION_PASS",
    })
    assert.equal(r.body.predictedDecision.basis, "PERSISTED_PASS")
    assert.equal(r.body.applicationPhase, "NEEDS_DECISION")
  })

  it("15. persisted QUARANTINE (non-PASS) → VALIDATION_NOT_PASS", async () => {
    const r = await run({ journal: [validationRow("VALIDATION_QUARANTINE", ["LOW_CONFIDENCE:worksiteName"])] })
    assert.deepEqual(r.body.validation, {
      status: "NOT_PASS",
      persisted: true,
      decisionCode: "VALIDATION_QUARANTINE",
    })
    assert.equal(r.body.predictedDecision.basis, "HYPOTHETICAL_NO_PERSISTED_PASS")
    assert.equal(r.body.applicationPhase, "SKIP_INELIGIBLE")
    assert.equal(r.body.predictedNextPhase, "VALIDATION_NOT_PASS")
  })
})

describe("auto-decision preflight — flags and predicted decision", () => {
  it("16. reports global / partner / effective flags separately", async () => {
    const r = await run(
      { partner: partnerRow({ autoApproveEnabled: true, autoConvertEnabled: false }) },
      { isAutoApproveEnabled: () => true, isAutoConvertEnabled: () => true }
    )
    assert.deepEqual(r.body.flags.autoApprove, { global: true, partner: true, effective: true })
    assert.deepEqual(r.body.flags.autoConvert, { global: true, partner: false, effective: false })
    assert.equal(r.body.flags.postExtractionSteps, true)
    assert.equal(r.body.flags.partnerResolved, true)
    assert.deepEqual(r.body.flags.minConfidence, { value: 0.75, source: "PARTNER_PROFILE" })

    const off = await run({}, { isAutoApproveEnabled: () => false, isAutoConvertEnabled: () => true })
    assert.deepEqual(off.body.flags.autoApprove, { global: false, partner: true, effective: false })
    assert.equal(off.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.deepEqual(off.body.predictedDecision.reasons, ["AUTO_APPROVE_DISABLED"])

    const noPartner = await run({ partner: null })
    assert.equal(noPartner.body.flags.partnerResolved, false)
    assert.deepEqual(noPartner.body.flags.autoApprove, { global: true, partner: false, effective: false })
  })

  it("17. AUTO_APPROVE_CONVERT → WOULD_APPROVE_AND_CONVERT (full response, no leak)", async () => {
    const r = await run()
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, {
      ok: true,
      mode: "CHECK_READ_ONLY",
      referenceInstant: "2026-09-05T00:00:00.000Z",
      draft: {
        id: DRAFT,
        status: "PENDING_REVIEW",
        version: 3,
        cycle: { contentHash: HASH, extractionSchemaVersion: "2", draftVersion: 3 },
        workPeriod: "FUTURE",
      },
      gates: { acquisitionEnabled: true, conversionFlag: true, conversionFullyEnabled: true },
      validation: { status: "PASS", persisted: true, decisionCode: "VALIDATION_PASS" },
      existingIntent: null,
      applicationPhase: "NEEDS_DECISION",
      flags: {
        postExtractionSteps: true,
        partnerResolved: true,
        autoApprove: { global: true, partner: true, effective: true },
        autoConvert: { global: true, partner: true, effective: true },
        minConfidence: { value: 0.75, source: "PARTNER_PROFILE" },
      },
      predictedDecision: {
        basis: "PERSISTED_PASS",
        preGateCode: "AUTO_APPROVE_CONVERT",
        code: "AUTO_APPROVE_CONVERT",
        reasons: ["THRESHOLDS_OK"],
      },
      detection: { classification: "CONSULTATION" },
      sourceFreshness: { ok: true, reason: null, matchesCycle: true },
      systemActor: { ok: true, code: null, reason: null },
      approvalReadiness: { ok: true, refusal: null },
      conversionReadiness: {
        clientMode: "EXISTING",
        clientMatched: true,
        clientAmbiguous: false,
        allowCreateClient: false,
        duplicateBlocked: false,
        duplicateMatchKind: "NONE",
        inputValid: true,
        inputRefusal: null,
      },
      predictedNextPhase: "WOULD_APPROVE_AND_CONVERT",
    })
    assertNoSecrets(r.text)
  })

  it("18. AUTO_APPROVE_ONLY when auto-convert is globally off", async () => {
    const r = await run({}, { isAutoConvertEnabled: () => false })
    assert.equal(r.body.predictedDecision.code, "AUTO_APPROVE_ONLY")
    assert.deepEqual(r.body.predictedDecision.reasons, ["THRESHOLDS_OK", "AUTO_CONVERT_DISABLED"])
    assert.equal(r.body.predictedNextPhase, "APPROVE_ONLY_NO_WORKSITE")
  })

  it("19. HUMAN_REVIEW_REQUIRED on low confidence", async () => {
    const r = await run({
      draft: {
        confidenceData: { worksiteName: 0.2, requestedStartDate: 0.95, requestedEndDate: 0.95 },
      },
    })
    assert.equal(r.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.deepEqual(r.body.predictedDecision.reasons, ["LOW_CONFIDENCE:worksiteName"])
    assert.equal(r.body.predictedNextPhase, "HUMAN_REVIEW")
  })

  it("20. persisted cancelled terminal → AUTO_REJECT_CANCELLED via the CANCEL literal", async () => {
    const r = await run({
      draft: { detectionClassification: "CANCELLATION" },
      journal: [
        validationRow("VALIDATION_FAIL_TERMINAL", ["CONSULTATION_CANCELLED"], {
          errorCode: "CONSULTATION_CANCELLED",
        }),
      ],
    })
    assert.equal(r.body.validation.status, "CANCELLED_TERMINAL")
    assert.equal(r.body.applicationPhase, "NEEDS_DECISION")
    assert.deepEqual(r.body.predictedDecision, {
      basis: "PERSISTED_CANCEL",
      preGateCode: "AUTO_REJECT_CANCELLED",
      code: "AUTO_REJECT_CANCELLED",
      reasons: ["CONSULTATION_CANCELLED"],
    })
    assert.equal(r.body.predictedNextPhase, "WOULD_REJECT_CANCELLED")
  })

  it("21. detection proof downgrades an automatic decision", async () => {
    const r = await run({ draft: { detectionClassification: "NON_CONSULTATION" } })
    assert.equal(r.body.predictedDecision.preGateCode, "AUTO_APPROVE_CONVERT")
    assert.equal(r.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.deepEqual(r.body.predictedDecision.reasons, ["DETECTION_NOT_AUTHORIZED_FOR_AUTO_CONVERSION"])
    assert.equal(r.body.predictedNextPhase, "HUMAN_REVIEW")
  })

  it("22. stale source content downgrades an automatic decision", async () => {
    const r = await run({ sourceHash: "hash-changed" })
    assert.deepEqual(r.body.sourceFreshness, {
      ok: false,
      reason: "SOURCE_HASH_STALE",
      matchesCycle: false,
    })
    assert.equal(r.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.deepEqual(r.body.predictedDecision.reasons, ["SOURCE_CONTENT_STALE", "SOURCE_HASH_STALE"])
    assert.equal(r.body.predictedNextPhase, "HUMAN_REVIEW")

    const missing = await run({ sourceHash: null })
    assert.deepEqual(missing.body.sourceFreshness, {
      ok: false,
      reason: "SOURCE_CONTENT_MISSING",
      matchesCycle: false,
    })
  })

  it("23. missing / invalid system actor blocks without exposing identity", async () => {
    for (const actor of [
      { ok: false as const, code: "SYSTEM_ACTOR_MISSING" as const, reason: "env_unset" },
      { ok: false as const, code: "SYSTEM_ACTOR_INVALID" as const, reason: "user_inactive" },
    ]) {
      const r = await run({}, { resolveSystemActor: async () => actor })
      assert.deepEqual(r.body.systemActor, actor)
      assert.equal(r.body.predictedNextPhase, "BLOCKED_SYSTEM_ACTOR")
    }
    const ok = await run()
    assert.deepEqual(ok.body.systemActor, { ok: true, code: null, reason: null })
    assertNoSecrets(ok.text)
  })

  it("24. blocked client (no match, no allowCreateClient)", async () => {
    const r = await run({ clientMatch: { clientId: null, matchKind: "NONE" } })
    assert.equal(r.body.predictedDecision.code, "AUTO_APPROVE_CONVERT")
    assert.equal(r.body.conversionReadiness.clientMode, "BLOCKED")
    assert.equal(r.body.conversionReadiness.clientMatched, false)
    assert.equal(r.body.predictedNextPhase, "BLOCKED_CLIENT")

    const creatable = await run({
      clientMatch: { clientId: null, matchKind: "NONE" },
      partner: partnerRow({ allowCreateClient: true }),
    })
    assert.equal(creatable.body.conversionReadiness.clientMode, "NEW")
    assert.equal(creatable.body.predictedNextPhase, "WOULD_APPROVE_AND_CONVERT")
    assertNoSecrets(creatable.text)
  })

  it("25. duplicate worksite: policy routes to human review; a recorded CONVERT intent is duplicate-blocked", async () => {
    const dup = { worksiteId: "ws-secret-1", matchKind: "ADDRESS" }
    const fresh = await run({ duplicate: dup })
    assert.equal(fresh.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.ok(fresh.body.predictedDecision.reasons.includes("POTENTIAL_DUPLICATE"))
    assert.equal(fresh.body.predictedNextPhase, "HUMAN_REVIEW")

    const recorded = await run({
      duplicate: dup,
      journal: [validationRow("VALIDATION_PASS"), intentRow("AUTO_APPROVE_CONVERT")],
    })
    assert.deepEqual(recorded.body.existingIntent, {
      decisionCode: "AUTO_APPROVE_CONVERT",
      postExtractionPipeline: true,
      latestForExtractionIdentity: true,
    })
    assert.equal(recorded.body.applicationPhase, "NEEDS_APPROVE")
    assert.equal(recorded.body.conversionReadiness.duplicateBlocked, true)
    assert.equal(recorded.body.conversionReadiness.duplicateMatchKind, "ADDRESS")
    assert.equal(recorded.body.predictedNextPhase, "BLOCKED_DUPLICATE")
    assertNoSecrets(recorded.text)
  })

  it("26. obsolete work period: policy → human review; recorded CONVERT intent → BLOCKED_WORK_PERIOD", async () => {
    const policy = await run({}, { now: () => AFTER_PERIOD })
    assert.equal(policy.body.draft.workPeriod, "OBSOLETE")
    assert.equal(policy.body.predictedDecision.code, "HUMAN_REVIEW_REQUIRED")
    assert.deepEqual(policy.body.predictedDecision.reasons, ["WORK_PERIOD_OBSOLETE"])
    assert.equal(policy.body.predictedNextPhase, "HUMAN_REVIEW")

    const recorded = await run(
      { journal: [validationRow("VALIDATION_PASS"), intentRow("AUTO_APPROVE_CONVERT")] },
      { now: () => AFTER_PERIOD }
    )
    assert.equal(recorded.body.predictedNextPhase, "BLOCKED_WORK_PERIOD")
  })

  it("27. pipeline disabled overrides every other phase", async () => {
    const r = await run(
      {},
      { env: { ...PREVIEW_ENV, ACQUISITION_ORCHESTRATOR_POST_EXTRACTION_STEPS: "false" } }
    )
    assert.equal(r.body.flags.postExtractionSteps, false)
    assert.equal(r.body.predictedDecision.code, "AUTO_APPROVE_CONVERT")
    assert.equal(r.body.predictedNextPhase, "PIPELINE_DISABLED")
  })
})

describe("auto-decision preflight — non-pending statuses", () => {
  it("28. APPROVED → ALREADY_APPROVED without journal reads or prediction", async () => {
    const r = await run({ draft: { status: "APPROVED", version: 4 } })
    assert.equal(r.status, 200)
    assert.equal(r.body.predictedNextPhase, "ALREADY_APPROVED")
    assert.equal(r.body.validation, null)
    assert.equal(r.body.predictedDecision, null)
    assert.ok(!r.h.calls.includes("acquisitionDecisionJournal.findMany"))
    assertNoSecrets(r.text)
  })

  it("29. REJECTED / CONVERTED → OUT_OF_SCOPE", async () => {
    for (const status of ["REJECTED", "CONVERTED"]) {
      const r = await run({ draft: { status } })
      assert.equal(r.body.predictedNextPhase, "OUT_OF_SCOPE")
      assert.equal(r.body.predictedDecision, null)
      assert.ok(!r.h.calls.includes("acquisitionDecisionJournal.findMany"))
    }
  })
})

describe("auto-decision preflight — clock, errors, route", () => {
  it("30. now() is called exactly once and the same instant drives policy and work period", async () => {
    // La date réelle (≥ 2026-09-27) est après la période : un policy sur horloge murale dirait OBSOLETE.
    const before = await run()
    assert.equal(before.h.nowCalls, 1)
    assert.equal(before.body.referenceInstant, BEFORE_PERIOD.toISOString())
    assert.equal(before.body.draft.workPeriod, "FUTURE")
    assert.equal(before.body.predictedDecision.code, "AUTO_APPROVE_CONVERT")

    let afterCalls = 0
    const after = await run(
      {},
      {
        now: () => {
          afterCalls += 1
          return AFTER_PERIOD
        },
      }
    )
    assert.equal(afterCalls, 1)
    assert.equal(after.body.referenceInstant, AFTER_PERIOD.toISOString())
    assert.equal(after.body.draft.workPeriod, "OBSOLETE")
    assert.deepEqual(after.body.predictedDecision.reasons, ["WORK_PERIOD_OBSOLETE"])
  })

  it("31. injected failure → generic 500 without internal details", async () => {
    const r = await run(
      {},
      {
        journal: {
          findLatestValidationDecisionForCycle: async () => {
            throw new Error("JOURNAL_SECRET_INTERNAL_91c2 dsn=postgres://u:p@h/db")
          },
          findLatestAutoIntentForCycle: async () => null,
          findLatestPostExtractionAutoIntentForExtractionIdentity: async () => null,
        },
      }
    )
    assert.equal(r.status, 500)
    assert.ok(!r.text.includes("JOURNAL_SECRET_INTERNAL_91c2"))
    assert.ok(!r.text.includes("postgres://"))
    assert.deepEqual(r.body, { ok: false, code: "PREFLIGHT_FAILED", message: "Erreur interne" })
  })

  it("32. the real route exports runtime nodejs and POST delegates fail-closed", async () => {
    const route = await import("@/app/api/acquisition/targeted-staging-auto-decision-preflight/route")
    assert.equal(route.runtime, "nodejs")
    assert.equal(typeof route.POST, "function")
    // Route sans injection : process.env réel doit être hors surface (ni auth ni DB atteints).
    assert.equal(isHarnessSurfaceAllowed(process.env), false)
    await refusedWith(await route.POST(request({ confirmation: CONFIRM })), 403, "HARNESS_SURFACE_FORBIDDEN")
  })
})

describe("auto-decision preflight — review blockers regression", () => {
  const RECORDED_CONVERT = () => [validationRow("VALIDATION_PASS"), intentRow("AUTO_APPROVE_CONVERT")]

  it("A. PLANIFICATOR_ACQUISITION_ENABLED off → BLOCKED_ACQUISITION_DISABLED (never WOULD_APPROVE_AND_CONVERT)", async () => {
    for (const journal of [undefined, RECORDED_CONVERT()]) {
      const r = await run(
        { journal },
        { isAcquisitionEnabled: () => false, isConversionFullyEnabled: () => false }
      )
      assert.equal(r.body.gates.acquisitionEnabled, false)
      assert.equal(r.body.predictedNextPhase, "BLOCKED_ACQUISITION_DISABLED")
      assert.notEqual(r.body.predictedNextPhase, "WOULD_APPROVE_AND_CONVERT")
    }
  })

  it("B. ACQUISITION_CONVERSION_ENABLED off → BLOCKED_CONVERSION_DISABLED", async () => {
    for (const journal of [undefined, RECORDED_CONVERT()]) {
      const r = await run(
        { journal },
        { isConversionEnabled: () => false, isConversionFullyEnabled: () => false }
      )
      assert.deepEqual(r.body.gates, {
        acquisitionEnabled: true,
        conversionFlag: false,
        conversionFullyEnabled: false,
      })
      assert.equal(r.body.predictedNextPhase, "BLOCKED_CONVERSION_DISABLED")
    }
    // APPROVE_ONLY n'a pas besoin de la conversion : non bloqué par ce gate.
    const only = await run(
      {},
      {
        isAutoConvertEnabled: () => false,
        isConversionEnabled: () => false,
        isConversionFullyEnabled: () => false,
      }
    )
    assert.equal(only.body.predictedNextPhase, "APPROVE_ONLY_NO_WORKSITE")
  })

  it("A/B. without injection, gates report the real production helpers (no env mutation)", async () => {
    const { isAcquisitionEnabled } = await import("@/lib/acquisition/acquisition-feature-flag")
    const conv = await import("@/lib/acquisition/conversion/conversion-feature-flag")
    const r = await run(
      {},
      { isAcquisitionEnabled: undefined, isConversionEnabled: undefined, isConversionFullyEnabled: undefined }
    )
    assert.deepEqual(r.body.gates, {
      acquisitionEnabled: isAcquisitionEnabled(),
      conversionFlag: conv.isAcquisitionConversionEnabled(),
      conversionFullyEnabled: conv.isAcquisitionConversionFullyEnabled(),
    })
  })

  it("C. recorded AUTO_APPROVE_CONVERT intent + stale source → BLOCKED_SOURCE_STALE", async () => {
    for (const sourceHash of ["hash-changed", null]) {
      const r = await run({ journal: RECORDED_CONVERT(), sourceHash })
      assert.equal(r.body.existingIntent.decisionCode, "AUTO_APPROVE_CONVERT")
      assert.equal(r.body.sourceFreshness.matchesCycle, false)
      assert.equal(r.body.predictedNextPhase, "BLOCKED_SOURCE_STALE")
    }
    // Détection désalignée (detection ≠ extraction) : même refus.
    const mismatch = await run({ journal: RECORDED_CONVERT(), draft: { detectionContentHash: "hash-old" } })
    assert.equal(mismatch.body.predictedNextPhase, "BLOCKED_SOURCE_STALE")
  })

  it("D. recorded AUTO_REJECT_CANCELLED intent + stale source → never WOULD_REJECT_CANCELLED", async () => {
    const journal = () => [
      validationRow("VALIDATION_FAIL_TERMINAL", ["CONSULTATION_CANCELLED"], {
        errorCode: "CONSULTATION_CANCELLED",
      }),
      intentRow("AUTO_REJECT_CANCELLED"),
    ]
    const stale = await run({
      draft: { detectionClassification: "CANCELLATION" },
      journal: journal(),
      sourceHash: "hash-changed",
    })
    assert.equal(stale.body.existingIntent.decisionCode, "AUTO_REJECT_CANCELLED")
    assert.equal(stale.body.predictedNextPhase, "BLOCKED_SOURCE_STALE")

    const fresh = await run({ draft: { detectionClassification: "CANCELLATION" }, journal: journal() })
    assert.equal(fresh.body.predictedNextPhase, "WOULD_REJECT_CANCELLED")
  })

  it("E. generated conversion input rejected by the real schema (overlong email) → BLOCKED_CONVERSION_INPUT", async () => {
    const longEmail = `${"a".repeat(200)}@expo.fr`
    const r = await run({
      clientMatch: { clientId: null, matchKind: "NONE" },
      partner: partnerRow({ allowCreateClient: true }),
      draft: {
        extractedData: {
          requestClassification: "CONSULTATION",
          clientEmail: longEmail,
          consultationReference: "REF-001",
        },
      },
    })
    assert.equal(r.body.predictedDecision.code, "AUTO_APPROVE_CONVERT")
    assert.equal(r.body.conversionReadiness.clientMode, "NEW")
    assert.equal(r.body.conversionReadiness.inputValid, false)
    assert.equal(r.body.conversionReadiness.inputRefusal, "INPUT_SCHEMA_INVALID")
    assert.equal(r.body.predictedNextPhase, "BLOCKED_CONVERSION_INPUT")
    assert.ok(!r.text.includes(longEmail))
    assert.ok(!r.text.includes("aaaaaaaaaa"))
  })

  it("F. deterministic approval refusals (name / dates / raw blocking warning) with a recorded intent", async () => {
    const cases: Array<[Row, string]> = [
      [{ proposedWorksiteName: "   " }, "MISSING_WORKSITE_NAME"],
      [{ proposedStartDate: null }, "MISSING_DATES"],
      [
        {
          proposedStartDate: new Date("2026-09-12T00:00:00.000Z"),
          proposedEndDate: new Date("2026-09-10T00:00:00.000Z"),
        },
        "DATE_RANGE_INVALID",
      ],
      [
        { warningData: [{ code: "CUSTOM_BLOCK", severity: "WARNING", blocking: true, source: "SERVICE" }] },
        "BLOCKING_WARNINGS",
      ],
    ]
    for (const [draft, refusal] of cases) {
      const r = await run({ draft, journal: RECORDED_CONVERT() })
      assert.equal(r.status, 200, refusal)
      assert.deepEqual(r.body.approvalReadiness, { ok: false, refusal }, refusal)
      assert.equal(r.body.predictedNextPhase, "BLOCKED_APPROVAL_REFUSAL", refusal)
    }
    // Conversion seule : nom > 100 accepté à l'approbation, refusé à la conversion.
    const longName = await run({ draft: { proposedWorksiteName: "N".repeat(101) }, journal: RECORDED_CONVERT() })
    assert.deepEqual(longName.body.approvalReadiness, { ok: true, refusal: null })
    assert.equal(longName.body.conversionReadiness.inputRefusal, "WORKSITE_NAME_INVALID")
    assert.equal(longName.body.predictedNextPhase, "BLOCKED_CONVERSION_INPUT")
  })

  it("G. current-cycle CONVERT intent without POST_EXTRACTION_STEPS provenance → BLOCKED_INTENT_PROVENANCE", async () => {
    const r = await run({
      journal: [validationRow("VALIDATION_PASS"), intentRow("AUTO_APPROVE_CONVERT", { pipeline: null })],
    })
    assert.deepEqual(r.body.existingIntent, {
      decisionCode: "AUTO_APPROVE_CONVERT",
      postExtractionPipeline: false,
      latestForExtractionIdentity: false,
    })
    assert.equal(r.body.predictedNextPhase, "BLOCKED_INTENT_PROVENANCE")

    // Provenance OK mais supplanté par un intent post-extraction plus récent (même identité extraction).
    const superseded = await run({
      journal: [
        validationRow("VALIDATION_PASS"),
        intentRow("AUTO_APPROVE_CONVERT"),
        intentRow("HUMAN_REVIEW_REQUIRED", { validatedDraftVersion: 2 }),
      ],
    })
    assert.equal(superseded.body.existingIntent.postExtractionPipeline, true)
    assert.equal(superseded.body.existingIntent.latestForExtractionIdentity, false)
    assert.equal(superseded.body.predictedNextPhase, "BLOCKED_INTENT_PROVENANCE")
  })

  it("H. same intent WITH correct provenance proceeds when every other gate is valid", async () => {
    const r = await run({ journal: RECORDED_CONVERT() })
    assert.deepEqual(r.body.existingIntent, {
      decisionCode: "AUTO_APPROVE_CONVERT",
      postExtractionPipeline: true,
      latestForExtractionIdentity: true,
    })
    assert.equal(r.body.applicationPhase, "NEEDS_APPROVE")
    assert.equal(r.body.predictedNextPhase, "WOULD_APPROVE_AND_CONVERT")
    assertNoSecrets(r.text)
  })

  it("conversion name limit matches the conversion service source", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/acquisition/conversion/conversion.service.ts"),
      "utf8"
    )
    assert.match(src, /if \(name\.length > 100\) \{\s*throw Object\.assign\(new Error\("WORKSITE_NAME_TOO_LONG"\)/)
  })
})

describe("auto-decision preflight — side-effect proofs", () => {
  it("33. production read paths over a strict recording DB: only allowed reads, writes/transactions rejected", async () => {
    // Journal réel (repository), freshness réelle, system actor réel (user.findFirst), contexte réel.
    // Le resolver production lit ACQUISITION_SYSTEM_ACTOR_USER_ID dans process.env : valeur de test
    // posée puis restaurée (le handler lui-même ne modifie jamais l'env).
    const previous = process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = SYSTEM_USER.id
    try {
      const r = await run(
        { journal: [validationRow("VALIDATION_PASS"), intentRow("AUTO_APPROVE_CONVERT")] },
        { journal: undefined, resolveSystemActor: undefined }
      )
      assert.equal(r.status, 200)
      assert.equal(r.body.existingIntent.decisionCode, "AUTO_APPROVE_CONVERT")
      assert.deepEqual(r.body.systemActor, { ok: true, code: null, reason: null })
      assert.equal(r.body.predictedNextPhase, "WOULD_APPROVE_AND_CONVERT")
      for (const call of r.h.calls) assert.ok(ALLOWED_DB_READS.has(call), `unexpected DB call ${call}`)
      for (const read of ALLOWED_DB_READS) assert.ok(r.h.calls.includes(read), `read not exercised: ${read}`)
      assertNoSecrets(r.text)

      // Même chemin réel : user d'un autre tenant → SYSTEM_ACTOR_INVALID / tenant_mismatch.
      const foreign = await run(
        { user: { ...SYSTEM_USER, companyId: "co-other" } },
        { journal: undefined, resolveSystemActor: undefined }
      )
      assert.deepEqual(foreign.body.systemActor, {
        ok: false,
        code: "SYSTEM_ACTOR_INVALID",
        reason: "tenant_mismatch",
      })
      assert.equal(foreign.body.predictedNextPhase, "BLOCKED_SYSTEM_ACTOR")
      assertNoSecrets(foreign.text)
    } finally {
      if (previous === undefined) delete process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID
      else process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = previous
    }

    // Le stub est réellement strict.
    const probe = recordingDb({}).db as unknown as Record<string, Record<string, () => Promise<unknown>>> & {
      $transaction: () => Promise<unknown>
    }
    await assert.rejects(probe.$transaction(), /FORBIDDEN_DB_CALL \$transaction/)
    await assert.rejects(probe.worksiteImportDraft.update(), /FORBIDDEN_DB_CALL/)
    await assert.rejects(probe.acquisitionDecisionJournal.create(), /FORBIDDEN_DB_CALL/)
    await assert.rejects(probe.worksite.create(), /FORBIDDEN_DB_CALL/)
  })

  it("34. static guard: the handler never references write / external / worker-run paths", () => {
    const raw = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/orchestrator/targeted-staging-auto-decision-preflight.handler.ts"
      ),
      "utf8"
    ).toLowerCase()
    // Seuls les schémas zod purs (safeParse) sont autorisés ; on les retire avant la recherche.
    const ALLOWED_SCHEMAS = ["approveimportdraftschema", "convertimportdraftschema"]
    const src = ALLOWED_SCHEMAS.reduce((s, name) => s.split(name).join(""), raw)
    for (const name of ALLOWED_SCHEMAS) {
      assert.match(raw, new RegExp(`${name}\\.safeparse\\(`), `${name} used only via safeParse`)
    }
    for (const forbidden of [
      "runacquisition",
      "approveimportdraft",
      "rejectimportdraft",
      "convertimportdraft",
      "importdraftreviewservice",
      "importdraftconversionservice",
      "applycancellationfollowup",
      "appendonce",
      ".append(",
      "forupdate",
      "intransaction",
      "$transaction",
      "$queryraw",
      "$executeraw",
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      "createmany",
      "updatemany",
      "deletemany",
      "geocode",
      "gmail",
      "cloudinary",
      "anthropic",
      "extraction.service",
      "targeted-staging-attachment-not-ready",
      "acquisition-validation.worker",
      "acquisition-orchestrator-workers",
      "acquisition-orchestrator.service",
      "fetch(",
    ]) {
      assert.ok(!src.includes(forbidden), `handler must not reference ${forbidden}`)
    }
  })

  it("35. fresh process: importing the handler loads no forbidden module, SDK, DB access or network call", () => {
    const HANDLER_FILE = path.join(
      "src",
      "lib",
      "acquisition",
      "orchestrator",
      "targeted-staging-auto-decision-preflight.handler.ts"
    )
    const FORBIDDEN_MODULES = [
      path.join("orchestrator", "acquisition-validation.worker.ts"),
      path.join("orchestrator", "acquisition-orchestrator.service.ts"),
      path.join("orchestrator", "acquisition-orchestrator-workers.ts"),
      path.join("extraction", "extraction.service.ts"),
      path.join("extraction", "targeted-staging-attachment-not-ready.handler.ts"),
    ]
    const MARKER = "__AUTO_DECISION_PREFLIGHT_GRAPH__"
    const probe = [
      // Prisma enregistreur installé AVANT tout import : toute utilisation au chargement est capturée.
      `const prismaAccess = [];`,
      `globalThis.prisma = new Proxy({}, { get(_t, p) { if (typeof p === "string") prismaAccess.push(p); return undefined } });`,
      `let fetchCalls = 0; globalThis.fetch = async () => { fetchCalls += 1; throw new Error("NO_NETWORK") };`,
      `const m = require("@/lib/acquisition/orchestrator/targeted-staging-auto-decision-preflight.handler");`,
      `setImmediate(() => setTimeout(() => {`,
      `  process.stdout.write("\\n${MARKER}" + JSON.stringify({`,
      `    handlerExport: typeof m.handleTargetedStagingAutoDecisionPreflight,`,
      `    loaded: Object.keys(require.cache),`,
      `    prismaAccess, fetchCalls,`,
      `  }) + "\\n");`,
      `}, 50));`,
    ].join("\n")

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    }
    delete childEnv.NODE_TEST_CONTEXT

    // Jette (→ échec) si le handler ne se charge pas.
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "-e", probe], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    })
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER))
    assert.ok(line, "child did not report its module graph")
    const graph = JSON.parse(line.slice(MARKER.length)) as {
      handlerExport: string
      loaded: string[]
      prismaAccess: string[]
      fetchCalls: number
    }

    assert.equal(graph.handlerExport, "function")
    assert.ok(graph.loaded.some((p) => p.endsWith(HANDLER_FILE)), "handler missing from require.cache")
    assert.deepEqual(
      FORBIDDEN_MODULES.filter((m) => graph.loaded.some((p) => p.endsWith(m))),
      []
    )
    assert.deepEqual(
      graph.loaded.filter((p) => /node_modules[\\/](@anthropic-ai|cloudinary|googleapis|@googleapis)[\\/]/.test(p)),
      []
    )
    assert.deepEqual(graph.prismaAccess, [])
    assert.equal(graph.fetchCalls, 0)
  })

  it("36. CANCEL literal matches the auto-decision worker source exactly", () => {
    assert.deepEqual(AUTO_DECISION_CANCEL_LITERAL, {
      code: "AUTO_REJECT_CANCELLED",
      reasons: ["CONSULTATION_CANCELLED"],
    })
    const workerSrc = readFileSync(
      path.join(process.cwd(), "src/lib/acquisition/orchestrator/acquisition-auto-decision.worker.ts"),
      "utf8"
    )
    assert.match(
      workerSrc,
      /if \(path === "CANCEL"\) \{\s*decision = \{\s*code: "AUTO_REJECT_CANCELLED",\s*reasons: \["CONSULTATION_CANCELLED"\],\s*scores: ctx\.snapshot\.confidenceData,\s*\}/
    )
  })
})
