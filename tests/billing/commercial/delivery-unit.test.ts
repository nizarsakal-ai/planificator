// 21/11/2026 — bons de livraison : saisie des quantités livrées (pure).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DELIVERY_ERRORS, formatQuantityFr, parseDeliveredQuantities } from "@/lib/billing/commercial/delivery-note.service"

const ordered = [BigInt(400), BigInt(150)]
describe("parseDeliveredQuantities", () => {
  it("vide ⇒ quantité commandée", () => assert.deepEqual(parseDeliveredQuantities(["", " "], ordered), { ok: true, value: ordered }))
  it("livraison partielle et décimales françaises", () => assert.deepEqual(parseDeliveredQuantities(["3", "1,5"], ordered), { ok: true, value: [BigInt(300), BigInt(150)] }))
  it("zéro sur une ligne accepté si une autre est livrée", () => assert.deepEqual(parseDeliveredQuantities(["0", ""], ordered), { ok: true, value: [BigInt(0), BigInt(150)] }))
  it("tout à zéro refusé", () => assert.deepEqual(parseDeliveredQuantities(["0", "0"], ordered), { ok: false, error: DELIVERY_ERRORS.nothingDelivered }))
  it("nombre de lignes incohérent refusé", () => assert.deepEqual(parseDeliveredQuantities(["1"], ordered), { ok: false, error: DELIVERY_ERRORS.quantityCount }))
  it("saisie invalide refusée avec le numéro de ligne", () => {
    for (const bad of ["abc", "-1", "1,234"]) {
      const r = parseDeliveredQuantities(["1", bad], ordered)
      assert.equal(r.ok, false, bad)
      if (!r.ok) assert.match(r.error, /^Ligne 2/)
    }
  })
})

describe("formatQuantityFr", () => {
  it("sans zéros inutiles, jamais tronqué", () => {
    const d = (s: string) => ({ toFixed: () => s })
    assert.deepEqual(["4.00", "1.50", "0.25", "10.00", "100.10"].map((s) => formatQuantityFr(d(s))), ["4", "1,5", "0,25", "10", "100,1"])
  })
})
