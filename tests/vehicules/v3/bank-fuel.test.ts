import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { bankLineIdempotencyKey, cardDigits, cityOf, classifyCardSpend, isFuelLine, learnCardTrucks, resolveFuelLines } from "@/lib/vehicules/v3/bank-fuel-domain"
import { bankFuelExpenseCommand, splitForTruck } from "@/lib/vehicules/v3/bank-fuel-service"
import { parseExpenseCommand } from "@/lib/vehicules/v3/expense-domain"

const line = (id: string, day: string, label: string, euros: number) => ({ id, day, label, amountCents: -Math.round(euros * 100) })
const tour = (truckId: string, startDay: string, endDay: string, stopAddresses: string[] = []) => ({ truckId, startDay, endDay, stopAddresses })

describe("lecture du libellé bancaire", () => {
  it("reconnaît les pleins, jamais un virement ni un crédit", () => {
    assert.equal(isFuelLine("CARTE X1234 15/11 TOTALENERGIES CARCASSONNE", -9550), true)
    assert.equal(isFuelLine("CB*5678 ESSO EXPRESS ORLEANS", -8000), true)
    assert.equal(isFuelLine("CARTE X1234 AS 24 NARBONNE", -12000), true)
    assert.equal(isFuelLine("VIR SEPA TOTAL REGLEMENT FACTURE", -9550), false)
    assert.equal(isFuelLine("CARTE X1234 TOTALENERGIES", 9550), false)
    assert.equal(isFuelLine("CARTE X1234 LEROY MERLIN", -9550), false)
  })
  it("classe péages, hôtels, repas", () => {
    assert.equal(classifyCardSpend("CARTE X1234 VINCI AUTOROUTES", -2310), "TOLL")
    assert.equal(classifyCardSpend("CARTE X1234 PEAGE SANEF", -1200), "TOLL")
    assert.equal(classifyCardSpend("CARTE X1234 HOTEL IBIS BUDGET", -6500), "HOTEL")
    assert.equal(classifyCardSpend("CARTE X1234 RESTAURANT LE RELAIS", -4500), "MEAL")
    assert.equal(classifyCardSpend("CARTE X1234 BRICO DEPOT", -4500), null)
    assert.equal(classifyCardSpend("PRLV SEPA HOTEL DES IMPOTS", -4500), null)
  })
  it("extrait les 4 derniers chiffres de la carte, jamais une date", () => {
    assert.equal(cardDigits("CARTE X1234 15/11 TOTAL"), "1234")
    assert.equal(cardDigits("CB*5678 ESSO"), "5678")
    assert.equal(cardDigits("PAIEMENT CB 1511 TOTAL CARCASSONNE"), null)
  })
  it("commune d'une adresse", () => {
    assert.equal(cityOf("Rue du Boulodrome, 11170 Alzonne"), "ALZONNE")
    assert.equal(cityOf("2 av. de la Gare 09700 Saverdun Cedex"), "SAVERDUN")
    assert.equal(cityOf("Place de la Mairie"), null)
  })
})

describe("carte → camion appris sans configuration", () => {
  it("par le ticket enregistré et par le jour où un seul camion roule", () => {
    const cards = learnCardTrucks(
      [line("b1", "2026-11-20", "CARTE X1111 TOTAL", 90), line("b2", "2026-11-21", "CARTE X2222 ESSO", 80), line("b3", "2026-11-23", "CARTE X2222 ESSO", 70), line("b4", "2026-11-21", "CARTE X4444 ESSO", 50)],
      [tour("hassen", "2026-11-21", "2026-11-23")],
      [{ truckId: "bilel", day: "2026-11-20", amountCents: 9000, reference: null }],
    )
    assert.equal(cards.get("1111"), "bilel", "un ticket suffit")
    assert.equal(cards.get("2222"), "hassen", "deux jours où seul ce camion roulait")
    assert.equal(cards.has("4444"), false, "un seul indice faible ne suffit pas")
  })
  it("vote majoritaire ; égalité = carte inconnue", () => {
    const cards = learnCardTrucks(
      [line("b1", "2026-11-01", "CARTE X3333 TOTAL", 10), line("b2", "2026-11-02", "CARTE X3333 TOTAL", 11)],
      [tour("a", "2026-11-01", "2026-11-01"), tour("b", "2026-11-02", "2026-11-02")],
      [],
    )
    assert.equal(cards.has("3333"), false)
  })
})

describe("rattachement d'un plein avec plusieurs départs le même jour", () => {
  const tours = [
    tour("hassen", "2026-11-20", "2026-11-27", ["Rue du Boulodrome, 11170 Alzonne"]),
    tour("bilel", "2026-11-20", "2026-12-04", ["Zone industrielle, 09700 Saverdun"]),
  ]
  it("carte reconnue : certain, même avec deux camions en route", () => {
    const [r] = resolveFuelLines({
      lines: [line("b9", "2026-11-22", "CARTE X1111 TOTAL CASTELNAUDARY", 95)],
      tours,
      expenses: [{ truckId: "bilel", day: "2026-11-02", amountCents: 7000, reference: "BANQUE:old" }, { truckId: "x", day: "2026-11-02", amountCents: 1, reference: null }],
    }).concat()
    // Carte inconnue ici (aucun historique) : la ville ne correspond à aucune étape → à confirmer.
    assert.equal(r.resolution.kind, "UNRESOLVED")
    const withHistory = resolveFuelLines({
      lines: [line("old", "2026-11-02", "CARTE X1111 TOTAL", 70), line("b9", "2026-11-22", "CARTE X1111 TOTAL CASTELNAUDARY", 95)],
      tours,
      expenses: [{ truckId: "bilel", day: "2026-11-02", amountCents: 7000, reference: "BANQUE:old" }],
    })
    assert.deepEqual(withHistory[1].resolution, { kind: "CARD", truckId: "bilel", card: "1111" })
  })
  it("ville de la station dans le libellé", () => {
    const [r] = resolveFuelLines({ lines: [line("b1", "2026-11-22", "CB*9999 ESSO SAVERDUN", 60)], tours, expenses: [] })
    assert.deepEqual(r.resolution, { kind: "TOWN", truckId: "bilel", town: "SAVERDUN" })
  })
  it("un seul camion en tournée", () => {
    const [r] = resolveFuelLines({ lines: [line("b1", "2026-12-01", "CB*9999 ESSO PARIS", 60)], tours, expenses: [] })
    assert.deepEqual(r.resolution, { kind: "ONLY_TOUR", truckId: "bilel" })
  })
  it("déjà enregistré (ticket du chauffeur) : pas de doublon", () => {
    const [r] = resolveFuelLines({ lines: [line("b1", "2026-11-22", "CB*9999 TOTAL", 60)], tours, expenses: [{ truckId: "hassen", day: "2026-11-21", amountCents: 6000, reference: null }] })
    assert.deepEqual(r.resolution, { kind: "RECORDED", truckId: "hassen" })
  })
})

describe("création de la dépense", () => {
  it("commande valide pour le registre, référence bancaire, statut à valider", () => {
    const cmd = bankFuelExpenseCommand({ id: "tx1", day: "2026-11-02", label: "CARTE X1111 TOTAL", amount: "95.50", card: "1111" })
    const parsed = parseExpenseCommand(cmd, bankLineIdempotencyKey("ab".repeat(32)))
    assert.equal(parsed.command.action, "CREATE")
    assert.equal(cmd.data.reference, "BANQUE:tx1")
    assert.match(cmd.data.notes, /carte •1111/)
  })
  it("répartition pour un camion : sûrs, à confirmer, déjà enregistrés", () => {
    const resolved = [
      { ...line("a", "2026-11-20", "X", 1), card: null, resolution: { kind: "CARD" as const, truckId: "t1", card: "1" } },
      { ...line("b", "2026-11-20", "X", 1), card: null, resolution: { kind: "UNRESOLVED" as const, candidates: ["t1", "t2"] } },
      { ...line("c", "2026-11-20", "X", 1), card: null, resolution: { kind: "RECORDED" as const, truckId: "t1" } },
      { ...line("d", "2026-11-20", "X", 1), card: null, resolution: { kind: "ONLY_TOUR" as const, truckId: "t2" } },
    ]
    const r = splitForTruck(resolved, "t1", "co", {}, 1)
    assert.deepEqual(r.forTruck.map((s) => s.id), ["a"])
    assert.deepEqual(r.toConfirm.map((s) => s.id), ["b"])
    assert.equal(r.recordedCount, 1)
    assert.equal(r.forTruck[0].amount, "0.01".replace("0.01", "1.00"))
  })
})
