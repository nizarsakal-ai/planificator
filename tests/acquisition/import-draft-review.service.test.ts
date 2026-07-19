process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import type { ReviewActorContext } from "@/lib/acquisition/review/import-draft-review.types"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"

type DraftRow = {
  id: string
  companyId: string
  status: string
  version: number
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  proposedDescription: string | null
  warningData: unknown
  reviewedByUserId: string | null
  reviewedAt: Date | null
  rejectionReason: string | null
  extractedData: unknown
  confidenceData: unknown
  proposedClientId: string | null
}

function createFakeDb(seed: DraftRow) {
  let draft = { ...seed }
  let clientCreates = 0
  let worksiteCreates = 0
  let documentCreates = 0

  const db = {
    get draft() {
      return draft
    },
    get clientCreates() {
      return clientCreates
    },
    get worksiteCreates() {
      return worksiteCreates
    },
    get documentCreates() {
      return documentCreates
    },
    worksiteImportDraft: {
      async findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean> }) {
        const w = args.where
        if (w.id !== draft.id) return null
        if (w.companyId && w.companyId !== draft.companyId) return null
        if (args.select) {
          const out: Record<string, unknown> = {}
          for (const k of Object.keys(args.select)) {
            if (args.select[k]) out[k] = (draft as Record<string, unknown>)[k]
          }
          return out
        }
        return { ...draft }
      },
      async updateMany(args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) {
        const w = args.where
        if (w.id !== draft.id || w.companyId !== draft.companyId) return { count: 0 }
        if (typeof w.version === "number" && w.version !== draft.version) return { count: 0 }
        if (w.status) {
          if (typeof w.status === "string" && w.status !== draft.status) return { count: 0 }
          if (
            typeof w.status === "object" &&
            w.status &&
            "in" in (w.status as object) &&
            !(w.status as { in: string[] }).in.includes(draft.status)
          ) {
            return { count: 0 }
          }
        }
        const data = { ...args.data }
        if (data.version && typeof data.version === "object" && "increment" in (data.version as object)) {
          draft.version += Number((data.version as { increment: number }).increment)
          delete data.version
        }
        draft = { ...draft, ...data } as DraftRow
        return { count: 1 }
      },
      async create() {
        throw new Error("should not create draft")
      },
    },
    client: {
      async create() {
        clientCreates++
      },
    },
    worksite: {
      async create() {
        worksiteCreates++
      },
    },
    document: {
      async create() {
        documentCreates++
      },
    },
  }

  return db
}

const admin: ReviewActorContext = {
  actorUserId: "u-admin",
  actorRole: "ADMIN",
  companyId: "co1",
}

function baseDraft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: "d1",
    companyId: "co1",
    status: "PENDING_REVIEW",
    version: 1,
    proposedWorksiteName: "Tour Alpha",
    proposedClientName: null,
    proposedAddress: null,
    proposedPostalCode: null,
    proposedCity: null,
    proposedStartDate: new Date("2026-09-01T00:00:00.000Z"),
    proposedEndDate: new Date("2026-09-10T00:00:00.000Z"),
    proposedDescription: null,
    warningData: [],
    reviewedByUserId: null,
    reviewedAt: null,
    rejectionReason: null,
    extractedData: { keep: true },
    confidenceData: { worksiteName: 0.7 },
    proposedClientId: null,
    ...over,
  }
}

describe("ImportDraftReviewService", () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("save PENDING_REVIEW", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(admin, {
      draftId: "d1",
      expectedVersion: 1,
      proposedWorksiteName: "  Nouveau  ",
      proposedClientName: "",
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: "2026-09-01",
      proposedEndDate: "2026-09-15",
      proposedDescription: null,
    })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.outcome, "SAVED")
      assert.equal(r.version, 2)
      assert.equal(r.status, "PENDING_REVIEW")
    }
    assert.equal(db.draft.proposedWorksiteName, "Nouveau")
    assert.equal(db.draft.proposedClientName, null)
    assert.deepEqual(db.draft.extractedData, { keep: true })
    assert.equal(db.clientCreates + db.worksiteCreates + db.documentCreates, 0)
  })

  it("save FAILED conserve statut", async () => {
    const db = createFakeDb(baseDraft({ status: "FAILED", version: 2 }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(admin, {
      draftId: "d1",
      expectedVersion: 2,
      proposedWorksiteName: "X",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: null,
      proposedEndDate: null,
      proposedDescription: null,
    })
    assert.equal(r.ok, true)
    assert.equal(db.draft.status, "FAILED")
  })

  it("save APPROVED refusé", async () => {
    const db = createFakeDb(baseDraft({ status: "APPROVED" }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(admin, {
      draftId: "d1",
      expectedVersion: 1,
      proposedWorksiteName: "X",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: null,
      proposedEndDate: null,
      proposedDescription: null,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INVALID_STATE")
  })

  it("dates inversées refusées", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(admin, {
      draftId: "d1",
      expectedVersion: 1,
      proposedWorksiteName: "X",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: "2026-09-20",
      proposedEndDate: "2026-09-01",
      proposedDescription: null,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "VALIDATION_ERROR")
  })

  it("approve valide sans clientName", async () => {
    const db = createFakeDb(baseDraft({ proposedClientName: null }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.outcome, "APPROVED")
    assert.equal(db.draft.status, "APPROVED")
    assert.equal(db.draft.proposedClientId, null)
    assert.equal(db.clientCreates, 0)
  })

  it("approve sans nom", async () => {
    const db = createFakeDb(baseDraft({ proposedWorksiteName: "  " }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "VALIDATION_ERROR")
  })

  it("approve sans dates", async () => {
    const db = createFakeDb(baseDraft({ proposedStartDate: null }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "MISSING_DATES")
  })

  it("approve dates inversées", async () => {
    const db = createFakeDb(
      baseDraft({
        proposedStartDate: new Date("2026-09-20T00:00:00.000Z"),
        proposedEndDate: new Date("2026-09-01T00:00:00.000Z"),
      })
    )
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "DATE_RANGE_INVALID")
  })

  it("approve blocking warning", async () => {
    const db = createFakeDb(
      baseDraft({ warningData: [catalogWarning("CONTENT_INSUFFICIENT", { source: "SERVICE" })] })
    )
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "BLOCKING_WARNINGS")
  })

  it("approve blocking warning inconnu", async () => {
    const db = createFakeDb(
      baseDraft({
        warningData: [{ code: "CUSTOM_UNKNOWN", blocking: true, message: "raw" }],
      })
    )
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "BLOCKING_WARNINGS")
  })

  it("reject valide", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.rejectImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 1,
      rejectionReason: "Hors périmètre métier",
    })
    assert.equal(r.ok, true)
    assert.equal(db.draft.status, "REJECTED")
  })

  it("reject reason trop court", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.rejectImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 1,
      rejectionReason: "non",
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "VALIDATION_ERROR")
  })

  it("reject FAILED refusé", async () => {
    const db = createFakeDb(baseDraft({ status: "FAILED" }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.rejectImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 1,
      rejectionReason: "Motif assez long",
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INVALID_STATE")
  })

  it("version conflict → STATE_CHANGED", async () => {
    const db = createFakeDb(baseDraft({ version: 5 }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(admin, {
      draftId: "d1",
      expectedVersion: 1,
      proposedWorksiteName: "X",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: null,
      proposedEndDate: null,
      proposedDescription: null,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "STATE_CHANGED")
  })

  it("cross-tenant NOT_FOUND", async () => {
    const db = createFakeDb(baseDraft({ companyId: "co1" }))
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { ...admin, companyId: "other" },
      { draftId: "d1", expectedVersion: 1 }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "NOT_FOUND")
  })

  it("EMPLOYEE interdit", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.saveImportDraftCorrections(
      { actorUserId: "e", actorRole: "EMPLOYEE", companyId: "co1" },
      {
        draftId: "d1",
        expectedVersion: 1,
        proposedWorksiteName: "X",
        proposedClientName: null,
        proposedAddress: null,
        proposedPostalCode: null,
        proposedCity: null,
        proposedStartDate: null,
        proposedEndDate: null,
        proposedDescription: null,
      }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("SUPER_ADMIN sans companyId interdit", async () => {
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(
      { actorUserId: "s", actorRole: "SUPER_ADMIN", companyId: "" },
      { draftId: "d1", expectedVersion: 1 }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("flags OFF → DISABLED", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "false"
    const db = createFakeDb(baseDraft())
    const svc = new ImportDraftReviewService({ db: db as never })
    const r = await svc.approveImportDraft(admin, { draftId: "d1", expectedVersion: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "DISABLED")
  })
})
