import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PlannedMileageReportView, initialPlannedMileageState, monthLabel, plannedMileageErrorMessage, plannedMileageReducer, shiftMonth } from "@/components/vehicules/VehiclePlannedMileage"
import { VehicleMileagePanel } from "@/components/vehicules/VehicleMileagePanel"
import type { PlannedMileageReport } from "@/lib/vehicules/planned-mileage-service"
;(globalThis as { React?: typeof React }).React = React

const report: PlannedMileageReport = {
  truckId: "truck-1", month: "2026-11", depot: "Siège · Montreuil centre", marginKm: 200, totalKm: 1359,
  lines: [
    { worksiteId: "a", worksiteName: "Salon Lyon", address: "Lyon", days: 2, firstDay: "2026-11-03", lastDay: "2026-11-04", oneWayKm: 466.8, roundTripKm: 934, marginKm: 200, totalKm: 1134, source: "ROUTE" },
    { worksiteId: "c", worksiteName: "Mairie Vincennes", address: "Vincennes", days: 1, firstDay: "2026-11-20", lastDay: "2026-11-20", oneWayKm: 12.3, roundTripKm: 25, marginKm: 200, totalKm: 225, source: "ESTIMATE" },
  ],
  unresolved: [{ worksiteId: "b", worksiteName: "Chantier sans adresse", days: 1, reason: "ADDRESS_MISSING" }],
}

describe("kilométrage prévu — présentation", () => {
  it("affiche chaque chantier, la marge, le total et la mention d'estimation", () => {
    const html = renderToStaticMarkup(createElement(PlannedMileageReportView, { report }))
    assert.match(html, /Salon Lyon/)
    assert.match(html, /1[^0-9]134 km/)
    assert.match(html, /aller-retour 934 km \+ marge 200 km/)
    assert.match(html, /2 jours · 03\/11 → 04\/11/)
    assert.match(html, /estimation approximative/)
    assert.match(html, /Chantier sans adresse \(1 jour\) non compté : adresse du chantier manquante/)
    assert.match(html, /Total prévu sur la période/)
    assert.match(html, /1[^0-9]359 km/)
    assert.match(html, /Siège · Montreuil centre/)
    assert.match(html, /le compteur et le journal ne sont pas modifiés/)
  })

  it("indique l'absence de chantier planifié", () => {
    const html = renderToStaticMarkup(createElement(PlannedMileageReportView, { report: { ...report, lines: [], unresolved: [], totalKm: 0 } }))
    assert.match(html, /Aucun chantier planifié/)
  })

  it("navigue de mois en mois et n'expose pas d'erreur brute", () => {
    assert.equal(shiftMonth("2026-12", 1), "2027-01")
    assert.equal(shiftMonth("2026-01", -1), "2025-12")
    assert.equal(monthLabel("2026-11"), "novembre 2026")
    assert.doesNotMatch(plannedMileageErrorMessage("SQL secret"), /SQL|secret/)
    assert.match(plannedMileageErrorMessage("DEPOT_NOT_CONFIGURED"), /Point de départ non configuré/)
  })

  it("ne rend rien de nouveau dans la carte tant que le drapeau est éteint", () => {
    const html = renderToStaticMarkup(createElement(VehicleMileagePanel, { truckId: "truck-1", matricule: "FL-129-AM", active: true, canManage: true, initialMileage: 278454 }))
    assert.doesNotMatch(html, /Trajets prévus/)
    assert.match(html, /Kilométrage et trajets/)
  })
})

describe("kilométrage prévu — état de chargement", () => {
  const loaded = plannedMileageReducer(plannedMileageReducer(initialPlannedMileageState, { type: "start", request: 1 }), { type: "success", request: 1, report })

  it("efface les chiffres du mois précédent dès le chargement suivant et après un échec", () => {
    assert.equal(loaded.report?.totalKm, 1359)
    const loading = plannedMileageReducer(loaded, { type: "start", request: 2 })
    assert.equal(loading.report, null)
    assert.equal(loading.loading, true)
    const failed = plannedMileageReducer(loading, { type: "failure", request: 2, error: "Impossible" })
    assert.deepEqual(failed, { request: 2, loading: false, report: null, error: "Impossible" })
  })

  it("ignore une réponse arrivée après un changement de mois ou de camion", () => {
    const otherTruck = plannedMileageReducer(loaded, { type: "start", request: 2 })
    const stale = plannedMileageReducer(otherTruck, { type: "success", request: 1, report })
    assert.equal(stale.report, null)
    assert.equal(stale.loading, true)
    assert.equal(plannedMileageReducer(otherTruck, { type: "failure", request: 1, error: "ancien" }).error, "")
    const fresh = plannedMileageReducer(otherTruck, { type: "success", request: 2, report: { ...report, truckId: "truck-2", totalKm: 225 } })
    assert.equal(fresh.report?.truckId, "truck-2")
    assert.equal(fresh.report?.totalKm, 225)
  })
})
