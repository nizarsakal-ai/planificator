/**
 * Lot A Planificator V2 : règles pures du stock et des achats (mouvements, inventaire, réception, totaux,
 * rapprochement, quantités). Exécution : `npm run test:stock`.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { belowThreshold, matchOrder, orderTotalCents, planInventoryCount, planMovement, planReceipt, STOCK_ERRORS } from "@/lib/stock/stock.core"
import { formatMilli, lineAmountCents, parseQuantityToMilli } from "@/lib/stock/quantity"

describe("quantités en millièmes", () => {
  it("saisie : virgule ou point, 3 décimales au plus, refus du négatif, du zéro (sauf autorisé) et de l'exponentielle", () => {
    assert.equal(parseQuantityToMilli("12"), 12000)
    assert.equal(parseQuantityToMilli("12,5"), 12500)
    assert.equal(parseQuantityToMilli("0.125"), 125)
    for (const bad of ["-1", "0", "1,2345", "1e3", "", "abc", "1 000", "10000000"]) assert.equal(parseQuantityToMilli(bad), null, bad)
    assert.equal(parseQuantityToMilli("0", { allowZero: true }), 0)
  })
  it("affichage sans arrondi caché", () => {
    assert.equal(formatMilli(12500), "12,5")
    assert.equal(formatMilli(125), "0,125")
    assert.equal(formatMilli(3000), "3")
    assert.equal(formatMilli(-1500), "-1,5")
  })
  it("montant de ligne en BigInt, arrondi au centime, sans perte sur de grands nombres", () => {
    assert.equal(lineAmountCents(1500, 1234), BigInt("1851")) // 1,5 × 12,34 € = 18,51 €
    assert.equal(lineAmountCents(333, 1), BigInt("0"))
    assert.equal(lineAmountCents(500, 1), BigInt("1")) // demi vers le haut
    assert.equal(lineAmountCents(1_000_000_000, 2_000_000_000), BigInt("2000000000000000"))
    assert.throws(() => lineAmountCents(-1, 1), /LINE_AMOUNT_INVALID/)
  })
})

describe("mouvements de stock", () => {
  it("entrée, sortie, transfert, ajustement : variations exactes", () => {
    assert.deepEqual(planMovement({ type: "RECEIPT", quantityMilli: 5000, toWarehouseId: "A" }), { ok: true, value: [{ warehouseId: "A", deltaMilli: 5000 }] })
    assert.deepEqual(planMovement({ type: "ISSUE", quantityMilli: 2000, fromWarehouseId: "A" }), { ok: true, value: [{ warehouseId: "A", deltaMilli: -2000 }] })
    assert.deepEqual(planMovement({ type: "TRANSFER", quantityMilli: 1000, fromWarehouseId: "A", toWarehouseId: "B" }), { ok: true, value: [{ warehouseId: "A", deltaMilli: -1000 }, { warehouseId: "B", deltaMilli: 1000 }] })
    assert.deepEqual(planMovement({ type: "ADJUSTMENT", quantityMilli: 300, fromWarehouseId: "A", reason: "casse" }), { ok: true, value: [{ warehouseId: "A", deltaMilli: -300 }] })
    assert.deepEqual(planMovement({ type: "ADJUSTMENT", quantityMilli: 300, toWarehouseId: "A", reason: "oubli" }), { ok: true, value: [{ warehouseId: "A", deltaMilli: 300 }] })
  })
  it("refus : quantité nulle ou non entière, sens incohérent, transfert vers le même dépôt, ajustement sans motif ou des deux côtés", () => {
    const bad = [
      { type: "RECEIPT", quantityMilli: 0, toWarehouseId: "A" }, { type: "RECEIPT", quantityMilli: 1.5, toWarehouseId: "A" },
      { type: "RECEIPT", quantityMilli: 1, fromWarehouseId: "A" }, { type: "ISSUE", quantityMilli: 1, toWarehouseId: "A" },
      { type: "TRANSFER", quantityMilli: 1, fromWarehouseId: "A" }, { type: "ADJUSTMENT", quantityMilli: 1, fromWarehouseId: "A", reason: " " },
      { type: "ADJUSTMENT", quantityMilli: 1, fromWarehouseId: "A", toWarehouseId: "B", reason: "x" }, { type: "INCONNU", quantityMilli: 1, toWarehouseId: "A" },
    ] as Parameters<typeof planMovement>[0][]
    for (const m of bad) assert.equal(planMovement(m).ok, false, JSON.stringify(m))
    assert.deepEqual(planMovement({ type: "TRANSFER", quantityMilli: 1, fromWarehouseId: "A", toWarehouseId: "A" }), { ok: false, error: STOCK_ERRORS.sameWarehouse })
  })
  it("inventaire : écart en plus, en moins, ou aucun mouvement", () => {
    assert.deepEqual(planInventoryCount(5000, 5000, "A", "annuel"), { ok: true, value: null })
    const plus = planInventoryCount(5000, 7000, "A", "annuel")
    assert.ok(plus.ok && plus.value && plus.value.toWarehouseId === "A" && plus.value.quantityMilli === 2000 && plus.value.type === "ADJUSTMENT")
    const minus = planInventoryCount(5000, 1000, "A", "")
    assert.ok(minus.ok && minus.value && minus.value.fromWarehouseId === "A" && minus.value.quantityMilli === 4000 && /^Inventaire : comptage/.test(minus.value.reason ?? ""))
    assert.equal(planInventoryCount(5000, -1, "A", "x").ok, false)
  })
  it("seuil d'alerte", () => {
    assert.equal(belowThreshold(900, 1000), true)
    assert.equal(belowThreshold(1000, 1000), false)
    assert.equal(belowThreshold(0, null), false)
  })
})

describe("réception et commande", () => {
  const lines = [{ id: "l1", quantityMilli: 10000, receivedMilli: 0, unitPriceCents: 1000 }, { id: "l2", quantityMilli: 2000, receivedMilli: 2000, unitPriceCents: 500 }]
  it("réception partielle puis totale", () => {
    assert.deepEqual(planReceipt("ORDERED", lines, [{ orderLineId: "l1", quantityMilli: 4000 }]), { ok: true, value: { lines: [{ orderLineId: "l1", quantityMilli: 4000 }], nextStatus: "PARTIALLY_RECEIVED" } })
    assert.deepEqual(planReceipt("PARTIALLY_RECEIVED", lines, [{ orderLineId: "l1", quantityMilli: 10000 }, { orderLineId: "l2", quantityMilli: 0 }]), { ok: true, value: { lines: [{ orderLineId: "l1", quantityMilli: 10000 }], nextStatus: "RECEIVED" } })
  })
  it("refus : surréception, ligne inconnue, doublon, rien à recevoir, état non réceptionnable", () => {
    assert.deepEqual(planReceipt("ORDERED", lines, [{ orderLineId: "l1", quantityMilli: 10001 }]), { ok: false, error: STOCK_ERRORS.overReceipt })
    assert.deepEqual(planReceipt("ORDERED", lines, [{ orderLineId: "l2", quantityMilli: 1 }]), { ok: false, error: STOCK_ERRORS.overReceipt })
    assert.deepEqual(planReceipt("ORDERED", lines, [{ orderLineId: "zz", quantityMilli: 1 }]), { ok: false, error: STOCK_ERRORS.notFound })
    assert.equal(planReceipt("ORDERED", lines, [{ orderLineId: "l1", quantityMilli: 1 }, { orderLineId: "l1", quantityMilli: 1 }]).ok, false)
    assert.deepEqual(planReceipt("ORDERED", lines, [{ orderLineId: "l1", quantityMilli: 0 }]), { ok: false, error: STOCK_ERRORS.emptyReceipt })
    for (const st of ["DRAFT", "RECEIVED", "CANCELLED"] as const) assert.deepEqual(planReceipt(st, lines, [{ orderLineId: "l1", quantityMilli: 1 }]), { ok: false, error: STOCK_ERRORS.orderNotReceivable })
  })
  it("total HT et rapprochement commande, réception, facture", () => {
    assert.equal(orderTotalCents(lines), BigInt("11000"))
    const partial = [{ id: "l1", quantityMilli: 10000, receivedMilli: 4000, unitPriceCents: 1000 }]
    assert.deepEqual(matchOrder({ lines: partial, invoicedHTCents: BigInt("0") }), { orderedCents: BigInt("10000"), receivedCents: BigInt("4000"), invoicedCents: BigInt("0"), status: "EN_ATTENTE" })
    assert.equal(matchOrder({ lines: partial, invoicedHTCents: BigInt("4050"), toleranceCents: BigInt("100") }).status, "CONFORME")
    assert.equal(matchOrder({ lines: partial, invoicedHTCents: BigInt("4200"), toleranceCents: BigInt("100") }).status, "ECART_FACTURE")
    assert.equal(matchOrder({ lines: partial, invoicedHTCents: BigInt("4001") }).status, "ECART_FACTURE")
    assert.equal(matchOrder({ lines: partial, invoicedHTCents: BigInt("4001"), toleranceCents: -BigInt("5") }).status, "ECART_FACTURE")
  })
})
