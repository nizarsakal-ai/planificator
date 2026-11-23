/**
 * Lot D Planificator V2 : indicateurs commerciaux lus sur une base PostgreSQL JETABLE. Toutes les pièces sont produites
 * par les VRAIS services de facturation (aucune modification de Finance, aucune pièce fabriquée en SQL) :
 * - devis avec une ligne d'ARTICLE, envoyé puis accepté ; acompte 30 % émis ; conversion en facture de solde ; déduction
 *   réelle de l'acompte (lignes négatives) ; solde NET 700 émis ⇒ CA 1 000, jamais 1 300 ;
 * - avoir PARTIEL de 100 HT sur le solde ⇒ CA 900. Dans la facturation actuelle, un avoir partiel ne porte AUCUN article :
 *   il réduit le CA mais pas le classement des articles (cas réel documenté, aucune attribution inventée) ;
 * - facture d'article émise puis AVOIR TOTAL (origine CANCELLED, toujours émise) ⇒ contribution nette 0, au CA comme à
 *   l'article (l'avoir total recopie les articles) ;
 * - brouillon exclu ; ventilations complètes (mois, clients, chantiers) égales au total ; isolation entre sociétés.
 * Mêmes oracles que le « facturé » du lot C (tests/budget/pg/budget-service.pg.test.ts), recalculés ici sur les sorties D,
 * sans rejouer le test C. Identifiants : ceux des aides de facturation (coA, coB) — propres à ce fichier parmi ceux du
 * lot D, qui partagent la même base jetable.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { applyDepositDeductions } from "@/lib/billing/invoices/deposit.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { salesIndicators } from "@/lib/sales-dashboard/queries"
import { periodFor } from "@/lib/sales-dashboard/sales.core"
import { A, B, NOW, seedCompanies, useTestClock } from "../../billing/fix/pg/helpers"
import { acceptedQuote, finalDraft, issue, issuedDeposit, issuedInvoice, type QuoteLineForm } from "../../billing/fix/pg/fixtures"

const db = new PrismaClient()
const Y = periodFor("2026", NOW)
const line = (designation: string, quantity: string, unitPrice: string, articleId?: string) => ({ designation, quantity, unitPrice, vatRate: "20", ...(articleId ? { articleId } : {}) }) as QuoteLineForm
const sum = (rs: { amountCents: bigint }[]) => rs.reduce((t, r) => t + r.amountCents, BigInt(0))
const at: Record<string, bigint> = {}
let finalId = "", depositId = ""

async function totalCreditNote(invoiceId: string) {
  await db.$transaction(async (tx) => {
    const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId, actorId: A.userId, reason: "annulation", now: NOW, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) })
    assert.ok(r.ok, r.ok ? "" : r.error)
    await flushDeferredConstraints(tx)
  })
}

before(async () => {
  useTestClock()
  setBillingMailerForTests(new RecordingMailer())
  await seedCompanies(db)
  await db.$executeRawUnsafe(`INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","updatedAt") VALUES ('artA','coA','Enduit 25 kg','sac',100,now())`)
  // Correctif D r1 (preuves d1) : la facturation exige l'adresse du client pour émettre (règle Finance, non modifiée).
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA2','coA','Client A2','client-a2@example.test','12 rue du Client A2',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA2','coA','clA2','admA','Maison A2',now())`)
  // 1. Devis 10 × 100,00 (article), accepté ; acompte 30 % émis ; solde converti, acompte déduit par le service réel, émis.
  const quoteId = await acceptedQuote(db, A, "wA", [line("Enduit 25 kg", "10", "100.00", "artA")])
  depositId = await issuedDeposit(db, A, quoteId, { kind: "PERCENT", bp: 3000 })
  finalId = await finalDraft(db, A, quoteId)
  const d = await applyDepositDeductions(db, A, finalId); assert.ok(d.ok, d.ok ? "" : d.error)
  await issue(db, A, finalId)
  at.afterBalance = (await salesIndicators(db, "coA", Y)).revenue.totalCents
  // 2. Avoir partiel 100,00 HT sur le solde (par montant : aucun article porté par l'avoir, comportement Finance actuel).
  const p = await createPartialCreditNote(db, A, finalId, { kind: "AMOUNT_HT", cents: BigInt(10_000) }, "Remise commerciale", NOW)
  assert.ok(p.ok, p.ok ? "" : p.error)
  at.afterPartial = (await salesIndicators(db, "coA", Y)).revenue.totalCents
  // 3. Facture d'article 2 × 60,00 émise puis annulée par avoir total.
  const cancelled = await issuedInvoice(db, A, "wA", [line("Enduit 25 kg", "2", "60.00", "artA")])
  at.withCancelledIssued = (await salesIndicators(db, "coA", Y)).revenue.totalCents
  await totalCreditNote(cancelled)
  // 4. Facture 50,00 sur un autre client et chantier ; brouillon 999,00 jamais émis.
  await issuedInvoice(db, A, "wA2", [line("Pose", "1", "50.00")])
  const draft = parseInvoiceForm({ worksiteId: "wA", lines: [line("Brouillon", "1", "999.00")], globalDiscount: "", vatReverseCharge: false })
  assert.ok(draft.ok)
  if (draft.ok) assert.ok((await createDraftInvoice(db, A, draft.value, NOW)).ok)
  // Société B : une facture émise de 999,99, qui ne doit jamais apparaître chez A.
  await issuedInvoice(db, B, "wB", [line("Autre", "1", "999.99")])
})
after(() => { setBillingMailerForTests(null); return db.$disconnect() })

describe("indicateurs commerciaux sur PostgreSQL (vrais services Finance)", () => {
  it("pièces réelles conformes au scénario : acompte sans article, déduction négative sans article, solde net 700", async () => {
    const dep = await db.invoice.findUniqueOrThrow({ where: { id: depositId }, select: { kind: true, totalHT: true, sentAt: true, lines: { select: { articleId: true } } } })
    assert.equal(dep.kind, "DEPOSIT"); assert.equal(dep.totalHT.toFixed(2), "300.00"); assert.ok(dep.sentAt)
    assert.ok(dep.lines.every((l) => l.articleId === null), "l'acompte ne porte aucun article")
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: finalId }, select: { totalHT: true, lines: { select: { articleId: true, deductsDepositId: true, lineHT: true } } } })
    assert.equal(fin.totalHT.toFixed(2), "700.00", "solde NET de l'acompte")
    const deduction = fin.lines.filter((l) => l.deductsDepositId !== null)
    assert.ok(deduction.length >= 1 && deduction.every((l) => Number(l.lineHT) < 0 && l.articleId === null), "lignes de déduction négatives, sans article")
    assert.deepEqual(fin.lines.filter((l) => l.articleId === "artA").map((l) => l.lineHT.toFixed(2)), ["1000.00"], "ligne d'article recopiée du devis")
  })
  it("CA : acompte 300 + solde net 700 = 1 000 ; avoir partiel 100 ⇒ 900 ; facture annulée par avoir total : contribution nette 0", () => {
    assert.equal(at.afterBalance, BigInt(100_000), "1 000,00 et jamais 1 300,00")
    assert.equal(at.afterPartial, BigInt(90_000))
    assert.equal(at.withCancelledIssued, BigInt(90_000) + BigInt(12_000), "facture émise comptée avant son annulation")
  })
  it("état final : 950,00 = 900,00 + 50,00 ; brouillon exclu ; comptes par nature", async () => {
    const k = await salesIndicators(db, "coA", Y)
    assert.equal(k.revenue.totalCents, BigInt(95_000), "+120 − 120 de la facture annulée ; brouillon 999 exclu")
    assert.deepEqual([k.revenue.invoicesCount, k.revenue.depositsCount, k.revenue.creditNotesCount], [3, 1, 2])
  })
  it("ventilations complètes : mois, clients et chantiers somment exactement au total", async () => {
    const k = await salesIndicators(db, "coA", Y)
    assert.equal(sum(k.revenue.byMonth), k.revenue.totalCents)
    assert.equal(sum(k.revenue.byClient), k.revenue.totalCents)
    assert.equal(sum(k.revenue.byWorksite), k.revenue.totalCents)
    assert.deepEqual(k.revenue.byClient.map((c) => [c.id, c.amountCents]), [["clA", BigInt(90_000)], ["clA2", BigInt(5_000)]])
    assert.deepEqual(k.revenue.byWorksite.map((w) => [w.id, w.amountCents]), [["wA", BigInt(90_000)], ["wA2", BigInt(5_000)]])
    assert.equal(k.revenue.byMonth.find((m) => m.month === "2026-03")?.amountCents, BigInt(95_000))
  })
  it("articles : ligne du solde comptée une fois, hors déduction ; acompte exclu ; avoir total déduit ; avoir partiel sans article sans effet (documenté)", async () => {
    const k = await salesIndicators(db, "coA", Y)
    assert.deepEqual(k.topArticles.map((a) => [a.id, a.amountCents, a.quantityMilli]), [["artA", BigInt(100_000), BigInt(10_000)]],
      "10 × 100,00 du solde ; +2 × 60,00 puis −2 × 60,00 (avoir total) ; ni l'acompte ni la déduction ; l'avoir partiel (sans article) ne réduit pas l'article")
    assert.notEqual(sum(k.topArticles), k.revenue.totalCents, "la somme des articles n'est pas le CA net : aucune égalité imposée")
  })
  it("devis accepté par le service : émis et signé, transformation 100 %", async () => {
    const k = await salesIndicators(db, "coA", Y)
    assert.deepEqual([k.quotes.emitted, k.quotes.signed, k.quotes.signedCents, k.quotes.conversionBp], [1, 1, BigInt(100_000), 10000])
  })
  it("isolation : B ne voit que sa facture, A jamais celle de B", async () => {
    const b = await salesIndicators(db, "coB", Y)
    assert.equal(b.revenue.totalCents, BigInt(99_999))
    assert.deepEqual(b.topClients.map((c) => c.id), ["clB"])
    assert.deepEqual(b.topArticles, [])
    const a = await salesIndicators(db, "coA", Y)
    assert.ok(!a.revenue.byClient.some((c) => c.id === "clB"))
  })
  it("hors période : année 2025 vide", async () => {
    const k = await salesIndicators(db, "coA", periodFor("2025", NOW))
    assert.deepEqual([k.revenue.totalCents, k.quotes.emitted], [BigInt(0), 0])
  })
})
