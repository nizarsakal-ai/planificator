// Tests unitaires des correctifs Lot C (revue Codex 26/10/2026) — calculs purs et cœurs injectés (sans base).
// P2-04 : validité civile Europe/Paris (changements d'heure) ; P1-02 : allocation cumulative de la TVA sur encaissements ;
// P2-01 : identité des opérations importées ; P1-01 : contrôle d'intégrité des totaux ; P1-05 : garde conditionnelle de la transition.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { calendarDayIn, isQuoteValidAt, quoteValidityEnd, timeZoneOffsetMs } from "@/lib/billing/quotes/quote-validity"
import { signatureExpiry } from "@/lib/billing/quotes/quote-signature"
import { allocateReceiptsVat, allocateReceiptsVatEvents, type VatEvent } from "@/lib/accounting/c5/vat"
import { computeDocumentTotals } from "@/lib/billing/money"
import { bankExternalFingerprint, bankFingerprint, guessBankMapping, parseBankCsv } from "@/lib/accounting/c5/bank-import"
import { DocumentIntegrityError, assertStoredTotalsMatch, recomputeDocumentTotals } from "@/lib/billing/document-integrity"
import { decisionInstant, serverNow, setBillingClockForTests } from "@/lib/billing/clock"
import { QUOTE_ERRORS, transitionQuoteCore } from "@/lib/billing/quotes/quote-lifecycle.core"
import type { Prisma } from "@prisma/client"

const d = (s: string) => new Date(s)

describe("P2-04 — validité civile Europe/Paris", () => {
  it("fin de validité = premier instant du lendemain à Paris : hiver (+1), été (+2), jours de changement d'heure", () => {
    assert.equal(quoteValidityEnd(d("2026-01-15T00:00:00Z")).toISOString(), "2026-01-15T23:00:00.000Z")
    assert.equal(quoteValidityEnd(d("2026-07-15T00:00:00Z")).toISOString(), "2026-07-15T22:00:00.000Z")
    assert.equal(quoteValidityEnd(d("2026-03-28T00:00:00Z")).toISOString(), "2026-03-28T23:00:00.000Z") // veille du passage à l'heure d'été
    assert.equal(quoteValidityEnd(d("2026-03-29T00:00:00Z")).toISOString(), "2026-03-29T22:00:00.000Z") // jour du passage (02:00 → 03:00)
    assert.equal(quoteValidityEnd(d("2026-10-24T00:00:00Z")).toISOString(), "2026-10-24T22:00:00.000Z") // veille du retour à l'heure d'hiver
    assert.equal(quoteValidityEnd(d("2026-10-25T00:00:00Z")).toISOString(), "2026-10-25T23:00:00.000Z") // jour du retour (03:00 → 02:00)
    assert.equal(timeZoneOffsetMs(d("2026-03-29T00:59:59Z")), 3_600_000); assert.equal(timeZoneOffsetMs(d("2026-03-29T01:00:00Z")), 7_200_000)
  })
  it("borne incluse/exclue, validité absente, jour civil de Paris", () => {
    const vu = d("2026-03-10T00:00:00Z")
    assert.equal(isQuoteValidAt(vu, d("2026-03-10T22:59:59.999Z")), true)
    assert.equal(isQuoteValidAt(vu, d("2026-03-10T23:00:00.000Z")), false)
    assert.equal(isQuoteValidAt(null, d("2099-01-01T00:00:00Z")), true)
    assert.equal(calendarDayIn(d("2026-03-10T23:30:00Z")).toISOString(), "2026-03-11T00:00:00.000Z") // 00:30 à Paris le 11
    assert.equal(calendarDayIn(d("2026-07-10T22:30:00Z")).toISOString(), "2026-07-11T00:00:00.000Z")
    assert.equal(signatureExpiry(vu, d("2026-03-01T00:00:00Z")).toISOString(), "2026-03-10T23:00:00.000Z")
    assert.throws(() => signatureExpiry(vu, d("2026-03-10T23:00:00Z")), /QUOTE_EXPIRED/)
    assert.equal(signatureExpiry(null, d("2026-03-01T00:00:00Z")).toISOString(), "2026-03-31T00:00:00.000Z")
  })
})

describe("P1-02 — allocation cumulative de la TVA sur encaissements", () => {
  const totals = computeDocumentTotals([{ quantityHundredths: BigInt(100), unitPriceCents: BigInt(10000), discountBp: 0, vatRateBp: 2000 }, { quantityHundredths: BigInt(100), unitPriceCents: BigInt(10000), discountBp: 0, vatRateBp: 1000 }], { globalDiscountBp: 0, vatReverseCharge: false }) // 230 TTC, TVA 20 + 10
  const sum = (parts: ReturnType<typeof allocateReceiptsVat>, bp: number) => parts.flat().filter((p) => p.vatRateBp === bp).reduce((s, p) => s + p.vatCents, BigInt(0))
  it("fractions non divisibles et centimes : Σ parts par taux = TVA de la facture exactement ; aucune part aberrante", () => {
    for (const fractions of [[1, 1, 1, 22997], [3333, 3333, 3333, 3333, 3333, 3333, 3002], [11500, 11500], [1, 22999], Array(23).fill(1000)]) {
      const parts = allocateReceiptsVat(totals, fractions.map((amountCents) => ({ amountCents: BigInt(amountCents) })))
      assert.equal(sum(parts, 2000), BigInt(2000), String(fractions)); assert.equal(sum(parts, 1000), BigInt(1000), String(fractions))
      for (const p of parts.flat()) assert.ok(p.vatCents >= BigInt(0) && p.vatCents <= BigInt(2000))
    }
  })
  it("contre-passation = part négative exacte du paiement annulé ; ordre des mouvements déterministe ; TTC nul ⇒ aucune part", () => {
    const parts = allocateReceiptsVat(totals, [{ amountCents: BigInt(10000) }, { amountCents: BigInt(-10000) }, { amountCents: BigInt(23000) }])
    assert.deepEqual(parts[1].map((p) => p.vatCents), parts[0].map((p) => -p.vatCents))
    assert.equal(sum(parts, 2000), BigInt(2000)); assert.equal(sum(parts, 1000), BigInt(1000))
    const single = computeDocumentTotals([{ quantityHundredths: BigInt(100), unitPriceCents: BigInt(10000), discountBp: 0, vatRateBp: 2000 }], { globalDiscountBp: 0, vatReverseCharge: false })
    const p60 = allocateReceiptsVat(single, [{ amountCents: BigInt(6000) }])
    assert.deepEqual(p60[0], [{ vatRateBp: 2000, baseCents: BigInt(5000), vatCents: BigInt(1000) }])
    assert.deepEqual(allocateReceiptsVat({ ...single, totalTTCCents: BigInt(0) }, [{ amountCents: BigInt(1) }]), [[]])
  })
})

describe("R1 — allocation par événements, nette des avoirs ciblés (oracles indépendants)", () => {
  const L = (price: number, bp: number) => ({ quantityHundredths: BigInt(100), unitPriceCents: BigInt(price), discountBp: 0, vatRateBp: bp })
  const original = computeDocumentTotals([L(10000, 2000), L(10000, 1000)], { globalDiscountBp: 0, vatReverseCharge: false }) // 230 TTC : 20 + 10
  const creditA = computeDocumentTotals([L(10000, 2000)], { globalDiscountBp: 0, vatReverseCharge: false }) // 120 TTC
  const creditB = computeDocumentTotals([L(10000, 1000)], { globalDiscountBp: 0, vatReverseCharge: false }) // 110 TTC
  const vat = (ev: ReturnType<typeof allocateReceiptsVatEvents>, bp: number) => ev.flatMap((e) => e.parts).filter((p) => p.vatRateBp === bp).reduce((s, p) => s + p.vatCents, BigInt(0))
  const pay = (c: number): VatEvent => ({ kind: "PAYMENT", amountCents: BigInt(c) })
  it("reproduction Codex : avoir A puis 110 € ⇒ 10 @10 %, 0 @20 % ; inverse : avoir B puis 120 € ⇒ 20 @20 % ; aucun excès", () => {
    const r = allocateReceiptsVatEvents(original, [{ kind: "CREDIT", totals: creditA }, pay(11000)])
    assert.equal(vat(r, 1000), BigInt(1000)); assert.equal(vat(r, 2000), BigInt(0)); assert.deepEqual(r.map((e) => e.excessCents), [BigInt(0), BigInt(0)])
    assert.deepEqual(r[1].parts, [{ vatRateBp: 1000, baseCents: BigInt(10000), vatCents: BigInt(1000) }])
    const inv = allocateReceiptsVatEvents(original, [{ kind: "CREDIT", totals: creditB }, pay(12000)])
    assert.equal(vat(inv, 2000), BigInt(2000)); assert.equal(vat(inv, 1000), BigInt(0))
  })
  it("paiement avant l'avoir : 50 € (4,35 @20 ; 2,17 @10) puis avoir A ⇒ réaffectation (−4,35 ; +2,38) puis 60 € ⇒ +5,45 : Σ = 10 @10, 0 @20", () => {
    const r = allocateReceiptsVatEvents(original, [pay(5000), { kind: "CREDIT", totals: creditA }, pay(6000)])
    assert.deepEqual(r[0].parts.map((p) => [p.vatRateBp, p.vatCents]), [[1000, BigInt(217)], [2000, BigInt(435)]])
    assert.deepEqual(r[1].parts.map((p) => [p.vatRateBp, p.vatCents]), [[1000, BigInt(238)], [2000, BigInt(-435)]])
    assert.deepEqual(r[2].parts.map((p) => [p.vatRateBp, p.vatCents]), [[1000, BigInt(545)]])
    assert.equal(vat(r, 1000), BigInt(1000)); assert.equal(vat(r, 2000), BigInt(0))
  })
  it("plusieurs avoirs, fractions non divisibles, contre-passation : Σ parts = TVA nette exacte par taux ; mono-taux : avoir après paiement ⇒ aucune part", () => {
    const half = computeDocumentTotals([{ ...L(10000, 2000), quantityHundredths: BigInt(50) }], { globalDiscountBp: 0, vatReverseCharge: false }) // 60 TTC
    // Net final = A/2 : 60 TTC, TVA 10 @20 ; mouvements 33,33 − 33,33 + 33,33 + 26,67 = 60,00 ; le cumul ne dépasse jamais le net courant (plafond C4).
    const r = allocateReceiptsVatEvents(original, [pay(3333), { kind: "CREDIT", totals: half }, { kind: "CREDIT", totals: creditB }, pay(-3333), pay(3333), pay(2667)])
    assert.equal(vat(r, 2000), BigInt(1000)); assert.equal(vat(r, 1000), BigInt(0)); assert.ok(r.every((e) => e.excessCents === BigInt(0)))
    const mono = computeDocumentTotals([L(10000, 2000)], { globalDiscountBp: 0, vatReverseCharge: false })
    const m = allocateReceiptsVatEvents(mono, [pay(6000), { kind: "CREDIT", totals: computeDocumentTotals([L(5000, 2000)], { globalDiscountBp: 0, vatReverseCharge: false }) }])
    assert.deepEqual(m[1].parts, []); assert.equal(vat(m, 2000), BigInt(1000))
  })
  it("hors contrat : avoir total après encaissement ⇒ excès = encaissé, aucune part ; avoir partiel au-delà du reste (héritage) ⇒ excès = dépassement, allocation gelée", () => {
    const total = allocateReceiptsVatEvents(original, [pay(23000), { kind: "CREDIT", totals: original }])
    assert.deepEqual(total[1], { parts: [], excessCents: BigInt(23000) }); assert.equal(vat(total, 2000), BigInt(2000))
    const over = allocateReceiptsVatEvents(original, [pay(20000), { kind: "CREDIT", totals: creditA }]) // net 110, encaissé 200 ⇒ excès 90 : allocation GELÉE (aucune part à l'avoir)
    assert.equal(over[1].excessCents, BigInt(9000)); assert.deepEqual(over[1].parts, []); assert.equal(vat(over, 2000), BigInt(1739)); assert.equal(vat(over, 1000), BigInt(870))
    // Compatibilité : l'ancienne allocation cumulative reste un cas particulier (sans avoir).
    assert.deepEqual(allocateReceiptsVat(original, [{ amountCents: BigInt(11500) }, { amountCents: BigInt(11500) }]).flat().map((p) => p.vatCents), [BigInt(500), BigInt(1000), BigInt(500), BigInt(1000)]) // ordre = taux croissants (vatSummary)
  })
})

describe("R3 — horloge de décision", () => {
  it("decisionInstant = horloge relue, jamais antérieure au début de requête ; horloge de test fixée puis restaurée", () => {
    const start = d("2026-03-10T10:00:00Z")
    assert.equal(decisionInstant(start, () => d("2026-03-10T10:00:01Z")).toISOString(), "2026-03-10T10:00:01.000Z")
    assert.equal(decisionInstant(start, () => d("2026-03-10T09:00:00Z")).toISOString(), start.toISOString(), "horloge non monotone ⇒ max")
    setBillingClockForTests(() => d("2030-01-01T00:00:00Z"))
    assert.equal(serverNow().toISOString(), "2030-01-01T00:00:00.000Z"); assert.equal(decisionInstant(start).toISOString(), "2030-01-01T00:00:00.000Z")
    setBillingClockForTests(null)
    assert.ok(Math.abs(serverNow().getTime() - Date.now()) < 1000)
  })
})

describe("P2-01 — identité des opérations importées", () => {
  const M = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }
  it("tuple répété ⇒ occurrences 1,2,3 toutes ambiguës ; empreinte de l'occurrence 1 = format antérieur ; tuple unique non ambigu", () => {
    const r = parseBankCsv("co", "d;l;m;r\n12/03/2026;VIR;10,00;A\n12/03/2026;VIR;10,00;A\n12/03/2026;VIR;10,00;A\n13/03/2026;VIR;10,00;A\n", M)
    assert.deepEqual(r.lines.map((l) => [l.occurrence, l.identityAmbiguous]), [[1, true], [2, true], [3, true], [1, false]])
    assert.equal(r.lines[0].fingerprint, bankFingerprint("co", r.lines[0].date, BigInt(1000), "VIR", "A"))
    assert.notEqual(r.lines[1].fingerprint, r.lines[0].fingerprint); assert.equal(new Set(r.lines.map((l) => l.fingerprint)).size, 4)
  })
  it("identifiant bancaire : empreinte dérivée de l'identifiant seul, jamais ambiguë, doublon dans le fichier invalide ; mapping deviné", () => {
    const r = parseBankCsv("co", "Date;Libellé;Montant;Référence;FITID\n12/03/2026;VIR;10,00;A;X1\n12/03/2026;VIR;10,00;A;X2\n12/03/2026;VIR;10,00;A;X2\n", { ...M, bankId: 4 })
    assert.deepEqual(r.lines.map((l) => [l.externalId, l.identityAmbiguous, l.occurrence]), [["X1", false, 1], ["X2", false, 1]])
    assert.equal(r.lines[0].fingerprint, bankExternalFingerprint("co", "X1")); assert.deepEqual(r.invalid.map((i) => i.error), ["identifiant bancaire en double dans le fichier (X2)"])
    assert.deepEqual(guessBankMapping(["Date", "Libellé", "Montant", "Référence", "FITID"]), { date: 0, label: 1, amount: 2, debit: undefined, credit: undefined, reference: 3, bankId: 4, headerRows: 1 })
    assert.deepEqual(guessBankMapping(["Date", "Libellé", "Débit", "Crédit", "Référence"]), { date: 0, label: 1, amount: undefined, debit: 2, credit: 3, reference: 4, headerRows: 1 })
    assert.equal(guessBankMapping(["Date", "Libellé", "Montant", "Liquidité", "Référence"]).bankId, undefined, "jamais par sous-chaîne")
  })
})

describe("P1-01 — intégrité des totaux persistés", () => {
  const doc = { number: "FAC-1", status: "SENT", globalDiscountBp: 1000, vatReverseCharge: false, totalHT: "45.00", totalVAT: "9.00", totalTTC: "54.00", lines: [{ quantity: "1.00", unitPrice: "100.00", vatRate: "20.00", discountBp: 0, deductsDepositId: null }, { quantity: "1.00", unitPrice: "-45.00", vatRate: "20.00", discountBp: 0, deductsDepositId: "dep" }] }
  it("solde remisé avec déduction hors remise : 54,00 ; marqueur perdu ⇒ recalcul 59,40 ⇒ refus ; brouillon jamais contrôlé", () => {
    assert.equal(assertStoredTotalsMatch(doc).totalTTCCents, BigInt(5400))
    const lost = { ...doc, lines: doc.lines.map((l) => ({ ...l, deductsDepositId: null })) }
    assert.equal(recomputeDocumentTotals(lost).totalTTCCents, BigInt(5940))
    assert.throws(() => assertStoredTotalsMatch(lost), (e: unknown) => e instanceof DocumentIntegrityError && e.detail.computed.ttc === BigInt(5940) && e.detail.stored.ttc === BigInt(5400))
    assert.equal(assertStoredTotalsMatch({ ...lost, status: "DRAFT" }).totalTTCCents, BigInt(5940))
  })
})

describe("P1-05 — transition conditionnée au jeton (cœur injecté)", () => {
  it("la garde fait partie de l'UPDATE conditionnel : hachage différent ⇒ conflit sans écriture ; hachage identique ⇒ transition", async () => {
    const rows: Record<string, unknown>[] = [{ id: "q1", companyId: "coA", status: "SENT", number: "DEV-1", worksiteId: "w", signatureTokenHash: "h1" }]
    const history: unknown[] = []
    const tx = {
      quote: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const r of rows) if (Object.entries(where).every(([k, v]) => r[k] === v)) { Object.assign(r, data); count++ } return { count } },
      },
      historyLog: { create: async ({ data }: { data: unknown }) => { history.push(data) } },
    } as unknown as Prisma.TransactionClient
    const stale = await transitionQuoteCore(tx, { companyId: "coA", quoteId: "q1", to: "ACCEPTED", actorId: "u", now: d("2026-03-10T00:00:00Z"), guard: { signatureTokenHash: "h-old" } })
    assert.deepEqual(stale, { ok: false, error: QUOTE_ERRORS.conflict }); assert.equal(rows[0].status, "SENT"); assert.equal(history.length, 0)
    const ok = await transitionQuoteCore(tx, { companyId: "coA", quoteId: "q1", to: "ACCEPTED", actorId: "u", now: d("2026-03-10T00:00:00Z"), guard: { signatureTokenHash: "h1" } })
    assert.ok(ok.ok); assert.equal(rows[0].status, "ACCEPTED"); assert.equal(history.length, 1)
  })
})
