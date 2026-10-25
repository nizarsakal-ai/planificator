// Lot C3 — calcul pur des acomptes : ventilation par taux (pourcentage, montant TTC exact), lignes de déduction.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildDeductionLines, computeDepositLines, depositDesignation, depositTotal } from "@/lib/billing/invoices/deposit.core"

const c = (n: number) => BigInt(n)
// Devis : base 20 % = 1 000,00 (TVA 200,00) ; base 10 % = 333,33 (TVA 33,33) ⇒ TTC 1 566,66
const summary = [{ vatRateBp: 1000, baseCents: c(33333), vatCents: c(3333) }, { vatRateBp: 2000, baseCents: c(100000), vatCents: c(20000) }]

describe("acompte en pourcentage", () => {
  it("30 % : HT par taux arrondi, TVA au taux de chaque ligne", () => {
    const lines = computeDepositLines(summary, { kind: "PERCENT", bp: 3000 }, false)
    assert.deepEqual(lines, [{ vatRateBp: 1000, netCents: c(10000), vatCents: c(1000) }, { vatRateBp: 2000, netCents: c(30000), vatCents: c(6000) }])
    assert.deepEqual(depositTotal(lines), { htCents: c(40000), vatCents: c(7000), ttcCents: c(47000) })
  })
  it("33,33 % : arrondi demi-supérieur ; autoliquidation ⇒ TVA 0 ; 0 % et > 100 % refusés ; devis vide refusé", () => {
    const l = computeDepositLines(summary, { kind: "PERCENT", bp: 3333 }, false)
    assert.equal(l[0].netCents, c(11110)) // 333,33 × 33,33 % = 111,098889 → 111,10
    assert.equal(computeDepositLines(summary, { kind: "PERCENT", bp: 5000 }, true)[1].vatCents, c(0))
    assert.throws(() => computeDepositLines(summary, { kind: "PERCENT", bp: 0 }, false), /PERCENT_INVALID/)
    assert.throws(() => computeDepositLines(summary, { kind: "PERCENT", bp: 10001 }, false), /PERCENT_INVALID/)
    assert.throws(() => computeDepositLines([], { kind: "PERCENT", bp: 1000 }, false), /DEPOSIT_EMPTY_QUOTE/)
  })
})

describe("acompte en montant TTC", () => {
  it("le TTC de l'acompte est exactement le montant demandé, ventilé au prorata des TTC par taux", () => {
    for (const amount of [50000, 123456, 1, 156666]) {
      const lines = computeDepositLines(summary, { kind: "AMOUNT_TTC", cents: c(amount) }, false)
      assert.equal(depositTotal(lines).ttcCents, c(amount), String(amount))
      for (const l of lines) assert.ok(l.netCents >= c(0) && l.vatCents >= c(0))
    }
  })
  it("dépassement du TTC du devis et montant nul refusés", () => {
    assert.throws(() => computeDepositLines(summary, { kind: "AMOUNT_TTC", cents: c(156667) }, false), /DEPOSIT_EXCEEDS_QUOTE/)
    assert.throws(() => computeDepositLines(summary, { kind: "AMOUNT_TTC", cents: c(0) }, false), /AMOUNT_INVALID/)
  })
})

describe("déductions", () => {
  it("une ligne négative par acompte et par taux, désignation avec numéro et date", () => {
    const lines = buildDeductionLines([{ id: "d1", number: "FAC-2026-0002", issueDate: new Date("2026-03-12T00:00:00Z"), lines: [{ vatRateBp: 2000, netCents: c(30000) }, { vatRateBp: 1000, netCents: c(0) }] }])
    assert.deepEqual(lines, [{ deductsDepositId: "d1", designation: "Déduction acompte FAC-2026-0002 du 12/03/2026 (TVA 20 %)", vatRateBp: 2000, unitPriceCents: c(-30000) }])
    assert.equal(depositDesignation("DEV-1", { kind: "PERCENT", bp: 3000 }, 550), "Acompte de 30 % sur le devis DEV-1 (base TVA 5,5 %)")
  })
})
