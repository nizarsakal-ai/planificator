// Le menu « ••• » importe les server actions : lancer via `npm run test:equipes`
// (DATABASE_URL / RESEND_API_KEY factices, comme test:employes).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { EquipesView } from "@/components/equipes/EquipesView"
import { EquipeStats } from "@/components/equipes/EquipeStats"
import type { EquipeViewItem } from "@/lib/equipes/equipes-view"

// tsconfig "jsx": "preserve" → sous tsx, runtime JSX classique.
;(globalThis as { React?: typeof React }).React = React

const noop = () => {}
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop }

const m = (id: string, firstName: string, lastName: string) => ({ id, firstName, lastName, avatarUrl: null, active: true })

const TEAMS: EquipeViewItem[] = [
  {
    id: "t1",
    name: "Équipe Nord",
    color: "#123456",
    active: true,
    leader: { id: "e1", firstName: "Hélène", lastName: "Dubois" },
    members: [m("e1", "Hélène", "Dubois"), m("e2", "Jérôme", "Martin"), m("e3", "Zoé", "Lefèvre"), m("e4", "Ali", "B"), m("e5", "Léa", "C"), m("e6", "Max", "D")],
    truck: { id: "tr1", matricule: "AB-123-CD", marque: "Crafter" },
    currentWorksite: { id: "w1", name: "Résidence Les Pins", latitude: 48.85, longitude: 2.35 },
  },
  {
    id: "t2",
    name: "Équipe Sud",
    color: null,
    active: true,
    leader: { id: "e7", firstName: "Paul", lastName: "Durand" },
    members: [m("e7", "Paul", "Durand")],
    truck: null,
    currentWorksite: null,
  },
  {
    id: "t3",
    name: "Équipe Archivée",
    color: null,
    active: false,
    leader: { id: "e8", firstName: "Inès", lastName: "Roux" },
    members: [],
    truck: null,
    currentWorksite: null,
  },
]

const render = (props: Partial<Parameters<typeof EquipesView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router as never },
      createElement(EquipesView, { teams: TEAMS, trucks: [], canManage: true, ...props })
    )
  )

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("Équipes — en-tête KPI", () => {
  it("4 tuiles pastel avec libellés et valeurs", () => {
    const html = renderToStaticMarkup(
      createElement(EquipeStats, {
        stats: { activeTeams: 2, totalTeams: 3, assignedMembers: 7, employeesWithoutTeam: 4, teamsWithVehicle: 1 },
      })
    )
    const t = text(html)
    for (const label of ["Équipes actives", "Membres affectés", "Employés sans équipe", "Équipes avec véhicule"]) {
      assert.ok(t.includes(label), label)
    }
    assert.equal((html.match(/<dd/g) ?? []).length, 4)
    assert.match(html, /bg-blue-50\/60/)
  })
})

describe("Équipes — vue Mosaïque (défaut)", () => {
  const html = render()
  const t = text(html)

  it("onglets avec compteurs", () => {
    for (const [label, n] of [["Toutes", 3], ["Actives", 2], ["En intervention", 1], ["Sans véhicule", 1], ["Archivées", 1]] as const) {
      assert.ok(t.includes(`${label} ${n}`), `${label} ${n}`)
    }
  })

  it("Mosaïque sélectionnée par défaut", () => {
    assert.match(html, /aria-pressed="true"[^>]*aria-label="Mosaïque"/)
    assert.ok(!html.includes("<table"))
  })

  it("carte compacte : chef, véhicule, chantier du jour, avatars +N, repère de taille", () => {
    assert.ok(t.includes("Hélène Dubois"))
    assert.ok(t.includes("AB-123-CD"))
    assert.ok(t.includes("Résidence Les Pins"))
    assert.ok(t.includes("+2")) // 6 membres, 4 avatars visibles
    assert.ok(t.includes("Membres : 6 · recommandation 5–6"))
    assert.ok(t.includes("Sans véhicule"))
    assert.ok(t.includes("Aucun chantier aujourd'hui") || t.includes("Aucun chantier aujourd&#x27;hui"))
  })

  it("jamais « Capacité : x/6 »", () => {
    assert.doesNotMatch(t, /Capacit/i)
    assert.doesNotMatch(t, /\b\d\/6\b/)
  })

  it("un menu « ••• » par équipe, liens vers /equipes/[id]", () => {
    assert.equal((html.match(/aria-label="Actions pour /g) ?? []).length, 3)
    for (const id of ["t1", "t2", "t3"]) assert.ok(html.includes(`href="/equipes/${id}"`), id)
  })

  it("aucune action hors périmètre PR A", () => {
    assert.doesNotMatch(t, /Affecter un chantier|Supprimer/)
  })
})

describe("Équipes — vue Liste", () => {
  const html = render({ initialView: "list" })

  it("colonnes attendues", () => {
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1].replace(/&#x27;|&apos;/g, "'"))
    assert.deepEqual(headers, ["Équipe", "Statut", "Membres", "Chef d'équipe", "Véhicule", "Chantier aujourd'hui", "Actions"])
  })

  it("une ligne par équipe, statut textuel", () => {
    assert.equal((html.match(/<tr[\s>]/g) ?? []).length, 1 + 3)
    const t = text(html)
    assert.ok(t.includes("Active") && t.includes("Archivée"))
  })
})

describe("Équipes — onglet initial et état vide", () => {
  it("onglet Archivées : seule l'équipe archivée", () => {
    const t = text(render({ initialTab: "archived" }))
    assert.ok(t.includes("Équipe Archivée"))
    assert.ok(!t.includes("Équipe Nord"))
  })

  it("aucune équipe : invitation à créer", () => {
    const t = text(render({ teams: [] }))
    assert.ok(t.includes("Aucune équipe pour le moment."))
  })
})
