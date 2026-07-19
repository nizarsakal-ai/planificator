process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

/**
 * PLAN-ACQ-005C-R1 — Tests réels des Server Actions (deps injectées).
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { Role, WorksiteImportDraftStatus } from "@prisma/client"
import {
  approveImportDraftActionImpl as approveImportDraftAction,
  reExtractImportDraftActionImpl as reExtractImportDraftAction,
  rejectImportDraftActionImpl as rejectImportDraftAction,
  saveImportDraftCorrectionsActionImpl as saveImportDraftCorrectionsAction,
  type AcquisitionReviewActionDeps,
} from "@/lib/actions/acquisition-review.actions.core"
import { getReExtractPolicy } from "@/lib/acquisition/review/consultation-ui"
import { reExtractImportDraftSchema } from "@/lib/acquisition/review/import-draft-review.schema"

function session(
  role: Role,
  companyId: string | null = "co1",
  id = "user-1"
): NonNullable<Awaited<ReturnType<NonNullable<AcquisitionReviewActionDeps["auth"]>>>> {
  return { user: { id, role, companyId } }
}

function baseDeps(over: AcquisitionReviewActionDeps = {}): AcquisitionReviewActionDeps {
  return {
    auth: async () => session("ADMIN"),
    isAcquisitionEnabled: () => true,
    isAcquisitionExtractionEnabled: () => true,
    revalidatePath: () => {},
    ...over,
  }
}

describe("getReExtractPolicy", () => {
  it("matrice force / allowed", () => {
    assert.deepEqual(getReExtractPolicy("PENDING_EXTRACTION"), { allowed: true, force: false })
    assert.deepEqual(getReExtractPolicy("FAILED"), { allowed: true, force: false })
    assert.deepEqual(getReExtractPolicy("PENDING_REVIEW"), { allowed: true, force: true })
    for (const s of ["EXTRACTING", "APPROVED", "REJECTED", "CONVERTED"] as WorksiteImportDraftStatus[]) {
      assert.deepEqual(getReExtractPolicy(s), { allowed: false })
    }
  })
})

describe("acquisition-review.actions auth", () => {
  it("session absente → FORBIDDEN", async () => {
    const r = await saveImportDraftCorrectionsAction({}, baseDeps({ auth: async () => null }))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  for (const role of ["EMPLOYEE", "TEAM_LEADER", "CLIENT"] as Role[]) {
    it(`${role} → FORBIDDEN`, async () => {
      const r = await approveImportDraftAction(
        { draftId: "d1", expectedVersion: 1 },
        baseDeps({ auth: async () => session(role) })
      )
      assert.equal(r.ok, false)
      if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
    })
  }

  it("SUPER_ADMIN sans companyId → FORBIDDEN", async () => {
    const r = await rejectImportDraftAction(
      { draftId: "d1", expectedVersion: 1, rejectionReason: "Motif assez long" },
      baseDeps({ auth: async () => session("SUPER_ADMIN", null) })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("ADMIN + companyId autorisé (délègue service)", async () => {
    let seenCompanyId: string | null = null
    const r = await saveImportDraftCorrectionsAction(
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
      },
      baseDeps({
        saveImportDraftCorrections: async (ctx) => {
          seenCompanyId = ctx.companyId
          return {
            ok: true,
            outcome: "SAVED",
            draftId: "d1",
            version: 2,
            status: "PENDING_REVIEW",
          }
        },
      })
    )
    assert.equal(r.ok, true)
    assert.equal(seenCompanyId, "co1")
  })

  it("SUPER_ADMIN + companyId autorisé", async () => {
    const r = await approveImportDraftAction(
      { draftId: "d1", expectedVersion: 1 },
      baseDeps({
        auth: async () => session("SUPER_ADMIN", "co-sa"),
        approveImportDraft: async (ctx) => {
          assert.equal(ctx.companyId, "co-sa")
          return { ok: true, outcome: "APPROVED", draftId: "d1", version: 2 }
        },
      })
    )
    assert.equal(r.ok, true)
  })
})

describe("acquisition-review.actions sécurité tenant + Zod", () => {
  it("companyId dans input rejeté (Zod strict)", async () => {
    const r = await reExtractImportDraftAction(
      { draftId: "d1", companyId: "evil" },
      baseDeps({
        runDraftExtraction: async () => {
          throw new Error("ne doit pas être appelé")
        },
      })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "VALIDATION_ERROR")
    assert.equal(reExtractImportDraftSchema.safeParse({ draftId: "d1", companyId: "x" }).success, false)
  })

  it("companyId vient exclusivement de la session", async () => {
    let extractionCompany: string | undefined
    await reExtractImportDraftAction(
      { draftId: "d1" },
      baseDeps({
        auth: async () => session("ADMIN", "session-co"),
        getImportDraftStatusForReview: async () => ({
          id: "d1",
          status: "PENDING_EXTRACTION",
          version: 1,
        }),
        runDraftExtraction: async (input) => {
          extractionCompany = input.actor.companyId
          return {
            ok: true,
            outcome: "EXTRACTED",
            draftId: "d1",
            status: "PENDING_REVIEW",
            contentHashAtExtraction: "abc",
            warningCount: 0,
          }
        },
      })
    )
    assert.equal(extractionCompany, "session-co")
  })
})

describe("acquisition-review.actions flags", () => {
  it("master OFF → DISABLED avant service", async () => {
    let serviceCalled = false
    const r = await saveImportDraftCorrectionsAction(
      { draftId: "d1" },
      baseDeps({
        isAcquisitionEnabled: () => false,
        saveImportDraftCorrections: async () => {
          serviceCalled = true
          return { ok: true, outcome: "SAVED", draftId: "d1", version: 1, status: "PENDING_REVIEW" }
        },
      })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "DISABLED")
    assert.equal(serviceCalled, false)
  })

  it("extraction OFF → re-extract DISABLED avant runDraftExtraction", async () => {
    let called = false
    const r = await reExtractImportDraftAction(
      { draftId: "d1" },
      baseDeps({
        isAcquisitionExtractionEnabled: () => false,
        runDraftExtraction: async () => {
          called = true
          return {
            ok: true,
            outcome: "EXTRACTED",
            draftId: "d1",
            status: "PENDING_REVIEW",
            contentHashAtExtraction: "abc",
            warningCount: 0,
          }
        },
      })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "DISABLED")
    assert.equal(called, false)
  })
})

describe("acquisition-review.actions re-extract", () => {
  const cases: Array<{
    status: WorksiteImportDraftStatus
    expect: "force-false" | "force-true" | "INVALID_STATE"
  }> = [
    { status: "PENDING_EXTRACTION", expect: "force-false" },
    { status: "FAILED", expect: "force-false" },
    { status: "PENDING_REVIEW", expect: "force-true" },
    { status: "EXTRACTING", expect: "INVALID_STATE" },
    { status: "APPROVED", expect: "INVALID_STATE" },
    { status: "REJECTED", expect: "INVALID_STATE" },
    { status: "CONVERTED", expect: "INVALID_STATE" },
  ]

  for (const c of cases) {
    it(`${c.status}`, async () => {
      let calls = 0
      let forceSeen: boolean | undefined
      const r = await reExtractImportDraftAction(
        { draftId: "d1" },
        baseDeps({
          getImportDraftStatusForReview: async () => ({
            id: "d1",
            status: c.status,
            version: 3,
          }),
          runDraftExtraction: async (input) => {
            calls++
            forceSeen = Boolean(input.force)
            return {
              ok: true,
              outcome: "EXTRACTED",
              draftId: "d1",
              status: "PENDING_REVIEW",
              contentHashAtExtraction: "abc",
              warningCount: 0,
            }
          },
        })
      )
      if (c.expect === "INVALID_STATE") {
        assert.equal(r.ok, false)
        if (!r.ok) assert.equal(r.outcome, "INVALID_STATE")
        assert.equal(calls, 0)
      } else {
        assert.equal(r.ok, true)
        assert.equal(calls, 1)
        assert.equal(forceSeen, c.expect === "force-true")
      }
    })
  }
})

describe("acquisition-review.actions revalidatePath", () => {
  let paths: string[]

  beforeEach(() => {
    paths = []
  })

  it("revalidate uniquement après succès", async () => {
    await saveImportDraftCorrectionsAction(
      {
        draftId: "d9",
        expectedVersion: 1,
        proposedWorksiteName: "X",
        proposedClientName: null,
        proposedAddress: null,
        proposedPostalCode: null,
        proposedCity: null,
        proposedStartDate: null,
        proposedEndDate: null,
        proposedDescription: null,
      },
      baseDeps({
        revalidatePath: (p) => paths.push(p),
        saveImportDraftCorrections: async () => ({
          ok: true,
          outcome: "SAVED",
          draftId: "d9",
          version: 2,
          status: "PENDING_REVIEW",
        }),
      })
    )
    assert.deepEqual(paths, ["/consultations", "/consultations/d9"])
  })

  it("aucune revalidation sur FORBIDDEN / DISABLED / STATE_CHANGED / INVALID_STATE", async () => {
    const track = (p: string) => paths.push(p)

    await saveImportDraftCorrectionsAction({}, baseDeps({ auth: async () => null, revalidatePath: track }))
    await saveImportDraftCorrectionsAction(
      {},
      baseDeps({ isAcquisitionEnabled: () => false, revalidatePath: track })
    )
    await approveImportDraftAction(
      { draftId: "d1", expectedVersion: 1 },
      baseDeps({
        revalidatePath: track,
        approveImportDraft: async () => ({
          ok: false,
          outcome: "STATE_CHANGED",
          code: "STATE_CHANGED",
          message: "Version obsolète",
        }),
      })
    )
    await reExtractImportDraftAction(
      { draftId: "d1" },
      baseDeps({
        revalidatePath: track,
        getImportDraftStatusForReview: async () => ({
          id: "d1",
          status: "APPROVED",
          version: 1,
        }),
        runDraftExtraction: async () => {
          throw new Error("no")
        },
      })
    )
    assert.deepEqual(paths, [])
  })
})
