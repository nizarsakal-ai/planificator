import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { findDuplicateInvoice, ticketAmounts } from "@/lib/vehicules/v3/driver-ticket-supplier-invoice"

const inv = (over: Partial<{ id: string; supplierName: string; siret: string | null; number: string; date: Date; totalTTCCents: bigint }> = {}) => ({
  id: "i1", supplierName: "TotalEnergies - Relais de l'Amitié", siret: "90240085200015", number: "106000012672",
  date: new Date("2026-11-18T00:00:00Z"), totalTTCCents: BigInt(15000), ...over,
})

describe("ticket chauffeur → facture fournisseur : doublons", () => {
  it("ticket déjà scanné en comptabilité (cas du 18/11) : reconnu par le fournisseur, le SIRET ou le numéro", () => {
    const t = { day: "2026-11-18", amountCents: 15000 }
    assert.equal(findDuplicateInvoice([inv()], { ...t, siret: null, number: null, supplier: "TOTAL" })?.id, "i1")
    assert.equal(findDuplicateInvoice([inv()], { ...t, siret: "90240085200015", number: null, supplier: null })?.id, "i1")
    assert.equal(findDuplicateInvoice([inv()], { ...t, siret: null, number: "106000012672", supplier: null })?.id, "i1")
    assert.equal(findDuplicateInvoice([inv({ supplierName: "VINCI Autoroutes (réseau Cofiroute)", siret: "55211589100426", totalTTCCents: BigInt(3380) })], { day: "2026-11-18", amountCents: 3380, siret: null, number: null, supplier: "Vinci Autoroutes" })?.id, "i1")
  })
  it("autre plein : montant, date (> 1 jour), SIRET ou fournisseur différents ⇒ facture créée", () => {
    assert.equal(findDuplicateInvoice([inv()], { day: "2026-11-18", amountCents: 9550, siret: null, number: null, supplier: "TOTAL" }), null)
    assert.equal(findDuplicateInvoice([inv()], { day: "2026-11-20", amountCents: 15000, siret: null, number: null, supplier: "TOTAL" }), null)
    assert.equal(findDuplicateInvoice([inv()], { day: "2026-11-18", amountCents: 15000, siret: "11111111111111", number: "106000012672", supplier: "TOTAL" }), null)
    assert.equal(findDuplicateInvoice([inv()], { day: "2026-11-18", amountCents: 15000, siret: null, number: null, supplier: "Esso Montreuil" }), null)
    assert.equal(findDuplicateInvoice([inv()], { day: "2026-11-18", amountCents: 15000, siret: null, number: null, supplier: null }), null)
  })
})

describe("ticket chauffeur → facture fournisseur : montants", () => {
  it("HT/TVA lus et cohérents avec le TTC du chauffeur : repris", () => {
    assert.deepEqual(ticketAmounts(15000, { totalHTCents: BigInt(12500), vatCents: BigInt(2500), vatRateBp: 2000 }), { totalHTCents: BigInt(12500), vatCents: BigInt(2500), totalTTCCents: BigInt(15000), vatRateBp: 2000, vatComputed: false })
  })
  it("lecture absente ou incohérente : TVA 20 % calculée sur le TTC (signalée)", () => {
    for (const ocr of [null, { totalHTCents: BigInt(10000), vatCents: BigInt(2000), vatRateBp: 2000 }]) {
      const a = ticketAmounts(3380, ocr)
      assert.deepEqual([a.totalHTCents, a.vatCents, a.totalTTCCents, a.vatComputed], [BigInt(2817), BigInt(563), BigInt(3380), true]) // cas VINCI : 28,17 + 5,63
    }
  })
})
