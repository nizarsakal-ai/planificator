import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computeTourKmEstimate, TRUCK_TANK_RANGE_KM } from "@/lib/vehicules/v3/tour-km-estimate-domain"
import { tourKmEstimateInputSchema } from "@/lib/vehicules/v3/tour-km-estimate-service"

describe("computeTourKmEstimate", () => {
  it("cas Alzone : aller-retour Montreuil + nuits au logement + midi", () => {
    const e = computeTourKmEstimate({
      depotToSite: { km: 780, source: "ROUTE" },
      lodgingToSite: { km: 12, source: "ROUTE" },
      workDays: 6,
      lunchKmPerDay: 10,
    })
    // 2 × 780 + 5 nuits × 2 × 12 + 6 × 10
    assert.equal(e.totalKm, 1560 + 120 + 60)
    assert.deepEqual(e.lines.map((l) => [l.key, l.km]), [["OUTBOUND", 780], ["RETURN", 780], ["LODGING", 120], ["LUNCH", 60]])
    assert.equal(e.tanks, Math.round((1740 / TRUCK_TANK_RANGE_KM) * 10) / 10)
    assert.equal(e.approximate, false)
  })
  it("sans logement : seuls aller, retour et midi", () => {
    const e = computeTourKmEstimate({ depotToSite: { km: 100.04, source: "ROUTE" }, lodgingToSite: null, workDays: 3, lunchKmPerDay: 0 })
    assert.deepEqual(e.lines.map((l) => l.key), ["OUTBOUND", "RETURN"])
    assert.equal(e.totalKm, 200)
  })
  it("un seul jour : aucune nuit au logement", () => {
    const e = computeTourKmEstimate({ depotToSite: { km: 50, source: "ROUTE" }, lodgingToSite: { km: 5, source: "ROUTE" }, workDays: 1, lunchKmPerDay: 10 })
    assert.equal(e.lines.some((l) => l.key === "LODGING"), false)
    assert.equal(e.totalKm, 110)
  })
  it("itinéraire indisponible → estimation signalée approximative ; bornes défensives", () => {
    const e = computeTourKmEstimate({ depotToSite: { km: 10, source: "ESTIMATE" }, lodgingToSite: null, workDays: 0, lunchKmPerDay: 999 })
    assert.equal(e.approximate, true)
    assert.equal(e.lines.find((l) => l.key === "LUNCH")?.km, 200) // 1 jour minimum, forfait plafonné à 200
  })
})

describe("tourKmEstimateInputSchema", () => {
  it("valide les entrées, refuse fin < début et champs inconnus", () => {
    assert.equal(tourKmEstimateInputSchema.safeParse({ worksiteId: "w", start: "2026-11-20", end: "2026-11-27", lunchKmPerDay: 10 }).success, true)
    assert.equal(tourKmEstimateInputSchema.safeParse({ worksiteId: "w", start: "2026-11-27", end: "2026-11-20" }).success, false)
    assert.equal(tourKmEstimateInputSchema.safeParse({ worksiteId: "w", start: "2026-11-20", end: "2026-11-21", x: 1 }).success, false)
  })
})
