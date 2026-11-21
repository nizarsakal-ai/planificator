/**
 * Lot C Planificator V2 : règles pures des budgets et marges, sur un jeu FICTIF complet calculé à la main, au centime.
 * Chaque source de coût et de recette y figure, avec ses cas exclus (brouillons, annulés, refusés, non valorisés,
 * déjà comptés ailleurs), pour prouver qu'aucun euro n'est compté deux fois ni oublié.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  BUDGET_ERRORS, COST_NATURES, MAX_CENTS, computeWorksiteMargin, ownedEquipmentCents, planAllocation, planBudgetVersion, priceAt,
  ratioBp, sameVersion, validateReason, valueMilliCents, type WorksiteFacts,
} from "@/lib/budget/budget.core"
import { committedRentalCents } from "@/lib/equipment/equipment.core"

const t = (s: string) => new Date(s)
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)

/** Jeu fictif complet d'un chantier (valeurs attendues calculées à la main dans les commentaires). */
const FACTS: WorksiteFacts = {
  // Budget v2 : recette 100 000,00 ; coûts 30 000 + 20 000 + 8 000 + 2 000 + 25 000 + 1 000 = 86 000,00.
  budget: {
    revision: 2, plannedRevenueCents: BigInt(10_000_000),
    lines: [
      { nature: "MATERIALS", amountCents: BigInt(3_000_000) }, { nature: "SUBCONTRACTING", amountCents: BigInt(2_000_000) },
      { nature: "EQUIPMENT", amountCents: BigInt(800_000) }, { nature: "VEHICLES", amountCents: BigInt(200_000) },
      { nature: "LABOR", amountCents: BigInt(2_500_000) }, { nature: "OTHER", amountCents: BigInt(100_000) },
    ],
  },
  // Devis signés = acceptés + convertis = 90 000,00 + 15 000,00 ; brouillon et refusé ignorés.
  quotes: [
    { status: "ACCEPTED", totalHTCents: BigInt(9_000_000) }, { status: "CONVERTED", totalHTCents: BigInt(1_500_000) },
    { status: "DRAFT", totalHTCents: BigInt(500_000) }, { status: "REFUSED", totalHTCents: BigInt(700_000) },
  ],
  // Facturé = acompte 27 000 + solde 50 000 + facture annulée par avoir 3 000 − avoir total 3 000 − avoir partiel 1 234,56
  // = 75 765,44 ; le brouillon (non émis) est ignoré.
  invoices: [
    { kind: "DEPOSIT", issued: true, totalHTCents: BigInt(2_700_000) },
    { kind: "INVOICE", issued: true, totalHTCents: BigInt(5_000_000) },
    { kind: "INVOICE", issued: false, totalHTCents: BigInt(1_000_000) },
    { kind: "INVOICE", issued: true, totalHTCents: BigInt(300_000) },
    { kind: "CREDIT_NOTE", issued: true, totalHTCents: BigInt(300_000) },
    { kind: "CREDIT_NOTE", issued: true, totalHTCents: BigInt(123_456) },
  ],
  // Sorties : A 10 u le 10/10 à 12,50 = 125,00 ; A 2,5 u le 20/10 (même instant que la réception à 13,00) = 32,50 ;
  // B 1,5 u à 3,33 = 4,995 → 5,00 (arrondi) ; C sans prix connu à sa date ⇒ non valorisée.
  // Total des sorties : 125,00 + 32,50 + 5,00 = 162,50.
  stockIssues: [
    { articleId: "A", quantityMilli: 10_000, at: t("2026-10-10T09:00:00Z") },
    { articleId: "A", quantityMilli: 2_500, at: t("2026-10-20T08:00:00Z") },
    { articleId: "B", quantityMilli: 1_500, at: t("2026-10-06T08:00:00Z") },
    { articleId: "C", quantityMilli: 1_000, at: t("2026-10-07T08:00:00Z") },
  ],
  otherLinkedMovements: 2,
  pricePoints: [
    { articleId: "A", at: t("2026-10-01T08:00:00Z"), id: "m1", unitPriceCents: 1_250 },
    { articleId: "A", at: t("2026-10-20T08:00:00Z"), id: "m2", unitPriceCents: 1_300 },
    { articleId: "B", at: t("2026-10-05T08:00:00Z"), id: "m3", unitPriceCents: 333 },
    { articleId: "A", at: t("2026-11-10T08:00:00Z"), id: "m9", unitPriceCents: 9_999 }, // postérieure : ne revalorise rien
    { articleId: "C", at: t("2026-10-08T08:00:00Z"), id: "m4", unitPriceCents: 100 }, // postérieure à la sortie de C
  ],
  orderLines: [
    // Commande passée, prestation sans article : 1 u × 1 500,00 engagée.
    { orderStatus: "ORDERED", hasArticle: false, quantityMilli: 1_000, receivedMilli: 0, unitPriceCents: 150_000 },
    // Partiellement reçue, sans article : 1 u reçue × 250,00 = réel 250,00 ; 3 u restantes = engagé 750,00.
    { orderStatus: "PARTIALLY_RECEIVED", hasArticle: false, quantityMilli: 4_000, receivedMilli: 1_000, unitPriceCents: 25_000 },
    // Partiellement reçue, AVEC article : 4 u reçues entrent en stock (52,00, non comptées) ; 6 u restantes engagées = 78,00.
    { orderStatus: "PARTIALLY_RECEIVED", hasArticle: true, quantityMilli: 10_000, receivedMilli: 4_000, unitPriceCents: 1_300 },
    // Brouillon : rien.
    { orderStatus: "DRAFT", hasArticle: false, quantityMilli: 1_000, receivedMilli: 0, unitPriceCents: 999_999 },
    // Reçue, sans article : 2 u × 100,01 = 200,02 réel.
    { orderStatus: "RECEIVED", hasArticle: false, quantityMilli: 2_000, receivedMilli: 2_000, unitPriceCents: 10_001 },
    // Annulée sans réception : rien.
    { orderStatus: "CANCELLED", hasArticle: false, quantityMilli: 1_000, receivedMilli: 0, unitPriceCents: 50_000 },
  ],
  rentals: [
    { status: "CLOSED", costCents: BigInt(123_450), startDate: day("2026-10-01"), endDate: day("2026-10-15"), dailyRateCents: 8_000, fixedFeesCents: 0 },
    // En cours du 01/11 au 10/11 (10 jours) × 80,00 + 50,00 de frais = 850,00 engagé.
    { status: "ACTIVE", costCents: null, startDate: day("2026-11-01"), endDate: day("2026-11-10"), dailyRateCents: 8_000, fixedFeesCents: 5_000 },
    { status: "CANCELLED", costCents: null, startDate: day("2026-12-01"), endDate: day("2026-12-31"), dailyRateCents: 8_000, fixedFeesCents: 0 },
  ],
  ownedBookings: [
    { checkedOutAt: t("2026-10-01T08:00:00Z"), returnedAt: t("2026-10-03T07:00:00Z"), dailyCostCents: 2_500 }, // 47 h ⇒ 2 jours = 50,00
    { checkedOutAt: t("2026-10-05T10:00:00Z"), returnedAt: t("2026-10-05T10:30:00Z"), dailyCostCents: 2_500 }, // au moins 1 jour = 25,00
  ],
  ownedBookingsWithoutCost: 0,
  vehicleAllocations: [
    { amountCents: BigInt(4_567), admitted: true }, { amountCents: BigInt(10_000), admitted: true }, { amountCents: BigInt(99_999), admitted: false },
  ],
  supplierAllocations: [
    { nature: "SUBCONTRACTING", amountHTCents: BigInt(1_500_000), invoiceStatus: "VALIDATED", linkedElsewhere: false },
    { nature: "SUBCONTRACTING", amountHTCents: BigInt(300_000), invoiceStatus: "PENDING", linkedElsewhere: false },
    { nature: "OTHER", amountHTCents: BigInt(12_345), invoiceStatus: "VALIDATED", linkedElsewhere: false },
    { nature: "MATERIALS", amountHTCents: BigInt(777_777), invoiceStatus: "VALIDATED", linkedElsewhere: true },
    { nature: "OTHER", amountHTCents: BigInt(1_000), invoiceStatus: "REJECTED", linkedElsewhere: false },
  ],
}

describe("marge d'un chantier : jeu fictif complet, au centime", () => {
  const m = computeWorksiteMargin(FACTS)
  const row = (n: string) => m.natures.find((r) => r.nature === n)!

  it("réel par nature : stock valorisé + achats directs reçus ; locations clôturées + matériel propre ; véhicules admis ; factures validées", () => {
    assert.equal(row("MATERIALS").actualCents, BigInt(12_500) + BigInt(3_250) + BigInt(500) + BigInt(25_000) + BigInt(20_002)) // 61 252
    assert.equal(row("SUBCONTRACTING").actualCents, BigInt(1_500_000))
    assert.equal(row("EQUIPMENT").actualCents, BigInt(123_450) + BigInt(5_000) + BigInt(2_500))
    assert.equal(row("VEHICLES").actualCents, BigInt(14_567))
    assert.equal(row("LABOR").actualCents, BigInt(0))
    assert.equal(row("OTHER").actualCents, BigInt(12_345))
    assert.equal(m.actualCents, BigInt(1_719_114))
  })
  it("engagé : reste à recevoir des commandes passées, locations en cours, factures imputées en attente", () => {
    assert.equal(row("MATERIALS").committedCents, BigInt(150_000) + BigInt(75_000) + BigInt(7_800))
    assert.equal(row("EQUIPMENT").committedCents, BigInt(85_000))
    assert.equal(row("SUBCONTRACTING").committedCents, BigInt(300_000))
    assert.equal(m.committedCents, BigInt(617_800))
    assert.equal(m.receivedArticlesCumulativeCents, BigInt(5_200), "cumul historique des réceptions d'articles : affiché, jamais compté")
  })
  it("prévu, reste et consommation par nature", () => {
    assert.equal(m.plannedCostCents, BigInt(8_600_000))
    assert.equal(row("MATERIALS").remainingCents, BigInt(3_000_000) - BigInt(61_252) - BigInt(232_800))
    assert.equal(row("MATERIALS").consumedBp, 980)
    assert.equal(row("LABOR").consumedBp, 0)
    assert.deepEqual(m.natures.map((r) => r.nature), [...COST_NATURES])
  })
  it("recettes : devis signés, facturé net des avoirs, reste à facturer", () => {
    assert.equal(m.signedQuotesHTCents, BigInt(10_500_000))
    assert.equal(m.invoicedHTCents, BigInt(7_576_544))
    assert.equal(m.toInvoiceCents, BigInt(10_500_000) - BigInt(7_576_544))
  })
  it("marges et taux (points de base, arrondi au plus proche)", () => {
    assert.equal(m.plannedRevenueCents, BigInt(10_000_000))
    assert.equal(m.plannedMarginCents, BigInt(1_400_000))
    assert.equal(m.plannedMarginBp, 1400)
    assert.equal(m.currentMarginCents, BigInt(7_576_544) - BigInt(1_719_114))
    assert.equal(m.currentMarginBp, 7731)
    // Σ max(prévu, réel + engagé) = prévu partout (8 600 000) ; 1 900 000 / 10 500 000 = 18,095 % ⇒ 1810 bp.
    assert.equal(m.forecastMarginCents, BigInt(10_500_000) - BigInt(8_600_000))
    assert.equal(m.forecastMarginBp, 1810)
    assert.equal(m.hasBudget, true)
    assert.equal(m.budgetRevision, 2)
  })
  it("points à vérifier : chaque exclusion est signalée avec son nombre", () => {
    assert.deepEqual(m.anomalies.map((a) => [a.code, a.count]), [
      ["UNVALUED_ISSUES", 1], ["OTHER_MOVEMENTS", 2], ["VEHICLE_EXCLUDED", 1], ["ALLOCATION_LINKED", 1], ["ALLOCATION_REJECTED", 1], ["LABOR_NOT_COMPUTED", 1],
    ])
  })
  it("matériel propre utilisé sans coût journalier (catalogue créé à la réception) : rien d'inventé, marge incomplète signalée", () => {
    const sansCout = computeWorksiteMargin({ ...FACTS, ownedBookingsWithoutCost: 2 })
    // Le réel matériel est INCHANGÉ (aucune valorisation inventée) ; l'alerte porte le nombre de réservations concernées.
    assert.equal(sansCout.natures.find((r) => r.nature === "EQUIPMENT")!.actualCents, BigInt(123_450) + BigInt(5_000) + BigInt(2_500))
    assert.equal(sansCout.actualCents, m.actualCents)
    const alerte = sansCout.anomalies.find((a) => a.code === "EQUIPMENT_COST_MISSING")
    assert.ok(alerte, "alerte coût matériel manquant présente")
    assert.equal(alerte!.count, 2)
    assert.match(alerte!.message, /^Marge incomplète : 2 réservation\(s\) de matériel propre/)
    assert.match(alerte!.message, /Coût matériel manquant, non valorisé : coût réel incomplet et marge potentiellement surestimée/)
    assert.doesNotMatch(alerte!.message, /sous-estimée?s?/, "la marge n'est jamais dite sous-estimée : un coût manquant la surestime")
    assert.deepEqual(m.anomalies.filter((a) => a.code === "EQUIPMENT_COST_MISSING"), [], "sans réservation concernée : aucune alerte")
  })
  it("estimation à terminaison : le réel + engagé l'emporte sur le prévu quand il le dépasse", () => {
    const over = computeWorksiteMargin({ ...FACTS, supplierAllocations: [{ nature: "SUBCONTRACTING", amountHTCents: BigInt(2_600_000), invoiceStatus: "VALIDATED", linkedElsewhere: false }] })
    // Sous-traitance : max(2 000 000, 2 600 000) ; le reste inchangé (8 600 000 − 2 000 000 + 2 600 000 = 9 200 000).
    assert.equal(over.forecastMarginCents, BigInt(10_500_000) - BigInt(9_200_000))
    assert.equal(over.natures.find((r) => r.nature === "SUBCONTRACTING")!.remainingCents, -BigInt(600_000))
  })
  it("chantier sans budget ni donnée : tout à zéro, taux indéfinis, aucun point à vérifier", () => {
    const empty = computeWorksiteMargin({ budget: null, quotes: [], invoices: [], stockIssues: [], otherLinkedMovements: 0, pricePoints: [], orderLines: [], rentals: [], ownedBookings: [], ownedBookingsWithoutCost: 0, vehicleAllocations: [], supplierAllocations: [] })
    assert.equal(empty.hasBudget, false)
    assert.equal(empty.budgetRevision, null)
    assert.equal(empty.currentMarginCents, BigInt(0))
    assert.equal(empty.currentMarginBp, null)
    assert.equal(empty.plannedMarginBp, null)
    assert.equal(empty.forecastMarginBp, null)
    assert.deepEqual(empty.anomalies, [])
    assert.ok(empty.natures.every((r) => r.consumedBp === null))
  })
})

describe("BUD-01 : cumul historique des réceptions d'articles, pas un solde de stock", () => {
  const empty: WorksiteFacts = { budget: null, quotes: [], invoices: [], stockIssues: [], otherLinkedMovements: 0, pricePoints: [], orderLines: [], rentals: [], ownedBookings: [], ownedBookingsWithoutCost: 0, vehicleAllocations: [], supplierAllocations: [] }
  // Commande du chantier : 10 u d'article reçues à 10,00 (réception le 01/10).
  // Correctif Codex du 05/11 : 10 000 millièmes × 1 000 centimes / 1 000 = 10 000 centimes (100,00 €), sortie partielle 4 000 × 1 000 / 1 000 = 4 000 centimes (40,00 €).
  const received: WorksiteFacts = {
    ...empty,
    orderLines: [{ orderStatus: "RECEIVED", hasArticle: true, quantityMilli: 10_000, receivedMilli: 10_000, unitPriceCents: 1_000 }],
    pricePoints: [{ articleId: "A", at: t("2026-10-01T08:00:00Z"), id: "r1", unitPriceCents: 1_000 }],
  }
  it("réception sans sortie : cumul 100,00, réel 0", () => {
    const m = computeWorksiteMargin(received)
    assert.equal(m.receivedArticlesCumulativeCents, BigInt(10_000))
    assert.equal(m.actualCents, BigInt(0))
  })
  it("réception puis sortie TOTALE : réel 100,00 (une seule fois), cumul inchangé", () => {
    const m = computeWorksiteMargin({ ...received, stockIssues: [{ articleId: "A", quantityMilli: 10_000, at: t("2026-10-02T08:00:00Z") }] })
    assert.equal(m.actualCents, BigInt(10_000))
    assert.equal(m.natures.find((r) => r.nature === "MATERIALS")!.actualCents, BigInt(10_000))
    assert.equal(m.receivedArticlesCumulativeCents, BigInt(10_000), "historique : la sortie n'est pas déduite")
    assert.equal(m.committedCents, BigInt(0))
  })
  it("réception puis sortie PARTIELLE : réel 40,00, cumul inchangé (aucune soustraction naïve)", () => {
    const m = computeWorksiteMargin({ ...received, stockIssues: [{ articleId: "A", quantityMilli: 4_000, at: t("2026-10-02T08:00:00Z") }] })
    assert.equal(m.actualCents, BigInt(4_000))
    assert.equal(m.receivedArticlesCumulativeCents, BigInt(10_000))
  })
})

describe("valorisation", () => {
  it("millièmes × centimes, arrondi au centime le plus proche ; entrées invalides refusées", () => {
    assert.equal(valueMilliCents(1_500, 333), BigInt(500))
    assert.equal(valueMilliCents(1_001, 333), BigInt(333))
    assert.equal(valueMilliCents(0, 999), BigInt(0))
    assert.equal(valueMilliCents(2_000_000_000, 2_000_000_000), BigInt(4_000_000_000_000_000), "BigInt : aucun dépassement")
    for (const [q, p] of [[-1, 1], [1, -1], [1.5, 1], [1, Number.NaN]]) assert.throws(() => valueMilliCents(q, p), RangeError)
  })
  it("dernier prix connu à la date ; égalité de date départagée par l'identifiant ; jamais un prix postérieur", () => {
    const pts = [
      { articleId: "A", at: t("2026-10-01T00:00:00Z"), id: "a", unitPriceCents: 100 },
      { articleId: "A", at: t("2026-10-01T00:00:00Z"), id: "b", unitPriceCents: 200 },
      { articleId: "B", at: t("2026-09-01T00:00:00Z"), id: "z", unitPriceCents: 999 },
    ]
    assert.equal(priceAt(pts, "A", t("2026-10-01T00:00:00Z")), 200)
    assert.equal(priceAt(pts, "A", t("2026-09-30T23:59:59Z")), null)
    assert.equal(priceAt(pts, "C", t("2027-01-01T00:00:00Z")), null)
  })
  it("matériel propre et location en cours : mêmes règles que le lot B", () => {
    assert.equal(ownedEquipmentCents(t("2026-10-01T08:00:00Z"), t("2026-10-02T08:00:00Z"), 1_000), BigInt(1_000), "24 h exactes = 1 jour")
    assert.equal(ownedEquipmentCents(t("2026-10-01T08:00:00Z"), t("2026-10-02T08:00:01Z"), 1_000), BigInt(2_000), "jour entamé")
    assert.equal(committedRentalCents({ startDate: day("2026-11-01"), endDate: day("2026-11-01"), dailyRateCents: 7_000, fixedFeesCents: 100 }), BigInt(7_100))
  })
  it("rapport en points de base : arrondi au plus proche, moitié en s'éloignant de zéro ; base nulle ⇒ null", () => {
    assert.equal(ratioBp(BigInt(1), BigInt(20_000)), 1)
    assert.equal(ratioBp(-BigInt(1), BigInt(20_000)), -1)
    assert.equal(ratioBp(-BigInt(1), BigInt(3)), -3333)
    assert.equal(ratioBp(BigInt(5), BigInt(0)), null)
  })
})

describe("versions de budget", () => {
  it("montants nuls sans ligne, total exact, ordre fixe des natures, libellés nettoyés", () => {
    const v = planBudgetVersion({ plannedRevenueCents: BigInt(500_000), lines: [
      { nature: "OTHER", amountCents: BigInt(1), label: "  frais  " }, { nature: "MATERIALS", amountCents: BigInt(0) }, { nature: "EQUIPMENT", amountCents: BigInt(250_000), label: "" },
    ] })
    assert.ok(v.ok)
    if (!v.ok) return
    assert.deepEqual(v.value.lines, [{ nature: "EQUIPMENT", amountCents: BigInt(250_000), label: null }, { nature: "OTHER", amountCents: BigInt(1), label: "frais" }])
    assert.equal(v.value.totalCostCents, BigInt(250_001))
  })
  it("refus : nature en double ou inconnue, montant négatif ou hors borne, recette invalide", () => {
    const bad = [
      { plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER" as const, amountCents: BigInt(1) }, { nature: "OTHER" as const, amountCents: BigInt(2) }] },
      { plannedRevenueCents: BigInt(0), lines: [{ nature: "SALAIRES" as never, amountCents: BigInt(1) }] },
      { plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER" as const, amountCents: -BigInt(1) }] },
      { plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER" as const, amountCents: MAX_CENTS + BigInt(1) }] },
      { plannedRevenueCents: -BigInt(1), lines: [] },
      { plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER" as const, amountCents: MAX_CENTS }, { nature: "LABOR" as const, amountCents: BigInt(1) }] },
    ]
    for (const b of bad) assert.deepEqual(planBudgetVersion(b), { ok: false, error: BUDGET_ERRORS.amount }, JSON.stringify(b, (_, v) => (typeof v === "bigint" ? String(v) : v)))
  })
  it("précision de plus de 200 caractères refusée, jamais tronquée en silence", () => {
    assert.deepEqual(planBudgetVersion({ plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER", amountCents: BigInt(1), label: "x".repeat(201) }] }), { ok: false, error: BUDGET_ERRORS.label })
    assert.equal(planBudgetVersion({ plannedRevenueCents: BigInt(0), lines: [{ nature: "OTHER", amountCents: BigInt(1), label: ` ${"x".repeat(200)} ` }] }).ok, true)
  })
  it("motif de révision : 3 à 500 caractères après nettoyage", () => {
    assert.deepEqual(validateReason("  Avenant 2 "), { ok: true, value: "Avenant 2" })
    for (const r of ["", "  ab ", null, "x".repeat(501)]) assert.deepEqual(validateReason(r), { ok: false, error: BUDGET_ERRORS.reason }, String(r))
  })
  it("version identique détectée (recette, montants, libellés)", () => {
    const a = planBudgetVersion({ plannedRevenueCents: BigInt(10), lines: [{ nature: "OTHER", amountCents: BigInt(5), label: "x" }] })
    const b = planBudgetVersion({ plannedRevenueCents: BigInt(10), lines: [{ nature: "OTHER", amountCents: BigInt(5), label: " x " }, { nature: "LABOR", amountCents: BigInt(0) }] })
    const c = planBudgetVersion({ plannedRevenueCents: BigInt(10), lines: [{ nature: "OTHER", amountCents: BigInt(5), label: "y" }] })
    assert.ok(a.ok && b.ok && c.ok)
    if (!a.ok || !b.ok || !c.ok) return
    assert.equal(sameVersion(a.value, b.value), true)
    assert.equal(sameVersion(a.value, c.value), false)
  })
})

describe("imputation d'une facture fournisseur", () => {
  const base = { nature: "SUBCONTRACTING", amountHTCents: BigInt(100), invoiceTotalHTCents: BigInt(1_000), alreadyAllocatedCents: BigInt(900), invoiceStatus: "VALIDATED" as const, linkedElsewhere: false }
  it("jusqu'au montant HT exact ; au-delà refusé", () => {
    assert.deepEqual(planAllocation(base), { ok: true, value: { nature: "SUBCONTRACTING" } })
    assert.deepEqual(planAllocation({ ...base, amountHTCents: BigInt(101) }), { ok: false, error: BUDGET_ERRORS.allocationExceeds })
  })
  it("refus : nature main-d'œuvre ou inconnue, facture déjà comptée ailleurs, refusée, montant nul", () => {
    assert.deepEqual(planAllocation({ ...base, nature: "LABOR" }), { ok: false, error: BUDGET_ERRORS.allocationNature })
    assert.deepEqual(planAllocation({ ...base, nature: "X" }), { ok: false, error: BUDGET_ERRORS.allocationNature })
    assert.deepEqual(planAllocation({ ...base, linkedElsewhere: true }), { ok: false, error: BUDGET_ERRORS.allocationLinked })
    assert.deepEqual(planAllocation({ ...base, invoiceStatus: "REJECTED" }), { ok: false, error: BUDGET_ERRORS.allocationRejected })
    assert.deepEqual(planAllocation({ ...base, amountHTCents: BigInt(0) }), { ok: false, error: BUDGET_ERRORS.amount })
  })
  it("facture en attente admise (comptée comme engagée)", () => {
    assert.equal(planAllocation({ ...base, invoiceStatus: "PENDING" }).ok, true)
  })
})
