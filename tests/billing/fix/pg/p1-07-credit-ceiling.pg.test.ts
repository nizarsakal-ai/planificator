// P1-07 — Invariant SQL central paiements/avoirs sur l'ORIGINE, sous verrou, pour tout événement (paiement, contre-passation, avoir),
// exécuté avec le RÔLE APPLICATIF non propriétaire (déclencheurs non désactivables), SQL direct sans mise à jour de l'origine.
// Invariants : paiements nets ≥ 0 ; paiements nets + avoirs partiels émis ≤ TTC ; statut cohérent ; PAID héritée sans paiement
// tolérée uniquement sans avoir partiel ; avoir partiel sur acompte interdit ; TOTAL et PARTIAL exclusifs ; avoir total exact toujours possible.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient, type Prisma } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { CREDIT_ERRORS, createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { A, NOW, appClient, currentRole, holdTransaction, js, seedCompanies, sqlError, useTestClock } from "./helpers"
import { acceptedQuote, issuedDeposit, issuedInvoice } from "./fixtures"

const owner = new PrismaClient()
const app = appClient()      // rôle applicatif (session 1)
const app2 = appClient()     // rôle applicatif (session 2, connexion indépendante)
let seq = 0
const nid = () => `n${++seq}`

/** Avoir partiel inséré en SQL direct (brouillon puis émis), SANS mise à jour de l'origine ; renvoie la fonction à exécuter dans une tx. */
function sqlPartialNote(tx: Prisma.TransactionClient, originId: string, noteId: string, ht: string, vat: string, ttc: string, scope: "PARTIAL" | "TOTAL" = "PARTIAL") {
  return (async () => {
    await tx.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC","issueDate") VALUES ('${noteId}','coA','wA','clA','AV-SQL-${noteId}','admA',now(),'DRAFT','CREDIT_NOTE','${scope}','${originId}',${ht},${vat},${ttc},'2026-03-10')`)
    await tx.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('${noteId}-l','${noteId}','Avoir SQL',1,${ht},20,${ht})`)
    await tx.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='${noteId}'`)
  })()
}
const attempt = (client: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<void>) => client.$transaction(async (tx) => { await fn(tx); await flushDeferredConstraints(tx) })

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setBillingMailerForTests(new RecordingMailer())
  await seedCompanies(owner)
  assert.equal(await currentRole(app), "planificator_app_test")
  // Le rôle applicatif ne peut ni désactiver les déclencheurs ni modifier le schéma.
  assert.match(await sqlError(app, `ALTER TABLE invoices DISABLE TRIGGER invoices_payments_status_check_trg`), /must be owner|permission denied|doit être le propriétaire/i)
})
after(async () => { setBillingMailerForTests(null); await owner.$disconnect(); await app.$disconnect(); await app2.$disconnect() })

describe("P1-07 — plafond central (rôle applicatif, SQL direct)", () => {
  it("facture PAID 120 € avec 120 € de paiements : insertion DRAFT puis émission PARTIAL 60 € sans UPDATE de l'origine ⇒ échec différé visible et rollback complet", async () => {
    const inv = await issuedInvoice(owner, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    assert.ok((await recordPayment(owner, A, inv, { amountCents: BigInt(12000), method: "TRANSFER", paidAt: NOW, reference: null, notes: null }, NOW)).ok)
    assert.equal((await owner.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PAID")
    const id = nid()
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, inv, id, "50", "10", "60")), /PAYMENT_EXCEEDS_TOTAL/)
    assert.equal(await owner.invoice.count({ where: { id } }), 0); assert.equal(await owner.invoiceLine.count({ where: { invoiceId: id } }), 0)
    // Sans flush explicite : le COMMIT lui-même est refusé par PostgreSQL (Prisma peut masquer l'erreur) — les lignes réellement persistées font foi.
    const id2 = nid()
    await app.$transaction((tx) => sqlPartialNote(tx, inv, id2, "50", "10", "60")).catch(() => undefined)
    assert.equal(await owner.invoice.count({ where: { id: id2 } }), 0, "aucun avoir persisté")
    assert.deepEqual(await owner.invoice.findUnique({ where: { id: inv }, select: { status: true, totalTTC: true } }).then((r) => [r?.status, r?.totalTTC.toFixed(2)]), ["PAID", "120.00"])
  })
  it("origine payée 60 € : avoir 60 € accepté (métier ⇒ PAID soldée par avoir ; SQL direct avec état final cohérent) ; 60,01 € refusé ; 60 € SQL sans mise à jour du statut ⇒ incohérence refusée", async () => {
    const invA = await issuedInvoice(owner, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    assert.ok((await recordPayment(owner, A, invA, { amountCents: BigInt(6000), method: "CASH", paidAt: NOW, reference: null, notes: null }, NOW)).ok)
    const tooMuch = await createPartialCreditNote(owner, A, invA, { kind: "AMOUNT_HT", cents: BigInt(5001) }, "trop", NOW) // 50,01 HT ⇒ 60,01 TTC
    assert.equal(tooMuch.ok, false); assert.equal((tooMuch as { error: string }).error, CREDIT_ERRORS.exceedsPaid)
    const exact = await createPartialCreditNote(owner, A, invA, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "solde", NOW)
    assert.ok(exact.ok, js(exact)); assert.equal((exact as { value: { originStatus: string } }).value.originStatus, "PAID")
    // SQL direct sur une seconde origine payée 60.
    const invB = await issuedInvoice(owner, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    assert.ok((await recordPayment(owner, A, invB, { amountCents: BigInt(6000), method: "CASH", paidAt: NOW, reference: null, notes: null }, NOW)).ok)
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, invB, nid(), "50.01", "10", "60.01")), /PAYMENT_EXCEEDS_TOTAL/)
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, invB, nid(), "50", "10", "60")), /PAYMENT_STATUS_MISMATCH/, "60 + 60 = TTC mais origine laissée PARTIAL : état final incohérent refusé")
    const ok = nid()
    await attempt(app, async (tx) => { await sqlPartialNote(tx, invB, ok, "50", "10", "60"); await tx.$executeRawUnsafe(`UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='${invB}' AND status='PARTIAL'`) })
    assert.equal((await owner.invoice.findUniqueOrThrow({ where: { id: invB } })).status, "PAID")
    assert.equal(await owner.invoice.count({ where: { creditedInvoiceId: invB, status: "SENT" } }), 1)
  })
  it("PAID héritée sans ligne de paiement : avoir partiel refusé (métier et SQL) — la tolérance n'est pas un contournement ; avoir total exact possible", async () => {
    const legacy = await issuedInvoice(owner, A, "wA", [{ designation: "L", quantity: "1", unitPrice: "100", vatRate: "20" }])
    await owner.$executeRawUnsafe(`UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='${legacy}'`) // chemin Lot B : règlement constaté
    const r = await createPartialCreditNote(owner, A, legacy, { kind: "AMOUNT_HT", cents: BigInt(1000) }, "geste", NOW)
    assert.deepEqual(r, { ok: false, error: CREDIT_ERRORS.settledOutside })
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, legacy, nid(), "10", "2", "12")), /PAYMENT_STATUS_MISMATCH/)
    assert.equal(await owner.invoice.count({ where: { creditedInvoiceId: legacy } }), 0)
    const total = await owner.$transaction(async (tx) => { const t = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: legacy, actorId: "admA", reason: null, now: NOW, nextNumber: (x) => nextDocumentNumber(x, "coA", "CREDIT_NOTE", 2026) }); if (t.ok) await flushDeferredConstraints(tx); return t })
    assert.ok(total.ok, js(total))
  })
  it("acompte : avoir partiel refusé en SQL ; TOTAL après PARTIAL et PARTIAL après TOTAL refusés ; avoir total exact toujours possible", async () => {
    const quote = await acceptedQuote(owner, A, "wA", [{ designation: "T", quantity: "1", unitPrice: "300", vatRate: "20" }])
    const dep = await issuedDeposit(owner, A, quote, { kind: "PERCENT", bp: 5000 })
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, dep, nid(), "10", "2", "12")), /PARTIAL_CREDIT_INVALID.*acompte/)
    const inv = await issuedInvoice(owner, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const partial = await createPartialCreditNote(owner, A, inv, { kind: "AMOUNT_HT", cents: BigInt(1000) }, "partiel", NOW); assert.ok(partial.ok)
    // TOTAL après PARTIAL (SQL : annulation de l'origine + copie exacte) refusé.
    const full = await owner.invoice.findUniqueOrThrow({ where: { id: inv }, include: { lines: true } })
    await assert.rejects(attempt(app, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='CANCELLED' WHERE id='${inv}'`)
      const id = nid()
      await tx.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('${id}','coA','wA','clA','AV-T-${id}','admA',now(),'DRAFT','CREDIT_NOTE','TOTAL','${inv}',${full.totalHT},${full.totalVAT},${full.totalTTC})`)
      await tx.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,unit,quantity,"unitPrice","vatRate","lineHT",position) SELECT '${id}-'||id,'${id}',designation,unit,quantity,"unitPrice","vatRate","lineHT",position FROM invoice_lines WHERE "invoiceId"='${inv}'`)
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='${id}'`)
    }), /CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE/)
    assert.equal((await owner.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "SENT")
    // PARTIAL après TOTAL refusé.
    const inv2 = await issuedInvoice(owner, A, "wA", [{ designation: "P2", quantity: "1", unitPrice: "80", vatRate: "20" }])
    const t = await owner.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: inv2, actorId: "admA", reason: null, now: NOW, nextNumber: (x) => nextDocumentNumber(x, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r })
    assert.ok(t.ok)
    await assert.rejects(attempt(app, (tx) => sqlPartialNote(tx, inv2, nid(), "10", "2", "12")), /PARTIAL_CREDIT_INVALID/)
  })
  it("concurrence à deux sessions applicatives (barrières) : deux avoirs, paiement vs avoir, contre-passation vs avoir ⇒ plafond global respecté, aucun write skew", async () => {
    // Deux avoirs partiels SQL de 70 sur une facture 120 non payée : la première commit, la seconde est refusée au COMMIT (verrou de l'origine).
    const inv = await issuedInvoice(owner, A, "wA", [{ designation: "C", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const s1 = await holdTransaction(app), s2 = await holdTransaction(app2)
    await sqlPartialNote(s1.tx, inv, nid(), "58.34", "11.66", "70")
    await sqlPartialNote(s2.tx, inv, nid(), "58.34", "11.66", "70")
    await flushDeferredConstraints(s1.tx); await s1.commit()
    await assert.rejects(flushDeferredConstraints(s2.tx), /PAYMENT_EXCEEDS_TOTAL|PARTIAL_CREDIT_EXCEEDS/)
    await s2.rollback()
    assert.equal(await owner.invoice.count({ where: { creditedInvoiceId: inv, status: "SENT" } }), 1)
    // Paiement (métier, 100 €) vs avoir SQL de 30 € : l'avoir attend le verrou puis est refusé (100 + 30 > 120).
    const inv2 = await issuedInvoice(owner, A, "wA", [{ designation: "C2", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const pay = await holdTransaction(app)
    await pay.tx.$executeRaw`SELECT set_config('planificator.billing_payments', 'on', true)`
    await pay.tx.$executeRawUnsafe(`SELECT 1 FROM invoices WHERE id='${inv2}' FOR UPDATE`)
    await pay.tx.$executeRawUnsafe(`INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById") VALUES ('pay-${inv2}','coA','${inv2}',10000,'CASH','2026-03-10','admA')`)
    await pay.tx.$executeRawUnsafe(`UPDATE invoices SET status='PARTIAL' WHERE id='${inv2}'`)
    const cn = attempt(app2, (tx) => sqlPartialNote(tx, inv2, nid(), "25", "5", "30"))
    await new Promise((r) => setTimeout(r, 200))
    await flushDeferredConstraints(pay.tx); await pay.commit()
    await assert.rejects(cn, /PAYMENT_EXCEEDS_TOTAL/)
    assert.equal(await owner.invoice.count({ where: { creditedInvoiceId: inv2 } }), 0)
    // Contre-passation (métier) puis avoir de 30 € : accepté (0 + 30 ≤ 120) ; l'ordre inverse (avoir d'abord sur 100 payés) serait refusé — vérifié ci-dessus.
    const rev = await reversePayment(owner, A, `pay-${inv2}`, "test", NOW); assert.ok(rev.ok, js(rev))
    await attempt(app, (tx) => sqlPartialNote(tx, inv2, nid(), "25", "5", "30"))
    assert.equal(await owner.invoice.count({ where: { creditedInvoiceId: inv2, status: "SENT" } }), 1)
    // Paiement net négatif refusé : contre-passation SQL au-delà des paiements.
    await assert.rejects(attempt(app, async (tx) => { await tx.$executeRaw`SELECT set_config('planificator.billing_payments', 'on', true)`; await tx.$executeRawUnsafe(`INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById","reversesPaymentId") VALUES ('rev2-${inv2}','coA','${inv2}',-10000,'CASH','2026-03-10','admA','pay-${inv2}')`) }), /PAYMENT_INVALID|PAYMENT_EXCEEDS_TOTAL|23505|already exists/)
  })
})
