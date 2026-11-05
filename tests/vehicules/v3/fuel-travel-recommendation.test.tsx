/**
 * Estimation carburant — proposition de mode de déplacement d'après la distance aller (règle d'organisation interne,
 * seuil 50 km) : helper pur et rendu du choix. Nouveaux cas seulement ; aucune donnée réelle, aucun appel réseau.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DAILY_RETURN_MAX_ONE_WAY_KM, recommendedTravelMode, travelRecommendationLabel } from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
import { TravelModeChoice } from "@/components/vehicules/v3/VehicleFuelEstimate"
import type { TravelMode } from "@/lib/vehicules/v3/fuel-estimate-domain"

// tsconfig "jsx": "preserve" → runtime JSX classique sous tsx.
;(globalThis as { React?: typeof React }).React = React

const LEGAL = /\bloi\b|légal|juridique|réglementaire|obligatoire|obligation|imposé|exigé/i

describe("proposition de mode : seuil de 50 km aller", () => {
  it("≤ 50 km (50 exact compris) → retour quotidien ; > 50 km → séjour sur place", () => {
    assert.equal(DAILY_RETURN_MAX_ONE_WAY_KM, 50)
    const cases: [number, TravelMode][] = [[20, "DAILY"], [49.9, "DAILY"], [50, "DAILY"], [50.1, "ONE_ROUND_TRIP"], [414.7, "ONE_ROUND_TRIP"]]
    for (const [km, mode] of cases) assert.equal(recommendedTravelMode(km), mode, `${km} km`)
  })

  it("distance inconnue, nulle, négative ou non finie : aucune proposition", () => {
    for (const km of [null, undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(recommendedTravelMode(km), null, String(km))
      assert.equal(travelRecommendationLabel(km), null, String(km))
    }
  })

  it("texte : distance, seuil et règle interne ; aucune assertion juridique ni fait d'hébergement", () => {
    const far = travelRecommendationLabel(414.7)!, near = travelRecommendationLabel(50)!
    assert.match(far, /414,7 km aller depuis le siège \(plus de 50 km\) : séjour sur place, un seul aller-retour au total, proposé/)
    assert.match(near, /50,0 km aller depuis le siège \(50 km ou moins\) : retour quotidien au siège proposé/)
    for (const text of [far, near]) {
      assert.match(text, /^Règle d’organisation Galya : /)
      assert.match(text, /\. Choisissez le mode correspondant à l’organisation prévue\.$/)
      assert.doesNotMatch(text, LEGAL)
    }
  })
})

describe("rendu du choix : proposition visible, aucun mode forcé", () => {
  const render = (mode: TravelMode | null, oneWayKm: number | null) =>
    renderToStaticMarkup(createElement(TravelModeChoice, { mode, oneWayKm, onChoose: () => {} }))
  const radios = (html: string) => html.match(/<input[^>]*name="fuel-travel"[^>]*>/g) ?? []

  it("proposition affichée sans aucun mode coché ; les deux choix restent présents et actifs", () => {
    for (const km of [20, 414.7]) {
      const html = render(null, km)
      assert.match(html, /Règle d’organisation Galya : /)
      assert.equal(radios(html).length, 2)
      for (const r of radios(html)) { assert.doesNotMatch(r, /checked|disabled/) }
      assert.doesNotMatch(html, LEGAL)
    }
  })

  it("choix explicite contraire à la proposition conservé tel quel", () => {
    const html = render("DAILY", 414.7)
    const [stay, daily] = radios(html)
    assert.ok(stay !== undefined && daily !== undefined, "deux radios attendues")
    assert.doesNotMatch(stay, /checked/)
    assert.match(daily, /checked/)
    const [stay2, daily2] = radios(render("ONE_ROUND_TRIP", 20))
    assert.ok(stay2 !== undefined && daily2 !== undefined, "deux radios attendues")
    assert.match(stay2, /checked/)
    assert.doesNotMatch(daily2, /checked/)
  })

  it("distance inconnue ou invalide : aucune proposition, choix toujours accessibles", () => {
    for (const km of [null, 0, Number.NaN]) {
      const html = render(null, km)
      assert.doesNotMatch(html, /Proposition/)
      assert.equal(radios(html).length, 2)
    }
  })

  it("libellés : séjour sur place (hébergement, un seul aller-retour) et retour quotidien", () => {
    const html = render(null, null)
    assert.match(html, /Séjour sur place \(hébergement près du chantier\) : un seul aller-retour/)
    assert.match(html, /Retour quotidien au siège : un aller-retour par jour planifié/)
  })
})
