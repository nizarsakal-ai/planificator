import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computeWorksiteCosts, truckAveragePrice, worksiteForDay, UNASSIGNED_KEY } from "@/lib/vehicules/v3/worksite-costs-domain"
import { worksiteCostsQuerySchema } from "@/lib/vehicules/v3/worksite-costs-service"

const names = new Map([["alz", "MAIRIE ALZONNE"], ["sav", "LAURALU Saverdun"]])
const tour = (id: string, startDay: string, endDay: string, estimatedKm: number | null, worksiteId: string | null) => ({ id, title: `Tournée ${id}`, startDay, endDay, estimatedKm, worksiteId })

describe("rattachement automatique d'une dépense au chantier", () => {
  const tours = [tour("t1", "2026-11-20", "2026-11-27", 1780, "alz")]
  const assignments = [{ day: "2026-11-28", worksiteId: "sav" }]
  it("tournée du camion en cours à la date de la dépense", () => {
    assert.equal(worksiteForDay("2026-11-20", tours, assignments), "alz")
    assert.equal(worksiteForDay("2026-11-27", tours, assignments), "alz")
  })
  it("sinon chantier planifié de l'équipe ce jour-là", () => assert.equal(worksiteForDay("2026-11-28", tours, assignments), "sav"))
  it("sinon hors chantier", () => assert.equal(worksiteForDay("2026-11-29", tours, assignments), null))
  it("une tournée sans chantier ne capte pas la dépense", () => {
    assert.equal(worksiteForDay("2026-11-28", [tour("t2", "2026-11-28", "2026-11-28", 30, null)], assignments), "sav")
  })
})

describe("prix moyen des tickets du camion", () => {
  it("moyenne pondérée par les litres, tickets incohérents ignorés", () => {
    assert.equal(truckAveragePrice([{ amount: 90, litres: 50 }, { amount: 54, litres: 30 }, { amount: 10, litres: null }, { amount: 100, litres: 1 }]), 1.8)
    assert.equal(truckAveragePrice([]), null)
  })
})

describe("coûts par chantier", () => {
  const result = computeWorksiteCosts({
    tours: [tour("t1", "2026-11-20", "2026-11-27", 1780.4, "alz"), tour("t2", "2026-11-28", "2026-11-28", null, "sav")],
    expenses: [
      { id: "e1", day: "2026-11-22", category: "FUEL", status: "APPROVED", amount: 95.5, litres: 52 },
      { id: "e2", day: "2026-11-28", category: "OTHER", status: "PENDING", amount: 12, litres: null },
      { id: "e3", day: "2026-12-05", category: "MAINTENANCE", status: "APPROVED", amount: 300, litres: null },
    ],
    assignments: [],
    worksiteNames: names,
    fuelPrice: { pricePerLitre: 1.75, source: "NATIONAL_AVERAGE" },
  })
  it("km, carburant estimé (10 L/100 km) et dépenses réelles par chantier", () => {
    const alz = result.rows.find((r) => r.worksiteId === "alz")!
    assert.equal(alz.name, "MAIRIE ALZONNE")
    assert.equal(alz.km, 1780)
    assert.equal(alz.estimatedLitres, 178)
    assert.equal(alz.estimatedFuelCost, 311.5)
    assert.equal(alz.expenses.FUEL, 95.5)
    assert.equal(alz.expensesTotal, 95.5)
  })
  it("tournée sans km signalée, dépense à valider comptée et signalée", () => {
    const sav = result.rows.find((r) => r.worksiteId === "sav")!
    assert.equal(sav.toursWithoutKm, 1)
    assert.equal(sav.estimatedFuelCost, null)
    assert.equal(sav.expensesTotal, 12)
    assert.equal(sav.pendingExpenses, 1)
  })
  it("hors chantier en dernier ; totaux", () => {
    assert.equal(result.rows.at(-1)!.key, UNASSIGNED_KEY)
    assert.equal(result.rows.at(-1)!.expensesTotal, 300)
    assert.deepEqual(result.totals, { km: 1780, estimatedFuelCost: 311.5, expensesTotal: 407.5 })
  })
  it("sans prix disponible : litres affichés, montant non calculé", () => {
    const r = computeWorksiteCosts({ tours: [tour("t1", "2026-11-20", "2026-11-20", 100, "alz")], expenses: [], assignments: [], worksiteNames: names, fuelPrice: null })
    assert.equal(r.rows[0].estimatedLitres, 10)
    assert.equal(r.rows[0].estimatedFuelCost, null)
    assert.equal(r.totals.estimatedFuelCost, null)
  })
})

describe("période", () => {
  it("valide les bornes", () => {
    assert.equal(worksiteCostsQuerySchema.safeParse({ from: "2026-11-01", to: "2026-11-30" }).success, true)
    assert.equal(worksiteCostsQuerySchema.safeParse({ from: "2026-11-30", to: "2026-11-01" }).success, false)
    assert.equal(worksiteCostsQuerySchema.safeParse({ from: "2025-01-01", to: "2026-11-30" }).success, false)
    assert.equal(worksiteCostsQuerySchema.safeParse({ from: null, to: "2026-11-30" }).success, false)
  })
})

describe("prix moyen national du gazole", () => {
  it("lit la moyenne, n'envoie aucune donnée de l'entreprise, met en cache une heure", async () => {
    const { nationalAveragePrice } = await import("@/lib/vehicules/v3/fuel-estimate-providers")
    const urls: string[] = []
    const fetchFn = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ results: [{ prix: 1.7234 }] })) }) as unknown as typeof fetch
    let t = 0
    assert.equal(await nationalAveragePrice("GAZOLE", fetchFn, () => t), 1.723)
    t = 3_000_000
    assert.equal(await nationalAveragePrice("GAZOLE", fetchFn, () => t), 1.723)
    assert.equal(urls.length, 1)
    const url = new URL(urls[0])
    assert.equal(url.hostname, "data.economie.gouv.fr")
    assert.deepEqual([...url.searchParams.keys()].sort(), ["select", "where"])
    assert.equal(url.searchParams.get("select"), "avg(gazole_prix) as prix")
  })
  it("valeur aberrante refusée", async () => {
    const { nationalAveragePrice } = await import("@/lib/vehicules/v3/fuel-estimate-providers")
    const fetchFn = (async () => new Response(JSON.stringify({ results: [{ prix: 42 }] }))) as unknown as typeof fetch
    await assert.rejects(nationalAveragePrice("SP98", fetchFn))
  })
})
