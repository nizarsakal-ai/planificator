import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChantiersResults, type ChantierCardData } from "@/components/chantiers/ChantiersResults"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React

const team = {
  id: "t1",
  name: "Équipe Nord",
  color: "#123456",
  leader: { firstName: "Paul", lastName: "Martin", avatarUrl: null },
}

const items: ChantierCardData[] = [
  {
    id: "w-active",
    name: "Rénovation Lauralu",
    address: "12 rue de la Paix, 75002 Paris",
    status: "EXTENDED",
    latitude: null,
    longitude: null,
    startDate: new Date("2026-09-20T00:00:00Z"),
    endDate: new Date("2026-10-20T00:00:00Z"),
    clientId: "c1",
    client: { name: "Lauralu SAS" },
    _count: { assignments: 3 },
    assignments: [{ teamId: "t1", team }],
    employeeIds: [],
  },
  {
    id: "w-archived",
    name: "Archive 2024",
    address: null,
    status: "ARCHIVED",
    latitude: null,
    longitude: null,
    startDate: null,
    endDate: null,
    clientId: "c2",
    client: { name: "Dupont" },
    _count: { assignments: 0 },
    assignments: [],
    employeeIds: [],
  },
]

function render(view: "grid" | "mosaic" | "list", state: "all" | "done" = "all") {
  return renderToStaticMarkup(
    createElement(ChantiersResults, { chantiers: items, view, state, mapKey: "k", onSelectState: () => {} })
  )
}

describe("ChantiersResults — L. les vues existantes continuent à fonctionner", () => {
  for (const view of ["grid", "mosaic", "list"] as const) {
    it(`vue ${view} : liens d'ouverture, nom, client, dates`, () => {
      const html = render(view)
      assert.ok(html.includes('href="/chantiers/w-active"'))
      assert.ok(html.includes('href="/chantiers/w-archived"'))
      assert.ok(html.includes("Rénovation Lauralu"))
      assert.ok(html.includes("Lauralu SAS"))
      assert.ok(html.includes("2026"))
    })
  }

  it("grille : adresse, affectations et équipe affichées", () => {
    const html = render("grid")
    assert.ok(html.includes("12 rue de la Paix, 75002 Paris"))
    assert.ok(html.includes("3 affectations"))
    assert.ok(html.includes("PM"))
  })

  it("Tous : badge Archivé visible ; Terminés : badge Archivé masqué", () => {
    assert.ok(render("grid", "all").includes("Archivé"))
    assert.ok(!render("grid", "done").includes("Archivé"))
  })
})
