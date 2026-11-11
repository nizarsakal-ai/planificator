/** Catalogue événementiel partagé Matériel / Stock : références stables, uniques et lisibles. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EVENT_STOCK_ARTICLES, EVENT_REF_PREFIX, eventArticleReference } from "@/components/equipment/event-catalog"

describe("catalogue événementiel en stock", () => {
  it("références uniques, préfixées, sans accent, 40 caractères au plus", () => {
    const refs = EVENT_STOCK_ARTICLES.map((a) => a.reference)
    assert.equal(new Set(refs).size, refs.length)
    for (const r of refs) { assert.ok(r.startsWith(EVENT_REF_PREFIX)); assert.match(r, /^[A-Z0-9-]+$/); assert.ok(r.length <= 40) }
  })
  it("contient les articles demandés", () => {
    const names = EVENT_STOCK_ARTICLES.map((a) => a.designation)
    for (const n of ["Tente pliante 3x3 m", "Tente pliante 3x6 m", "Photobooth 360°", "Photobooth", "Prestation vidéo", "Tee-shirt floqué", "Pull floqué", "Table pliante", "Mange-debout", "Chaise pliante", "Moquette événementielle"]) assert.ok(names.includes(n), n)
  })
  it("référence lisible et unité m² pour la moquette", () => {
    assert.equal(eventArticleReference("Photobooth 360°"), "EVT-PHOTOBOOTH-360")
    assert.equal(EVENT_STOCK_ARTICLES.find((a) => a.designation === "Moquette événementielle")?.unit, "m²")
  })
})

describe("menus d'articles de stock", () => {
  it("proposent tout le catalogue, réutilisent un article existant et masquent les autres articles", async () => {
    const React = await import("react"); (globalThis as Record<string, unknown>).React = React
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { ArticleOptions } = await import("@/components/stock/ArticleOptions")
    const articles = [
      { id: "a1", reference: "EVT-PHOTOBOOTH-360", designation: "Photobooth 360°", unit: "u" },
      { id: "a2", reference: "DPORTE", designation: "DEPOSE Portes", unit: "u" },
    ]
    const html = renderToStaticMarkup(React.createElement(ArticleOptions, { articles }))
    assert.match(html, /value="a1"/)
    assert.match(html, /value="evt:EVT-TENTE-PLIANTE-3X3-M"/)
    assert.doesNotMatch(html, /DEPOSE Portes/)
    assert.match(renderToStaticMarkup(React.createElement(ArticleOptions, { articles, withOthers: true })), /DEPOSE Portes/)
  })
})
