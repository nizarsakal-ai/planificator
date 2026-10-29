// Factures fournisseurs — corrections M1/M2 (29/10/2026) : tests PURS (base simulée) des chemins d'erreur exigés par la revue Codex :
// P2002 d'une autre cible relancé tel quel ; gagnant introuvable ⇒ fail-closed ; course sur la même pièce ⇒ exception typée (rollback).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prisma, type PrismaClient } from "@prisma/client"
import { LifecycleAbort } from "@/lib/billing/lifecycle-abort"
import { createSupplierInvoice, isUniqueViolationOn, storeSupplierFile, SUPPLIER_ERRORS } from "@/lib/accounting/c5/supplier-invoice.service"

const ctx = { companyId: "coA", userId: "admA" }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("unit")])
const p2002 = (target: unknown) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { target } })
const input = { supplierName: "F", siret: null, number: "N-1", date: new Date("2026-10-29T00:00:00Z"), dueDate: null, totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(120), vatRateBp: 2000, category: null, expenseAccountId: null, notes: null }

function fakeDb(o: { fileFindFirst?: () => unknown; fileCreate?: () => unknown; invoiceFindFirst?: () => unknown; invoiceCreate?: () => unknown }) {
  const calls = { fileFind: 0, fileCreate: 0, invoiceFind: 0, invoiceCreate: 0, history: 0 }
  return { calls, db: {
    supplierInvoiceFile: { findFirst: async () => { calls.fileFind++; return o.fileFindFirst?.() ?? null }, create: async () => { calls.fileCreate++; return o.fileCreate?.() ?? { id: "f1" } } },
    supplierInvoice: { findFirst: async () => { calls.invoiceFind++; return o.invoiceFindFirst?.() ?? null }, create: async () => { calls.invoiceCreate++; return o.invoiceCreate?.() ?? { id: "i1" } } },
    accountingAccount: { findFirst: async () => null },
    historyLog: { create: async () => { calls.history++; return { id: "h1" } } },
  } as unknown as PrismaClient }
}

describe("isUniqueViolationOn", () => {
  it("vrai uniquement pour P2002 ciblant exactement les colonnes attendues (ordre indifférent)", () => {
    assert.equal(isUniqueViolationOn(p2002(["companyId", "sha256"]), ["companyId", "sha256"]), true)
    assert.equal(isUniqueViolationOn(p2002(["sha256", "companyId"]), ["companyId", "sha256"]), true)
    assert.equal(isUniqueViolationOn(p2002(["id"]), ["companyId", "sha256"]), false)
    assert.equal(isUniqueViolationOn(p2002(["companyId", "sha256", "id"]), ["companyId", "sha256"]), false)
    assert.equal(isUniqueViolationOn(p2002("companyId_sha256"), ["companyId", "sha256"]), false)
    assert.equal(isUniqueViolationOn(new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0" }), ["companyId", "sha256"]), false)
    assert.equal(isUniqueViolationOn(new Error("P2002"), ["companyId", "sha256"]), false)
  })
})

describe("storeSupplierFile — M1", () => {
  it("course gagnée par un autre import : relecture ⇒ fichier réutilisé (aucune facture active)", async () => {
    let reads = 0
    const { db, calls } = fakeDb({ fileFindFirst: () => (++reads === 1 ? null : { id: "winner", invoices: [] }), fileCreate: () => { throw p2002(["companyId", "sha256"]) } })
    const r = await storeSupplierFile(db, ctx, png, "f.png")
    assert.deepEqual(r.ok && { id: r.value.fileId, dup: r.value.duplicate }, { id: "winner", dup: true })
    assert.deepEqual([calls.fileFind, calls.fileCreate], [2, 1])
  })
  it("course gagnée par un import dont la pièce est déjà rattachée à une facture active ⇒ doublon explicite", async () => {
    let reads = 0
    const { db } = fakeDb({ fileFindFirst: () => (++reads === 1 ? null : { id: "winner", invoices: [{ id: "inv" }] }), fileCreate: () => { throw p2002(["companyId", "sha256"]) } })
    assert.deepEqual(await storeSupplierFile(db, ctx, png, "f.png"), { ok: false, error: SUPPLIER_ERRORS.duplicateFile })
  })
  it("P2002 d'une AUTRE cible (clé primaire) ⇒ relancé tel quel, jamais traduit", async () => {
    const err = p2002(["id"])
    const { db } = fakeDb({ fileCreate: () => { throw err } })
    await assert.rejects(storeSupplierFile(db, ctx, png, "f.png"), (e) => e === err)
  })
  it("gagnant introuvable après P2002 (companyId, sha256) ⇒ fail-closed : erreur explicite SUPPLIER_FILE_INCONSISTENT, cause conservée", async () => {
    const err = p2002(["companyId", "sha256"])
    const { db } = fakeDb({ fileFindFirst: () => null, fileCreate: () => { throw err } })
    await assert.rejects(storeSupplierFile(db, ctx, png, "f.png"), (e: Error & { cause?: unknown }) => /SUPPLIER_FILE_INCONSISTENT/.test(e.message) && e.cause === err)
  })
  it("autre erreur (connexion…) ⇒ relancée", async () => {
    const { db } = fakeDb({ fileCreate: () => { throw new Error("connection reset") } })
    await assert.rejects(storeSupplierFile(db, ctx, png, "f.png"), /connection reset/)
  })
})

describe("createSupplierInvoice — M2", () => {
  it("pré-contrôle : pièce déjà rattachée à une facture active ⇒ refus explicite AVANT toute écriture", async () => {
    const { db, calls } = fakeDb({ fileFindFirst: () => ({ id: "f1" }), invoiceFindFirst: () => ({ id: "active" }) })
    assert.deepEqual(await createSupplierInvoice(db, ctx, input, { fileId: "f1", ocr: null }), { ok: false, error: SUPPLIER_ERRORS.duplicateSubmission })
    assert.deepEqual([calls.invoiceCreate, calls.history], [0, 0])
  })
  it("pièce rattachée seulement à une facture REJETÉE (le filtre exclut REJECTED) ⇒ création autorisée, journal écrit", async () => {
    const { db, calls } = fakeDb({ fileFindFirst: () => ({ id: "f1" }), invoiceFindFirst: () => null })
    const r = await createSupplierInvoice(db, ctx, input, { fileId: "f1", ocr: null })
    assert.ok(r.ok); assert.deepEqual([calls.invoiceCreate, calls.history], [1, 1])
  })
  it("course arbitrée par l'index partiel (P2002 companyId+fileId) ⇒ LifecycleAbort typé (rollback par le wrapper), jamais un résultat", async () => {
    const { db, calls } = fakeDb({ fileFindFirst: () => ({ id: "f1" }), invoiceCreate: () => { throw p2002(["companyId", "fileId"]) } })
    await assert.rejects(createSupplierInvoice(db, ctx, input, { fileId: "f1", ocr: null }), (e) => e instanceof LifecycleAbort && e.userMessage === SUPPLIER_ERRORS.duplicateSubmission)
    assert.equal(calls.history, 0, "aucun journal après l'échec")
  })
  it("P2002 d'une autre cible (numéro validé, clé primaire) ⇒ relancé tel quel", async () => {
    for (const target of [["companyId", "supplierId", "number"], ["id"]]) {
      const err = p2002(target)
      const { db } = fakeDb({ fileFindFirst: () => ({ id: "f1" }), invoiceCreate: () => { throw err } })
      await assert.rejects(createSupplierInvoice(db, ctx, input, { fileId: "f1", ocr: null }), (e) => e === err)
    }
  })
  it("sans fichier : aucun pré-contrôle de pièce, création normale", async () => {
    const { db, calls } = fakeDb({})
    assert.ok((await createSupplierInvoice(db, ctx, input, { fileId: null, ocr: null })).ok)
    assert.equal(calls.invoiceFind, 0)
  })
})
