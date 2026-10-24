import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { VehicleMaintenancePanel, maintenanceDateIso, maintenanceSummaryLabel, maintenanceUiError, type MaintenanceSummary } from "@/components/vehicules/VehicleMaintenancePanel"
;(globalThis as { React?: typeof React }).React = React
const summary = (status: string): MaintenanceSummary => ({ status, lastOilChange: null, nextMileage: null, nextDate: null, remainingKm: null, remainingDays: null })
const noop = () => {}
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop }

describe("Entretien — interface et dates métier", () => {
  it("encode les dates à minuit UTC et rejette les dates impossibles au lieu de les décaler", () => {
    assert.equal(maintenanceDateIso("2024-02-29"), "2024-02-29T00:00:00.000Z")
    assert.equal(maintenanceDateIso("2026-02-29"), null)
    assert.equal(maintenanceDateIso("2026-04-31"), null)
    assert.equal(maintenanceDateIso("24/10/2026"), null)
    assert.equal(maintenanceDateIso("2026-10-24"), "2026-10-24T00:00:00.000Z")
  })
  it("distingue échéance dépassée, proche, à jour et données manquantes", () => {
    assert.equal(maintenanceSummaryLabel(summary("DUE")), "Vidange à faire")
    assert.equal(maintenanceSummaryLabel(summary("SOON")), "Vidange bientôt")
    assert.equal(maintenanceSummaryLabel(summary("OK")), "Vidange à jour")
    assert.equal(maintenanceSummaryLabel(summary("NO_HISTORY")), "Première vidange à renseigner")
    assert.equal(maintenanceSummaryLabel(null), "Périodicité à définir")
    assert.equal(maintenanceSummaryLabel(summary("UNKNOWN_MILEAGE")), "Compteur à renseigner")
    assert.equal(maintenanceSummaryLabel(summary("INCONSISTENT_MILEAGE")), "Compteur à vérifier")
  })
  it("explique comment réparer un compteur dépassé et un conflit sans exposer les erreurs techniques", () => {
    assert.match(maintenanceUiError("MAINTENANCE_ABOVE_CURRENT_MILEAGE"), /relevé dans Kilométrage/)
    assert.match(maintenanceUiError("MAINTENANCE_PLAN_CONFLICT"), /Actualisez/)
    assert.doesNotMatch(maintenanceUiError("SQL secret"), /SQL|secret/)
  })
  it("affiche l’alerte serveur dès la carte repliée sans requête par véhicule", () => {
    const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, createElement(VehicleMaintenancePanel, { truckId: "t", matricule: "AB-123-CD", active: true, canManage: true, initialSummary: summary("DUE") })))
    assert.match(html, /aria-label="Entretien de AB-123-CD"/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /Vidange à faire/)
    assert.match(html, /text-red-700/)
    assert.doesNotMatch(html, /<form|statut/i)
  })
})
