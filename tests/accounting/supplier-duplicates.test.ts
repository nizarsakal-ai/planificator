import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { findValidatedDuplicates, isSameInvoice, type ValidatedCandidate } from "../../src/lib/accounting/c5/supplier-invoice.service"
import { listSupplierInvoices } from "../../src/lib/accounting/c5/supplier-invoice.service"

// Données synthétiques. Retour 18/11/2026 : même facture fournisseur importée deux fois (une validée, une rejetée).
const validated = (o: Partial<ValidatedCandidate> = {}): ValidatedCandidate =>
  ({ id: "v1", number: "36077", supplierName: "CALI GAME", siret: "98182357800019", supplier: { name: "CALI GAME", siret: "98182357800019" }, ...o })

describe("doublons de factures fournisseurs", () => {
  it("même numéro et même SIRET : doublon, quel que soit le nom saisi", () => {
    assert.equal(isSameInvoice({ number: " 36077 ", supplierName: "Cali Game SAS", siret: "98182357800019" }, validated()), true)
  })
  it("même numéro, SIRET différent : pas un doublon (deux fournisseurs distincts)", () => {
    assert.equal(isSameInvoice({ number: "36077", supplierName: "CALI GAME", siret: "11111111111111" }, validated()), false)
  })
  it("sans SIRET : même nom, casse ignorée", () => {
    assert.equal(isSameInvoice({ number: "36077", supplierName: "cali game", siret: null }, validated({ siret: null, supplier: { name: "CALI GAME", siret: null } })), true)
    assert.equal(isSameInvoice({ number: "36077", supplierName: "Autre", siret: null }, validated({ siret: null, supplier: null })), false)
  })
  it("numéro différent : jamais un doublon", () => {
    assert.equal(isSameInvoice({ number: "36078", supplierName: "CALI GAME", siret: "98182357800019" }, validated()), false)
  })
  it("requête : factures VALIDÉES de la société, numéros demandés, sonde elle-même exclue", async () => {
    let where: Record<string, unknown> = {}
    const db = { supplierInvoice: { findMany: async (a: { where?: Record<string, unknown> }) => { where = a.where ?? {}; return [validated()] } } }
    const hits = await findValidatedDuplicates(db as never, { companyId: "co" }, [{ number: "36077", supplierName: "CALI GAME", siret: null }, { number: "1", supplierName: "X", siret: null }], ["r1"])
    assert.deepEqual(hits, ["v1", null])
    assert.equal(where.companyId, "co"); assert.equal(where.status, "VALIDATED")
    assert.deepEqual(where.number, { in: ["36077", "1"] }); assert.deepEqual(where.id, { notIn: ["r1"] })
  })
  it("aucun numéro : aucune requête", async () => {
    let calls = 0
    const db = { supplierInvoice: { findMany: async () => { calls++; return [] } } }
    assert.deepEqual(await findValidatedDuplicates(db as never, { companyId: "co" }, [{ number: " ", supplierName: "X", siret: null }]), [null]); assert.equal(calls, 0)
  })
})

describe("liste des factures fournisseurs : rejetées masquées par défaut", () => {
  const capture = async (status?: "ALL" | "REJECTED") => {
    let where: Record<string, unknown> = {}
    const db = { supplierInvoice: { count: async (a: { where: Record<string, unknown> }) => { where = a.where; return 0 }, findMany: async () => [] } }
    await listSupplierInvoices(db as never, { companyId: "co" }, { status })
    return where
  }
  it("sans filtre : factures rejetées exclues", async () => { assert.deepEqual((await capture()).status, { not: "REJECTED" }) })
  it("« Toutes » : aucune restriction de statut", async () => { assert.equal("status" in (await capture("ALL")), false) })
  it("filtre « Rejetées » : toujours accessibles", async () => { assert.equal((await capture("REJECTED")).status, "REJECTED") })
  it("la page signale les doublons et propose « Toutes, rejetées comprises »", () => {
    const page = readFileSync("src/app/(dashboard)/comptabilite/fournisseurs/page.tsx", "utf8")
    assert.match(page, /findValidatedDuplicates\(prisma, ctx,/)
    assert.match(page, /<option value="ALL">Toutes, rejetées comprises<\/option>/)
    assert.match(page, /Doublon de la facture validée/)
  })
})
