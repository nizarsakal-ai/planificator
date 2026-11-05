/**
 * R13 — prévision carburant automatique d'un séjour (pure + rendu) et passage « ticket lu → dépense préremplie ».
 * Données synthétiques neutres ; aucune base, aucun réseau, aucun document réel.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { FuelEstimate, FuelStation, PlannedStay, PriceStats } from "@/lib/vehicules/v3/fuel-estimate-domain"
import { extractVehicleDocumentFields } from "@/lib/vehicules/v3/document-recognition-domain"
import { departureInfo, emptyDecisions, estimateQuery, hasDecisions, reconcileEstimate, emptyEstimateState, stayLabel } from "@/components/vehicules/v3/vehicle-fuel-estimate-ui"
import { INDICATIVE_CONSUMPTION_L_PER_100KM, forecastNote, forecastProposal, forecastSummary, stayForecast } from "@/components/vehicules/v3/vehicle-fuel-forecast"
import { ForecastPanel } from "@/components/vehicules/v3/VehicleFuelEstimate"
import {
  TICKET_DRAFT_MAX_BYTES, TICKET_DRAFT_TTL_MS, applyTicketDraft, draftDocumentAllowed, parseTicketDraft, purgeTicketDrafts, saveTicketDraft, takeTicketDraft, ticketDraftError, ticketExpenseValues,
  withDocumentCorrections, withdrawTicketFields, type DraftStorage, type TicketForm,
} from "@/components/vehicules/v3/expense-ticket-handoff"

// tsconfig "jsx": "preserve" → runtime JSX classique sous tsx.
;(globalThis as { React?: typeof React }).React = React

const TODAY = "2026-11-05"
const station = (over: Partial<FuelStation> = {}): FuelStation => ({ id: "st-1", label: "STATION FICTIVE A", city: "Exempleville", price: 2.25, updatedAt: "2026-11-05T06:00:00.000Z", offRouteKm: 0.3, open24h: false, ...over })
const stay = (over: Partial<PlannedStay> = {}): PlannedStay => ({ id: "ws-1~team-g~2026-11-06", worksiteId: "ws-1", worksiteName: "Chantier fictif", hasAddress: true, hasCoordinates: true, teamId: "team-g", teamName: "Équipe fictive",
  leaderName: null, chauffeurName: null, departure: "2026-11-06", return: "2026-11-09", days: 4, spanDays: 4, runs: [{ from: "2026-11-06", to: "2026-11-09", days: 4 }], gaps: [],
  departureKnown: true, returnKnown: true, estimable: true, blocked: null, assignment: "HISTORY", handoverDays: [], context: "v1-00000000000000aa", ...over })
const stats = (over: Partial<PriceStats> = {}): PriceStats => ({ count: 120, min: 2.1, median: 2.4, max: 2.6, sampled: false, ...over })
const reading = (s: PlannedStay, over: Partial<FuelEstimate> = {}): FuelEstimate => ({ source: "STAY", tripId: s.id, stay: s, tripDate: s.departure, tripClosed: false, worksiteName: s.worksiteName, odometer: null,
  km: null, kmSource: null, route: { status: "ROUTE", oneWayKm: 783.5 }, fuel: "GAZOLE", stations: [station()], stationsStatus: "ROUTE_CORRIDOR", priceStats: null,
  travel: null, depotConfirmed: false, missing: ["MODE", "DEPOT"], ...over })
const forecast = (s: PlannedStay, e: FuelEstimate, over: Partial<{ consumptionInput: string; extraKm: number; priceKey: string; priceChosen: boolean }> = {}) =>
  stayForecast({ stay: s, estimate: e, consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, ...over })
const ok = (r: ReturnType<typeof stayForecast>) => { assert.ok(r.ok, JSON.stringify(r)); return r.forecast }
const CONFIRM = /confirm|déclar/i

describe("prévision : règle d'organisation et calcul", () => {
  it("≤ 50 km aller (50 compris) : retour quotidien, un aller-retour par jour planifié ; 50,1 km : un seul aller-retour", () => {
    const s = stay({ days: 3 })
    for (const [km, mode, trips, travelKm] of [[20, "DAILY", 3, 120], [50, "DAILY", 3, 300], [50.1, "ONE_ROUND_TRIP", 1, 100]] as const) {
      const f = ok(forecast(s, reading(s, { route: { status: "ROUTE", oneWayKm: km } })))
      assert.deepEqual([f.mode, f.roundTrips, f.travelKm], [mode, trips, travelKm], String(km))
    }
  })
  it("783,5 km aller, 600 km sur place saisis, 9 L/100 km préférés, échantillon tronqué : station réelle, aucune fausse médiane", () => {
    const s = stay()
    const e = reading(s, { priceStats: stats({ sampled: true, count: 283, median: 2.05 }), stations: [station({ id: "st-cheap", price: 2.199 }), station({ id: "st-2", price: 2.25 })] })
    const f = ok(forecast(s, e, { consumptionInput: "9", extraKm: 600 }))
    assert.deepEqual([f.mode, f.travelKm, f.extraKm, f.km, f.consumption, f.consumptionIndicative, f.litres, f.amount], ["ONE_ROUND_TRIP", 1567, 600, 2167, 9, false, 195.03, 428.87])
    assert.equal(f.price?.kind, "STATION")
    assert.match(f.price!.label, /2,199 €\/L Gazole : prix indicatif d'une station réelle, pas une moyenne \(STATION FICTIVE A, Exempleville, publié le 05\/11\/2026\)/)
    assert.doesNotMatch(f.assumptions.join(" "), /médiane|2,050/)
    assert.equal(forecastSummary(f), "2167 km · 195,03 L · ≈ 428,87 €")
  })
  it("414,7 km, consommation par défaut 8 indicative, prix choisi par l'opérateur prioritaire : 829 km, 66,32 L, 149,22 €", () => {
    const s = stay()
    const e = reading(s, { route: { status: "ROUTE", oneWayKm: 414.7 }, priceStats: stats(), stations: [station({ id: "st-a", price: 2.1 }), station({ id: "st-b", price: 2.25 })] })
    const auto = ok(forecast(s, e))
    assert.deepEqual([auto.consumption, auto.consumptionIndicative, auto.price?.kind, auto.amount], [INDICATIVE_CONSUMPTION_L_PER_100KM, true, "MEDIAN", 159.17])
    const chosen = ok(forecast(s, e, { priceKey: "st-b", priceChosen: true }))
    assert.deepEqual([chosen.km, chosen.litres, chosen.price?.kind, chosen.amount], [829, 66.32, "CHOSEN", 149.22])
    assert.match(chosen.assumptions.join(" "), /8 L\/100 km, valeur indicative/)
  })
  it("aucune station valide : km et litres calculés, montant indisponible ; consommation invalide : pas de litres", () => {
    const s = stay()
    const none = ok(forecast(s, reading(s, { stations: [station({ price: Number.NaN })], priceStats: stats({ sampled: true }) })))
    assert.deepEqual([none.price, none.litres, none.amount], [null, 125.36, null])
    assert.equal(forecastSummary(none), "1567 km · 125,36 L · montant non calculé")
    const invalid = ok(forecast(s, reading(s), { consumptionInput: "abc" }))
    assert.deepEqual([invalid.consumption, invalid.litres, invalid.amount], [null, null, null])
  })
  it("coupures en un seul aller-retour : hypothèse « reste sur place » affichée", () => {
    const s = stay({ gaps: [{ from: "2026-11-07", to: "2026-11-07", days: 1 }], days: 3 })
    assert.match(ok(forecast(s, reading(s))).assumptions.join(" "), /reste sur place jusqu'à la fin du séjour, coupures du planning comprises/)
  })
  it("distance inconnue : raison claire ; lecture d'un autre séjour ou d'un autre contexte : rien n'est réutilisé", () => {
    const s = stay()
    assert.deepEqual(forecast(s, reading(s, { route: { status: "UNAVAILABLE", oneWayKm: null } })), { ok: false, reason: "Distance routière inconnue : prévision impossible. Saisissez le montant du ticket." })
    assert.deepEqual(forecast(s, reading(stay({ context: "v1-00000000000000bb" }))), { ok: false, reason: null })
    assert.deepEqual(forecast(stay({ estimable: false, blocked: "NO_HISTORY" }), reading(stay({ estimable: false, blocked: "NO_HISTORY" }))), { ok: false, reason: null })
  })
})

describe("prévision : réaffectation en journée", () => {
  const blocked = (handoverDays: string[]) => stay({ estimable: false, blocked: "HANDOVER", handoverDays })
  it("veille du départ et un seul aller-retour : prévision calculée, information « affectation à vérifier », aucune case", () => {
    const s = blocked(["2026-11-05"])
    const f = ok(forecast(s, reading(s)))
    assert.equal(f.travelKm, 1567)
    assert.match(f.notice!, /Affectation du camion à vérifier : réaffecté le 05\/11/)
  })
  it("veille du départ et retour quotidien : pas de prévision, le fait manquant est demandé", () => {
    const s = blocked(["2026-11-05"])
    const r = forecast(s, reading(s, { route: { status: "ROUTE", oneWayKm: 20 } }))
    assert.equal(r.ok, false)
    assert.match(r.ok ? "" : r.reason!, /Retour quotidien : le nombre d'allers-retours dépend du jour de réaffectation/)
  })
  it("réaffectation pendant le séjour : pas de prévision, même pour un seul aller-retour", () => {
    const s = blocked(["2026-11-07"])
    const r = forecast(s, reading(s))
    assert.equal(r.ok, false)
    assert.match(r.ok ? "" : r.reason!, /réaffecté pendant le séjour \(07\/11\)/)
  })
})

describe("prévision : provenance, préremplissage et requêtes", () => {
  it("provenance « hypothèses à vérifier », jamais une confirmation ni une déclaration ; pas de fournisseur proposé", () => {
    const s = blocked()
    const f = ok(forecast(s, reading(s), { extraKm: 600, consumptionInput: "9" }))
    const note = forecastNote(s, f)
    assert.match(note, /^Prévision carburant \(hypothèses à vérifier\) : chantier Chantier fictif/)
    assert.match(note, /1 aller-retour siège ↔ chantier de 2 × 783,5 km selon la règle d'organisation \(départ et retour au siège supposés\) \+ 600 km sur place = 2167 km × 9,0 L\/100 km/)
    for (const text of [note, ...f.assumptions, f.notice ?? ""]) assert.doesNotMatch(text, CONFIRM)
    const p = forecastProposal(s, f)!
    assert.deepEqual(p.values, { category: "FUEL", date: "2026-11-06", litres: "195,03", amount: "438,82" })
    function blocked() { return stay({ estimable: false, blocked: "HANDOVER", handoverDays: ["2026-11-05"] }) }
  })
  it("« Utiliser la prévision » est explicite : un champ saisi à la main n'est écrasé que par ce clic, une réponse ultérieure sans montant le retire", () => {
    const s = stay(), f = ok(forecast(s, reading(s))), p = forecastProposal(s, f)!
    const auto = reconcileEstimate({ state: emptyEstimateState(), proposal: p, current: { amount: "90,00" }, defaults: {}, touched: new Set(["amount"]), explicit: false, currency: "EUR" })
    assert.equal(auto.writes.amount, undefined)
    const clicked = reconcileEstimate({ state: emptyEstimateState(), proposal: p, current: { amount: "90,00" }, defaults: { amount: "", litres: "" }, touched: new Set(["amount"]), explicit: true, currency: "EUR" })
    assert.equal(clicked.writes.amount, "282,06")
    const later = reconcileEstimate({ state: clicked.state, proposal: { values: { category: "FUEL", date: "2026-11-06" }, provenance: null }, current: { ...clicked.writes, amount: "282,06" }, defaults: { amount: "", litres: "" }, touched: new Set(), explicit: false, currency: "EUR" })
    assert.deepEqual([later.writes.amount, later.writes.litres, later.state.provenance], ["", "", null])
  })
  it("requête de prévision : contexte du séjour, aucune décision ; décisions = calcul déclaré d'avant", () => {
    const s = stay()
    assert.deepEqual(Object.fromEntries(estimateQuery(`stay:${s.id}`, "GAZOLE", emptyDecisions("o"), s, { forecast: true })), { stayId: s.id, fuel: "GAZOLE", forecast: "1", context: s.context })
    assert.equal(estimateQuery("trip:t1", "GAZOLE", null, null, { forecast: true }).has("forecast"), false)
    assert.deepEqual([hasDecisions(emptyDecisions("o")), hasDecisions({ ...emptyDecisions("o"), depot: true }), hasDecisions({ ...emptyDecisions("o"), mode: "DAILY" })], [false, true, true])
  })
  it("départ à venir : information neutre « Prix d'aujourd'hui ; départ prévu le … », aucune pour un trajet passé", () => {
    const s = stay()
    assert.equal(departureInfo(reading(s), TODAY), "Prix d'aujourd'hui ; départ prévu le 06/11/2026.")
    assert.equal(departureInfo(reading(s, { tripDate: "2026-11-01" }), TODAY), null)
  })
})

describe("rendu de la prévision", () => {
  const render = (props: Parameters<typeof ForecastPanel>[0]) => renderToStaticMarkup(createElement(ForecastPanel, props))
  it("un résultat visible, hypothèses et information neutre ; aucun champ coché, bouton seulement s'il y a une proposition", () => {
    const s = stay(), result = forecast(s, reading(s))
    const html = render({ result, departure: departureInfo(reading(s), TODAY), onUse: () => {} })
    assert.match(html, /Prévision : 1567 km · 125,36 L · ≈ 282,06 €/)
    assert.match(html, /Prix d&#x27;aujourd&#x27;hui ; départ prévu le 06\/11\/2026\./)
    assert.match(html, /Utiliser la prévision/)
    assert.doesNotMatch(html, /<input|checked|Départ à venir/)
    assert.doesNotMatch(render({ result, departure: null, onUse: null }), /Utiliser la prévision/)
  })
  it("exception : seulement la raison, sans résultat chiffré", () => {
    const html = render({ result: { ok: false, reason: "Raison fictive." }, departure: null, onUse: null })
    assert.equal(html, '<p role="status" class="text-sm text-amber-800">Raison fictive.</p>')
  })
})

// ─── Ticket lu → dépense ─────────────────────────────────────────────────────

const truck = { matricule: "GA-123-LY", marque: "FICTIVE" }
const ticket = (body: string, lowConfidence = false) => extractVehicleDocumentFields({ category: "EXPENSE_RECEIPT", text: `STATION FICTIVE\nTOTALENERGIES\nLE 04/11/26 A 07:42\nTICKET N° 004521\n${body}\nKM 120 900`, truck, lowConfidence })

describe("ticket : valeurs structurées (lecture locale déjà qualifiée, texte synthétique)", () => {
  it("total TTC et litres lus, devise unique : bloc structuré ; observations d'avant inchangées", () => {
    const p = ticket("GAZOLE 52,31 L\nPRIX/L 1,689 EUR\nTOTAL TTC 88,35 EUR")
    assert.deepEqual(p.expense, {
      currency: { value: "EUR", status: "READ" }, fuel: true, amount: { value: "88,35", confidence: "READ", ttc: true }, litres: { value: "52,31", confidence: "READ" },
      date: { value: "2026-11-04", confidence: "READ" }, supplier: { value: "TOTALENERGIES", confidence: "READ" }, reference: { value: "004521", confidence: "READ" }, mileage: { value: 120900, confidence: "TO_CHECK" },
    })
    assert.deepEqual(p.observations, ["Montant TTC lu : 88,35 €", "Volume lu : 52,31 L"])
    const v = ticketExpenseValues(p.expense!)
    assert.deepEqual(v.values, { amount: "88,35", currency: "EUR", litres: "52,31", category: "FUEL", date: "2026-11-04", supplier: "TOTALENERGIES", reference: "004521", mileage: "120900" })
    assert.deepEqual(v.warnings, [])
  })
  it("total sans mention TTC : repris « à vérifier » avec un avertissement ; HT et TVA seuls : aucun montant", () => {
    const weak = ticketExpenseValues(ticket("GAZOLE 52,31 L\nMONTANT 88,35 EUR").expense!)
    assert.deepEqual([weak.values.amount, weak.confidence.amount, weak.warnings], ["88,35", "TO_CHECK", ["Le ticket ne précise pas que le montant est TTC : vérifiez-le."]])
    const ht = ticket("TOTAL HT 73,63 EUR\nTVA 14,72 EUR")
    assert.equal(ht.expense!.amount, undefined)
    assert.equal(ticketExpenseValues(ht.expense!).values.amount, undefined)
  })
  it("devise absente ou contradictoire : montant non repris, signalé, jamais supposé EUR", () => {
    const unknown = ticket("GAZOLE 52,31 L\nTOTAL TTC 88,35")
    assert.deepEqual(unknown.expense!.currency, { value: null, status: "UNKNOWN" })
    const u = ticketExpenseValues(unknown.expense!)
    assert.deepEqual([u.values.amount, u.values.currency, u.values.litres], [undefined, undefined, "52,31"])
    assert.match(u.warnings[0], /Devise absente du ticket : montant non repris, 88,35/)
    const conflict = ticketExpenseValues(ticket("TOTAL TTC 88,35 EUR\nSOIT 95,10 CHF").expense!)
    assert.deepEqual([conflict.values.amount, conflict.values.currency], [undefined, undefined])
    assert.match(conflict.warnings[0], /Plusieurs devises/)
  })
  it("lecture peu sûre : tout passe « à vérifier » ; autre rubrique : aucun bloc dépense", () => {
    const low = ticket("GAZOLE 52,31 L\nTOTAL TTC 88,35 EUR", true).expense!
    assert.ok([low.amount, low.litres, low.date, low.supplier, low.reference, low.mileage].every((f) => f?.confidence === "TO_CHECK"))
    assert.equal(extractVehicleDocumentFields({ category: "REPAIR_MAINTENANCE", text: "GARAGE FICTIF\nTOTAL TTC 180,00 EUR", truck }).expense, undefined)
  })
  it("corrections de l'opérateur dans la pièce : sa valeur enregistrée remplace la lecture, un champ vidé n'est pas repris", () => {
    const v = ticketExpenseValues(ticket("GAZOLE 52,31 L\nTOTAL TTC 88,35 EUR").expense!)
    const fixed = withDocumentCorrections(v, { issuedOn: "2026-11-03", issuerName: null, referenceNumber: "004521", mileage: 120900 }, new Set(["issuedOn", "issuerName"]))
    assert.deepEqual([fixed.values.date, fixed.confidence.date, fixed.values.supplier, fixed.confidence.supplier, fixed.values.reference, fixed.confidence.reference], ["2026-11-03", undefined, undefined, undefined, "004521", "READ"])
    assert.equal(v.values.date, "2026-11-04")
  })
})

class MemoryStorage implements DraftStorage {
  map = new Map<string, string>()
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}

describe("brouillon éphémère ticket → dépense", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e", NOW = 1_800_000_000_000
  const values = ticketExpenseValues(ticket("GAZOLE 52,31 L\nTOTAL TTC 88,35 EUR").expense!)
  const save = (storage: MemoryStorage, over: Partial<{ companyId: string; truckId: string }> = {}) =>
    saveTicketDraft(storage, { id: ID, companyId: "co-g", truckId: "truck-g", documentId: "doc-1", versionId: "ver-2", ...values, ...over }, NOW)
  it("lecture unique dans la durée, rattachée à la société, au camion et à la version exacte ; aucun texte lu stocké", () => {
    const storage = new MemoryStorage()
    assert.equal(save(storage), ID)
    const stored = [...storage.map.values()].join("")
    assert.doesNotMatch(stored, /STATION FICTIVE|Volume lu|Montant TTC lu|observations/)
    const taken = takeTicketDraft(storage, { id: ID, companyId: "co-g", truckId: "truck-g", now: NOW + 60_000 })
    assert.ok(taken.ok && taken.draft.versionId === "ver-2" && taken.draft.values.amount === "88,35")
    assert.deepEqual(takeTicketDraft(storage, { id: ID, companyId: "co-g", truckId: "truck-g", now: NOW + 60_000 }), { ok: false, reason: "MISSING" })
    assert.equal(storage.length, 0)
  })
  it("périmé, autre camion, autre société, identifiant invalide : refus, et le brouillon est consommé quand même", () => {
    for (const [input, reason] of [
      [{ now: NOW + TICKET_DRAFT_TTL_MS + 1 }, "EXPIRED"], [{ now: NOW - 1 }, "EXPIRED"], [{ truckId: "truck-other" }, "SCOPE"], [{ companyId: "co-other" }, "SCOPE"],
    ] as const) {
      const storage = new MemoryStorage(); save(storage)
      assert.deepEqual(takeTicketDraft(storage, Object.assign({ id: ID, companyId: "co-g", truckId: "truck-g", now: NOW + 1000 }, input)), { ok: false, reason })
      assert.equal(storage.length, 0)
    }
    assert.deepEqual(takeTicketDraft(new MemoryStorage(), { id: "../autre", companyId: "co-g", truckId: "truck-g", now: NOW }), { ok: false, reason: "MISSING" })
  })
  it("brouillons périmés purgés à l'enregistrement suivant ; contenu illisible supprimé", () => {
    const storage = new MemoryStorage(); save(storage)
    storage.setItem("planificator:expense-ticket-draft:illisible", "{")
    purgeTicketDrafts(storage, NOW + TICKET_DRAFT_TTL_MS + 1)
    assert.equal(storage.length, 0)
  })
  it("justificatif : seulement la version courante d'un dossier non archivé de la liste autorisée", () => {
    const docs = [{ id: "doc-1", archivedAt: null, currentVersion: { id: "ver-2" } }, { id: "doc-9", archivedAt: "2026-11-01T00:00:00Z", currentVersion: { id: "ver-9" } }]
    assert.equal(draftDocumentAllowed({ documentId: "doc-1", versionId: "ver-2" }, docs), true)
    assert.equal(draftDocumentAllowed({ documentId: "doc-1", versionId: "ver-1" }, docs), false)
    assert.equal(draftDocumentAllowed({ documentId: "doc-9", versionId: "ver-9" }, docs), false)
    assert.equal(draftDocumentAllowed({ documentId: "doc-x", versionId: "ver-2" }, docs), false)
  })
})

// ─── Revue Codex v1 : corrections ────────────────────────────────────────────

const raw = (text: string) => extractVehicleDocumentFields({ category: "EXPENSE_RECEIPT", text, truck })

describe("v2 — point 1 : devise (le $ seul n'est pas l'USD) et observations cohérentes", () => {
  it("« $ » seul : ambigu, montant non repris, observation « devise à vérifier » (jamais « € »)", () => {
    const p = raw("STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 $")
    assert.deepEqual(p.expense!.currency, { value: null, status: "AMBIGUOUS" })
    const v = ticketExpenseValues(p.expense!)
    assert.deepEqual([v.values.amount, v.values.currency], [undefined, undefined])
    assert.match(v.warnings[0], /Symbole \$ sans pays/)
    assert.equal(p.observations[0], "Montant TTC lu : 100,00 (devise à vérifier)")
  })
  it("USD, US$, CAD, C$, AUD explicites : devise lue, observation dans cette devise ; « $ » avec un seul dollar qualifié : cohérent", () => {
    for (const [mark, code] of [["USD", "USD"], ["US$", "USD"], ["CAD", "CAD"], ["C$", "CAD"], ["AUD", "AUD"], ["A$", "AUD"]] as const) {
      const p = raw(`STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 ${mark}`)
      assert.deepEqual(p.expense!.currency, { value: code, status: "READ" }, mark)
      assert.equal(p.observations[0], `Montant TTC lu : 100,00 ${code}`, mark)
    }
    assert.deepEqual(raw("TOTAL TTC 100,00 $\nMONTANT EN USD").expense!.currency, { value: "USD", status: "READ" })
  })
  it("euro lu : observation inchangée « € » ; « $ » avec l'euro ou deux dollars : conflit, rien de supposé", () => {
    assert.equal(raw("GAZOLE 40,00 L\nTOTAL TTC 100,00 EUR").observations[0], "Montant TTC lu : 100,00 €")
    assert.deepEqual(raw("TOTAL TTC 100,00 EUR\nSOIT 110,00 $").expense!.currency, { value: null, status: "CONFLICT" })
    assert.deepEqual(raw("TOTAL TTC 100,00 USD\nSOIT 130,00 CAD").expense!.currency, { value: null, status: "CONFLICT" })
  })
})

describe("v2 — point 2 : « TOTAL TTC » n'est pas l'enseigne TOTAL", () => {
  it("sans enseigne : aucun fournisseur « TOTAL » lu ; enseigne réelle en tête : lue", () => {
    const p = raw("STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 EUR")
    assert.notEqual(p.expense!.supplier?.value, "TOTAL")
    assert.equal(p.expense!.supplier?.confidence === "READ" && p.expense!.supplier.value === "TOTAL", false)
    for (const [header, brand] of [["TOTALENERGIES", "TOTALENERGIES"], ["TOTAL ACCESS", "TOTAL ACCESS"], ["TOTAL", "TOTAL"]] as const)
      assert.deepEqual(raw(`${header}\nSTATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 EUR`).expense!.supplier, { value: brand, confidence: "READ" }, header)
    assert.notEqual(raw("SOUS-TOTAL 80,00 EUR\nTOTAL 100,00 EUR\nMERCI").expense!.supplier?.value, "TOTAL")
  })
})

describe("v2 — point 3 : Carburant et litres seulement avec un carburant nommé", () => {
  it("facture non carburant (eau 4,50 L, quantité sans unité) : catégorie « Autres » à vérifier, aucun litre", () => {
    for (const text of ["SUPERETTE FICTIVE\nEAU 4,50 L\nTOTAL TTC 10,00 EUR", "SUPERETTE FICTIVE\nQUANTITE 4,50\nTOTAL TTC 10,00 EUR", "TOTALENERGIES\nLAVAGE\nTOTAL TTC 10,00 EUR"]) {
      const e = raw(text).expense!
      assert.deepEqual([e.fuel, e.litres], [false, undefined], text)
      const v = ticketExpenseValues(e)
      assert.deepEqual([v.values.category, v.confidence.category, v.values.litres], ["OTHER", "TO_CHECK", undefined], text)
    }
  })
  it("ticket gazole : quantité explicite en litres reprise ; quantité sans unité : Carburant sans litres inventés", () => {
    const withUnit = ticketExpenseValues(raw("STATION FICTIVE\nGAZOLE\nQUANTITE 40,00 L\nTOTAL TTC 100,00 EUR").expense!)
    assert.deepEqual([withUnit.values.category, withUnit.values.litres], ["FUEL", "40,00"])
    const noUnit = ticketExpenseValues(raw("STATION FICTIVE\nGAZOLE\nQUANTITE 40,00\nTOTAL TTC 100,00 EUR").expense!)
    assert.deepEqual([noUnit.values.category, noUnit.confidence.category, noUnit.values.litres], ["FUEL", "TO_CHECK", undefined])
    const water = raw("STATION FICTIVE\nGAZOLE 40,00 L\nEAU 1,50 L\nTOTAL TTC 101,50 EUR").expense!
    assert.equal(water.litres?.value, "40,00")
  })
})

/** Double de formulaire : contrôles nommés avec une valeur (comme le DOM). */
const fakeForm = (initial: Record<string, string>) => {
  const controls = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, { value: v }]))
  return { controls, form: { elements: { namedItem: (name: string) => controls[name] ?? null } } satisfies TicketForm }
}
const FORM = { category: "FUEL", date: "2026-11-05", amount: "", currency: "EUR", litres: "", mileage: "", supplier: "", reference: "", documentVersionId: "" }

describe("v2 — points 4 et 5 : saisies pendant le chargement et changement de justificatif", () => {
  const draft = { versionId: "ver-A", values: { amount: "88,35", currency: "EUR", litres: "52,31", category: "FUEL", date: "2026-11-04", supplier: "TOTALENERGIES" } as const }
  it("montant et date saisis pendant le chargement des justificatifs : conservés, le reste est rempli et lié à A", () => {
    const { controls, form } = fakeForm({ ...FORM, amount: "90,00", date: "2026-11-03" })
    const r = applyTicketDraft(form, draft, new Set(["amount", "date"]))
    assert.ok(r.applied)
    // v3 : montant saisi = devise jamais réécrite sous lui (couple montant/devise), même identique.
    assert.deepEqual([r.written.sort(), r.kept.sort()], [["category", "litres", "supplier"], ["amount", "date"]])
    assert.deepEqual([controls.amount.value, controls.date.value, controls.litres.value, controls.documentVersionId.value], ["90,00", "2026-11-03", "52,31", "ver-A"])
  })
  it("justificatif B choisi à la main avant l'arrivée du ticket A : rien n'est repris, le choix B est gardé ; A choisi à la main : repris", () => {
    const b = fakeForm({ ...FORM, documentVersionId: "ver-B" })
    assert.deepEqual(applyTicketDraft(b.form, draft, new Set(["documentVersionId"])), { applied: false })
    assert.deepEqual([b.controls.documentVersionId.value, b.controls.amount.value], ["ver-B", ""])
    const a = fakeForm({ ...FORM, documentVersionId: "ver-A" })
    assert.equal(applyTicketDraft(a.form, draft, new Set(["documentVersionId"])).applied, true)
  })
  it("passage à B ou « Aucun » : seuls les champs encore intacts du ticket A sont retirés, la correction manuelle reste", () => {
    const { controls, form } = fakeForm(FORM)
    const r = applyTicketDraft(form, draft, new Set())
    assert.ok(r.applied)
    controls.litres.value = "50,00" // correction de l'opérateur
    controls.documentVersionId.value = ""
    const owned = r.written.filter((n) => n !== "litres")
    const removed = withdrawTicketFields(form, owned, draft.values, { category: "FUEL", date: "2026-11-05", currency: "EUR" })
    assert.deepEqual(removed.sort(), ["amount", "category", "currency", "date", "supplier"])
    assert.deepEqual([controls.amount.value, controls.supplier.value, controls.date.value, controls.litres.value], ["", "", "2026-11-05", "50,00"])
  })
})

describe("v2 — point 6 : brouillon relu validé champ par champ", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e", NOW = 1_800_000_000_000
  const good = { v: 1, id: ID, companyId: "co-g", truckId: "truck-g", documentId: "doc-1", versionId: "ver-2", createdAt: NOW, values: { amount: "88,35", currency: "EUR", date: "2026-11-04" }, confidence: { amount: "READ" }, warnings: [] }
  it("structure valide acceptée telle quelle", () => {
    assert.deepEqual(parseTicketDraft(JSON.stringify(good), ID), good)
  })
  it("structures mal formées refusées (INVALID) et brouillon consommé, sans exception", () => {
    const bad: unknown[] = [
      { ...good, values: null }, { ...good, confidence: "READ" }, { ...good, warnings: "x" }, { ...good, values: { notes: "texte" } },
      { ...good, values: { amount: "1e5" } }, { ...good, values: { date: "2026-02-30" } }, { ...good, values: { category: "CARBURANT" } },
      { ...good, values: { supplier: "a\u0000b" } }, { ...good, confidence: { litres: "READ" } }, { ...good, confidence: { amount: "SURE" } },
      { ...good, versionId: "../x" }, { ...good, documentId: 42 }, { ...good, createdAt: "hier" }, { ...good, warnings: [1] }, { ...good, warnings: Array(6).fill("w") },
      [], "texte", null,
    ]
    for (const value of bad) {
      const storage = new MemoryStorage()
      storage.setItem(`planificator:expense-ticket-draft:${ID}`, JSON.stringify(value))
      assert.deepEqual(takeTicketDraft(storage, { id: ID, companyId: "co-g", truckId: "truck-g", now: NOW }), { ok: false, reason: "INVALID" }, JSON.stringify(value))
      assert.equal(storage.length, 0)
    }
    const big = new MemoryStorage()
    big.setItem(`planificator:expense-ticket-draft:${ID}`, JSON.stringify({ ...good, warnings: ["w".repeat(TICKET_DRAFT_MAX_BYTES)] }))
    assert.deepEqual(takeTicketDraft(big, { id: ID, companyId: "co-g", truckId: "truck-g", now: NOW }), { ok: false, reason: "INVALID" })
  })
})

describe("v2 — point 7 : messages vrais sur une lecture éphémère perdue", () => {
  it("aucun message ne promet une relecture depuis Documents ; l'action proposée est la saisie avec le justificatif de la liste", () => {
    for (const reason of ["MISSING", "EXPIRED", "SCOPE", "INVALID", "DOCUMENT"] as const) {
      const text = ticketDraftError(reason)
      assert.doesNotMatch(text, /Rouvrez|relire|relancez/i, reason)
      assert.match(text, /rien n'a été prérempli\. Saisissez la dépense à partir du ticket et choisissez son justificatif dans la liste\.$/, reason)
    }
    assert.match(ticketDraftError("LINK_CHOSEN"), /votre choix est conservé/)
  })
})

// ─── Revue Codex v2 : corrections ────────────────────────────────────────────

describe("v3 — point 1 : avoir, remboursement, total ou volume négatif", () => {
  it("total et volume négatifs, ou avoir au total positif : ni montant ni litres repris, avertissement explicite", () => {
    for (const text of ["STATION FICTIVE\nGAZOLE\nTOTAL TTC -100,00 EUR\nVOLUME -40,00 L", "STATION FICTIVE\nAVOIR REMBOURSEMENT\nGAZOLE\nTOTAL TTC 100,00 EUR\nVOLUME 40,00 L",
      "STATION FICTIVE\nFACTURE D'AVOIR N° 12\nGAZOLE 40,00 L\nTOTAL TTC 100,00 EUR", "STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC − 100,00 EUR"]) {
      const p = raw(text), v = ticketExpenseValues(p.expense!)
      assert.deepEqual([p.expense!.refund, p.expense!.amount, p.expense!.litres, v.values.amount, v.values.litres], [true, undefined, undefined, undefined, undefined], text)
      assert.match(v.warnings[0], /Avoir ou remboursement : ce n'est pas une dépense/, text)
      assert.match(p.observations[0], /^Avoir ou remboursement, à traiter séparément : montant lu 100,00 €$/, text)
      assert.equal(v.values.category, "FUEL", "les autres valeurs ne sont pas perdues sans raison")
    }
  })
  it("pas de faux positif : mention « pas de remboursement », « non remboursable », remise négative dans un panier au total positif", () => {
    for (const text of ["STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 EUR\nPAS DE REMBOURSEMENT", "STATION FICTIVE\nGAZOLE 40,00 L\nTOTAL TTC 100,00 EUR\nARTICLE NON REMBOURSABLE",
      "STATION FICTIVE\nGAZOLE 40,00 L\nREMISE FIDELITE -5,00 EUR\nTOTAL TTC 95,00 EUR"]) {
      const v = ticketExpenseValues(raw(text).expense!)
      assert.equal(raw(text).expense!.refund, undefined, text)
      assert.ok(v.values.amount && v.values.litres === "40,00", text)
    }
  })
})

describe("v4 — signe du total lu comme le montant (collé, ligne suivante, Unicode)", () => {
  it("« TOTAL TTC-100,00 », « TOTAL TTC » puis « -100,00 », « TOTAL TTC−100,00 » : avoir, ni montant ni litres, observation explicite", () => {
    for (const total of ["TOTAL TTC-100,00 EUR", "TOTAL TTC\n-100,00 EUR", "TOTAL TTC−100,00 EUR", "NET A PAYER\n− 100,00 EUR"]) {
      const p = raw(`STATION FICTIVE\nGAZOLE\n${total}\nVOLUME 40,00 L`), v = ticketExpenseValues(p.expense!)
      assert.deepEqual([p.expense!.refund, p.expense!.amount, p.expense!.litres, v.values.amount, v.values.litres], [true, undefined, undefined, undefined, undefined], total)
      assert.match(p.observations[0], /^Avoir ou remboursement, à traiter séparément : montant lu 100,00 €$/, total)
    }
  })
  it("pas de faux positif : total positif avec remise −5 sur un article, total TTC après un HT, total sur la ligne suivante positif", () => {
    for (const [text, amount] of [["GAZOLE 40,00 L\nREMISE ARTICLE −5,00 EUR\nTOTAL TTC 95,00 EUR", "95,00"], ["GAZOLE 40,00 L\nTOTAL HT 80,00 EUR\nTOTAL TTC 96,00 EUR", "96,00"], ["GAZOLE 40,00 L\nTOTAL TTC\n100,00 EUR", "100,00"], ["GAZOLE 40,00 L\nTOTAL TTC 100,00 EUR\nRENDU -0,00 EUR", "100,00"]] as const) {
      const e = raw(`STATION FICTIVE\n${text}`).expense!
      assert.deepEqual([e.refund, e.amount?.value, e.litres?.value], [undefined, amount, "40,00"], text)
    }
  })
})

describe("v3 — point 2 : montant et devise protégés ensemble, aucune conversion", () => {
  const draft = { versionId: "ver-A", values: { amount: "90,00", currency: "USD", litres: "40,00", category: "FUEL" } as const }
  it("devise GBP choisie à la main pendant le chargement, ticket 90 USD : montant non repris (jamais 90 GBP), avertissement, le reste repris", () => {
    const { controls, form } = fakeForm({ ...FORM, currency: "GBP" })
    const r = applyTicketDraft(form, draft, new Set(["currency"]))
    assert.ok(r.applied)
    assert.deepEqual([controls.amount.value, controls.currency.value, controls.litres.value], ["", "GBP", "40,00"])
    assert.match(r.warnings[0], /Montant lu sur le ticket \(90,00 USD\) non repris : la devise saisie \(GBP\) est différente et aucune conversion n'est faite/)
    assert.ok(!r.written.includes("amount") && !r.written.includes("currency"))
  })
  it("devise saisie identique à celle du ticket : montant repris ; montant saisi : devise jamais changée sous lui", () => {
    const same = fakeForm({ ...FORM, currency: "USD" })
    const r1 = applyTicketDraft(same.form, draft, new Set(["currency"]))
    assert.ok(r1.applied && r1.written.includes("amount") && r1.warnings.length === 0)
    assert.equal(same.controls.amount.value, "90,00")
    const typed = fakeForm({ ...FORM, amount: "91,00", currency: "EUR" })
    const r2 = applyTicketDraft(typed.form, draft, new Set(["amount"]))
    assert.ok(r2.applied)
    assert.deepEqual([typed.controls.amount.value, typed.controls.currency.value], ["91,00", "EUR"])
    assert.match(r2.warnings[0], /90,00 USD\) non repris/)
  })
  it("rien de saisi : le couple est repris ensemble", () => {
    const { controls, form } = fakeForm(FORM)
    const r = applyTicketDraft(form, draft, new Set())
    assert.ok(r.applied)
    assert.deepEqual([controls.amount.value, controls.currency.value], ["90,00", "USD"])
  })
  it("retrait du ticket : montant 91 saisi à la main avec la devise USD du ticket, la devise reste USD (jamais 91 EUR)", () => {
    const { controls, form } = fakeForm(FORM)
    const r = applyTicketDraft(form, draft, new Set())
    assert.ok(r.applied)
    controls.amount.value = "91,00" // correction manuelle : le montant n'appartient plus au ticket
    const owned = r.written.filter((n) => n !== "amount")
    const removed = withdrawTicketFields(form, owned, draft.values, { category: "FUEL", date: "2026-11-05", currency: "EUR" })
    assert.deepEqual([controls.amount.value, controls.currency.value, controls.litres.value], ["91,00", "USD", ""])
    assert.ok(!removed.includes("currency"))
    // Montant encore intact du ticket : retiré avec sa devise.
    const both = fakeForm(FORM); const r2 = applyTicketDraft(both.form, draft, new Set()); assert.ok(r2.applied)
    withdrawTicketFields(both.form, r2.written, draft.values, { currency: "EUR" })
    assert.deepEqual([both.controls.amount.value, both.controls.currency.value], ["", "EUR"])
  })
})

describe("v3 — point 3 : brouillon hostile refusé sans exception", () => {
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e", NOW = 1_800_000_000_000
  const base = { v: 1, id: ID, companyId: "co-g", truckId: "truck-g", documentId: "doc-1", versionId: "ver-2", createdAt: NOW, warnings: [] as string[] }
  it("dates impossibles, clés héritées (__proto__, constructor, toString) dans values ou confidence, montant sans devise : INVALID", () => {
    const texts = [
      JSON.stringify({ ...base, values: { date: "2026-99-99" }, confidence: {} }),
      JSON.stringify({ ...base, values: { date: "2026-13-01" }, confidence: {} }),
      `{"v":1,"id":"${ID}","companyId":"co-g","truckId":"truck-g","documentId":"doc-1","versionId":"ver-2","createdAt":${NOW},"warnings":[],"values":{"__proto__":"x"},"confidence":{}}`,
      `{"v":1,"id":"${ID}","companyId":"co-g","truckId":"truck-g","documentId":"doc-1","versionId":"ver-2","createdAt":${NOW},"warnings":[],"values":{"date":"2026-11-04"},"confidence":{"__proto__":"READ"}}`,
      JSON.stringify({ ...base, values: { constructor: "x" }, confidence: {} }),
      JSON.stringify({ ...base, values: { toString: "x" }, confidence: {} }),
      JSON.stringify({ ...base, values: { date: "2026-11-04" }, confidence: { constructor: "READ" } }),
      JSON.stringify({ ...base, values: { amount: "90,00" }, confidence: {} }),
    ]
    for (const text of texts) {
      assert.doesNotThrow(() => parseTicketDraft(text, ID), text)
      assert.equal(parseTicketDraft(text, ID), null, text)
      const storage = new MemoryStorage()
      storage.setItem(`planificator:expense-ticket-draft:${ID}`, text)
      assert.deepEqual(takeTicketDraft(storage, { id: ID, companyId: "co-g", truckId: "truck-g", now: NOW }), { ok: false, reason: "INVALID" }, text)
      assert.equal(storage.length, 0)
    }
  })
})

describe("v3 — points 4 et 5 : réaffectation en bordure et hypothèses de mode ou de coupure", () => {
  const edge = (over: Partial<PlannedStay> = {}) => stay({ estimable: false, blocked: "HANDOVER", handoverDays: ["2026-11-05"], ...over })
  it("libellé du séjour en bordure : « affectation à vérifier » (plus « à confirmer »)", () => {
    assert.match(stayLabel(edge()), /— affectation à vérifier$/)
  })
  it("chantier proche, mode « séjour sur place » choisi en hypothèse : un seul aller-retour, provenance « choisi en hypothèse »", () => {
    const s = stay({ days: 3 })
    const f = ok(forecast(s, reading(s, { route: { status: "ROUTE", oneWayKm: 20 } }), {}))
    assert.equal(f.roundTrips, 3)
    const chosen = ok(stayForecast({ stay: s, estimate: reading(s, { route: { status: "ROUTE", oneWayKm: 20 } }), consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, modeOverride: "ONE_ROUND_TRIP" }))
    assert.deepEqual([chosen.mode, chosen.modeSource, chosen.roundTrips, chosen.travelKm], ["ONE_ROUND_TRIP", "CHOSEN", 1, 40])
    const note = forecastNote(s, chosen)
    assert.match(note, /mode séjour sur place choisi en hypothèse/)
    assert.doesNotMatch(note, /selon la règle d'organisation|confirm|déclar/i)
    assert.match(chosen.assumptions[0], /mode choisi dans vos hypothèses : séjour sur place/)
  })
  it("chantier lointain, retour quotidien choisi : un aller-retour par jour planifié ; coupure « retour au siège » : un aller-retour de plus", () => {
    const s = stay({ gaps: [{ from: "2026-11-07", to: "2026-11-07", days: 1 }], days: 3, runs: [{ from: "2026-11-06", to: "2026-11-06", days: 1 }, { from: "2026-11-08", to: "2026-11-09", days: 2 }] })
    const e = reading(s)
    const daily = ok(stayForecast({ stay: s, estimate: e, consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, modeOverride: "DAILY" }))
    assert.deepEqual([daily.roundTrips, daily.travelKm], [3, 4701])
    const back = ok(stayForecast({ stay: s, estimate: e, consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, gapChoices: { "2026-11-07..2026-11-07": "RETURN", "2026-12-01..2026-12-02": "RETURN" } }))
    assert.deepEqual([back.mode, back.modeSource, back.roundTrips, back.travelKm, back.returnGaps], ["ONE_ROUND_TRIP", "RULE", 2, 3134, ["07/11"]])
    assert.match(back.assumptions[1], /Retour au siège pendant la coupure du 07\/11 \(votre hypothèse\) : 2 allers-retours au total/)
    assert.match(forecastNote(s, back), /retour au siège supposé pendant la coupure du 07\/11/)
  })
  it("les vrais blocages demeurent : bordure + retour quotidien choisi, réaffectation pendant le séjour", () => {
    const s = edge()
    assert.equal(ok(stayForecast({ stay: s, estimate: reading(s, { route: { status: "ROUTE", oneWayKm: 20 } }), consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, modeOverride: "ONE_ROUND_TRIP" })).roundTrips, 1)
    const daily = stayForecast({ stay: s, estimate: reading(s), consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, modeOverride: "DAILY" })
    assert.equal(daily.ok, false)
    const during = edge({ handoverDays: ["2026-11-07"] })
    assert.equal(stayForecast({ stay: during, estimate: reading(during), consumptionInput: "", extraKm: 0, priceKey: "", priceChosen: false, today: TODAY, modeOverride: "ONE_ROUND_TRIP" }).ok, false)
  })
  it("requête de prévision inchangée par les hypothèses : ni mode ni coupure envoyés avec forecast=1", () => {
    const s = stay()
    const q = estimateQuery(`stay:${s.id}`, "GAZOLE", { ...emptyDecisions("o"), mode: "DAILY", gaps: { "2026-11-07..2026-11-07": "RETURN" } }, s, { forecast: true })
    assert.deepEqual(Object.fromEntries(q), { stayId: s.id, fuel: "GAZOLE", forecast: "1", context: s.context })
  })
})
