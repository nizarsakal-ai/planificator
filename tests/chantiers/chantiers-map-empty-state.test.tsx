import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import React, { createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ChantiersResults,
  MapEmptyState,
  type ChantierCardData,
} from "@/components/chantiers/ChantiersResults"
import {
  applyChantierView,
  DEFAULT_SORT,
  EMPTY_COMPLEMENTARY_FILTERS,
  hasMapCoordinates,
  mapEmptyStateMessage,
  shouldShowMapEmptyState,
  type ChantierStateFilter,
} from "@/lib/chantiers/chantiers-view-filters"

// tsconfig "jsx": "preserve" → sous tsx, runtime JSX classique.
;(globalThis as { React?: typeof React }).React = React

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function chantier(id: string, status: string, coords: [number, number] | null): ChantierCardData {
  return {
    id,
    name: `Chantier ${id}`,
    address: null,
    status,
    latitude: coords?.[0] ?? null,
    longitude: coords?.[1] ?? null,
    startDate: null,
    endDate: null,
    clientId: "c1",
    client: { name: "Client" },
    _count: { assignments: 1 },
    assignments: [],
    employeeIds: [],
  }
}

// 3 actifs sans coordonnées ; anciens/planifiés géolocalisés (situation constatée en production).
const DATA: ChantierCardData[] = [
  chantier("a1", "IN_PROGRESS", null),
  chantier("a2", "IN_PROGRESS", null),
  chantier("a3", "EXTENDED", null),
  chantier("p1", "PLANNED", [48.85, 2.35]),
  chantier("d1", "COMPLETED", [45.76, 4.83]),
  chantier("d2", "ARCHIVED", null),
]

const view = (state: ChantierStateFilter) =>
  applyChantierView(DATA, { state, search: "", filters: EMPTY_COMPLEMENTARY_FILTERS, sort: DEFAULT_SORT }).items

function renderMap(state: ChantierStateFilter, onSelectState: (s: ChantierStateFilter) => void = () => {}) {
  return renderToStaticMarkup(
    createElement(ChantiersResults, { chantiers: view(state), view: "map", state, mapKey: "k", onSelectState })
  )
}

/** Parcourt un arbre d'éléments React (sans DOM) pour trouver le premier <button>. */
function findButton(node: ReactNode): ReactElement<{ onClick: () => void; children: ReactNode }> | null {
  if (!isValidElement(node)) return null
  if (node.type === "button") return node as ReactElement<{ onClick: () => void; children: ReactNode }>
  const children = (node.props as { children?: ReactNode }).children
  for (const child of React.Children.toArray(children)) {
    const found = findButton(child)
    if (found) return found
  }
  return null
}

describe("Carte Chantiers — état vide contextuel d'un onglet filtré", () => {
  it("1. Actifs + zéro coordonnées → état vide contextuel, carte Leaflet non montée", () => {
    const html = renderMap("active")
    assert.ok(html.includes("Aucun chantier géolocalisé parmi les 3 chantiers actifs."))
    assert.ok(html.includes("Voir tous les chantiers sur la carte"))
    assert.ok(!html.includes("animate-pulse"), "le placeholder de ChantiersMap ne doit pas être rendu")
    assert.ok(!html.includes("Ajoutez une adresse"), "l'ancien message générique ne doit plus apparaître")
  })

  it("2. le nombre de chantiers de l'onglet est exact (pluriel / singulier / autres onglets)", () => {
    assert.equal(mapEmptyStateMessage("active", 3), "Aucun chantier géolocalisé parmi les 3 chantiers actifs.")
    assert.equal(mapEmptyStateMessage("active", 1), "Aucun chantier géolocalisé : le chantier actif n'a pas de coordonnées.")
    assert.equal(mapEmptyStateMessage("planned", 4), "Aucun chantier géolocalisé parmi les 4 chantiers planifiés.")
    assert.equal(mapEmptyStateMessage("unassigned", 2), "Aucun chantier géolocalisé parmi les 2 chantiers à affecter.")
    assert.equal(mapEmptyStateMessage("done", 5), "Aucun chantier géolocalisé parmi les 5 chantiers terminés.")
    assert.equal(view("active").length, 3)
  })

  it("3. « Voir tous les chantiers sur la carte » sélectionne l'onglet Tous via le mécanisme d'onglet", () => {
    const selected: ChantierStateFilter[] = []
    const tree = ChantiersResults({
      chantiers: view("active"),
      view: "map",
      state: "active",
      mapKey: "k",
      onSelectState: (s) => selected.push(s),
    }) as ReactElement<{ onShowAll: () => void; count: number }>
    assert.equal(tree.type, MapEmptyState)
    assert.equal(tree.props.count, 3)

    const button = findButton(MapEmptyState(tree.props as Parameters<typeof MapEmptyState>[0]))
    assert.ok(button)
    assert.equal(React.Children.toArray(button.props.children).join(""), "Voir tous les chantiers sur la carte")
    button.props.onClick()
    assert.deepEqual(selected, ["all"])

    // ChantiersView branche ce callback sur le même setter que les onglets (pas d'état dupliqué).
    const viewSrc = readFileSync(join(ROOT, "src/components/chantiers/ChantiersView.tsx"), "utf8")
    assert.ok(viewSrc.includes("onStateChange={setState}"))
    assert.ok(viewSrc.includes("onSelectState={setState}"))
  })

  it("4. Tous + coordonnées → carte normale (pas d'état vide contextuel)", () => {
    const html = renderMap("all")
    assert.ok(html.includes("animate-pulse"), "ChantiersMap (chargement dynamique) est rendu")
    assert.ok(!html.includes("Voir tous les chantiers sur la carte"))
    assert.equal(shouldShowMapEmptyState(view("all"), "all"), false)
  })

  it("onglet filtré avec au moins une coordonnée → carte normale", () => {
    assert.equal(shouldShowMapEmptyState(view("planned"), "planned"), false)
    assert.ok(renderMap("planned").includes("animate-pulse"))
  })

  it("Tous sans aucune coordonnée → état vide natif de la carte conservé (pas de bouton circulaire)", () => {
    const none = [chantier("x", "IN_PROGRESS", null)]
    assert.equal(shouldShowMapEmptyState(none, "all"), false)
  })

  it("onglet vide → pas d'état vide carte (l'état vide de la vue s'applique)", () => {
    assert.equal(shouldShowMapEmptyState([], "active"), false)
  })

  it("5. aucun changement du filtrage existant : mêmes ensembles par onglet, données non modifiées", () => {
    const snapshot = JSON.stringify(DATA)
    assert.deepEqual(view("active").map((c) => c.id).sort(), ["a1", "a2", "a3"])
    assert.deepEqual(view("planned").map((c) => c.id), ["p1"])
    assert.deepEqual(view("done").map((c) => c.id).sort(), ["d1", "d2"])
    assert.equal(view("all").length, 6)
    renderMap("active")
    shouldShowMapEmptyState(view("active"), "active")
    assert.equal(JSON.stringify(DATA), snapshot)
  })

  it("règle de coordonnées identique à ChantiersMap", () => {
    assert.equal(hasMapCoordinates({ latitude: 48.8, longitude: 2.3 }), true)
    assert.equal(hasMapCoordinates({ latitude: null, longitude: 2.3 }), false)
    assert.equal(hasMapCoordinates({ latitude: 48.8, longitude: null }), false)
    const mapSrc = readFileSync(join(ROOT, "src/components/chantiers/ChantiersMap.tsx"), "utf8")
    assert.ok(mapSrc.includes("chantiers.filter((c) => c.latitude && c.longitude)"))
  })
})
