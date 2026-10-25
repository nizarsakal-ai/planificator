// Lot C4 — calcul pur des avoirs partiels : par lignes (quantités), par montant HT ventilé, refus.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeCreditLines } from "@/lib/billing/invoices/credit-note.core"

const c = (n: number) => BigInt(n)
const origin = {
  globalDiscountBp: 1000, vatReverseCharge: false,
  lines: [
    { id: "l1", designation: "Pose", description: null, unit: "h", quantityHundredths: c(1000), unitPriceCents: c(5000), discountBp: 0, vatRateBp: 2000, deductsDepositId: null },
    { id: "l2", designation: "Fournitures", description: "détail", unit: "u", quantityHundredths: c(200), unitPriceCents: c(10000), discountBp: 500, vatRateBp: 1000, deductsDepositId: null },
    { id: "d1", designation: "Déduction acompte", description: null, unit: "forfait", quantityHundredths: c(100), unitPriceCents: c(-10000), discountBp: 0, vatRateBp: 2000, deductsDepositId: "dep" },
  ],
}

describe("avoir par lignes", () => {
  it("mêmes PU, remises de ligne ET remise globale ; quantité ≤ origine ; désignation préfixée", () => {
    const r = computeCreditLines(origin, { kind: "LINES", items: [{ lineId: "l1", quantityHundredths: c(400) }, { lineId: "l2", quantityHundredths: c(100) }] })
    assert.equal(r.lines[0].designation, "Avoir — Pose"); assert.equal(r.lines[1].description, "détail")
    // l1 : 4 × 50 = 200 ; −10 % global = 180 ; TVA 36. l2 : 1 × 100 − 5 % = 95 ; −10 % = 85,50 ; TVA 8,55.
    assert.equal(r.totals.totalHTCents, c(18000 + 8550)); assert.equal(r.totals.totalVATCents, c(3600 + 855))
  })
  it("refus : ligne inconnue, quantité nulle ou supérieure, ligne de déduction d'acompte, aucune ligne", () => {
    assert.throws(() => computeCreditLines(origin, { kind: "LINES", items: [{ lineId: "x", quantityHundredths: c(100) }] }), /CREDIT_LINE_UNKNOWN/)
    assert.throws(() => computeCreditLines(origin, { kind: "LINES", items: [{ lineId: "l1", quantityHundredths: c(0) }] }), /CREDIT_QUANTITY_INVALID/)
    assert.throws(() => computeCreditLines(origin, { kind: "LINES", items: [{ lineId: "l1", quantityHundredths: c(1001) }] }), /CREDIT_QUANTITY_INVALID/)
    assert.throws(() => computeCreditLines(origin, { kind: "LINES", items: [{ lineId: "d1", quantityHundredths: c(100) }] }), /CREDIT_LINE_NOT_CREDITABLE/)
    assert.throws(() => computeCreditLines(origin, { kind: "LINES", items: [] }), /CREDIT_NO_LINES/)
  })
})

describe("avoir par montant HT", () => {
  it("ventilé par taux au prorata des bases HT nettes (hors déductions), somme exacte, TVA au taux", () => {
    // Bases nettes : 20 % : 500 − 10 % = 450 ; 10 % : 190 − 10 % = 171 ⇒ total 621.
    const r = computeCreditLines(origin, { kind: "AMOUNT_HT", cents: c(10000) })
    assert.equal(r.totals.totalHTCents, c(10000))
    assert.deepEqual(r.lines.map((l) => [l.vatRateBp, l.unitPriceCents]), [[1000, c(2754)], [2000, c(7246)]]) // 100 × 171/621 = 27,536 → 27,54 ; reste 72,46
    assert.equal(r.totals.totalVATCents, c(275 + 1449))
  })
  it("arrondis : la somme ventilée est exactement le montant (3 centimes sur deux taux)", () => {
    const r = computeCreditLines(origin, { kind: "AMOUNT_HT", cents: c(3) })
    assert.equal(r.lines.reduce((s, l) => s + l.unitPriceCents, c(0)), c(3))
  })
  it("refus : montant nul, montant > HT net de l'origine", () => {
    assert.throws(() => computeCreditLines(origin, { kind: "AMOUNT_HT", cents: c(0) }), /AMOUNT_INVALID/)
    assert.throws(() => computeCreditLines(origin, { kind: "AMOUNT_HT", cents: c(62101) }), /CREDIT_EXCEEDS/)
  })
})
