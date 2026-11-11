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
