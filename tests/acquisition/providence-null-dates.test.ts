/**
 * PLAN-ACQ-PROVIDENCE-DATES-002 — fixture métier Lycée La Providence (in-memory).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
process.env.ACQUISITION_CONVERSION_ENABLED = "true"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"

type CreatedWorksite = {
  startDate: Date | null
  endDate: Date | null
  status: string
}

describe("PROVIDENCE fixture — dates inconnues", () => {
  it("policy → AUTO_APPROVE_CONVERT puis conversion PLANNED null/null", async () => {
    const decision = evaluateAutoDecision({
      worksiteName: "LYCEE LA PROVIDENCE 49",
      startDate: null,
      endDate: null,
      address: "33 AVENUE GUSTAVE FERRIE",
      postalCode: "49030",
      city: "CHOLET",
      clientName: "Lycée La Providence",
      clientEmail: null,
      confidenceData: { worksiteName: 0.85 },
      warningData: [
        { code: "DATE_AMBIGUOUS", blocking: false },
        { code: "LOW_CONFIDENCE", field: "contactName", blocking: false },
        { code: "LOW_CONFIDENCE", field: "description", blocking: false },
        { code: "LOW_CONFIDENCE", field: "requestedWeekNumber", blocking: false },
        { code: "PROVIDER_PARTIAL_RESULT", blocking: false },
      ],
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      minConfidence: 0.75,
      hasResolvedClient: true,
    })
    assert.equal(decision.code, "AUTO_APPROVE_CONVERT")

    const created: CreatedWorksite[] = []
    let assignmentCreates = 0

    const draft = {
      id: "d-prov",
      companyId: "co1",
      status: "APPROVED",
      version: 2,
      acquisitionMessageId: "msg-prov",
      proposedWorksiteName: "LYCEE LA PROVIDENCE 49",
      proposedDescription: "Consultation devis",
      proposedAddress: "33 AVENUE GUSTAVE FERRIE",
      proposedPostalCode: "49030",
      proposedCity: "CHOLET",
      proposedStartDate: null as Date | null,
      proposedEndDate: null as Date | null,
      createdWorksiteId: null as string | null,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake Prisma in-memory
    const db: any = {
      worksiteImportDraft: {
        findFirst: async () => ({ ...draft }),
        updateMany: async () => {
          draft.status = "CONVERTED"
          draft.version = 3
          draft.createdWorksiteId = "ws-prov"
          return { count: 1 }
        },
      },
      client: {
        findFirst: async () => ({ id: "c-prov" }),
        create: async () => ({ id: "c-new" }),
      },
      worksite: {
        findMany: async () => [],
        create: async (args: { data: Record<string, unknown> }) => {
          created.push({
            startDate: (args.data.startDate as Date | null) ?? null,
            endDate: (args.data.endDate as Date | null) ?? null,
            status: String(args.data.status),
          })
          return { id: "ws-prov" }
        },
      },
      acquisitionAttachment: { findMany: async () => [] },
      document: { create: async () => ({ id: "doc1" }), count: async () => 0 },
      team: { create: async () => {} },
      assignment: {
        create: async () => {
          assignmentCreates++
        },
      },
      async $transaction<T>(fn: (tx: typeof db) => Promise<T>) {
        return fn(db)
      },
    }

    const svc = new ImportDraftConversionService({ db })
    const converted = await svc.convertImportDraft(
      { actorUserId: "sys", actorRole: "SYSTEM", companyId: "co1" },
      {
        draftId: "d-prov",
        expectedVersion: 2,
        clientMode: "EXISTING",
        existingClientId: "c-prov",
      },
      {
        transactionalOwnershipFence: {
          assertOwnedAndLock: async () => "OWNED",
        },
      }
    )
    assert.equal(converted.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0]!.status, "PLANNED")
    assert.equal(created[0]!.startDate, null)
    assert.equal(created[0]!.endDate, null)
    assert.equal(assignmentCreates, 0)
  })
})
