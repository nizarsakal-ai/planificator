import assert from "node:assert/strict"
import { test } from "node:test"
import {
  BAT_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  PRODUCTION_STATUS_LABELS,
  readPrintManagerQuote,
} from "../../src/lib/imprimerie/print-manager"

const quote = { number: "DEV-2024-0001", status: "DRAFT" }
const invoiceRequestScope = encodeURIComponent(JSON.stringify(["societe-test", "chantier-test", quote.number]))

test("le suivi conserve seulement le numéro et le statut de la facture", async (t) => {
  for (const status of Object.keys(INVOICE_STATUS_LABELS)) {
    await t.test(status, async (t) => {
      const invoice = { number: "FAC-TEST-01", status }
      t.mock.method(globalThis, "fetch", (input: string, options?: RequestInit) => {
        assert.match(input, /\/devis\/DEV-2024-0001$/)
        assert.equal(new Headers(options?.headers).get("X-Imprimerie-Invoice-Scope"), invoiceRequestScope)
        return Promise.resolve(Response.json({
          ...quote, invoice: { ...invoice, total: 50, pdfUrl: "hors contrat" },
        }))
      })
      assert.deepEqual(await readPrintManagerQuote(quote.number, "test-token", invoiceRequestScope), {
        state: "ready", quote: { ...quote, invoice },
      })
    })
  }
})

test("une facture reçue sans demande explicite est ignorée", async (t) => {
  t.mock.method(globalThis, "fetch", (_input: string, options?: RequestInit) => {
    assert.equal(new Headers(options?.headers).get("X-Imprimerie-Invoice-Scope"), null)
    return Promise.resolve(Response.json({ ...quote, invoice: { number: "FAC-TEST-01", status: "PAID" } }))
  })
  assert.deepEqual(await readPrintManagerQuote(quote.number, "test-token"), { state: "ready", quote })
})

test("une facture absente ou invalide préserve le suivi du devis", async (t) => {
  for (const invoice of [
    undefined, null, "FAC-TEST-01", {},
    { number: 123, status: "PAID" },
    { number: " ", status: "PAID" },
    { number: "FAC-TEST-01", status: "UNKNOWN" },
    { number: "FAC-TEST-01", status: "constructor" },
  ]) {
    const stub = t.mock.method(globalThis, "fetch", () =>
      Promise.resolve(Response.json({ ...quote, invoice })))
    assert.deepEqual(
      await readPrintManagerQuote(quote.number, "test-token", invoiceRequestScope),
      { state: "ready", quote },
    )
    stub.mock.restore()
  }
})

test("la réponse d’un autre devis est écartée", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ ...quote, number: "DEV-2024-0002" })))
  assert.deepEqual(await readPrintManagerQuote(quote.number, "test-token"), { state: "unavailable" })
})

test("le BAT associé expose ses quatre statuts métier en lecture seule", async (t) => {
  for (const status of Object.keys(BAT_STATUS_LABELS)) {
    await t.test(status, async (t) => {
      const bat = { number: "BAT-2024-0001", status }
      t.mock.method(globalThis, "fetch", (input: string, options?: RequestInit) => {
        assert.equal(input, "https://printmanager-pro.onrender.com/api/integrations/imprimerie/devis/" + quote.number)
        assert.equal(options?.method ?? "GET", "GET")
        assert.equal(options?.cache, "no-store")
        return Promise.resolve(Response.json({ ...quote, bat }))
      })
      assert.deepEqual(await readPrintManagerQuote(quote.number, "test-token"), {
        state: "ready",
        quote: { number: quote.number, status: quote.status, bat },
      })
    })
  }
})

test("une réponse sans BAT, ancienne ou incomplète garde le devis accessible", async (t) => {
  for (const value of [null, undefined, { number: "BAT-2024-0001", status: "UNKNOWN" }]) {
    await t.test(value === null ? "aucun BAT rattaché" : value === undefined ? "ancien serveur" : "statut inconnu", async (t) => {
      t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ ...quote, bat: value })))
      const result = await readPrintManagerQuote(quote.number, "test-token")
      assert.equal(result.state, "ready")
      if (result.state === "ready") {
        assert.equal(result.quote.number, quote.number)
        assert.equal(result.quote.bat, value === null ? null : undefined)
      }
    })
  }
})

test("les ordres de fabrication conservent leur numéro et leur statut à côté du BAT", async (t) => {
  const bat = { number: "BAT-2024-0001", status: "APPROVED" }
  const productionOrders = Object.keys(PRODUCTION_STATUS_LABELS).map((status, index) => ({
    number: "OF-2024-000" + (index + 1),
    status,
  }))
  const payload = productionOrders.map((order) => ({ ...order, internalNotes: "hors périmètre" }))
  t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ ...quote, bat, productionOrders: payload })))
  assert.deepEqual(await readPrintManagerQuote(quote.number, "test-token"), {
    state: "ready",
    quote: {
      number: quote.number,
      status: quote.status,
      bat,
      productionOrders: productionOrders.map((order) => ({ ...order, deliveredAt: null })),
    },
  })
})

test("une fabrication vide est distincte d’un suivi absent ou invalide", async (t) => {
  const scenarios = [
    { name: "aucun ordre", payload: [], expected: [] },
    { name: "ancien serveur", payload: undefined, expected: undefined },
    { name: "statut inconnu", payload: [{ number: "OF-2024-0001", status: "UNKNOWN" }], expected: undefined },
    { name: "ordre invalide", payload: [null], expected: undefined },
  ]
  for (const { name, payload, expected } of scenarios) {
    await t.test(name, async (t) => {
      const bat = { number: "BAT-2024-0001", status: "APPROVED" }
      t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ ...quote, bat, productionOrders: payload })))
      const result = await readPrintManagerQuote(quote.number, "test-token")
      assert.equal(result.state, "ready")
      assert.equal(result.quote.number, quote.number)
      assert.deepEqual(result.quote.bat, bat)
      assert.deepEqual(result.quote.productionOrders, expected)
    })
  }
})

test("seule une date ISO valide d’un ordre livré est affichable", async (t) => {
  const date = "2026-11-24T23:30:00.000Z"
  const orders = [
    { number: "OF-01", status: "LIVRE", deliveredAt: date },
    { number: "OF-02", status: "PRET", deliveredAt: date },
    { number: "OF-03", status: "ANNULE", deliveredAt: date },
    { number: "OF-04", status: "LIVRE", deliveredAt: "2026-02-30T10:00:00.000Z" },
    { number: "OF-05", status: "LIVRE" },
  ]
  t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ ...quote, productionOrders: orders })))
  const result = await readPrintManagerQuote(quote.number, "test-token")
  assert.equal(result.state, "ready")
  assert.deepEqual(result.quote.productionOrders, [
    orders[0],
    ...orders.slice(1).map((order) => ({ ...order, deliveredAt: null })),
  ])
})
