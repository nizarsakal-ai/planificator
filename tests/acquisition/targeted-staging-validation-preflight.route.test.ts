process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import {
  buildConsultationEvaluationContext,
  type ConsultationEvaluationDraft,
} from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  ALLOWED_VERCEL_PROJECT_ID as LOCAL_ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID as LOCAL_FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  TARGETED_STAGING_VALIDATION_PREFLIGHT_CHECK_CONFIRMATION,
  handleTargetedStagingValidationPreflight,
  isHarnessSurfaceAllowed as localIsHarnessSurfaceAllowed,
  preflightAddressDiagnostic,
  preflightValidationDecisionCode,
  type TargetedValidationPreflightDeps,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import { validateConsultation } from "@/lib/acquisition/capabilities/validation.capability"
import type { ConsultationValidationInput } from "@/lib/acquisition/capabilities/consultation-capability.ports"
import type { ValidationDecision } from "@/lib/acquisition/capabilities/consultation-capability.types"
import { validationDecisionToCode } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

const COMPANY = "co-validation-preflight"
const DRAFT = "draft-validation-preflight"
const CONFIRM = TARGETED_STAGING_VALIDATION_PREFLIGHT_CHECK_CONFIRMATION

const BEFORE_PERIOD = new Date("2026-09-05T00:00:00.000Z")
const AFTER_PERIOD = new Date("2026-09-26T00:00:00.000Z")

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_VALIDATION_PREFLIGHT_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

function sessionAuth(role = "ADMIN", companyId: string | null = COMPANY) {
  return (async () => ({ user: { id: "u1", role, companyId } })) as never
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-validation-preflight",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  )
}

function draft(over: Partial<ConsultationEvaluationDraft> = {}): ConsultationEvaluationDraft {
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
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warningData: [],
    extractedData: {
      requestClassification: "CONSULTATION",
      clientEmail: "client@expo.fr",
      consultationReference: "REF-001",
    },
    contentHashAtExtraction: "hash-1",
    extractionSchemaVersion: "2",
    acquisitionMessage: { resolvedPartnerId: null, senderDomain: null, threadId: null },
    ...over,
  } as ConsultationEvaluationDraft
}

/**
 * Real context builder over a recording DB : only worksiteImportDraft.findFirst answers,
 * any other model/operation (writes, journal, …) throws and is recorded.
 */
function recordingContext(d: ConsultationEvaluationDraft | null = draft()) {
  const dbCalls: string[] = []
  const builderInputs: unknown[] = []
  const db = new Proxy(
    {},
    {
      get(_t, model) {
        if (typeof model !== "string") return undefined
        return new Proxy(
          {},
          {
            get(_m, op) {
              if (typeof op !== "string") return undefined
              return async () => {
                dbCalls.push(`${model}.${op}`)
                if (model === "worksiteImportDraft" && op === "findFirst") return d
                throw new Error(`UNEXPECTED_DB_CALL ${model}.${op}`)
              }
            },
          }
        )
      },
    }
  )
  const buildContext: TargetedValidationPreflightDeps["buildContext"] = async (input) => {
    builderInputs.push(input)
    return buildConsultationEvaluationContext({
      ...input,
      deps: {
        db: db as never,
        registry: {
          findPartnerById: async () => null,
          findPartnerByDomain: async () => null,
        } as never,
        findDuplicate: async () => ({ worksiteId: null, matchKind: "NONE" as const }),
        matchClient: async () => ({ clientId: "cli1", matchKind: "EMAIL" as const }),
      } as never,
    })
  }
  return { buildContext, dbCalls, builderInputs }
}

function clock(instant: Date) {
  let calls = 0
  return {
    now: () => {
      calls += 1
      return instant
    },
    get calls() {
      return calls
    },
  }
}

function spyValidate() {
  const inputs: ConsultationValidationInput[] = []
  const validate: typeof validateConsultation = (input) => {
    inputs.push(input)
    return validateConsultation(input)
  }
  return { validate, inputs }
}

async function refusedWith(
  response: Response,
  status: number,
  code: string
): Promise<void> {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, code)
}

describe("targeted staging validation preflight — guards", () => {
  function unreachableDeps(): TargetedValidationPreflightDeps & { reached: string[] } {
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
      validate: (input) => {
        reached.push("validate")
        return validateConsultation(input)
      },
    }
  }

  it("rejects outside the allowed Preview project", async () => {
    const deps = unreachableDeps()
    for (const env of [
      { ...PREVIEW_ENV, VERCEL_ENV: "production" },
      { ...PREVIEW_ENV, VERCEL_PROJECT_ID: "prj_other" },
    ]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM }),
        { ...deps, auth: sessionAuth(), env }
      )
      await refusedWith(res, 403, "HARNESS_SURFACE_FORBIDDEN")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects when the dedicated flag is not exactly true", async () => {
    const deps = unreachableDeps()
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM }),
        {
          ...deps,
          auth: sessionAuth(),
          env: { ...PREVIEW_ENV, TARGETED_STAGING_VALIDATION_PREFLIGHT_ENABLED: flag },
        }
      )
      await refusedWith(res, 403, "HARNESS_DISABLED")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects unauthenticated requests", async () => {
    const deps = unreachableDeps()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { ...deps, auth: (async () => null) as never, env: PREVIEW_ENV }
    )
    await refusedWith(res, 401, "UNAUTHORIZED")
    assert.deepEqual(deps.reached, [])
  })

  it("rejects non-admin roles", async () => {
    const deps = unreachableDeps()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { ...deps, auth: sessionAuth("USER"), env: PREVIEW_ENV }
    )
    await refusedWith(res, 403, "FORBIDDEN")
    assert.deepEqual(deps.reached, [])
  })

  it("rejects invalid JSON and missing / wrong confirmation", async () => {
    const deps = unreachableDeps()
    const base = { ...deps, auth: sessionAuth(), env: PREVIEW_ENV }
    await refusedWith(
      await handleTargetedStagingValidationPreflight(request("{not json"), base),
      400,
      "INVALID_BODY"
    )
    for (const body of [{}, { confirmation: "" }, { confirmation: "check" }, null]) {
      await refusedWith(
        await handleTargetedStagingValidationPreflight(request(body), base),
        400,
        "CONFIRMATION_REQUIRED"
      )
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects any RUN-style confirmation", async () => {
    const deps = unreachableDeps()
    for (const confirmation of [
      "RUN_TARGETED_STAGING_VALIDATION_PREFLIGHT",
      "RUN_TARGETED_STAGING_VALIDATION",
    ]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation }),
        { ...deps, auth: sessionAuth(), env: PREVIEW_ENV }
      )
      await refusedWith(res, 400, "CONFIRMATION_REQUIRED")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects company/draft target overrides in the body", async () => {
    const deps = unreachableDeps()
    for (const key of ["companyId", "company_id", "draftId", "draft_id"]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM, [key]: "other" }),
        { ...deps, auth: sessionAuth(), env: PREVIEW_ENV }
      )
      await refusedWith(res, 400, "TARGET_OVERRIDE_FORBIDDEN")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects referenceInstant/now overrides in the body", async () => {
    const deps = unreachableDeps()
    for (const key of ["referenceInstant", "reference_instant", "now"]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM, [key]: "2026-09-05T00:00:00.000Z" }),
        { ...deps, auth: sessionAuth(), env: PREVIEW_ENV }
      )
      await refusedWith(res, 400, "CLOCK_OVERRIDE_FORBIDDEN")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects when the target env is missing", async () => {
    const deps = unreachableDeps()
    for (const env of [
      { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: undefined },
      { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "  " },
    ]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM }),
        { ...deps, auth: sessionAuth(), env }
      )
      await refusedWith(res, 403, "HARNESS_TARGET_UNSET")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("rejects the explicitly forbidden draft", async () => {
    const deps = unreachableDeps()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        ...deps,
        auth: sessionAuth(),
        env: {
          ...PREVIEW_ENV,
          TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
        },
      }
    )
    await refusedWith(res, 403, "FORBIDDEN_DRAFT")
    assert.deepEqual(deps.reached, [])
  })

  it("rejects tenant mismatch, including a session without company", async () => {
    const deps = unreachableDeps()
    for (const companyId of ["co-other", null]) {
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM }),
        { ...deps, auth: sessionAuth("ADMIN", companyId), env: PREVIEW_ENV }
      )
      await refusedWith(res, 403, "TENANT_MISMATCH")
    }
    assert.deepEqual(deps.reached, [])
  })

  it("fails closed when the evaluation context is unavailable", async () => {
    const t = clock(BEFORE_PERIOD)
    const spy = spyValidate()
    const missing = recordingContext(null)
    await refusedWith(
      await handleTargetedStagingValidationPreflight(request({ confirmation: CONFIRM }), {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: t.now,
        buildContext: missing.buildContext,
        validate: spy.validate,
      }),
      409,
      "EVALUATION_CONTEXT_UNAVAILABLE"
    )

    const noCycle = recordingContext(draft({ contentHashAtExtraction: null }))
    await refusedWith(
      await handleTargetedStagingValidationPreflight(request({ confirmation: CONFIRM }), {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: t.now,
        buildContext: noCycle.buildContext,
        validate: spy.validate,
      }),
      409,
      "EVALUATION_CONTEXT_UNAVAILABLE"
    )

    const wrongScope = recordingContext(draft({ companyId: "co-other" }))
    await refusedWith(
      await handleTargetedStagingValidationPreflight(request({ confirmation: CONFIRM }), {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: t.now,
        buildContext: wrongScope.buildContext,
        validate: spy.validate,
      }),
      409,
      "EVALUATION_CONTEXT_UNAVAILABLE"
    )

    assert.equal(t.calls, 0)
    assert.equal(spy.inputs.length, 0)
  })

  it("returns a generic 500 without internal details when the context build throws", async () => {
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: () => BEFORE_PERIOD,
        buildContext: async () => {
          throw new Error("SECRET_INTERNAL_DETAIL db=postgres://user:pw@host")
        },
      }
    )
    assert.equal(res.status, 500)
    const text = await res.text()
    assert.ok(!text.includes("SECRET_INTERNAL_DETAIL"))
    assert.ok(!text.includes("postgres://"))
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      code: "PREFLIGHT_FAILED",
      message: "Erreur interne",
    })
  })
})

describe("targeted staging validation preflight — read-only evaluation", () => {
  it("reports PASS before the work period, read-only, at the injected instant", async () => {
    const t = clock(BEFORE_PERIOD)
    const spy = spyValidate()
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: t.now,
        buildContext: ctx.buildContext,
        validate: spy.validate,
      }
    )

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, {
      ok: true,
      mode: "CHECK_READ_ONLY",
      referenceInstant: "2026-09-05T00:00:00.000Z",
      draft: {
        id: DRAFT,
        status: "PENDING_REVIEW",
        version: 3,
        cycle: { contentHash: "hash-1", extractionSchemaVersion: "2", draftVersion: 3 },
        startDate: "2026-09-10",
        endDate: "2026-09-12",
      },
      classification: "CONSULTATION",
      validation: {
        code: "PASS",
        decisionCode: "VALIDATION_PASS",
        reasons: ["THRESHOLDS_OK"],
        errorCode: null,
      },
      addressDiagnostic: { addressEmpty: false, addressTooShort: false, cityEmpty: false },
    })

    // Scope strict : le builder ne reçoit que la cible env.
    assert.deepEqual(ctx.builderInputs, [{ companyId: COMPANY, draftId: DRAFT }])
    // Read-only : une seule lecture draft, aucune autre opération DB (journal, update, …).
    assert.deepEqual(ctx.dbCalls, ["worksiteImportDraft.findFirst"])
  })

  it("reports QUARANTINE with exactly WORK_PERIOD_OBSOLETE after the work period", async () => {
    const t = clock(AFTER_PERIOD)
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { auth: sessionAuth("SUPER_ADMIN"), env: PREVIEW_ENV, now: t.now, buildContext: ctx.buildContext }
    )

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.referenceInstant, "2026-09-26T00:00:00.000Z")
    assert.deepEqual(body.validation, {
      code: "QUARANTINE",
      decisionCode: "VALIDATION_QUARANTINE",
      reasons: ["WORK_PERIOD_OBSOLETE"],
      errorCode: null,
    })
    assert.deepEqual(ctx.dbCalls, ["worksiteImportDraft.findFirst"])
  })

  it("captures now() exactly once and passes that exact Date as referenceInstant", async () => {
    const t = clock(BEFORE_PERIOD)
    const spy = spyValidate()
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: t.now,
        buildContext: ctx.buildContext,
        validate: spy.validate,
      }
    )
    assert.equal(res.status, 200)
    assert.equal(t.calls, 1)
    assert.equal(spy.inputs.length, 1)
    assert.equal(spy.inputs[0]!.referenceInstant, BEFORE_PERIOD)
    assert.equal(spy.inputs[0]!.companyId, COMPANY)
    assert.equal(spy.inputs[0]!.draftId, DRAFT)
  })

  it("is deterministic: same injected instant → identical response", async () => {
    const run = async () => {
      const ctx = recordingContext()
      const res = await handleTargetedStagingValidationPreflight(
        request({ confirmation: CONFIRM }),
        { auth: sessionAuth(), env: PREVIEW_ENV, now: () => AFTER_PERIOD, buildContext: ctx.buildContext }
      )
      return res.json()
    }
    assert.deepEqual(await run(), await run())
  })

  it("does not leak snapshot, client email, address or confidence payloads", async () => {
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { auth: sessionAuth(), env: PREVIEW_ENV, now: () => BEFORE_PERIOD, buildContext: ctx.buildContext }
    )
    const text = await res.text()
    for (const secret of ["client@expo.fr", "12 rue de la Foire", "Lyon", "69002", "Client Expo", "0.95", "snapshot", "confidence"]) {
      assert.ok(!text.includes(secret), `response leaks ${secret}`)
    }
  })
})

describe("targeted staging validation preflight — AMBIGUOUS_ADDRESS diagnostic", () => {
  async function runWith(over: Partial<ConsultationEvaluationDraft>) {
    const ctx = recordingContext(draft(over))
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { auth: sessionAuth(), env: PREVIEW_ENV, now: () => BEFORE_PERIOD, buildContext: ctx.buildContext }
    )
    assert.equal(res.status, 200)
    const text = await res.text()
    return { text, body: JSON.parse(text), dbCalls: ctx.dbCalls }
  }

  it("null / blank address → addressEmpty, not addressTooShort; policy still reports AMBIGUOUS_ADDRESS", async () => {
    for (const proposedAddress of [null, "", "   "]) {
      const r = await runWith({ proposedAddress })
      assert.deepEqual(r.body.addressDiagnostic, {
        addressEmpty: true,
        addressTooShort: false,
        cityEmpty: false,
      })
      assert.equal(r.body.validation.code, "QUARANTINE")
      assert.ok(r.body.validation.reasons.includes("AMBIGUOUS_ADDRESS"), JSON.stringify(proposedAddress))
    }
  })

  it("non-empty address shorter than 5 after trim → addressTooShort; policy reports AMBIGUOUS_ADDRESS", async () => {
    for (const proposedAddress of ["  Zq9 ", "a", " abcd "]) {
      const r = await runWith({ proposedAddress })
      assert.deepEqual(r.body.addressDiagnostic, {
        addressEmpty: false,
        addressTooShort: true,
        cityEmpty: false,
      })
      assert.ok(r.body.validation.reasons.includes("AMBIGUOUS_ADDRESS"), proposedAddress)
    }
    // Frontière : 5 caractères après trim → ni vide ni trop court, pas d'AMBIGUOUS_ADDRESS.
    const boundary = await runWith({ proposedAddress: "  abcde  " })
    assert.deepEqual(boundary.body.addressDiagnostic, {
      addressEmpty: false,
      addressTooShort: false,
      cityEmpty: false,
    })
    assert.ok(!boundary.body.validation.reasons.includes("AMBIGUOUS_ADDRESS"))
  })

  it("null / blank city → cityEmpty; policy reports AMBIGUOUS_ADDRESS", async () => {
    for (const proposedCity of [null, "", "  "]) {
      const r = await runWith({ proposedCity })
      assert.deepEqual(r.body.addressDiagnostic, {
        addressEmpty: false,
        addressTooShort: false,
        cityEmpty: true,
      })
      assert.ok(r.body.validation.reasons.includes("AMBIGUOUS_ADDRESS"), JSON.stringify(proposedCity))
    }
  })

  it("valid address + city → all false, no AMBIGUOUS_ADDRESS, validation unchanged", async () => {
    const r = await runWith({})
    assert.deepEqual(r.body.addressDiagnostic, {
      addressEmpty: false,
      addressTooShort: false,
      cityEmpty: false,
    })
    assert.deepEqual(r.body.validation, {
      code: "PASS",
      decisionCode: "VALIDATION_PASS",
      reasons: ["THRESHOLDS_OK"],
      errorCode: null,
    })
    assert.deepEqual(r.dbCalls, ["worksiteImportDraft.findFirst"])
  })

  it("exposes exactly three booleans and never the address / city / postal text", async () => {
    const cases: Array<Partial<ConsultationEvaluationDraft>> = [
      { proposedAddress: "  Zq9 ", proposedCity: "Qwertyville", proposedPostalCode: "75123" },
      { proposedAddress: "99 avenue Unique Xyz", proposedCity: "   " },
      { proposedAddress: null, proposedCity: "Villeneuve-Zed" },
    ]
    for (const over of cases) {
      const r = await runWith(over)
      assert.deepEqual(Object.keys(r.body.addressDiagnostic).sort(), [
        "addressEmpty",
        "addressTooShort",
        "cityEmpty",
      ])
      for (const v of Object.values(r.body.addressDiagnostic)) assert.equal(typeof v, "boolean")
      for (const secret of [over.proposedAddress, over.proposedCity, over.proposedPostalCode]) {
        const t = typeof secret === "string" ? secret.trim() : ""
        if (t) assert.ok(!r.text.includes(t), `response leaks ${t}`)
      }
    }
  })

  it("pure helper mirrors the policy branches (null / blank / short / boundary)", () => {
    assert.deepEqual(preflightAddressDiagnostic({ address: null, city: null }), {
      addressEmpty: true,
      addressTooShort: false,
      cityEmpty: true,
    })
    assert.deepEqual(preflightAddressDiagnostic({ address: " \t ", city: "Lyon" }), {
      addressEmpty: true,
      addressTooShort: false,
      cityEmpty: false,
    })
    assert.deepEqual(preflightAddressDiagnostic({ address: " 1234 ", city: "Lyon" }), {
      addressEmpty: false,
      addressTooShort: true,
      cityEmpty: false,
    })
    assert.deepEqual(preflightAddressDiagnostic({ address: "12345", city: "Lyon" }), {
      addressEmpty: false,
      addressTooShort: false,
      cityEmpty: false,
    })
  })
})

describe("targeted staging validation preflight — failure decisions", () => {
  it("returns FAIL_RETRYABLE with its errorCode", async () => {
    // Le builder de production fixe contentMissingRetryable=false : on force le
    // snapshot réel pour atteindre la branche retryable du validateur réel.
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: () => BEFORE_PERIOD,
        buildContext: async (input) => {
          const real = await ctx.buildContext!(input)
          return real && { ...real, snapshot: { ...real.snapshot, contentMissingRetryable: true } }
        },
      }
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.validation, {
      code: "FAIL_RETRYABLE",
      decisionCode: "VALIDATION_FAIL_RETRYABLE",
      reasons: ["CONTENT_MISSING"],
      errorCode: "CONTENT_MISSING",
    })
  })

  it("returns FAIL_TERMINAL with its errorCode for a confirmed cancellation", async () => {
    const ctx = recordingContext(
      draft({
        extractedData: {
          requestClassification: "CANCELLED_CONSULTATION",
          clientEmail: "client@expo.fr",
          consultationReference: "REF-001",
        },
      })
    )
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      { auth: sessionAuth(), env: PREVIEW_ENV, now: () => BEFORE_PERIOD, buildContext: ctx.buildContext }
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.classification, "CANCELLATION")
    assert.deepEqual(body.validation, {
      code: "FAIL_TERMINAL",
      decisionCode: "VALIDATION_FAIL_TERMINAL",
      reasons: ["CONSULTATION_CANCELLED"],
      errorCode: "CONSULTATION_CANCELLED",
    })
    assert.deepEqual(ctx.dbCalls, ["worksiteImportDraft.findFirst"])
  })

  it("returns a generic 500 without internal details when the validator throws", async () => {
    const ctx = recordingContext()
    const res = await handleTargetedStagingValidationPreflight(
      request({ confirmation: CONFIRM }),
      {
        auth: sessionAuth(),
        env: PREVIEW_ENV,
        now: () => BEFORE_PERIOD,
        buildContext: ctx.buildContext,
        validate: () => {
          throw new Error("VALIDATOR_SECRET_INTERNAL_7f3a stack=/srv/internal")
        },
      }
    )
    assert.equal(res.status, 500)
    const text = await res.text()
    assert.ok(!text.includes("VALIDATOR_SECRET_INTERNAL_7f3a"))
    assert.ok(!text.includes("/srv/internal"))
    const body = JSON.parse(text)
    assert.equal(body.ok, false)
    assert.equal(body.code, "PREFLIGHT_FAILED")
  })
})

describe("targeted staging validation preflight — real route contract", () => {
  it("exports runtime nodejs and POST delegates to the handler (fail-closed surface)", async () => {
    const route = await import("@/app/api/acquisition/targeted-staging-validation-preflight/route")
    assert.equal(route.runtime, "nodejs")
    assert.equal(typeof route.POST, "function")

    // Sans injection possible, la route utilise process.env réel : on exige qu'il soit
    // hors surface autorisée pour que POST s'arrête au premier garde (ni auth ni DB).
    assert.equal(localIsHarnessSurfaceAllowed(process.env), false)

    const res = await route.POST(request({ confirmation: CONFIRM }))
    await refusedWith(res, 403, "HARNESS_SURFACE_FORBIDDEN")
  })
})

describe("targeted staging validation preflight — decision code mapping", () => {
  it("maps all four ValidationDecision variants exactly like the worker", () => {
    const cases: Array<[ValidationDecision, string]> = [
      [{ code: "PASS", reasons: ["THRESHOLDS_OK"] }, "VALIDATION_PASS"],
      [{ code: "QUARANTINE", reasons: ["WORK_PERIOD_OBSOLETE"] }, "VALIDATION_QUARANTINE"],
      [
        { code: "FAIL_RETRYABLE", reasons: ["CONTENT_MISSING"], errorCode: "CONTENT_MISSING" },
        "VALIDATION_FAIL_RETRYABLE",
      ],
      [
        { code: "FAIL_TERMINAL", reasons: ["CONSULTATION_CANCELLED"], errorCode: "CONSULTATION_CANCELLED" },
        "VALIDATION_FAIL_TERMINAL",
      ],
    ]
    for (const [decision, expected] of cases) {
      assert.equal(preflightValidationDecisionCode(decision), expected)
      assert.equal(preflightValidationDecisionCode(decision), validationDecisionToCode(decision))
    }
  })
})

describe("targeted staging validation preflight — guard drift contract", () => {
  it("local guard constants equal the established harness exports", () => {
    assert.equal(LOCAL_FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID, FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID)
    assert.equal(LOCAL_ALLOWED_VERCEL_PROJECT_ID, ALLOWED_VERCEL_PROJECT_ID)
  })

  it("local surface guard matches the established guard on every reference env", () => {
    const envs: Array<[string, Record<string, string | undefined>, boolean]> = [
      ["exact allowed Preview", { VERCEL_ENV: "preview", VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID }, true],
      ["wrong project", { VERCEL_ENV: "preview", VERCEL_PROJECT_ID: "prj_other" }, false],
      ["production", { VERCEL_ENV: "production", VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID }, false],
      ["missing project ID", { VERCEL_ENV: "preview" }, false],
      ["empty env", {}, false],
    ]
    for (const [label, rawEnv, expected] of envs) {
      const env = rawEnv as NodeJS.ProcessEnv
      assert.equal(localIsHarnessSurfaceAllowed(env), expected, `local: ${label}`)
      assert.equal(localIsHarnessSurfaceAllowed(env), isHarnessSurfaceAllowed(env), `drift: ${label}`)
    }
  })
})

describe("targeted staging validation preflight — module graph", () => {
  const HANDLER_FILE = path.join(
    "src",
    "lib",
    "acquisition",
    "capabilities",
    "targeted-staging-validation-preflight.handler.ts"
  )
  const FORBIDDEN_MODULES = [
    path.join("orchestrator", "acquisition-validation.worker.ts"),
    path.join("policy", "decision-journal.repository.ts"),
    path.join("orchestrator", "acquisition-orchestrator-workers.ts"),
    path.join("extraction", "extraction.service.ts"),
    path.join("extraction", "targeted-staging-attachment-not-ready.handler.ts"),
  ]
  const MARKER = "__PREFLIGHT_MODULE_GRAPH__"

  it("loading only the handler in a fresh process pulls no worker/journal/orchestrator/extraction module", () => {
    const probe = [
      `const m = require("@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler");`,
      `process.stdout.write("\\n${MARKER}" + JSON.stringify({`,
      `  handlerExport: typeof m.handleTargetedStagingValidationPreflight,`,
      `  loaded: Object.keys(require.cache),`,
      `}) + "\\n");`,
    ].join("\n")

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    }
    delete childEnv.NODE_TEST_CONTEXT

    // Throws (→ test fails) if the child cannot load the handler.
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
    }

    // Preuve positive : le handler a réellement été chargé.
    assert.equal(graph.handlerExport, "function")
    assert.ok(
      graph.loaded.some((p) => p.endsWith(HANDLER_FILE)),
      "handler module missing from require.cache"
    )

    const hits = FORBIDDEN_MODULES.filter((m) => graph.loaded.some((p) => p.endsWith(m)))
    assert.deepEqual(hits, [])
  })
})

describe("targeted staging validation preflight — static guards", () => {
  const handlerSource = readFileSync(
    path.join(
      process.cwd(),
      "src/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler.ts"
    ),
    "utf8"
  )

  it("never references worker execution, journal, prisma, providers or mutations", () => {
    for (const forbidden of [
      "runAcquisitionValidationWorker",
      "runAcquisition",
      "@/lib/acquisition/orchestrator/",
      "acquisition-validation.worker",
      "validationDecisionToCode",
      "targeted-staging-attachment-not-ready",
      "@/lib/acquisition/extraction/",
      "shouldSkipValidationForExistingMarker",
      "acquisitionDecisionJournalRepository",
      "decision-journal",
      "appendOnce",
      "@/lib/prisma",
      "extraction.service",
      "anthropic",
      "cloudinary",
      "gmail",
      "conversion.service",
      ".update(",
      ".create(",
      ".upsert(",
      ".delete(",
    ]) {
      assert.ok(
        !handlerSource.toLowerCase().includes(forbidden.toLowerCase()),
        `handler must not reference ${forbidden}`
      )
    }
  })
})
