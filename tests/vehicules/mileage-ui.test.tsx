import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { effectiveMileageEntries, mileageErrorMessage, VehicleMileagePanel, type MileageHistoryEntry } from "@/components/vehicules/VehicleMileagePanel"
;(globalThis as { React?: typeof React }).React = React

const entry = (over: Partial<MileageHistoryEntry>): MileageHistoryEntry => ({
  id: "original", kind: "READING", mileage: 100, revision: 1, occurredAt: "2026-01-01T12:00:00Z",
  recordedAt: "2026-01-01T12:00:00Z", createdByName: "Admin", rootEntryId: null,
  supersedesEntryId: null, correctionReason: null, ...over,
})

describe("Kilométrage — sélection des valeurs corrigées et présentation", () => {
  it("cible la dernière correction par révision sans masquer les originaux ni muter le journal", () => {
    const history = [entry({}), entry({ id: "c2", kind: "CORRECTION", revision: 3, mileage: 120, rootEntryId: "original" }), entry({ id: "c1", kind: "CORRECTION", revision: 2, mileage: 110, rootEntryId: "original" }), entry({ id: "departure", kind: "DEPARTURE", revision: 4, mileage: 130 })]
    const before = JSON.stringify(history)
    const effective = effectiveMileageEntries(history)
    assert.equal(effective.length, 2)
    assert.equal(effective[0].original.id, "original")
    assert.equal(effective[0].effective.id, "c2")
    assert.equal(effective[1].effective.id, "departure")
    assert.equal(JSON.stringify(history), before)
  })
  it("fournit une récupération concrète pour les conflits sans exposer d'erreur SQL", () => {
    assert.match(mileageErrorMessage("MILEAGE_REVISION_CONFLICT"), /Actualisez/)
    assert.match(mileageErrorMessage("MILEAGE_CORRECTION_CONFLICT"), /corrigé entre-temps/)
    assert.doesNotMatch(mileageErrorMessage("SQL secret"), /SQL|secret/)
  })
  it("garde le contexte et le panneau accessible sans chargement réseau au rendu initial", () => {
    const html = renderToStaticMarkup(createElement(VehicleMileagePanel, { truckId: "truck-1", matricule: "AB-123-CD", active: true, canManage: true, initialMileage: 125000 }))
    assert.match(html, /aria-label="Kilométrage de AB-123-CD"/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /Kilométrage et trajets/)
    assert.match(html, /125[^0-9]*000 km/)
    assert.doesNotMatch(html, /<form/)
  })
})
