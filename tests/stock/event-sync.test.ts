/** Automatisation Stock ⇄ Achats ⇄ Matériel : règles pures (lien fiche → article, quantité attendue par dépôt). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { catalogItemFor, catalogItemForArticle, expectedUnitsByWarehouse } from "@/lib/integration/event-sync"
import { EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"

describe("automatisation stock / achats / matériel", () => {
  it("relie une fiche Matériel à son article par la désignation du catalogue (à défaut la catégorie)", () => {
    assert.equal(catalogItemFor({ name: "tente pliante 3X3 m" })?.reference, "EVT-TENTE-PLIANTE-3X3-M")
    assert.equal(catalogItemFor({ name: "Ma tente bleue", category: "Photobooth 360°" })?.reference, "EVT-PHOTOBOOTH-360")
    assert.equal(catalogItemFor({ name: "Compresseur" }), null)
    assert.equal(catalogItemForArticle({ reference: null, designation: "Mange-debout" })?.tracked, false)
  })
  it("sépare suivi à l'unité et gestion en quantité", () => {
    const t = (d: string) => EVENT_STOCK_ARTICLES.find((a) => a.designation === d)?.tracked
    assert.equal(t("Tente pliante 3x3 m"), true)
    assert.equal(t("Photobooth 360°"), true)
    assert.equal(t("Chaise pliante"), false)
    assert.equal(t("Tee-shirt floqué"), false)
    assert.equal(t("Moquette événementielle"), false)
  })
  it("compte en stock les fiches en propriété présentes au dépôt (ni sorties, ni réformées, ni louées)", () => {
    const m = expectedUnitsByWarehouse([
      { warehouseId: "w1", status: "AVAILABLE", ownership: "OWNED" },
      { warehouseId: "w1", status: "MAINTENANCE", ownership: "OWNED" },
      { warehouseId: "w1", status: "OUT", ownership: "OWNED" },
      { warehouseId: "w1", status: "RETIRED", ownership: "OWNED" },
      { warehouseId: "w1", status: "AVAILABLE", ownership: "RENTED" },
      { warehouseId: "w2", status: "AVAILABLE", ownership: "OWNED" },
      { warehouseId: null, status: "AVAILABLE", ownership: "OWNED" },
    ])
    assert.deepEqual([...m.entries()].sort(), [["w1", 2], ["w2", 1]])
  })
})

describe("création automatique depuis Matériel", () => {
  it("codes courts lisibles et uniques pour les n° internes", async () => {
    const { eventShortCode } = await import("@/components/equipment/event-catalog")
    assert.equal(eventShortCode("Tente pliante 3x3 m"), "TENTE-3X3")
    assert.equal(eventShortCode("Tente pliante 3x6 m"), "TENTE-3X6")
    assert.equal(eventShortCode("Photobooth 360°"), "PHOTOBOOTH-360")
    const codes = EVENT_STOCK_ARTICLES.map((a) => a.code)
    assert.equal(new Set(codes).size, codes.length)
    for (const c of codes) assert.match(c, /^[A-Z0-9][A-Z0-9-]{0,23}$/)
  })
  it("prochains numéros libres, sans réutiliser un numéro pris", async () => {
    const { nextEquipmentNumbers } = await import("@/lib/integration/event-sync")
    const db = { equipment: { findMany: async () => [{ number: "TENTE-3X3-001" }, { number: "TENTE-3X3-003" }] } }
    assert.deepEqual(await nextEquipmentNumbers(db as never, "c1", "TENTE-3X3", 3), ["TENTE-3X3-002", "TENTE-3X3-004", "TENTE-3X3-005"])
  })
})
