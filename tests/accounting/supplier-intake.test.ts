import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { hasIntakeEmployeeGrant, hasIntakeGrant, resolveIntakeAccess, intakeInvoiceScope } from "@/lib/supplier-intake/access.core"
import { issueFileProof, verifyFileProof } from "@/lib/supplier-intake/file-proof"
import { getNavItems, withSupplierIntakeNavItem } from "@/lib/navigation/nav-config"
import { resolveAccountingAccess } from "@/lib/accounting/access/accounting-access.core"
const ctx = { userId: "user-test", companyId: "company-test" }
const grant = JSON.stringify([ctx])
const deps = () => ({ enabled: () => true, auth: async () => ({ user: { id: ctx.userId, companyId: ctx.companyId, role: "EMPLOYEE" } }), grants: () => grant, membershipActive: async () => true })
describe("supplier intake capability", () => {
  it("requires an exact user/company grant, rejects malformed configuration", () => {
    assert.equal(hasIntakeGrant(grant, ctx), true)
    for (const raw of [undefined, "", "{}", "[null]", "invalid", JSON.stringify([{ ...ctx, role: "ADMIN" }])]) assert.equal(hasIntakeGrant(raw, ctx), false)
    assert.equal(hasIntakeGrant(grant, { ...ctx, companyId: "other" }), false)
    assert.equal(hasIntakeGrant(grant, { ...ctx, userId: "other" }), false)
  })
  it("fails closed on disabled module, missing session, revoked membership or lookup failure", async () => {
    assert.deepEqual(await resolveIntakeAccess(deps()), ctx)
    assert.equal(await resolveIntakeAccess({ ...deps(), enabled: () => false }), null)
    assert.equal(await resolveIntakeAccess({ ...deps(), auth: async () => null }), null)
    assert.equal(await resolveIntakeAccess({ ...deps(), membershipActive: async () => false }), null)
    assert.equal(await resolveIntakeAccess({ ...deps(), membershipActive: async () => { throw Error("db unavailable") } }), null)
    for (const role of ["CLIENT", "ADMIN", "SUPER_ADMIN", "unknown"]) assert.equal(await resolveIntakeAccess({ ...deps(), auth: async () => ({ user: { id: ctx.userId, companyId: ctx.companyId, role } }) }), null)
  })
  it("accepts only explicit employee profiles bound by the server to the session", async () => {
    assert.equal(hasIntakeEmployeeGrant('["profile-test"]', "profile-test"), true)
    for (const raw of [undefined, '[]', '["other"]', '[null]', '["*"]', '[" profile-test "]']) assert.equal(hasIntakeEmployeeGrant(raw, "profile-test"), false)
    assert.deepEqual(await resolveIntakeAccess({ ...deps(), grants: () => undefined, employeeGrant: async () => true }), ctx)
    assert.equal(await resolveIntakeAccess({ ...deps(), grants: () => undefined, employeeGrant: async () => false }), null)
    assert.equal(await resolveIntakeAccess({ ...deps(), grants: () => undefined, employeeGrant: async () => true, membershipActive: async () => false }), null)
  })
  it("does not confer accounting administrator access", async () => {
    const r = await resolveAccountingAccess({ auth: deps().auth, isModuleEnabled: () => true, findCompany: async () => ({ id: ctx.companyId, active: true }), findUserHomeCompanyId: async () => ctx.companyId })
    assert.deepEqual(r, { ok: false, reason: "FORBIDDEN" })
  })
  it("scopes all intake listings and documents to their author and company", () => {
    assert.deepEqual(intakeInvoiceScope(ctx), { companyId: ctx.companyId, createdById: ctx.userId })
  })
  it("adds a single supplemental link without changing other role navigation", () => {
    const items = getNavItems("EMPLOYEE")
    assert.deepEqual(withSupplierIntakeNavItem(items, false), items)
    const shown = withSupplierIntakeNavItem(items, true)
    assert.equal(shown.filter(i => i.href === "/factures-fournisseurs").length, 1)
    assert.deepEqual(shown.filter(i => i.href !== "/factures-fournisseurs"), items)
    assert.deepEqual(withSupplierIntakeNavItem(shown, true), shown)
    assert.equal(shown.some(i => i.href === "/comptabilite"), false)
  })
})
describe("upload provenance", () => {
  const secret = "test-secret-never-used-in-production-1234567890"
  const now = 1_800_000_000_000
  it("binds proof to author, company, file and expiry; rejects tampering", () => {
    const proof = issueFileProof(ctx, "file1", secret, now)
    assert.equal(verifyFileProof(ctx, "file1", proof, secret, now), true)
    assert.equal(verifyFileProof({ ...ctx, userId: "other" }, "file1", proof, secret, now), false)
    assert.equal(verifyFileProof({ ...ctx, companyId: "other" }, "file1", proof, secret, now), false)
    assert.equal(verifyFileProof(ctx, "file2", proof, secret, now), false)
    assert.equal(verifyFileProof(ctx, "file1", proof, secret, now + 86400000), false)
    assert.equal(verifyFileProof(ctx, "file1", proof, "different-but-long-enough-secret-value", now), false)
    for (const p of [undefined, "bad", proof + "x", "0." + "0".repeat(64)]) assert.equal(verifyFileProof(ctx, "file1", p, secret, now), false)
    assert.throws(() => issueFileProof(ctx, "file1", ""))
    assert.equal(verifyFileProof(ctx, "file1", proof, "", now), false)
  })
})
