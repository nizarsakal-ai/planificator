/**
 * L1b v2 — revue B (B-R1) : début EFFECTIVEMENT occupé d'une sortie anticipée, règles pures. Les tests d'origine
 * (equipment-core.test.ts) ne sont pas modifiés. Données synthétiques.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  EQUIPMENT_ERRORS, dayPeriod, effectivePeriod, effectiveStart, findConflict, parseDay, planBooking, planCheckout,
  planRentalCancel, planRentalClose, type BookingLike,
} from "@/lib/equipment/equipment.core"

const d = (s: string) => parseDay(s)!
const at = (s: string) => new Date(s)
const period = (a: string, b: string) => { const p = dayPeriod(d(a), d(b)); assert.ok(p.ok); return (p as { ok: true; value: { startAt: Date; endAt: Date } }).value }
const booking = (id: string, a: string, b: string, status: BookingLike["status"], checkedOutAt: Date | null = null): BookingLike => ({ id, status, checkedOutAt, ...period(a, b) })

describe("B-R1 — début effectif d'une sortie anticipée", () => {
  it("début effectif = sortie constatée si elle précède le début prévu ; sinon début prévu ; dates prévues inchangées", () => {
    const early = booking("x", "2028-11-20", "2028-11-22", "CHECKED_OUT", at("2028-11-10T09:00:00Z"))
    assert.equal(effectiveStart(early).toISOString(), "2028-11-10T09:00:00.000Z")
    assert.equal(early.startAt.toISOString(), "2028-11-20T00:00:00.000Z", "date prévue conservée")
    const late = booking("y", "2028-11-20", "2028-11-22", "CHECKED_OUT", at("2028-11-20T10:00:00Z"))
    assert.equal(effectiveStart(late).toISOString(), "2028-11-20T00:00:00.000Z")
    const reserved = booking("z", "2028-11-20", "2028-11-22", "RESERVED", at("2028-11-10T09:00:00Z"))
    assert.equal(effectiveStart(reserved).toISOString(), "2028-11-20T00:00:00.000Z", "une réservation non sortie n'est pas avancée")
    const legacy: BookingLike = { id: "w", status: "CHECKED_OUT", ...period("2028-11-20", "2028-11-22") }
    assert.equal(effectiveStart(legacy).toISOString(), "2028-11-20T00:00:00.000Z", "checkedOutAt absent : début prévu")
    const p = effectivePeriod(early, at("2028-11-11T09:00:00Z"))
    assert.deepEqual([p.startAt.toISOString(), p.endAt.toISOString()], ["2028-11-10T09:00:00.000Z", "2028-11-23T00:00:00.000Z"])
  })
  it("réservation du 12 au 13 demandée le 11 pendant une sortie anticipée (prévue du 20 au 22, sortie le 10) ⇒ REFUSÉE", () => {
    const out = booking("x", "2028-11-20", "2028-11-22", "CHECKED_OUT", at("2028-11-10T09:00:00Z"))
    const now = at("2028-11-11T09:00:00Z")
    assert.equal(findConflict([out], period("2028-11-12", "2028-11-13"), now)?.id, "x")
    assert.deepEqual(planBooking({ equipmentStatus: "OUT", ownership: "OWNED", wanted: period("2028-11-12", "2028-11-13"), bookings: [out], contracts: [], now }), { ok: false, error: EQUIPMENT_ERRORS.overlap })
  })
  it("période future réellement disjointe (25–26) ⇒ toujours AUTORISÉE pendant la sortie anticipée (pas de refus global de l'état OUT)", () => {
    const out = booking("x", "2028-11-20", "2028-11-22", "CHECKED_OUT", at("2028-11-10T09:00:00Z"))
    assert.deepEqual(planBooking({ equipmentStatus: "OUT", ownership: "OWNED", wanted: period("2028-11-25", "2028-11-26"), bookings: [out], contracts: [], now: at("2028-11-11T09:00:00Z") }), { ok: true, value: { coveringContractId: null } })
  })
  it("après le retour (réservation RETURNED), la même période 12–13 est acceptée", () => {
    const back = booking("x", "2028-11-20", "2028-11-22", "RETURNED", at("2028-11-10T09:00:00Z"))
    assert.equal(findConflict([back], period("2028-11-12", "2028-11-13"), at("2028-11-11T12:00:00Z")), null)
  })
  it("sortie anticipée REFUSÉE si une réservation antérieure existe déjà (12–13 réservée, sortie le 10 de la 20–22)", () => {
    const x = booking("x", "2028-11-20", "2028-11-22", "RESERVED"), y = booking("y", "2028-11-12", "2028-11-13", "RESERVED")
    assert.deepEqual(planCheckout({ booking: x, equipmentStatus: "AVAILABLE", condition: "GOOD", others: [x, y], now: at("2028-11-10T09:00:00Z") }), { ok: false, error: EQUIPMENT_ERRORS.overlap })
  })
  it("location : annulation et clôture d'un contrat tiennent compte du début effectif d'une sortie anticipée", () => {
    const contract = { id: "c", status: "ACTIVE" as const, startDate: d("2028-11-01"), endDate: d("2028-11-15"), dailyRateCents: 1000, fixedFeesCents: 0 }
    const out = booking("x", "2028-11-20", "2028-11-22", "CHECKED_OUT", at("2028-11-14T09:00:00Z"))
    const now = at("2028-11-16T09:00:00Z")
    assert.deepEqual(planRentalCancel(contract, [out], now), { ok: false, error: EQUIPMENT_ERRORS.bookingsOnContract }, "sortie effective le 14, dans le contrat")
    assert.deepEqual(planRentalClose({ contract, returnedOn: d("2028-11-15"), bookings: [out], now }), { ok: false, error: EQUIPMENT_ERRORS.stillOut })
    const reserved = booking("y", "2028-11-20", "2028-11-22", "RESERVED")
    assert.deepEqual(planRentalCancel(contract, [reserved], now), { ok: true, value: null }, "réservation non sortie, hors contrat : sans effet")
  })
})
