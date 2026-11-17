import { test } from "node:test"
import assert from "node:assert/strict"
import {
  compareTourKm,
  computeConsumption,
  consumptionRise,
  odometerAt,
  ticketMileagePlausible,
  tourFuelPurchases,
  type FuelFill,
  type OdometerPoint,
} from "../../../src/lib/vehicules/v3/fuel-consumption-domain"
import { resolveEstimatedKm } from "../../../src/lib/vehicules/v3/tour-domain"
import {
  driverTicketSchema,
  optionalTicketMileage,
  ticketCorrectCommand,
  ticketCreateCommand,
  type CandidateExpense,
} from "../../../src/lib/vehicules/v3/driver-fuel-ticket-domain"

const day = (d: string) => Date.parse(`${d}T12:00:00Z`)

test("écart km réels / estimés : alerte au-delà de 20 % ET de 50 km", () => {
  assert.equal(compareTourKm(null, 100), null)
  assert.equal(compareTourKm(1740, null), null)
  const ok = compareTourKm(1740, 1850)!
  assert.deepEqual({ gap: ok.gapKm, alert: ok.alert }, { gap: 110, alert: false }) // +6 %
  const high = compareTourKm(1740, 2300)!
  assert.equal(high.alert, true)
  assert.equal(high.gapRatio, 0.322)
  // 40 km d'écart sur une petite tournée : > 20 % mais < 50 km → pas d'alerte.
  assert.equal(compareTourKm(100, 140)!.alert, false)
  // Estimation nulle : alerte dès 50 km d'écart.
  assert.equal(compareTourKm(0, 60)!.alert, true)
})

test("compteur interpolé entre deux relevés, jamais hors plage", () => {
  const points: OdometerPoint[] = [{ at: day("2026-11-01"), km: 10_000 }, { at: day("2026-11-11"), km: 11_000 }]
  assert.equal(odometerAt(points, day("2026-11-06")), 10_500)
  assert.equal(odometerAt(points, day("2026-11-01")), 10_000)
  assert.equal(odometerAt(points, day("2026-10-30")), null)
  assert.equal(odometerAt(points, day("2026-11-12")), null)
})

test("compteur lu sur ticket : cohérent avec le journal, sinon ignoré", () => {
  const points: OdometerPoint[] = [{ at: day("2026-11-01"), km: 10_000 }, { at: day("2026-11-11"), km: 11_000 }]
  assert.equal(ticketMileagePlausible(points, day("2026-11-05"), 10_400), true)
  assert.equal(ticketMileagePlausible(points, day("2026-11-05"), 9_000), false) // recule
  assert.equal(ticketMileagePlausible(points, day("2026-11-05"), 12_000), false) // dépasse le relevé suivant
  assert.equal(ticketMileagePlausible(points, day("2026-11-20"), 13_000), true) // après le dernier relevé
  assert.equal(ticketMileagePlausible(points, day("2026-11-20"), 40_000), false) // trop loin devant
  assert.equal(ticketMileagePlausible([], day("2026-11-20"), 40_000), true) // aucun relevé : accepté
  assert.equal(ticketMileagePlausible(points, day("2026-11-05"), 0), false)
})

const journal: OdometerPoint[] = [{ at: day("2026-09-01"), km: 100_000 }, { at: day("2026-11-30"), km: 106_000 }]
const fill = (d: string, litres: number | null, amount = 100, ticketMileage: number | null = null): FuelFill => ({ at: day(d), litres, amount, ticketMileage })

test("consommation plein à plein : litres après le premier plein / km entre premier et dernier", () => {
  // 6 000 km sur 90 jours ; pleins tous les ~1 000 km. Interpolation : 66,7 km/jour.
  const fills = [fill("2026-09-01", 80), fill("2026-09-16", 100), fill("2026-10-01", 100), fill("2026-10-16", 100), fill("2026-10-31", 100), fill("2026-11-15", 100), fill("2026-11-30", 100)]
  const r = computeConsumption(fills, journal, 1.8)
  assert.equal(r.status, "OK")
  assert.equal(r.fills, 7)
  assert.equal(r.km, 6_000)
  assert.equal(r.litres, 600) // le premier plein (80 L) est exclu
  assert.equal(r.lPer100Km, 10)
})

test("consommation : données insuffisantes (moins de 3 000 km ou de 3 pleins)", () => {
  const r = computeConsumption([fill("2026-09-01", 80), fill("2026-09-16", 100)], journal, 1.8)
  assert.equal(r.status, "INSUFFICIENT_DATA")
  assert.equal(r.lPer100Km, null)
  // Aucun relevé du compteur : impossible de mesurer.
  assert.equal(computeConsumption([fill("2026-09-01", 80), fill("2026-10-01", 100), fill("2026-11-01", 100)], [], 1.8).status, "INSUFFICIENT_DATA")
})

test("consommation : un plein sans litres est estimé au prix moyen, sinon pas de mesure", () => {
  const fills = [fill("2026-09-01", 80), fill("2026-10-01", null, 180), fill("2026-10-31", 200), fill("2026-11-30", 200)]
  const r = computeConsumption(fills, journal, 1.8)
  assert.equal(r.status, "OK")
  assert.equal(r.litresFromAmount, 1)
  assert.equal(r.litres, 500) // 100 L déduits de 180 € à 1,80 €/L
  assert.equal(computeConsumption(fills, journal, null).status, "INSUFFICIENT_DATA")
})

test("consommation : un compteur de ticket faux est ignoré, un compteur juste est utilisé", () => {
  const fills = [fill("2026-09-01", 80, 100, 100_000), fill("2026-10-01", 200, 100, 999_999), fill("2026-11-30", 400, 100, 106_000)]
  const r = computeConsumption(fills, journal, 1.8)
  assert.equal(r.ticketMileageUsed, 2)
  assert.equal(r.ticketMileageIgnored, 1)
  assert.equal(r.lPer100Km, 10)
})

test("consommation incohérente signalée (ticket ou compteur faux)", () => {
  const fills = [fill("2026-09-01", 80), fill("2026-10-15", 1_500), fill("2026-11-30", 1_500)]
  const r = computeConsumption(fills, journal, 1.8)
  assert.equal(r.status, "IMPLAUSIBLE")
  assert.equal(r.lPer100Km, 50)
})

test("hausse de consommation > 20 % signalée", () => {
  const base = { litres: 0, km: 0, fills: 3, litresFromAmount: 0, ticketMileageUsed: 0, ticketMileageIgnored: 0 }
  assert.equal(consumptionRise({ ...base, status: "OK", lPer100Km: 13 }, { ...base, status: "OK", lPer100Km: 10 }), 0.3)
  assert.equal(consumptionRise({ ...base, status: "OK", lPer100Km: 11 }, { ...base, status: "OK", lPer100Km: 10 }), null)
  assert.equal(consumptionRise({ ...base, status: "OK", lPer100Km: 13 }, { ...base, status: "INSUFFICIENT_DATA", lPer100Km: null }), null)
})

test("carburant acheté pendant une tournée : indicatif seulement au-delà de 300 km et sans plein inconnu", () => {
  const tour = { startsAt: day("2026-11-20"), endsAt: day("2026-11-27"), actualKm: 1_800 }
  const fills = [fill("2026-11-19", 90), fill("2026-11-21", 90), fill("2026-11-24", 95), fill("2026-11-28", 90)]
  assert.deepEqual(tourFuelPurchases(tour, fills), { litres: 185, fills: 2, unknownLitres: 0, lPer100KmIndicative: 10.3 })
  assert.equal(tourFuelPurchases({ ...tour, actualKm: 200 }, fills).lPer100KmIndicative, null)
  assert.equal(tourFuelPurchases(tour, [...fills, fill("2026-11-25", null)]).lPer100KmIndicative, null)
})

test("source des km estimés : automatique par défaut, saisie manuelle jamais écrasée", () => {
  // Création
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: null }, null), { source: "AUTO", estimatedKm: null })
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 757 }, null), { source: "MANUAL", estimatedKm: 757 })
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 757, estimatedKmAuto: true }, null), { source: "AUTO", estimatedKm: null }) // valeur client ignorée
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 757, estimatedKmAuto: false }, null), { source: "MANUAL", estimatedKm: 757 })
  // Modification d'une tournée automatique : le formulaire renvoie la valeur calculée → reste automatique.
  const auto = { estimatedKm: 1740, estimatedKmSource: "AUTO" }
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 1740 }, auto), { source: "AUTO", estimatedKm: 1740 })
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 1800 }, auto), { source: "MANUAL", estimatedKm: 1800 })
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: null, estimatedKmAuto: true }, auto), { source: "AUTO", estimatedKm: 1740 })
  // Retour au calcul automatique d'une tournée manuelle.
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: null, estimatedKmAuto: true }, { estimatedKm: 757, estimatedKmSource: "MANUAL" }), { source: "AUTO", estimatedKm: 757 })
  // Ancienne tournée (source inconnue) : une valeur identique reste manuelle.
  assert.deepEqual(resolveEstimatedKm({ estimatedKm: 757 }, { estimatedKm: 757, estimatedKmSource: null }), { source: "MANUAL", estimatedKm: 757 })
})

test("compteur du ticket : facultatif et jamais bloquant", () => {
  assert.equal(optionalTicketMileage(undefined), null)
  assert.equal(optionalTicketMileage(null), null)
  assert.equal(optionalTicketMileage(""), null)
  assert.equal(optionalTicketMileage("abc"), null)
  assert.equal(optionalTicketMileage("-12"), null)
  assert.equal(optionalTicketMileage("123 456"), 123_456)
  assert.equal(optionalTicketMileage("123.456"), 123_456)
  assert.equal(optionalTicketMileage(98765), 98_765)
  assert.equal(optionalTicketMileage(12.5), null)
  assert.equal(optionalTicketMileage("99999999"), null)
  const base = { truckId: "t1", amount: "95,50", litres: "52,3", day: "2026-11-17", station: null }
  for (const mileage of [undefined, null, "", "illisible", -5, "123456"]) {
    const parsed = driverTicketSchema.safeParse(mileage === undefined ? base : { ...base, mileage })
    assert.equal(parsed.success, true, `mileage ${String(mileage)} ne doit pas bloquer l'envoi`)
  }
  assert.equal(driverTicketSchema.parse({ ...base, mileage: "123456" }).mileage, 123_456)
  assert.equal(driverTicketSchema.parse({ ...base, mileage: "illisible" }).mileage, null)
})

test("compteur du ticket : enregistré sur le plein créé, complété sur le plein bancaire", () => {
  const input = { truckId: "t1", amount: "95,50", litres: "52,3", day: "2026-11-17", station: null, mileage: 123_456 }
  assert.equal(ticketCreateCommand(input, "v1", "Hassen").data.mileageObservation, 123_456)
  assert.equal(ticketCreateCommand({ ...input, mileage: null }, "v1", "Hassen").data.mileageObservation, null)
  const bank: CandidateExpense = { id: "e1", revision: 1, day: "2026-11-17", amountCents: 9550, currency: "EUR", reference: "BANQUE:x", supplier: null, notes: null, litres: null, mileageObservation: 120_000, documentVersionId: null, status: "PENDING" }
  assert.equal(ticketCorrectCommand(bank, input, "v1", "Hassen").data.mileageObservation, 123_456)
  assert.equal(ticketCorrectCommand(bank, { ...input, mileage: null }, "v1", "Hassen").data.mileageObservation, 120_000)
})
