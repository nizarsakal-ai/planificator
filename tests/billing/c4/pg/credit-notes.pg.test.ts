// Lot C4 — tests PostgreSQL : avoirs partiels (par lignes, par montant), plafond relu sous verrou et au COMMIT, reste à payer
// et statut de l'origine (soldée par avoir), avoir total après partiel refusé, isolation, immutabilité, compatibilité Lot B.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote, creditedPartialCents } from "@/lib/billing/invoices/credit-note.service"
import { getInvoiceDetail, invoiceSummary, listInvoices } from "@/lib/billing/invoices/invoice-queries"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const now = new Date("2026-03-10T10:00:00Z")
const ids: Record<string, string> = {}
const js = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }
async function issued(lines: { designation: string; quantity: string; unitPrice: string; vatRate: string; discount?: string }[], globalDiscount = "") {
  const p = parseInvoiceForm({ worksiteId: "wA", lines, globalDiscount }); if (!p.ok) throw new Error(p.error)
  const d = await createDraftInvoice(db, A, p.value, now); if (!d.ok) throw new Error(d.error)
  const r = await issueInvoice(db, A, d.value.id, now); if (!r.ok) throw new Error(r.error)
  return d.value.id
}
const totalNote = (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], invoiceId: string) => createCreditNoteCore(tx, { companyId: "coA", invoiceId, actorId: "admA", reason: null, now, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) })

before(async () => {
  setBillingClockForTests(() => now) // R3 : horloge de décision déterministe dans les tests
  setBillingMailerForTests(new RecordingMailer())
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b','98765432100011','2 rue B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test','10 rue',now()),('clB','coB','Client B','client-b@example.test','11 rue',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wB','coB','clB','admB','Maison B',now())`)
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("Avoirs partiels", () => {
  it("par lignes : AV-2026-0001 émis immédiatement, origine inchangée, reste à payer réduit ; motif obligatoire ; société B refusée", async () => {
    // Facture : 10 × 50 à 20 % + 2 × 100 (−5 %) à 10 %, remise globale 10 % ⇒ HT 621, TVA 90 + 17,10 ⇒ TTC 728,10
    ids.inv = await issued([{ designation: "Pose", quantity: "10", unitPrice: "50", vatRate: "20" }, { designation: "Fournitures", quantity: "2", unitPrice: "100", vatRate: "10", discount: "5" }], "10")
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: ids.inv, designation: "Pose" } })
    const req = { kind: "LINES" as const, items: [{ lineId: line.id, quantityHundredths: BigInt(400) }] }
    assert.equal((await createPartialCreditNote(db, A, ids.inv, req, "x", now)).ok, false)
    assert.deepEqual(await createPartialCreditNote(db, B, ids.inv, req, "erreur", now), { ok: false, error: "Facture introuvable." })
    const r = await createPartialCreditNote(db, A, ids.inv, req, "Prestation non réalisée", now)
    assert.ok(r.ok, js(r)); if (!r.ok) return
    ids.cn1 = r.value.id
    // 4 × 50 = 200 ; −10 % = 180 ; TVA 36 ⇒ 216
    assert.equal(r.value.number, "AV-2026-0001"); assert.equal(r.value.ttcCents, BigInt(21600)); assert.equal(r.value.originStatus, "SENT")
    const n = await db.invoice.findUniqueOrThrow({ where: { id: ids.cn1 }, include: { lines: true } })
    assert.equal(n.kind, "CREDIT_NOTE"); assert.equal(n.creditScope, "PARTIAL"); assert.equal(n.status, "SENT"); assert.equal(n.creditedInvoiceId, ids.inv); assert.equal(n.creditReason, "Prestation non réalisée"); assert.equal(n.lines[0].designation, "Avoir — Pose")
    const o = await db.invoice.findUniqueOrThrow({ where: { id: ids.inv } })
    assert.equal(o.status, "SENT"); assert.equal(o.totalTTC.toFixed(2), "728.10")
    const det = await getInvoiceDetail(db, "coA", ids.inv)
    assert.equal(det?.creditedPartialCents, BigInt(21600)); assert.equal(det?.remainingCents, BigInt(72810 - 21600))
    assert.equal((await listInvoices(db, "coA", {})).rows.find((x) => x.id === ids.inv)?.remainingCents, BigInt(72810 - 21600))
    const pdf = await buildInvoicePdfData(db, "coA", ids.cn1)
    assert.equal(pdf?.title, "AVOIR"); assert.ok(pdf?.extraBlocks?.some((b) => b.rows.some((x) => /Motif : Prestation non réalisée/.test(x))))
  })
  it("par montant HT : ventilé par taux ; plafond : avoir > restant créditable refusé ; concurrence : un seul des deux passe ; avoir total refusé après partiel", async () => {
    const r = await createPartialCreditNote(db, A, ids.inv, { kind: "AMOUNT_HT", cents: BigInt(10000) }, "Remise commerciale", now)
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.value.number, "AV-2026-0002")
    const credited = await creditedPartialCents(db, "coA", ids.inv)
    assert.equal(credited, BigInt(21600) + r.value.ttcCents)
    const remainingCreditable = BigInt(72810) - credited
    assert.equal((await createPartialCreditNote(db, A, ids.inv, { kind: "AMOUNT_HT", cents: BigInt(62100) }, "trop", now)).ok, false)
    // Deux avoirs concurrents du restant exact en HT net ⇒ un seul.
    const ht = (remainingCreditable * BigInt(10000)) / BigInt(11500) // approximation HT (taux mixtes) ; le plafond se joue sur le TTC
    void ht
    const results = await Promise.all([createPartialCreditNote(db, A, ids.inv, { kind: "AMOUNT_HT", cents: BigInt(30000) }, "concurrent 1", now), createPartialCreditNote(db, A, ids.inv, { kind: "AMOUNT_HT", cents: BigInt(30000) }, "concurrent 2", now)])
    assert.equal(results.filter((x) => x.ok).length, 1, js(results))
    const total = await db.$transaction(async (tx) => { const t = await totalNote(tx, ids.inv); return t })
    assert.equal(total.ok, false)
  })
  it("soldée par avoir : reste 0 ⇒ PAID ; trop-perçu refusé ; paiements conservés ; SQL direct au-delà du plafond refusé au COMMIT ; avoir partiel immuable", async () => {
    const inv = await issued([{ designation: "Petit", quantity: "1", unitPrice: "100", vatRate: "20" }])
    assert.ok((await recordPayment(db, A, inv, { amountCents: BigInt(6000), method: "CASH", paidAt: now, reference: null, notes: null }, now)).ok)
    // 60 payés : un avoir de 70 € TTC (58,33 HT) dépasserait le reste à payer (60) ⇒ refus explicite avant toute écriture.
    const tooMuch = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(5834) }, "trop", now)
    assert.equal(tooMuch.ok, false); assert.match((tooMuch as { error: string }).error, /reste à payer/)
    assert.equal(await db.invoice.count({ where: { creditedInvoiceId: inv } }), 0)
    const det0 = await getInvoiceDetail(db, "coA", inv)
    assert.equal(det0?.creditableCents, BigInt(6000))
    const r = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "Solde par avoir", now)
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.value.originStatus, "PAID")
    const o = await db.invoice.findUniqueOrThrow({ where: { id: inv } })
    assert.equal(o.status, "PAID"); assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 1)
    assert.equal((await invoiceSummary(db, "coA")).collectedCents >= BigInt(6000), true)
    assert.match(await sqlError(`UPDATE invoices SET "creditReason"='x' WHERE id='${r.value.id}'`), /INVOICE_IMMUTABLE/)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('cnx','coA','wA','clA','AV-x','admA',now(),'DRAFT','CREDIT_NOTE','PARTIAL','${inv}',100,20,120)`)
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='cnx'`)
      await flushDeferredConstraints(tx)
    }), /PARTIAL_CREDIT_EXCEEDS/)
  })
  it("acompte : avoir partiel refusé (double crédit avec la déduction) ; relance manuelle et courrier nets des avoirs", async () => {
    const { parseQuoteForm } = await import("@/lib/billing/quotes/quote-schemas")
    const { acceptQuoteManually, createQuote, sendQuote } = await import("@/lib/billing/quotes/quote.service")
    const { createDepositInvoice } = await import("@/lib/billing/invoices/deposit.service")
    const { sendInvoiceMail } = await import("@/lib/billing/invoices/invoice.service")
    const q = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", lines: [{ designation: "T", quantity: "1", unitPrice: "300", vatRate: "20" }] }); assert.ok(q.ok); if (!q.ok) return
    const cq = await createQuote(db, A, q.value); assert.ok(cq.ok); if (!cq.ok) return
    await sendQuote(db, A, cq.value.id, now); await acceptQuoteManually(db, A, cq.value.id, now)
    const dep = await createDepositInvoice(db, A, cq.value.id, { kind: "PERCENT", bp: 5000 }, now); assert.ok(dep.ok); if (!dep.ok) return
    assert.ok((await issueInvoice(db, A, dep.value.id, now)).ok)
    const r = await createPartialCreditNote(db, A, dep.value.id, { kind: "AMOUNT_HT", cents: BigInt(1000) }, "sur acompte", now)
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /acompte/)
    const mail = await sendInvoiceMail(db, A, ids.inv)
    assert.ok(mail.ok)
    const det = await getInvoiceDetail(db, "coA", ids.inv)
    const { RecordingMailer: RM, getBillingMailer } = await import("@/lib/billing/mail/mailer")
    const m = getBillingMailer() as InstanceType<typeof RM>
    assert.ok(m.sent.at(-1)?.text.includes(`Reste à payer : ${(Number(det?.remainingCents) / 100).toFixed(2).replace(".", ",")}`.replace(/(\d)(?=(\d{3})+,)/g, "$1\u202f")), m.sent.at(-1)?.text)
  })
  it("avoir total (Lot B) seul : toujours possible, copie exacte, portée TOTAL ; puis avoir partiel refusé", async () => {
    const inv = await issued([{ designation: "Seul", quantity: "1", unitPrice: "80", vatRate: "20" }])
    const t = await db.$transaction(async (tx) => { const r = await totalNote(tx, inv); await flushDeferredConstraints(tx); return r })
    assert.ok(t.ok); if (!t.ok) return
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: t.value.id } })).creditScope, "TOTAL")
    assert.deepEqual(await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(100) }, "après total", now), { ok: false, error: "Seule une facture émise (envoyée, partiellement ou totalement payée) peut faire l'objet d'un avoir." })
  })
})
