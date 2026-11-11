/**
 * Lot B Planificator V2 : règles pures du matériel et de la location (périodes, chevauchement, sortie et retour,
 * contrats, coûts au centime, entretien). Aucune base.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  EQUIPMENT_ERRORS, billedDays, committedRentalCents, coveringContract, dayPeriod, effectiveEnd, findConflict, formatDay,
  maintenanceOverdue, parisToday, parseDay, planBooking, planCheckout, planRentalCancel, planRentalClose, planRentalContract,
  planReturn, planStatusChange, rentalCostCents, validCents, validateEquipmentIdentity, validateMaintenance,
  type BookingLike, type ContractLike, type Period,
} from "@/lib/equipment/equipment.core"

const d = (s: string) => parseDay(s)!
const per = (a: string, b: string): Period => { const p = dayPeriod(d(a), d(b)); assert.ok(p.ok); return p.value }
const bk = (id: string, a: string, b: string, status: BookingLike["status"] = "RESERVED"): BookingLike => ({ id, status, ...per(a, b) })
const ct = (id: string, a: string, b: string, status: ContractLike["status"] = "ACTIVE") => ({ id, status, startDate: d(a), endDate: d(b), dailyRateCents: 4500, fixedFeesCents: 3000 })
const NOW = new Date("2026-11-04T09:00:00Z")

describe("saisies", () => {
  it("parseDay : jours réels seulement, minuit UTC", () => {
    assert.equal(parseDay("2026-11-04")?.toISOString(), "2026-11-04T00:00:00.000Z")
    for (const bad of ["2026-02-30", "2026-13-01", "26-11-04", "2026-11-4", "", "1999-12-31", "2101-01-01", "2026-11-04T00:00"]) assert.equal(parseDay(bad), null, bad)
    assert.equal(parseDay("2028-02-29")?.toISOString().slice(0, 10), "2028-02-29")
    assert.equal(formatDay(d("2026-01-09")), "2026-01-09")
  })
  it("numéro, nom et catégorie : refusés s'ils sont vides ou trop longs, jamais tronqués", () => {
    assert.deepEqual(validateEquipmentIdentity({ number: " MAT-012 ", name: " Nacelle ", category: "Élévation" }), { ok: true, value: { number: "MAT-012", name: "Nacelle", category: "Élévation" } })
    for (const number of ["", "-A", "A B", "x".repeat(41), "MAT;1"]) assert.deepEqual(validateEquipmentIdentity({ number, name: "n", category: "c" }), { ok: false, error: EQUIPMENT_ERRORS.invalidNumber }, number)
    assert.equal(validateEquipmentIdentity({ number: "A", name: "x".repeat(161), category: "c" }).ok, false)
    assert.equal(validateEquipmentIdentity({ number: "A", name: "n", category: " " }).ok, false)
  })
  it("montants : entiers ≥ 0 bornés à la colonne INTEGER", () => {
    for (const ok of [null, undefined, 0, 2_000_000_000]) assert.equal(validCents(ok), true)
    for (const bad of [-1, 1.5, 2_000_000_001, Number.NaN]) assert.equal(validCents(bad), false)
  })
})

describe("périodes et chevauchement", () => {
  it("jours inclus → intervalle semi-ouvert ; fin avant début refusée ; durée bornée", () => {
    const p = per("2026-11-10", "2026-11-12")
    assert.equal(p.startAt.toISOString(), "2026-11-10T00:00:00.000Z")
    assert.equal(p.endAt.toISOString(), "2026-11-13T00:00:00.000Z")
    assert.equal(per("2026-11-10", "2026-11-10").endAt.toISOString(), "2026-11-11T00:00:00.000Z", "un seul jour")
    assert.deepEqual(dayPeriod(d("2026-11-12"), d("2026-11-10")), { ok: false, error: EQUIPMENT_ERRORS.invalidPeriod })
    assert.deepEqual(dayPeriod(d("2026-01-01"), d("2028-01-02")), { ok: false, error: EQUIPMENT_ERRORS.periodTooLong })
  })
  it("pas de double réservation : un jour commun suffit ; des périodes contiguës ne se chevauchent pas", () => {
    const existing = [bk("a", "2026-11-10", "2026-11-12")]
    assert.equal(findConflict(existing, per("2026-11-12", "2026-11-14"), NOW)?.id, "a", "le 12 est commun")
    assert.equal(findConflict(existing, per("2026-11-05", "2026-11-20"), NOW)?.id, "a", "englobante")
    assert.equal(findConflict(existing, per("2026-11-11", "2026-11-11"), NOW)?.id, "a", "incluse")
    assert.equal(findConflict(existing, per("2026-11-13", "2026-11-14"), NOW), null, "contiguë après")
    assert.equal(findConflict(existing, per("2026-11-08", "2026-11-09"), NOW), null, "contiguë avant")
  })
  it("réservations rendues ou annulées ignorées ; exclusion de soi-même", () => {
    const existing = [bk("r", "2026-11-10", "2026-11-12", "RETURNED"), bk("c", "2026-11-10", "2026-11-12", "CANCELLED"), bk("s", "2026-11-10", "2026-11-12")]
    assert.equal(findConflict(existing, per("2026-11-11", "2026-11-11"), NOW, "s"), null)
    assert.equal(findConflict(existing, per("2026-11-11", "2026-11-11"), NOW)?.id, "s")
  })
  it("sortie non rendue après sa fin : occupe l'équipement jusqu'à maintenant", () => {
    const late = bk("l", "2026-10-28", "2026-10-30", "CHECKED_OUT")
    assert.equal(effectiveEnd(late, NOW).toISOString(), NOW.toISOString())
    assert.equal(findConflict([late], per("2026-11-02", "2026-11-03"), NOW)?.id, "l", "retard en cours")
    assert.equal(findConflict([late], per("2026-11-05", "2026-11-06"), NOW), null, "après maintenant")
    assert.equal(effectiveEnd(bk("x", "2026-10-28", "2026-10-30"), NOW).toISOString(), "2026-10-31T00:00:00.000Z", "réservée : fin prévue")
  })
})

describe("réservation", () => {
  const base = { equipmentStatus: "AVAILABLE" as const, ownership: "OWNED" as const, bookings: [], contracts: [], now: NOW }
  it("acceptée sur un équipement propre libre, même en entretien (réservation future)", () => {
    assert.deepEqual(planBooking({ ...base, wanted: per("2026-11-10", "2026-11-12") }), { ok: true, value: { coveringContractId: null } })
    assert.equal(planBooking({ ...base, equipmentStatus: "MAINTENANCE", wanted: per("2026-11-10", "2026-11-12") }).ok, true)
  })
  it("refusée si réformé, si chevauchement, ou si caution invalide", () => {
    assert.deepEqual(planBooking({ ...base, equipmentStatus: "RETIRED", wanted: per("2026-11-10", "2026-11-12") }), { ok: false, error: EQUIPMENT_ERRORS.retired })
    assert.deepEqual(planBooking({ ...base, bookings: [bk("a", "2026-11-11", "2026-11-11")], wanted: per("2026-11-10", "2026-11-12") }), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    assert.deepEqual(planBooking({ ...base, depositCents: -5, wanted: per("2026-11-10", "2026-11-12") }), { ok: false, error: EQUIPMENT_ERRORS.invalidAmount })
  })
  it("équipement loué : période entièrement couverte par UN contrat actif", () => {
    const contracts = [ct("k1", "2026-11-01", "2026-11-15"), ct("k2", "2026-11-16", "2026-11-30"), ct("kx", "2026-12-01", "2026-12-31", "CANCELLED")]
    const rented = { ...base, ownership: "RENTED" as const, contracts }
    assert.deepEqual(planBooking({ ...rented, wanted: per("2026-11-10", "2026-11-15") }), { ok: true, value: { coveringContractId: "k1" } }, "dernier jour du contrat inclus")
    assert.deepEqual(planBooking({ ...rented, wanted: per("2026-11-14", "2026-11-17") }), { ok: false, error: EQUIPMENT_ERRORS.notCovered }, "à cheval sur deux contrats")
    assert.deepEqual(planBooking({ ...rented, wanted: per("2026-12-02", "2026-12-03") }), { ok: false, error: EQUIPMENT_ERRORS.notCovered }, "contrat annulé")
    assert.equal(coveringContract(contracts, per("2026-10-31", "2026-11-02")), null)
  })
})

describe("sortie et retour avec état", () => {
  const b = bk("b", "2026-11-04", "2026-11-06")
  it("sortie : réservation en attente, équipement disponible, état connu", () => {
    assert.deepEqual(planCheckout({ booking: b, equipmentStatus: "AVAILABLE", condition: "WORN", others: [], now: NOW }), { ok: true, value: "WORN" })
    assert.deepEqual(planCheckout({ booking: { ...b, status: "CHECKED_OUT" }, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [], now: NOW }), { ok: false, error: EQUIPMENT_ERRORS.notReserved })
    for (const s of ["OUT", "MAINTENANCE", "RETIRED"] as const) assert.deepEqual(planCheckout({ booking: b, equipmentStatus: s, condition: "GOOD", others: [], now: NOW }), { ok: false, error: EQUIPMENT_ERRORS.unavailable }, s)
    assert.deepEqual(planCheckout({ booking: b, equipmentStatus: "AVAILABLE", condition: "NEUF", others: [], now: NOW }), { ok: false, error: EQUIPMENT_ERRORS.invalidCondition })
  })
  it("sortie tardive (fin prévue passée, jamais sortie) : occupe jusqu'à maintenant, refusée si une réservation suit déjà", () => {
    const past = bk("past", "2026-10-28", "2026-10-30")
    assert.equal(planCheckout({ booking: past, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [past], now: NOW }).ok, true)
    assert.deepEqual(planCheckout({ booking: past, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [past, bk("n", "2026-11-02", "2026-11-03")], now: NOW }), { ok: false, error: EQUIPMENT_ERRORS.overlap })
  })
  it("sortie anticipée refusée si une autre réservation tombe avant le début prévu", () => {
    const later = bk("later", "2026-11-10", "2026-11-12")
    const earlier = bk("earlier", "2026-11-06", "2026-11-07")
    assert.deepEqual(planCheckout({ booking: later, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [later, earlier], now: NOW }), { ok: false, error: EQUIPMENT_ERRORS.overlap })
    assert.equal(planCheckout({ booking: later, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [later], now: NOW }).ok, true)
  })
  it("retour : endommagé ⇒ entretien ; sinon disponible ; seulement depuis « sorti »", () => {
    assert.deepEqual(planReturn("CHECKED_OUT", "DAMAGED"), { ok: true, value: { condition: "DAMAGED", nextStatus: "MAINTENANCE" } })
    assert.deepEqual(planReturn("CHECKED_OUT", "WORN"), { ok: true, value: { condition: "WORN", nextStatus: "AVAILABLE" } })
    assert.deepEqual(planReturn("RESERVED", "GOOD"), { ok: false, error: EQUIPMENT_ERRORS.notCheckedOut })
    assert.deepEqual(planReturn("CHECKED_OUT", ""), { ok: false, error: EQUIPMENT_ERRORS.invalidCondition })
  })
  it("changements d'état manuels : jamais « sorti » à la main, réformé définitif", () => {
    assert.deepEqual(planStatusChange("AVAILABLE", "MAINTENANCE"), { ok: true, value: "MAINTENANCE" })
    assert.deepEqual(planStatusChange("MAINTENANCE", "AVAILABLE"), { ok: true, value: "AVAILABLE" })
    for (const [from, to] of [["AVAILABLE", "OUT"], ["OUT", "AVAILABLE"], ["OUT", "MAINTENANCE"], ["RETIRED", "AVAILABLE"], ["AVAILABLE", "AVAILABLE"], ["AVAILABLE", "x"]] as const) {
      assert.deepEqual(planStatusChange(from, to), { ok: false, error: EQUIPMENT_ERRORS.invalidStatusChange }, `${from}→${to}`)
    }
  })
})

describe("location : contrats et coûts au centime", () => {
  it("jours facturés bornes incluses ; coût = jours × tarif + frais (BigInt)", () => {
    assert.equal(billedDays(d("2026-11-01"), d("2026-11-03")), 3)
    assert.deepEqual(rentalCostCents({ startDate: d("2026-11-01"), lastDay: d("2026-11-03"), dailyRateCents: 4550, fixedFeesCents: 2999 }), { ok: true, value: BigInt("3") * BigInt("4550") + BigInt("2999") })
    assert.deepEqual(rentalCostCents({ startDate: d("2026-11-01"), lastDay: d("2026-10-31"), dailyRateCents: 1, fixedFeesCents: 0 }), { ok: false, error: EQUIPMENT_ERRORS.returnBeforeStart })
    // Au-delà de Number.MAX_SAFE_INTEGER en centimes : aucun arrondi flottant.
    assert.deepEqual(rentalCostCents({ startDate: d("2026-01-01"), lastDay: d("2027-12-31"), dailyRateCents: 2_000_000_000, fixedFeesCents: 2_000_000_000 }), { ok: true, value: BigInt("730") * BigInt("2000000000") + BigInt("2000000000") })
    assert.equal(committedRentalCents(ct("k", "2026-11-01", "2026-11-10")), BigInt("10") * BigInt("4500") + BigInt("3000"))
  })
  it("nouveau contrat : équipement loué non réformé, montants valides, pas de chevauchement avec un contrat actif", () => {
    const base = { ownership: "RENTED" as const, equipmentStatus: "AVAILABLE" as const, startDate: d("2026-11-10"), endDate: d("2026-11-20"), dailyRateCents: 4500, fixedFeesCents: 0, contracts: [] }
    assert.equal(planRentalContract(base).ok, true)
    assert.deepEqual(planRentalContract({ ...base, ownership: "OWNED" }), { ok: false, error: EQUIPMENT_ERRORS.notRented })
    assert.deepEqual(planRentalContract({ ...base, equipmentStatus: "RETIRED" }), { ok: false, error: EQUIPMENT_ERRORS.retired })
    assert.deepEqual(planRentalContract({ ...base, dailyRateCents: -1 }), { ok: false, error: EQUIPMENT_ERRORS.invalidAmount })
    assert.deepEqual(planRentalContract({ ...base, endDate: d("2026-11-09") }), { ok: false, error: EQUIPMENT_ERRORS.invalidPeriod })
    assert.deepEqual(planRentalContract({ ...base, contracts: [ct("k", "2026-11-20", "2026-11-25")] }), { ok: false, error: EQUIPMENT_ERRORS.contractOverlap })
    assert.equal(planRentalContract({ ...base, contracts: [ct("k", "2026-11-21", "2026-11-25"), ct("c", "2026-11-12", "2026-11-14", "CLOSED")] }).ok, true)
  })
  it("clôture : coût figé sur les jours réels (retour anticipé ou tardif) ; refus si encore sorti ou si une réservation dépasse le retour", () => {
    const contract = ct("k", "2026-11-01", "2026-11-10")
    const LATER = new Date("2026-11-20T10:00:00Z")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [], now: LATER }), { ok: true, value: BigInt("5") * BigInt("4500") + BigInt("3000") })
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-12"), bookings: [], now: LATER }), { ok: true, value: BigInt("12") * BigInt("4500") + BigInt("3000") }, "retard facturé")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [], now: new Date("2026-11-04T23:30:00Z") }), { ok: true, value: BigInt("5") * BigInt("4500") + BigInt("3000") }, "aujourd'hui à Paris")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [], now: new Date("2026-11-04T22:30:00Z") }), { ok: false, error: EQUIPMENT_ERRORS.returnInFuture }, "demain à Paris")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [bk("o", "2026-11-03", "2026-11-04", "CHECKED_OUT")], now: LATER }), { ok: false, error: EQUIPMENT_ERRORS.stillOut })
    // Revue indépendante : une sortie relevant d'un contrat ultérieur ne bloque pas la clôture de celui-ci.
    assert.equal(planRentalClose({ contract, returnedOn: d("2026-11-10"), bookings: [bk("o2", "2026-11-25", "2026-11-28", "CHECKED_OUT")], now: new Date("2026-11-26T10:00:00Z") }).ok, true)
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2029-01-01"), bookings: [], now: new Date("2029-06-01T10:00:00Z") }), { ok: false, error: EQUIPMENT_ERRORS.periodTooLong }, "retour saisi aberrant")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [bk("r", "2026-11-06", "2026-11-07")], now: LATER }), { ok: false, error: EQUIPMENT_ERRORS.bookingsAfterReturn })
    assert.equal(planRentalClose({ contract, returnedOn: d("2026-11-05"), bookings: [bk("r", "2026-11-04", "2026-11-05")], now: LATER }).ok, true, "réservation finie le jour du retour")
    assert.deepEqual(planRentalClose({ contract: { ...contract, status: "CLOSED" }, returnedOn: d("2026-11-05"), bookings: [], now: LATER }), { ok: false, error: EQUIPMENT_ERRORS.contractNotActive })
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2026-10-31"), bookings: [], now: LATER }), { ok: false, error: EQUIPMENT_ERRORS.returnBeforeStart })
  })
  it("annulation : refusée tant qu'une réservation active en dépend", () => {
    const contract = ct("k", "2026-11-01", "2026-11-10")
    assert.equal(planRentalCancel(contract, [bk("r", "2026-11-20", "2026-11-21")], NOW).ok, true)
    assert.deepEqual(planRentalCancel(contract, [bk("r", "2026-11-09", "2026-11-12")], NOW), { ok: false, error: EQUIPMENT_ERRORS.bookingsOnContract })
    assert.deepEqual(planRentalCancel({ ...contract, status: "CANCELLED" }, [], NOW), { ok: false, error: EQUIPMENT_ERRORS.contractNotActive })
  })
})

describe("entretien", () => {
  it("description et au moins une date ; coût valide", () => {
    assert.deepEqual(validateMaintenance({ description: " Vidange ", plannedOn: d("2026-11-10"), performedOn: null, costCents: null }), { ok: true, value: { description: "Vidange" } })
    assert.deepEqual(validateMaintenance({ description: "Vidange", plannedOn: null, performedOn: null, costCents: null }), { ok: false, error: EQUIPMENT_ERRORS.invalidMaintenance })
    assert.deepEqual(validateMaintenance({ description: " ", plannedOn: d("2026-11-10"), performedOn: null, costCents: null }), { ok: false, error: EQUIPMENT_ERRORS.invalidMaintenance })
    assert.deepEqual(validateMaintenance({ description: "x", plannedOn: d("2026-11-10"), performedOn: null, costCents: -1 }), { ok: false, error: EQUIPMENT_ERRORS.invalidAmount })
  })
  it("en retard : prévu avant aujourd'hui et non réalisé", () => {
    const today = d("2026-11-04")
    assert.equal(maintenanceOverdue({ plannedOn: d("2026-11-03"), performedOn: null }, today), true)
    assert.equal(maintenanceOverdue({ plannedOn: d("2026-11-04"), performedOn: null }, today), false)
    assert.equal(maintenanceOverdue({ plannedOn: d("2026-11-03"), performedOn: d("2026-11-03") }, today), false)
  })
  it("jour civil de Paris (passage de minuit en heure d'hiver)", () => {
    assert.equal(parisToday(new Date("2026-11-04T23:30:00Z")).toISOString(), "2026-11-05T00:00:00.000Z")
    assert.equal(parisToday(new Date("2026-11-04T22:30:00Z")).toISOString(), "2026-11-04T00:00:00.000Z")
  })
})
