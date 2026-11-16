import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  parseTourPrefill,
  worksiteTeamVehicles,
  worksiteTourHref,
} from "@/lib/chantiers/worksite-vehicles"

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)

describe("worksiteTeamVehicles", () => {
  it("relie équipe → véhicule → chauffeur, jours à venir uniquement", () => {
    const rows = worksiteTeamVehicles({
      today: "2026-11-17",
      assignments: [
        { teamId: "t1", teamName: "HASSEN", date: d("2026-11-16") },
        { teamId: "t1", teamName: "HASSEN", date: d("2026-11-18") },
        { teamId: "t1", teamName: "HASSEN", date: d("2026-11-19") },
      ],
      trucks: [{ id: "tr1", matricule: "FL-129-AM", marque: "Volkswagen", modele: "Crafter", teamId: "t1", chauffeurName: "Riadh Boussaid" }],
    })
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].truck, { id: "tr1", matricule: "FL-129-AM", label: "Volkswagen Crafter", chauffeurName: "Riadh Boussaid" })
    assert.equal(rows[0].firstDate, "2026-11-18")
    assert.equal(rows[0].lastDate, "2026-11-19")
    assert.equal(rows[0].upcoming, true)
    assert.equal(rows[0].tourStart, "2026-11-18")
    assert.equal(rows[0].tourEnd, "2026-11-19")
  })
  it("équipe sans véhicule → truck null (alerte affichée)", () => {
    const rows = worksiteTeamVehicles({
      today: "2026-11-17",
      assignments: [{ teamId: "t2", teamName: "BILEL", date: d("2026-11-20") }],
      trucks: [],
    })
    assert.equal(rows[0].truck, null)
  })
  it("fenêtre de tournée bornée à 7 jours ; chantier passé marqué non à venir", () => {
    const days = Array.from({ length: 12 }, (_, i) => d(`2026-12-${String(i + 1).padStart(2, "0")}`))
    const [future] = worksiteTeamVehicles({
      today: "2026-11-17",
      assignments: days.map((date) => ({ teamId: "t1", teamName: "A", date })),
      trucks: [],
    })
    assert.equal(future.tourStart, "2026-12-01")
    assert.equal(future.tourEnd, "2026-12-07")
    const [past] = worksiteTeamVehicles({
      today: "2027-01-01",
      assignments: [{ teamId: "t1", teamName: "A", date: d("2026-12-01") }],
      trucks: [],
    })
    assert.equal(past.upcoming, false)
  })
})

describe("lien et paramètres de tournée", () => {
  it("aller-retour lien → paramètres", () => {
    const href = worksiteTourHref({ truckId: "tr 1", worksiteId: "ws1", start: "2026-11-18", end: "2026-11-19" })
    assert.equal(href, "/vehicules/tr%201/tournees?worksiteId=ws1&start=2026-11-18&end=2026-11-19")
    const q = Object.fromEntries(new URL(href, "https://x").searchParams)
    assert.deepEqual(parseTourPrefill(q), { worksiteId: "ws1", start: "2026-11-18", end: "2026-11-19" })
  })
  it("rejette les paramètres invalides (aucun pré-remplissage, page inchangée)", () => {
    assert.equal(parseTourPrefill({}), null)
    assert.equal(parseTourPrefill({ worksiteId: "ws1", start: "2026-11-19", end: "2026-11-18" }), null)
    assert.equal(parseTourPrefill({ worksiteId: "ws1", start: "2026-11-01", end: "2026-11-30" }), null)
    assert.equal(parseTourPrefill({ worksiteId: ["a", "b"], start: "2026-11-01", end: "2026-11-02" }), null)
    assert.equal(parseTourPrefill({ worksiteId: "ws1", start: "x", end: "2026-11-02" }), null)
  })
})
