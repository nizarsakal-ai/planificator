// P2-03 — Réédition fidèle : les données documentaires d'une pièce émise (vendeur, acheteur, mentions, conditions, pied de page,
// chantier, références) sont figées à l'émission ; la modification ultérieure des fiches ne change pas la réédition ; le suivi des
// règlements est une annexe distincte ; brouillon ⇒ données courantes ; pièce émise sans snapshot (héritée) ⇒ signalée, jamais reconstruite.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { NO_SNAPSHOT_MENTION, buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { A, NOW, js, seedCompanies, sqlError } from "./helpers"
import { acceptedQuote, finalDraft, issue, issuedDeposit, issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const frozen = async (id: string) => { const d = await buildInvoicePdfData(db, "coA", id, NOW); if (!d) throw new Error("pdf"); const { settlement, ...rest } = d; return { content: js(rest), settlement } }
async function mutateMasters(tag: string) {
  await db.$executeRawUnsafe(`UPDATE companies SET name='Société A ${tag}', address='99 avenue ${tag}', siret='11122233300044', email='x${tag}@a.test' WHERE id='coA'`)
  await db.$executeRawUnsafe(`UPDATE clients SET name='Client A ${tag}', address='Nouvelle adresse ${tag}', siret='55566677700088', "vatNumber"='FR00${tag}' WHERE id='clA'`)
  await db.$executeRawUnsafe(`UPDATE worksites SET name='Chantier ${tag}' WHERE id='wA'`)
  await db.billingSettings.upsert({ where: { companyId: "coA" }, create: { companyId: "coA", iban: `FR76 ${tag}`, invoiceFooter: `Pied ${tag}`, latePenaltyText: `Pénalités ${tag}`, legalForm: `SAS ${tag}`, vatNumber: `FR12 ${tag}` }, update: { iban: `FR76 ${tag}`, invoiceFooter: `Pied ${tag}`, latePenaltyText: `Pénalités ${tag}`, legalForm: `SAS ${tag}`, vatNumber: `FR12 ${tag}` } })
}

before(async () => { setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db); await mutateMasters("v1") })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("P2-03 — snapshot documentaire", () => {
  it("facture, acompte, avoir partiel et avoir total : contenu documentaire inchangé après modification de Company/Client/BillingSettings/chantier ; annexe des règlements distincte et évolutive", async () => {
    const quote = await acceptedQuote(db, A, "wA", [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }])
    const dep = await issuedDeposit(db, A, quote, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, quote); await issue(db, A, fin)
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "Pose", quantity: "2", unitPrice: "50", vatRate: "20" }])
    const partial = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(1000) }, "geste", NOW); assert.ok(partial.ok); if (!partial.ok) return
    const other = await issuedInvoice(db, A, "wA", [{ designation: "Seule", quantity: "1", unitPrice: "80", vatRate: "20" }])
    const total = await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: other, actorId: "admA", reason: null, now: NOW, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(total.ok); if (!total.ok) return
    const ids = { dep, fin, inv, partial: partial.value.id, total: total.value.id }
    const before: Record<string, Awaited<ReturnType<typeof frozen>>> = {}
    for (const [k, id] of Object.entries(ids)) { before[k] = await frozen(id); assert.ok(before[k].content.includes("v1"), `${k} figé avec les fiches v1`); assert.ok(before[k].content.includes('"source":"SNAPSHOT"')) }
    assert.ok(before.fin.content.includes("Chantier v1") && before.fin.content.includes("SAS v1") && before.fin.content.includes("Pied v1") && before.fin.content.includes("Client A v1") && before.fin.content.includes("Pénalités v1"))
    await mutateMasters("v2")
    for (const [k, id] of Object.entries(ids)) {
      const after = await frozen(id)
      assert.equal(after.content, before[k].content, `${k} : réédition identique après modification des fiches`)
    }
    // Annexe des règlements : évolue après un paiement, la pièce reste identique.
    assert.ok((await recordPayment(db, A, ids.inv, { amountCents: BigInt(5000), method: "CHECK", paidAt: NOW, reference: null, notes: null }, NOW)).ok)
    const after = await frozen(ids.inv)
    assert.equal(after.content, before.inv.content); assert.notEqual(js(after.settlement), js(before.inv.settlement)); assert.match(after.settlement?.title ?? "", /annexe informative/)
    assert.equal(await db.invoiceDocumentSnapshot.count({ where: { companyId: "coA" } }), 6) // acompte, solde, facture, avoir partiel, facture annulée, avoir total
  })
  it("brouillon ⇒ données courantes autorisées (la réédition suit les fiches) ; aucun snapshot tant que non émis", async () => {
    const p = parseInvoiceForm({ worksiteId: "wA", lines: [{ designation: "Brouillon", quantity: "1", unitPrice: "10", vatRate: "20" }] }); assert.ok(p.ok); if (!p.ok) return
    const d = await createDraftInvoice(db, A, p.value, NOW); assert.ok(d.ok); if (!d.ok) return
    const b1 = await frozen(d.value.id); assert.ok(b1.content.includes("v2") && b1.content.includes('"source":"DRAFT"'))
    await mutateMasters("v3")
    const b2 = await frozen(d.value.id); assert.ok(b2.content.includes("v3")); assert.notEqual(b2.content, b1.content)
    assert.equal(await db.invoiceDocumentSnapshot.count({ where: { invoiceId: d.value.id } }), 0)
    await issue(db, A, d.value.id)
    assert.equal(await db.invoiceDocumentSnapshot.count({ where: { invoiceId: d.value.id } }), 1)
    await mutateMasters("v4")
    assert.ok((await frozen(d.value.id)).content.includes("v3"), "figé à l'émission (v3), insensible à v4")
  })
  it("SQL : snapshot immuable (UPDATE/DELETE refusés), snapshot d'un brouillon ou d'une autre société refusé ; pièce héritée sans snapshot ⇒ réédition signalée, jamais reconstruite ni antidatée", async () => {
    const snap = await db.invoiceDocumentSnapshot.findFirstOrThrow({ where: { companyId: "coA" } })
    assert.match(await sqlError(db, `UPDATE invoice_document_snapshots SET seller='{}' WHERE id='${snap.id}'`), /DOCUMENT_SNAPSHOT_IMMUTABLE/)
    assert.match(await sqlError(db, `DELETE FROM invoice_document_snapshots WHERE id='${snap.id}'`), /DOCUMENT_SNAPSHOT_IMMUTABLE/)
    const p = parseInvoiceForm({ worksiteId: "wA", lines: [{ designation: "B", quantity: "1", unitPrice: "10", vatRate: "20" }] }); assert.ok(p.ok); if (!p.ok) return
    const d = await createDraftInvoice(db, A, p.value, NOW); assert.ok(d.ok); if (!d.ok) return
    assert.match(await sqlError(db, `INSERT INTO invoice_document_snapshots(id,"companyId","invoiceId",seller,buyer,document) VALUES ('s-draft','coA','${d.value.id}','{}','{}','{}')`), /DOCUMENT_SNAPSHOT_INVALID/)
    assert.match(await sqlError(db, `INSERT INTO invoice_document_snapshots(id,"companyId","invoiceId",seller,buyer,document) VALUES ('s-b','coB','${snap.invoiceId}','{}','{}','{}')`), /DOCUMENT_SNAPSHOT_INVALID|foreign key|23503/)
    // Pièce héritée : émise par le chemin SQL/Lot B sans snapshot (aucune reprise automatique par la migration).
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"totalHT","totalVAT","totalTTC","issueDate") VALUES ('legacy1','coA','wA','clA','FAC-2025-0001','admA',now(),'DRAFT','INVOICE',100,20,120,'2025-06-01')`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('legacy1-l','legacy1','Ancien',1,100,20,100)`)
    await db.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"='2025-06-01' WHERE id='legacy1'`)
    const pdf = await buildInvoicePdfData(db, "coA", "legacy1", NOW)
    assert.equal(pdf?.reissue?.source, "CURRENT_NO_SNAPSHOT"); assert.ok(pdf?.mentions.includes(NO_SNAPSHOT_MENTION)); assert.ok(pdf?.seller.name.includes("v4"), "données courantes, explicitement signalées")
    assert.equal(await db.invoiceDocumentSnapshot.count({ where: { invoiceId: "legacy1" } }), 0)
  })
})
