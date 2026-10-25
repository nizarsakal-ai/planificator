// Lot C1 — monnaie exacte en centimes : conversions, arrondis, totaux multi-taux et remises.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prisma } from "@prisma/client"
import {
  MoneyError, bpToPercentString, centsToDecimal, centsToDecimalString, computeDocumentTotals, decimalToCents, formatEuro,
  parseEuroInputToCents, parsePercentToBp, parseQuantityToHundredths, parseVatRateToBp, storedVatRateToBp,
} from "@/lib/billing/money"

const c = (n: number | string) => BigInt(n)

describe("conversions Decimal ↔ centimes", () => {
  it("decimalToCents exact, refuse plus de 2 décimales", () => {
    assert.equal(decimalToCents(new Prisma.Decimal("1234.56")), c(123456))
    assert.equal(decimalToCents(new Prisma.Decimal("-0.05")), c(-5))
    assert.equal(decimalToCents("20"), c(2000))
    assert.equal(decimalToCents(null), c(0))
    assert.throws(() => decimalToCents(new Prisma.Decimal("1.005")), (e: unknown) => e instanceof MoneyError && e.code === "DECIMAL_NOT_CENTS")
  })
  it("centsToDecimalString / centsToDecimal", () => {
    assert.equal(centsToDecimalString(c(5)), "0.05")
    assert.equal(centsToDecimalString(c(-123456)), "-1234.56")
    assert.equal(centsToDecimal(c(100)).toFixed(2), "1.00")
    assert.throws(() => centsToDecimal(c("10000000000")), /AMOUNT_TOO_LARGE/)
  })
  it("saisies : euros, quantités, pourcentages, taux", () => {
    assert.equal(parseEuroInputToCents("1 234,56"), c(123456))
    assert.equal(parseEuroInputToCents("12.5"), c(1250))
    assert.equal(parseEuroInputToCents(""), c(0))
    assert.throws(() => parseEuroInputToCents("-1"), /AMOUNT_INVALID/)
    assert.throws(() => parseEuroInputToCents("1,234"), /AMOUNT_INVALID/)
    assert.throws(() => parseEuroInputToCents("100000000"), /AMOUNT_TOO_LARGE/)
    assert.equal(parseQuantityToHundredths("1,5"), c(150))
    assert.equal(parseQuantityToHundredths("3"), c(300))
    assert.throws(() => parseQuantityToHundredths("1.234"), /QUANTITY_INVALID/)
    assert.equal(parsePercentToBp("2,5"), 250)
    assert.equal(parsePercentToBp("100"), 10000)
    assert.throws(() => parsePercentToBp("100.5"), /PERCENT_INVALID/)
    assert.equal(parseVatRateToBp("20"), 2000); assert.equal(parseVatRateToBp("5,5"), 550); assert.equal(parseVatRateToBp("2.10"), 210); assert.equal(parseVatRateToBp(0), 0)
    assert.throws(() => parseVatRateToBp("19.6"), /VAT_RATE_INVALID/)
    assert.equal(storedVatRateToBp(new Prisma.Decimal("5.50")), 550)
    assert.equal(bpToPercentString(550), "5.5"); assert.equal(bpToPercentString(2000), "20"); assert.equal(bpToPercentString(210), "2.1")
  })
  it("formatEuro fr-FR exact", () => {
    assert.equal(formatEuro(c(123456789)), "1 234 567,89 €")
    assert.equal(formatEuro(c(-5)), "−0,05 €")
  })
})

describe("totaux de document (arrondi demi-supérieur ligne par ligne)", () => {
  it("multi-taux sans remise : TVA par ligne puis sommes", () => {
    const t = computeDocumentTotals([
      { quantityHundredths: c(300), unitPriceCents: c(3333), discountBp: 0, vatRateBp: 2000 }, // 99.99 → TVA 19.998 → 20.00
      { quantityHundredths: c(100), unitPriceCents: c(1001), discountBp: 0, vatRateBp: 550 },  // 10.01 → 0.55055 → 0.55
      { quantityHundredths: c(150), unitPriceCents: c(1000), discountBp: 0, vatRateBp: 1000 }, // 15.00 → 1.50
    ], { globalDiscountBp: 0, vatReverseCharge: false })
    assert.equal(t.totalHTCents, c(12500))
    assert.equal(t.totalVATCents, c(2000 + 55 + 150))
    assert.equal(t.totalTTCCents, c(12500 + 2205))
    assert.deepEqual(t.vatSummary.map((v) => [v.vatRateBp, v.baseCents, v.vatCents]), [[550, c(1001), c(55)], [1000, c(1500), c(150)], [2000, c(9999), c(2000)]])
  })
  it("remise de ligne puis remise globale, chacune arrondie au centime", () => {
    const t = computeDocumentTotals([{ quantityHundredths: c(100), unitPriceCents: c(10000), discountBp: 1250, vatRateBp: 2000 }], { globalDiscountBp: 500, vatReverseCharge: false })
    // 100 − 12,5 % = 87,50 ; − 5 % (4,375 → 4,38) = 83,12 ; TVA 16,624 → 16,62
    assert.equal(t.lines[0].lineHTCents, c(8750))
    assert.equal(t.subtotalCents, c(8750))
    assert.equal(t.globalDiscountCents, c(438))
    assert.equal(t.totalHTCents, c(8312))
    assert.equal(t.totalVATCents, c(1662))
    assert.equal(t.totalTTCCents, c(9974))
  })
  it("autoliquidation : TVA nulle, taux conservés dans le récapitulatif", () => {
    const t = computeDocumentTotals([{ quantityHundredths: c(100), unitPriceCents: c(1000), discountBp: 0, vatRateBp: 2000 }], { globalDiscountBp: 0, vatReverseCharge: true })
    assert.equal(t.totalVATCents, c(0)); assert.equal(t.totalTTCCents, c(1000)); assert.equal(t.vatSummary[0].vatRateBp, 2000)
  })
  it("quantité × prix : 0,33 × 3,33 = 1,0989 → 1,10 ; demi exact 0,5 × 0,01 = 0,005 → 0,01", () => {
    const t = computeDocumentTotals([
      { quantityHundredths: c(33), unitPriceCents: c(333), discountBp: 0, vatRateBp: 0 },
      { quantityHundredths: c(50), unitPriceCents: c(1), discountBp: 0, vatRateBp: 0 },
    ], { globalDiscountBp: 0, vatReverseCharge: false })
    assert.equal(t.lines[0].grossCents, c(110)); assert.equal(t.lines[1].grossCents, c(1))
  })
  it("prix négatif (déduction d'acompte) : arrondi sur la valeur absolue, signe réappliqué", () => {
    const t = computeDocumentTotals([{ quantityHundredths: c(100), unitPriceCents: c(-1001), discountBp: 0, vatRateBp: 550 }], { globalDiscountBp: 0, vatReverseCharge: false })
    assert.equal(t.totalHTCents, c(-1001)); assert.equal(t.totalVATCents, c(-55))
  })
  it("refuse taux hors liste, remise > 100 %, dépassement Decimal(10,2)", () => {
    assert.throws(() => computeDocumentTotals([{ quantityHundredths: c(100), unitPriceCents: c(1), discountBp: 0, vatRateBp: 1960 }], { globalDiscountBp: 0, vatReverseCharge: false }), /VAT_RATE_INVALID/)
    assert.throws(() => computeDocumentTotals([{ quantityHundredths: c(100), unitPriceCents: c(1), discountBp: 10001, vatRateBp: 0 }], { globalDiscountBp: 0, vatReverseCharge: false }), /PERCENT_INVALID/)
    assert.throws(() => computeDocumentTotals([{ quantityHundredths: c(10000000), unitPriceCents: c(10000000), discountBp: 0, vatRateBp: 0 }], { globalDiscountBp: 0, vatReverseCharge: false }), /AMOUNT_TOO_LARGE/)
  })
})
