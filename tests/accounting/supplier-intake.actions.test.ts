import assert from "node:assert/strict"
import { before, beforeEach, describe, it, mock } from "node:test"
import { supplierOcrMetadata } from "@/lib/supplier-intake/ocr-metadata"
import { setOcrProviderForTests } from "@/lib/accounting/c5/ocr-provider"
const ctx = { userId: "intake-test-user", companyId: "intake-test-company" }
const state = { allowed: true, owner: ctx.userId, company: ctx.companyId, status: "PENDING", writes: 0, creates: 0, duplicate: false, transactionMode: "", fileWhere: null as unknown }
const matches = (where: any) => where.companyId === state.company && (!where.createdById || where.createdById === state.owner) && (!where.status || typeof where.status !== "string" || where.status === state.status)
const prisma = {
  supplierInvoice: {
    findFirst: async ({ where }: any) => {
      if (where.fileId) return state.duplicate ? { id: "duplicate" } : null
      return matches(where) ? { id: "invoice1", fileId: "file1" } : null
    },
    updateMany: async ({ where }: any) => { const count = matches(where) ? 1 : 0; state.writes += count; return { count } },
    create: async ({ data }: any) => { assert.equal(data.companyId, ctx.companyId); assert.equal(data.createdById, ctx.userId); assert.equal(data.status, "PENDING"); state.creates++; return { id: "new-invoice" } },
  },
  supplierInvoiceFile: {
    findFirst: async ({ where }: any) => { state.fileWhere = where; return where.sha256 ? null : { id: "file1", data: Buffer.from("%PDF-1.4 test"), mime: "application/pdf", originalName: "test.pdf" } },
    create: async () => ({ id: "file1" }),
  },
  accountingAccount: { findFirst: async () => ({ id: "expense1" }) },
  historyLog: { create: async () => ({ id: "log1" }) },
  $transaction: async (fn: (tx: any) => Promise<any>, options: any) => { state.transactionMode = options.isolationLevel; return fn(prisma) },
}
let actions: typeof import("@/lib/actions/supplier-intake.actions")
let route: typeof import("@/app/(dashboard)/factures-fournisseurs/[id]/fichier/route")
let proof: typeof import("@/lib/supplier-intake/file-proof")
before(async () => {
  mock.module("@/lib/prisma", { namedExports: { prisma } })
  mock.module("next/cache", { namedExports: { revalidatePath: () => {} } })
  mock.module("@/lib/supplier-intake/access", { namedExports: {
    resolveSupplierIntakeAccess: async () => state.allowed ? ctx : null,
    requireSupplierIntake: async () => { if (!state.allowed) throw Error("denied"); return ctx },
  } })
  actions = await import("@/lib/actions/supplier-intake.actions")
  route = await import("@/app/(dashboard)/factures-fournisseurs/[id]/fichier/route")
  proof = await import("@/lib/supplier-intake/file-proof")
})
beforeEach(() => {
  Object.assign(state, { allowed: true, owner: ctx.userId, company: ctx.companyId, status: "PENDING", writes: 0, creates: 0, duplicate: false, transactionMode: "", fileWhere: null })
  setOcrProviderForTests(null)
  delete process.env.BILLING_OCR_ENABLED
  process.env.AUTH_SECRET = "test-only-signing-secret-at-least-thirty-two-characters"
})
const input = () => ({ supplierName: "Fournisseur test", number: "TEST-1", date: "2026-10-28", totalHT: "100", vat: "20", totalTTC: "120" })
describe("real restricted supplier actions", () => {
  it("creates only PENDING documents under the authenticated company and author", async () => {
    assert.deepEqual(await actions.createIntakeInvoiceAction(input()), { ok: true, id: "new-invoice" })
    assert.equal(state.creates, 1); assert.equal(state.transactionMode, "Serializable")
  })
  it("rejects absent capability and injected company/author/status fields", async () => {
    state.allowed = false
    assert.equal((await actions.createIntakeInvoiceAction(input())).ok, false)
    state.allowed = true
    for (const extra of [{ companyId: "other" }, { createdById: "other" }, { status: "VALIDATED" }]) assert.equal((await actions.createIntakeInvoiceAction({ ...input(), ...extra })).ok, false)
    assert.equal(state.creates, 0)
  })
  it("edits only own pending invoices, enforced in the atomic update", async () => {
    assert.equal((await actions.updateIntakeInvoiceAction("invoice1", input())).ok, true)
    for (const change of [{ owner: "other" }, { status: "VALIDATED" }, { status: "REJECTED" }, { company: "other" }]) {
      Object.assign(state, { owner: ctx.userId, company: ctx.companyId, status: "PENDING" }, change)
      assert.equal((await actions.updateIntakeInvoiceAction("invoice1", input())).ok, false)
    }
    assert.equal(state.writes, 1)
  })
  it("rejects arbitrary attachments, accepts only server-bound upload proofs", async () => {
    const data = { ...input(), fileId: "file1" }
    assert.equal((await actions.createIntakeInvoiceAction(data)).ok, false)
    const token = proof.issueFileProof(ctx, "file1", process.env.AUTH_SECRET!)
    assert.equal((await actions.createIntakeInvoiceAction(data, token)).ok, true)
    assert.deepEqual(state.fileWhere, { id: "file1", companyId: ctx.companyId })
    state.duplicate = true
    assert.equal((await actions.createIntakeInvoiceAction(data, token)).ok, false)
    assert.equal(state.creates, 1)
  })
  it("imports with OCR disabled, preserving the manual fallback and upload provenance", async () => {
    const form = new FormData(); form.set("file", new File(["%PDF-1.4 test"], "test.pdf", { type: "application/pdf" }))
    const r = await actions.uploadIntakeFileAction(form)
    assert.equal(r.ok, true)
    if (!r.ok) throw Error("upload failed")
    assert.equal(r.extraction, null)
    assert.ok(r.extractionError)
    assert.equal(proof.verifyFileProof(ctx, r.fileId, r.fileProof, process.env.AUTH_SECRET!), true)
  })
  it("round-trips imported OCR metadata through the real creation action", async () => {
    setOcrProviderForTests({ name: "synthetic-test", extract: async () => ({
      supplier: "Fournisseur test", siret: null, invoiceNumber: "TEST-1", date: "2026-10-28", totalHTCents: BigInt(10000), vatCents: BigInt(2000),
      totalTTCCents: BigInt(12000), vatRateBp: 2000, category: "services", confidence: { supplier: 0.9 }, amountsAdjusted: false, rawText: "synthetic OCR text",
    }) })
    const form = new FormData(); form.set("file", new File(["%PDF-1.4 test"], "test.pdf", { type: "application/pdf" }))
    const r = await actions.uploadIntakeFileAction(form)
    assert.equal(r.ok, true)
    if (!r.ok) throw Error("upload failed")
    assert.ok(r.extraction)
    const metadata = supplierOcrMetadata(r.extraction)
    assert.equal(Object.hasOwn(metadata!, "rawText"), false)
    assert.equal((await actions.createIntakeInvoiceAction({ ...input(), fileId: r.fileId, ocr: metadata }, r.fileProof)).ok, true)
    assert.equal(state.creates, 1)
    setOcrProviderForTests(null)
  })
  it("guards the actual file route by author and company and disables caching", async () => {
    const get = () => route.GET(new Request("http://localhost/factures-fournisseurs/invoice1/fichier"), { params: Promise.resolve({ id: "invoice1" }) })
    let response = await get()
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.deepEqual(state.fileWhere, { id: "file1", companyId: ctx.companyId })
    for (const change of [{ owner: "other" }, { company: "other" }, { allowed: false }]) {
      Object.assign(state, { owner: ctx.userId, company: ctx.companyId, allowed: true }, change)
      response = await get(); assert.equal(response.status, 404)
    }
  })
  it("has no validation/payment exports and rejects attachment replacement on edit", async () => {
    assert.deepEqual(Object.keys(actions).sort(), ["createIntakeInvoiceAction", "updateIntakeInvoiceAction", "uploadIntakeFileAction"].sort())
    assert.equal((await actions.updateIntakeInvoiceAction("invoice1", { ...input(), fileId: "file1" })).ok, false)
    assert.equal(state.writes, 0)
  })
})
