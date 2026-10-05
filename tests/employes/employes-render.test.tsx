// Le menu « ⋯ » importe les server actions (Resend instancié au chargement) :
// lancer via `npm run test:employes`, qui fournit RESEND_API_KEY factice (cf. test:security:hotfix).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { EmployeGroupSection } from "@/components/employes/EmployeGroupSection"
import { EmployeStats } from "@/components/employes/EmployeStats"
import { PlanificatorMark } from "@/components/brand/PlanificatorLogo"
import type { EmployeeGroup } from "@/lib/employes/employes-view"

// tsconfig "jsx": "preserve" → sous tsx, runtime JSX classique.
;(globalThis as { React?: typeof React }).React = React

const group: EmployeeGroup = {
  fonction: "technicien",
  label: "Techniciens / Monteurs",
  items: [
    {
      id: "e1",
      firstName: "Zoé",
      lastName: "Bernard",
      jobTitle: "Technicien monteur",
      phone: "0600000000",
      avatarUrl: null,
      active: true,
      leadsTeam: false,
      team: { id: "t1", name: "Équipe Nord", color: "#123456" },
    },
    {
      id: "e2",
      firstName: "Céline",
      lastName: "Morel",
      jobTitle: null,
      phone: null,
      avatarUrl: null,
      active: false,
      leadsTeam: false,
      team: null,
    },
  ],
}

const render = (view: "grid" | "list", collapsed = false) =>
  renderToStaticMarkup(createElement(EmployeGroupSection, { group, view, collapsed, onToggle: () => {} }))

describe("EmployeGroupSection — rendu", () => {
  for (const view of ["grid", "list"] as const) {
    it(`${view} : lien fiche, nom, fonction, équipe, état textuel, menu nommé`, () => {
      const html = render(view)
      assert.ok(html.includes('href="/employes/e1"'))
      assert.ok(html.includes('aria-label="Voir Zoé Bernard"'))
      assert.ok(html.includes("Technicien monteur"))
      assert.ok(html.includes("Équipe Nord"))
      assert.ok(html.includes(">Actif<"))
      assert.ok(html.includes(">Archivé<"))
      assert.ok(html.includes('aria-label="Actions pour Zoé Bernard"'))
      // Plus de gros boutons Désactiver/Supprimer répétés sur les cartes.
      assert.ok(!html.includes("Desactiver"))
      assert.ok(!html.includes("Supprimer"))
    })
  }

  it("section repliable : aria-expanded + contenu masqué quand replié", () => {
    const open = render("grid", false)
    assert.ok(open.includes('aria-expanded="true"'))
    assert.ok(open.includes('aria-controls="employes-group-technicien"'))
    assert.ok(open.includes("Techniciens / Monteurs"))
    const closed = render("grid", true)
    assert.ok(closed.includes('aria-expanded="false"'))
    assert.ok(!closed.includes('href="/employes/e1"'))
  })

  it("indicateurs : 5 libellés et valeurs", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeStats, { stats: { active: 7, archived: 2, chefs: 3, techniciens: 4, conducteurs: 1 } })
    )
    for (const label of ["Employés actifs", "Employés archivés", "Chefs d&#x27;équipe", "Techniciens / Monteurs", "Conducteurs de travaux"]) {
      assert.ok(html.includes(label), label)
    }
    assert.ok(html.includes(">7<") && html.includes(">2<") && html.includes(">4<"))
  })

  it("logo : SVG local, sans ressource distante, décoratif par défaut", () => {
    const html = renderToStaticMarkup(createElement(PlanificatorMark))
    assert.ok(html.startsWith("<svg"))
    assert.ok(html.includes('aria-hidden="true"'))
    assert.ok(!/https?:\/\//.test(html.replace('xmlns="http://www.w3.org/2000/svg"', "")))
  })
})
