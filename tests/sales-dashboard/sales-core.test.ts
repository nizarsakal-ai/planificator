/**
 * Lot D Planificator V2 : indicateurs commerciaux sur un jeu FICTIF calculé à la main (valeurs recoupées par un
 * second calcul indépendant avant écriture). Chaque définition a ses cas exclus (brouillon, en attente, non émis, hors
 * période, fuseau de Paris, lignes sans article, avoir).
 * Réconciliation 12/11 (revue indépendante D) : pièce d'acompte jamais comptée dans les articles, même avec un article ;
 * ligne de déduction d'acompte exclue ; ventilations complètes égales au total ; mois en heure de Paris aux changements
 * d'heure ; quantité et montant séparés ; grandes valeurs exactes.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeSalesIndicators, decimalToMilli, monthsOf, periodFor, ratioBp, type SalesFacts } from "@/lib/sales-dashboard/sales.core"

const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const Y2026 = periodFor("2026", new Date("2026-11-04T10:00:00Z"))

const FACTS: SalesFacts = {
  quotes: [
    { status: "ACCEPTED", issueDate: new Date("2026-01-15T09:00:00Z"), totalHTCents: BigInt("1000000") },
    { status: "CONVERTED", issueDate: new Date("2026-03-10T09:00:00Z"), totalHTCents: BigInt("500000") },
    { status: "REFUSED", issueDate: new Date("2026-04-01T09:00:00Z"), totalHTCents: BigInt("300000") },
    { status: "EXPIRED", issueDate: new Date("2026-05-01T09:00:00Z"), totalHTCents: BigInt("200000") },
    { status: "SENT", issueDate: new Date("2026-06-01T09:00:00Z"), totalHTCents: BigInt("400000") },
    { status: "DRAFT", issueDate: new Date("2026-06-02T09:00:00Z"), totalHTCents: BigInt("999999") },
    // 31/12/2025 23 h 30 UTC = 1er janvier 2026 à Paris : dans l'année 2026.
    { status: "ACCEPTED", issueDate: new Date("2025-12-31T23:30:00Z"), totalHTCents: BigInt("100000") },
    // 31/12/2026 23 h 30 UTC = 1er janvier 2027 à Paris : hors de l'année 2026.
    { status: "ACCEPTED", issueDate: new Date("2026-12-31T23:30:00Z"), totalHTCents: BigInt("777777") },
  ],
  invoices: [
    { id: "i1", kind: "INVOICE", issued: true, issueDate: day("2026-01-20"), totalHTCents: BigInt("1000000"), clientId: "A", clientName: "Client A", worksiteId: "W1", worksiteName: "Chantier 1" },
    { id: "i2", kind: "DEPOSIT", issued: true, issueDate: day("2026-02-05"), totalHTCents: BigInt("300000"), clientId: "B", clientName: "Client B", worksiteId: "W2", worksiteName: "Chantier 2" },
    { id: "i3", kind: "INVOICE", issued: true, issueDate: day("2026-02-25"), totalHTCents: BigInt("200000"), clientId: "B", clientName: "Client B", worksiteId: "W2", worksiteName: "Chantier 2" },
    { id: "i4", kind: "CREDIT_NOTE", issued: true, issueDate: day("2026-03-01"), totalHTCents: BigInt("100000"), clientId: "A", clientName: "Client A", worksiteId: "W1", worksiteName: "Chantier 1" },
    { id: "i5", kind: "INVOICE", issued: false, issueDate: day("2026-03-02"), totalHTCents: BigInt("50000"), clientId: "A", clientName: "Client A", worksiteId: "W1", worksiteName: "Chantier 1" },
    { id: "i6", kind: "INVOICE", issued: true, issueDate: day("2025-12-31"), totalHTCents: BigInt("999"), clientId: "A", clientName: "Client A", worksiteId: "W1", worksiteName: "Chantier 1" },
  ],
  lines: [
    { invoiceId: "i1", articleId: "X", deductsDeposit: false, designation: "Article X", quantityMilli: BigInt("10000"), lineHTCents: BigInt("600000") },
    { invoiceId: "i1", articleId: "Y", deductsDeposit: false, designation: "Article Y", quantityMilli: BigInt("5000"), lineHTCents: BigInt("400000") },
    { invoiceId: "i3", articleId: "Y", deductsDeposit: false, designation: "Article Y", quantityMilli: BigInt("2000"), lineHTCents: BigInt("200000") },
    { invoiceId: "i2", articleId: null, deductsDeposit: false, designation: "Acompte 30 %", quantityMilli: BigInt("1000"), lineHTCents: BigInt("300000") },
    { invoiceId: "i4", articleId: "X", deductsDeposit: false, designation: "Article X", quantityMilli: BigInt("1000"), lineHTCents: BigInt("100000") },
    { invoiceId: "i5", articleId: "Z", deductsDeposit: false, designation: "Article Z", quantityMilli: BigInt("1000"), lineHTCents: BigInt("50000") },
    { invoiceId: "i6", articleId: "Z", deductsDeposit: false, designation: "Article Z", quantityMilli: BigInt("1000"), lineHTCents: BigInt("999") },
  ],
}

describe("indicateurs commerciaux : jeu fictif, année 2026", () => {
  const k = computeSalesIndicators(FACTS, Y2026)
  it("devis émis, signés, en attente, décidés ; brouillon et hors période exclus ; fuseau de Paris", () => {
    assert.deepEqual(
      { emitted: k.quotes.emitted, emittedCents: k.quotes.emittedCents, signed: k.quotes.signed, signedCents: k.quotes.signedCents, pending: k.quotes.pending, decided: k.quotes.decided, decidedCents: k.quotes.decidedCents },
      { emitted: 6, emittedCents: BigInt("2500000"), signed: 3, signedCents: BigInt("1600000"), pending: 1, decided: 5, decidedCents: BigInt("2100000") },
    )
  })
  it("taux de transformation : 3 / 5 = 60 % en nombre ; 1 600 000 / 2 100 000 = 76,19 % en montant", () => {
    assert.equal(k.quotes.conversionBp, 6000)
    assert.equal(k.quotes.conversionValueBp, 7619)
  })
  it("chiffre d'affaires : factures et acomptes émis − avoirs ; non émis et hors période exclus", () => {
    assert.equal(k.revenue.totalCents, BigInt("1400000"))
    assert.deepEqual([k.revenue.invoicesCount, k.revenue.depositsCount, k.revenue.creditNotesCount], [2, 1, 1])
  })
  it("série mensuelle complète (12 mois, mois vides à zéro)", () => {
    assert.equal(k.revenue.byMonth.length, 12)
    assert.deepEqual(k.revenue.byMonth.slice(0, 4), [
      { month: "2026-01", amountCents: BigInt("1000000") }, { month: "2026-02", amountCents: BigInt("500000") },
      { month: "2026-03", amountCents: -BigInt("100000") }, { month: "2026-04", amountCents: BigInt("0") },
    ])
    assert.equal(k.revenue.byMonth.reduce((t, m) => t + m.amountCents, BigInt("0")), k.revenue.totalCents)
  })
  it("classements clients et chantiers (avoir déduit)", () => {
    assert.deepEqual(k.topClients.map((c) => [c.id, c.amountCents]), [["A", BigInt("900000")], ["B", BigInt("500000")]])
    assert.deepEqual(k.topWorksites.map((c) => [c.id, c.amountCents]), [["W1", BigInt("900000")], ["W2", BigInt("500000")]])
  })
  it("ventilations complètes : mois, clients et chantiers somment exactement au total", () => {
    const sum = (rs: { amountCents: bigint }[]) => rs.reduce((t, r) => t + r.amountCents, BigInt("0"))
    assert.equal(sum(k.revenue.byMonth), k.revenue.totalCents)
    assert.equal(sum(k.revenue.byClient), k.revenue.totalCents)
    assert.equal(sum(k.revenue.byWorksite), k.revenue.totalCents)
  })
  it("articles : lignes du catalogue des pièces émises de la période, avoir déduit ; ligne d'acompte et pièces exclues ignorées", () => {
    assert.deepEqual(k.topArticles.map((a) => [a.id, a.amountCents, a.quantityMilli]), [["Y", BigInt("600000"), BigInt("7000")], ["X", BigInt("500000"), BigInt("9000")]])
  })
  it("sans devis décidé : taux indéfinis ; sans donnée : tout à zéro", () => {
    const empty = computeSalesIndicators({ quotes: [{ status: "SENT", issueDate: day("2026-02-01"), totalHTCents: BigInt("1") }], invoices: [], lines: [] }, Y2026)
    assert.equal(empty.quotes.conversionBp, null)
    assert.equal(empty.quotes.conversionValueBp, null)
    assert.equal(empty.revenue.totalCents, BigInt("0"))
    assert.deepEqual(empty.topArticles, [])
  })
})

describe("revue indépendante D : acompte, solde, avoirs, articles", () => {
  const inv = (id: string, kind: "INVOICE" | "DEPOSIT" | "CREDIT_NOTE", cents: string, issueDate = day("2026-06-10"), client = "C", site = "W") =>
    ({ id, kind, issued: true, issueDate, totalHTCents: BigInt(cents), clientId: client, clientName: `Client ${client}`, worksiteId: site, worksiteName: `Chantier ${site}` })
  const ln = (invoiceId: string, articleId: string | null, qty: string, cents: string, deductsDeposit = false) =>
    ({ invoiceId, articleId, deductsDeposit, designation: articleId ?? "texte", quantityMilli: BigInt(qty), lineHTCents: BigInt(cents) })
  it("acompte 300 + solde net 700 = 1 000 ; l'article du solde compté une seule fois, hors déduction ; acompte avec article ignoré", () => {
    const f: SalesFacts = {
      quotes: [],
      invoices: [inv("dep", "DEPOSIT", "30000"), inv("sol", "INVOICE", "70000")],
      lines: [
        ln("dep", "ART", "1000", "30000"), // un acompte portant un article (cas forgé) : jamais une vente d'article
        ln("sol", "ART", "10000", "100000"), ln("sol", null, "1000", "-30000", true), // ligne de déduction d'acompte, sans article
        ln("sol", "ART", "1000", "5000", true), // ligne de déduction forgée portant un article : exclue quand même
      ],
    }
    const r = computeSalesIndicators(f, Y2026)
    assert.equal(r.revenue.totalCents, BigInt("100000"), "1 000,00 et jamais 1 300,00")
    assert.deepEqual([r.revenue.invoicesCount, r.revenue.depositsCount], [1, 1])
    assert.deepEqual(r.topArticles.map((a) => [a.id, a.amountCents, a.quantityMilli]), [["ART", BigInt("100000"), BigInt("10000")]], "montant HT de ligne hors déduction, une seule fois")
  })
  it("avoir partiel (sans article dans la facturation) : CA réduit, classement des articles inchangé ; avoir total : article et CA ramenés à zéro", () => {
    const partial: SalesFacts = { quotes: [], invoices: [inv("f", "INVOICE", "100000"), inv("ap", "CREDIT_NOTE", "10000")], lines: [ln("f", "ART", "10000", "100000"), ln("ap", null, "1000", "10000")] }
    const p = computeSalesIndicators(partial, Y2026)
    assert.equal(p.revenue.totalCents, BigInt("90000"))
    assert.deepEqual(p.topArticles.map((a) => [a.id, a.amountCents]), [["ART", BigInt("100000")]], "aucune attribution inventée de l'avoir partiel à l'article")
    const total: SalesFacts = { quotes: [], invoices: [inv("f", "INVOICE", "100000"), inv("at", "CREDIT_NOTE", "100000")], lines: [ln("f", "ART", "10000", "100000"), ln("at", "ART", "10000", "100000")] }
    const t = computeSalesIndicators(total, Y2026)
    assert.equal(t.revenue.totalCents, BigInt("0"), "facture annulée et son avoir : contribution nette nulle")
    assert.deepEqual(t.topArticles, [], "article ramené à zéro, non classé")
    assert.deepEqual(t.topClients, [], "client à solde nul non classé")
    assert.deepEqual(t.revenue.byClient.map((c) => [c.id, c.amountCents]), [["C", BigInt("0")]], "mais présent, à zéro, dans la ventilation complète")
  })
  it("quantité et montant indépendants : plus grosse quantité ≠ plus gros montant", () => {
    const f: SalesFacts = { quotes: [], invoices: [inv("f", "INVOICE", "0")], lines: [ln("f", "VIS", "500000", "5000"), ln("f", "CHAUD", "1000", "450000")] }
    const r = computeSalesIndicators(f, Y2026)
    assert.deepEqual(r.topArticles.map((a) => [a.id, a.amountCents, a.quantityMilli]), [["CHAUD", BigInt("450000"), BigInt("1000")], ["VIS", BigInt("5000"), BigInt("500000")]])
  })
  it("mois en heure de Paris aux changements d'heure ; grandes valeurs exactes au centime", () => {
    const big = "900719925474099312" // > 2^53 centimes : aucun passage par un flottant
    const f: SalesFacts = { quotes: [], invoices: [
      inv("m1", "INVOICE", "100", new Date("2026-03-31T22:30:00Z")), // 1er avril 00 h 30 à Paris (heure d'été) ⇒ avril
      inv("m2", "INVOICE", "200", new Date("2026-10-31T23:30:00Z")), // 1er novembre 00 h 30 à Paris (heure d'hiver) ⇒ novembre
      inv("m3", "INVOICE", "300", new Date("2026-03-29T00:30:00Z")), // nuit du changement d'heure ⇒ mars
      inv("m4", "INVOICE", big, day("2026-07-01")),
    ], lines: [] }
    const r = computeSalesIndicators(f, Y2026)
    const m = Object.fromEntries(r.revenue.byMonth.map((x) => [x.month, x.amountCents]))
    assert.deepEqual([m["2026-03"], m["2026-04"], m["2026-07"], m["2026-10"], m["2026-11"]], [BigInt("300"), BigInt("100"), BigInt(big), BigInt("0"), BigInt("200")])
    assert.equal(r.revenue.totalCents, BigInt(big) + BigInt("600"))
  })
  it("taux : dénominateur nul affiché indéfini, jamais 0 % ; en nombre et en montant séparément", () => {
    const only = computeSalesIndicators({ quotes: [
      { status: "ACCEPTED", issueDate: day("2026-02-01"), totalHTCents: BigInt("100") },
      { status: "REFUSED", issueDate: day("2026-02-02"), totalHTCents: BigInt("900") },
    ], invoices: [], lines: [] }, Y2026)
    assert.deepEqual([only.quotes.conversionBp, only.quotes.conversionValueBp], [5000, 1000])
    const none = computeSalesIndicators({ quotes: [], invoices: [], lines: [] }, Y2026)
    assert.deepEqual([none.quotes.conversionBp, none.quotes.conversionValueBp], [null, null])
  })
})

describe("périodes et utilitaires", () => {
  it("année civile ; 12 derniers mois civils jusqu'au jour courant inclus ; passage d'année à Paris", () => {
    assert.deepEqual([Y2026.from.toISOString(), Y2026.to.toISOString()], ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"])
    const r = periodFor(null, new Date("2026-11-04T10:00:00Z"))
    assert.deepEqual([r.from.toISOString(), r.to.toISOString()], ["2025-12-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"])
    assert.deepEqual(monthsOf(r), ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"])
    const nye = periodFor("", new Date("2026-12-31T23:30:00Z"))
    assert.deepEqual([nye.from.toISOString(), nye.to.toISOString()], ["2026-02-01T00:00:00.000Z", "2027-01-02T00:00:00.000Z"])
    assert.equal(periodFor("1999", new Date("2026-11-04T10:00:00Z")).label, "12 derniers mois", "année hors motif ignorée")
  })
  it("quantité décimale → millièmes sans flottant ; points de base", () => {
    assert.equal(decimalToMilli("2.50"), BigInt("2500"))
    assert.equal(decimalToMilli("-0.125"), -BigInt("125"))
    assert.throws(() => decimalToMilli("1e3"), RangeError)
    assert.equal(ratioBp(BigInt("1"), BigInt("3")), 3333)
    assert.equal(ratioBp(BigInt("1"), BigInt("0")), null)
  })
})
