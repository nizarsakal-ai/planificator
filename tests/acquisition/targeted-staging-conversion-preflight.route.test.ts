process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import {
  TARGETED_STAGING_CONVERSION_PREFLIGHT_CHECK_CONFIRMATION,
  handleTargetedStagingConversionPreflight,
  type TargetedConversionPreflightDraft,
} from "@/lib/acquisition/conversion/targeted-staging-conversion-preflight.handler"
import { ALLOWED_VERCEL_PROJECT_ID } from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"
import type {
  AutoDecisionIntentCode,
  FrozenValidationCycle,
  JournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

const COMPANY = "co-preflight"
const DRAFT = "draft-preflight"

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_CONVERSION_PREFLIGHT_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

function adminAuth(companyId: string | null = COMPANY) {
  return async () => ({
    user: { id: "u1", role: "ADMIN", companyId },
  })
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-conversion-preflight",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function draft(
  overrides: Partial<TargetedConversionPreflightDraft> = {}
): TargetedConversionPreflightDraft {
  return {
    id: DRAFT,
    companyId: COMPANY,
    status: "APPROVED",
    version: 8,
    createdWorksiteId: null,
    contentHashAtExtraction: "hash-1",
    extractionSchemaVersion: "2",
    proposedStartDate: new Date("2026-09-11T00:00:00.000Z"),
    proposedEndDate: null,
    ...overrides,
  }
}

function frozen(): FrozenValidationCycle {
  return {
    contentHash: "hash-1",
    extractionSchemaVersion: "2",
    validatedDraftVersion: 7,
  }
}

function intent(): JournalRow & { decisionCode: AutoDecisionIntentCode } {
  return {
    id: "intent-1",
    companyId: COMPANY,
    draftId: DRAFT,
    decisionCode: "AUTO_APPROVE_CONVERT",
    reasons: [],
    scores: {},
    actorUserId: "sys1",
    metadata: {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: frozen(),
    },
    createdAt: new Date("2026-09-11T12:00:00.000Z"),
  }
}

function context(): ConsultationEvaluationContext {
  return {
    draft: {
      id: DRAFT,
      companyId: COMPANY,
      status: "APPROVED",
      version: 8,
      proposedWorksiteName: "Chantier test",
      proposedClientName: "Client SA",
      proposedAddress: "1 rue Test",
      proposedPostalCode: "75001",
      proposedCity: "Paris",
      proposedStartDate: new Date("2026-09-11T00:00:00.000Z"),
      proposedEndDate: null,
      proposedClientId: null,
      confidenceData: {},
      warningData: [],
      extractedData: { clientEmail: "client@example.com" },
      contentHashAtExtraction: "hash-1",
      extractionSchemaVersion: "2",
      acquisitionMessage: {
        resolvedPartnerId: "partner-1",
        senderDomain: "example.com",
        threadId: "thread-1",
      },
    },
    cycle: frozen(),
    classification: "CONSULTATION",
    partner: {
      id: "partner-1",
      code: "partner",
      minConfidence: null,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      allowCreateClient: false,
      clientId: null,
    },
    partnerProfile: null,
    clientMatch: {
      clientId: "client-1",
      matchKind: "EMAIL",
      ambiguous: false,
    },
    duplicate: {
      worksiteId: null,
      matchKind: "NONE",
    },
    snapshot: {
      worksiteName: "Chantier test",
      address: "1 rue Test",
      city: "Paris",
      postalCode: "75001",
      clientName: "Client SA",
      clientEmail: "client@example.com",
      consultationReference: null,
      requestedStartDate: "2026-09-11",
      requestedEndDate: null,
      confidenceData: {},
      warnings: [],
      clientAmbiguous: false,
      hasResolvedClient: true,
      potentialDuplicate: false,
      duplicateRequiresAck: false,
      requiredDocumentUnreadable: false,
      consultationCancelled: false,
      contentMissingRetryable: false,
    },
  } as ConsultationEvaluationContext
}

describe("targeted staging conversion preflight", () => {
  it("reports START_ONLY as NEEDS_CONVERSION without mutating", async () => {
    const response = await handleTargetedStagingConversionPreflight(
      request({
        confirmation: TARGETED_STAGING_CONVERSION_PREFLIGHT_CHECK_CONFIRMATION,
      }),
      {
        auth: adminAuth(),
        env: PREVIEW_ENV,
        loadDraft: async () => draft(),
        buildContext: async () => context(),
        findLatestIntent: async () => intent(),
        resolveSystemActor: async () => ({
          ok: true,
          userId: "sys1",
          role: "ADMIN",
        }),
      }
    )

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "CHECK_READ_ONLY")
    assert.equal(body.draft.startDate, "2026-09-11")
    assert.equal(body.draft.endDate, null)
    assert.equal(body.draft.workPeriod, "START_ONLY")
    assert.equal(body.decision.phase, "NEEDS_CONVERSION")
    assert.equal(body.decision.intent, "AUTO_APPROVE_CONVERT")
  })
})

describe("targeted staging conversion preflight security", () => {
  it("rejects any RUN-style confirmation", async () => {
    const response = await handleTargetedStagingConversionPreflight(
      request({ confirmation: "RUN_TARGETED_STAGING_CONVERSION_PREFLIGHT" }),
      {
        auth: adminAuth(),
        env: PREVIEW_ENV,
      }
    )

    assert.equal(response.status, 400)
  })
})

describe("targeted staging conversion preflight surface", () => {
  it("rejects outside the allowed Preview surface", async () => {
    const response = await handleTargetedStagingConversionPreflight(
      request({
        confirmation: TARGETED_STAGING_CONVERSION_PREFLIGHT_CHECK_CONFIRMATION,
      }),
      {
        auth: adminAuth(),
        env: {
          ...PREVIEW_ENV,
          VERCEL_ENV: "production",
        },
      }
    )

    assert.equal(response.status, 403)
  })
})
