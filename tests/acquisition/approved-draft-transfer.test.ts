process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
import { it } from "node:test"
import assert from "node:assert/strict"
import { transferApprovedDraft } from "@/lib/acquisition/conversion/approved-draft-transfer.service"
import type { ConsultationEvaluationContext } from "@/lib/acquisition/capabilities/consultation-evaluation-context"
import { approveImportDraftActionImpl } from "@/lib/actions/acquisition-review.actions.core"
import { matchesState } from "@/lib/chantiers/chantiers-view-filters"

const actor = { actorUserId: "u", actorRole: "ADMIN" as const, companyId: "company" }
const success = { ok: true as const, outcome: "CONVERTED" as const, worksiteId: "w", clientId: "c", clientCreated: false, documentCount: 2, skippedAttachmentCount: 0 }
function context(over: Partial<ConsultationEvaluationContext> = {}) {
  return { draft: { status: "APPROVED", version: 3, proposedStartDate: new Date("2027-01-02"), proposedEndDate: new Date("2027-01-06"), proposedPostalCode: "12345" },
    clientMatch: { clientId: "c", ambiguous: false }, duplicate: { worksiteId: null }, ...over } as unknown as ConsultationEvaluationContext
}

it("human approval transfers with the approved version, then refreshes both worksite views", async () => {
  const paths: string[] = []
  const result = await approveImportDraftActionImpl({ draftId: "d", expectedVersion: 2 }, {
    auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "company" } }),
    isAcquisitionEnabled: () => true, isConversionEnabled: () => true,
    approveImportDraft: async () => ({ ok: true, outcome: "APPROVED", draftId: "d", version: 3 }),
    transferApprovedDraft: async (ctx, input) => { assert.deepEqual(ctx, actor); assert.equal(input.expectedVersion, 3); return success },
    revalidatePath: p => paths.push(p),
  })
  assert.ok(result.ok && "transfer" in result && result.transfer?.ok)
  assert.ok(paths.includes("/chantiers") && paths.includes("/consultations/d"))
  const created = { status: "PLANNED", _count: { assignments: 0 } }
  assert.equal(matchesState(created, "planned"), true)
  assert.equal(matchesState(created, "unassigned"), true)
})

it("failure of approval or disabled conversion never transfers", async () => {
  for (const enabled of [true, false]) {
    let calls = 0
    await approveImportDraftActionImpl({}, {
      auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "company" } }),
      isAcquisitionEnabled: () => true, isConversionEnabled: () => enabled,
      approveImportDraft: async () => enabled
        ? { ok: false, outcome: "STATE_CHANGED", code: "STATE_CHANGED", message: "obsolete" }
        : { ok: true, outcome: "APPROVED", draftId: "d", version: 3 },
      transferApprovedDraft: async () => { calls++; return success }, revalidatePath: () => {},
    })
    assert.equal(calls, 0)
  }
})

it("transfer failure is explicit and does not pretend to have rolled back the approval", async () => {
  const result = await approveImportDraftActionImpl({}, {
    auth: async () => ({ user: { id: "u", role: "ADMIN", companyId: "company" } }),
    isAcquisitionEnabled: () => true, isConversionEnabled: () => true,
    approveImportDraft: async () => ({ ok: true, outcome: "APPROVED", draftId: "d", version: 3 }),
    transferApprovedDraft: async () => { throw new Error("private error") }, revalidatePath: () => {},
  })
  assert.ok(result.ok && "transfer" in result && !result.transfer?.ok)
  assert.equal(JSON.stringify(result).includes("private error"), false)
})

it("uses existing client only, keeps duplicate acknowledgement false and delegates the transaction", async () => {
  let payload: unknown
  const r = await transferApprovedDraft(actor, { draftId: "d", expectedVersion: 3 }, {
    loadContext: async () => context(), findPossibleDuplicate: (async () => null) as never,
    convert: async (_ctx, input) => { payload = input; return success },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(payload, { draftId: "d", expectedVersion: 3, clientMode: "EXISTING", existingClientId: "c" })
})

it("manual PGS-like worksite at same client, dates and postcode blocks a duplicate", async () => {
  let calls = 0
  const r = await transferApprovedDraft(actor, { draftId: "d", expectedVersion: 3 }, {
    loadContext: async () => context(), findPossibleDuplicate: (async (args: { where: { companyId: string; clientId: string } }) => {
      assert.equal(args.where.companyId, "company"); assert.equal(args.where.clientId, "c"); return { id: "manual-pgs" }
    }) as never,
    convert: async () => { calls++; return success },
  })
  assert.ok(!r.ok && r.existingWorksiteId === "manual-pgs")
  assert.equal(calls, 0)
})

it("unknown client, stale version, pending review and SYSTEM all remain non-creating", async () => {
  for (const c of [context({ clientMatch: { clientId: null, matchKind: "NONE" } }), context({ draft: { ...context().draft, version: 4 } }), context({ draft: { ...context().draft, status: "PENDING_REVIEW" } })]) {
    let calls = 0
    const r = await transferApprovedDraft(actor, { draftId: "d", expectedVersion: 3 }, { loadContext: async () => c, convert: async () => { calls++; return success } })
    assert.equal(r.ok, false); assert.equal(calls, 0)
  }
  const r = await transferApprovedDraft({ ...actor, actorRole: "SYSTEM" }, { draftId: "d", expectedVersion: 3 }, { loadContext: async () => { throw new Error("must not load") } })
  assert.equal(r.ok, false)
})
