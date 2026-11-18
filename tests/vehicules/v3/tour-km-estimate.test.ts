import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  computeTourKmEstimate,
  googleMapsDirectionsUrl,
  isDepotStopLabel,
  TRUCK_TANK_RANGE_KM,
} from "@/lib/vehicules/v3/tour-km-estimate-domain"
import { tourKmEstimateInputSchema } from "@/lib/vehicules/v3/tour-km-estimate-service"

const route = (label: string, km: number) => ({ label, km, source: "ROUTE" as const })

describe("computeTourKmEstimate", () => {
  it("cas Alzone : dépôt → Alzone → Saverdun → dépôt + nuits au logement + midi", () => {
    const e = computeTourKmEstimate({
      legs: [route("Dépôt → MAIRIE ALZONNE", 780), route("MAIRIE ALZONNE → LAURALU", 60), route("LAURALU → Dépôt", 760)],
      lodgingToSite: { km: 12, source: "ROUTE" },
      workDays: 6,
      lunchKmPerDay: 10,
    })
    // 780 + 60 + 760 + 5 nuits × 2 × 12 + 6 × 10
    assert.equal(e.totalKm, 1600 + 120 + 60)
    assert.deepEqual(e.lines.map((l) => [l.key, l.km]), [["LEG", 780], ["LEG", 60], ["LEG", 760], ["LODGING", 120], ["LUNCH", 60]])
    assert.equal(e.tanks, Math.round((1780 / TRUCK_TANK_RANGE_KM) * 10) / 10)
    assert.equal(e.approximate, false)
  })
  it("sans logement : seuls les trajets et le midi", () => {
    const e = computeTourKmEstimate({ legs: [route("a", 100.04), route("b", 100)], lodgingToSite: null, workDays: 3, lunchKmPerDay: 0 })
    assert.deepEqual(e.lines.map((l) => l.key), ["LEG", "LEG"])
    assert.equal(e.totalKm, 200)
  })
  it("un seul jour : aucune nuit au logement", () => {
    const e = computeTourKmEstimate({ legs: [route("a", 50), route("b", 50)], lodgingToSite: { km: 5, source: "ROUTE" }, workDays: 1, lunchKmPerDay: 10 })
    assert.equal(e.lines.some((l) => l.key === "LODGING"), false)
    assert.equal(e.totalKm, 110)
  })
  it("itinéraire indisponible → approximative ; bornes défensives", () => {
    const e = computeTourKmEstimate({ legs: [{ label: "a", km: 10, source: "ESTIMATE" }], lodgingToSite: null, workDays: 0, lunchKmPerDay: 999 })
    assert.equal(e.approximate, true)
    assert.equal(e.lines.find((l) => l.key === "LUNCH")?.km, 200)
  })
})

describe("itinéraire Google Maps", () => {
  it("départ et retour au dépôt, étapes dans l'ordre, 9 étapes au plus", () => {
    const url = new URL(googleMapsDirectionsUrl({ depot: "Montreuil", stops: ["Rue du Boulodrome, 11170 Alzonne", "Hôtel X Carcassonne"] }))
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/")
    assert.equal(url.searchParams.get("origin"), "Montreuil")
    assert.equal(url.searchParams.get("destination"), "Montreuil")
    assert.equal(url.searchParams.get("waypoints"), "Rue du Boulodrome, 11170 Alzonne|Hôtel X Carcassonne")
    assert.equal(url.searchParams.get("travelmode"), "driving")
    const many = new URL(googleMapsDirectionsUrl({ depot: "D", stops: Array.from({ length: 12 }, (_, i) => `s${i}`) }))
    assert.equal(many.searchParams.get("waypoints")?.split("|").length, 9)
  })
  it("reconnaît les étapes dépôt ajoutées à la préparation", () => {
    assert.equal(isDepotStopLabel("Départ dépôt"), true)
    assert.equal(isDepotStopLabel("Retour dépôt"), true)
    assert.equal(isDepotStopLabel("MAIRIE ALZONNE"), false)
  })
})

describe("tourKmEstimateInputSchema", () => {
  it("accepte une tournée existante ou un chantier ; refuse le reste", () => {
    assert.equal(tourKmEstimateInputSchema.safeParse({ tourId: "t1", lunchKmPerDay: 10 }).success, true)
    assert.equal(tourKmEstimateInputSchema.safeParse({ worksiteId: "w", start: "2026-11-20", end: "2026-11-27" }).success, true)
    assert.equal(tourKmEstimateInputSchema.safeParse({ worksiteId: "w", start: "2026-11-27", end: "2026-11-20" }).success, false)
    assert.equal(tourKmEstimateInputSchema.safeParse({ tourId: "t1", x: 1 }).success, false)
  })
})
