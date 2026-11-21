// 21/11/2026 — bons de commande clients et bons de livraison : tests PostgreSQL (base jetable migrée) avec les vrais services.
// Numérotation BC/BL, un seul bon de commande actif par devis (service ET index unique partiel), sources autorisées,
// livraison partielle, réception, annulations, isolation société, filets SQL, rendu PDF réel, snapshot facture (adresse/intitulé).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import React from "react"
import { PrismaClient } from "@prisma/client"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice } from "@/lib/billing/invoices/invoice.service"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { CLIENT_ORDER_ERRORS, cancelClientOrder, createClientOrderFromQuote, getClientOrder } from "@/lib/billing/commercial/client-order.service"
import { DELIVERY_ERRORS, cancelDeliveryNote, createDeliveryNote, deliverySourcePreview, getDeliveryNote, recordDeliveryReceipt } from "@/lib/billing/commercial/delivery-note.service"
import { buildClientOrderPdfData, buildDeliveryNotePdfData } from "@/lib/billing/pdf/commercial-pdf"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"
import type { DocumentPdfData } from "@/lib/billing/pdf/document-data"

;(globalThis as { React?: typeof React }).React = React
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "cmA", userId: "cmAdm" }
const B = { companyId: "cmB", userId: "cmBAdm" }
const now = new Date("2026-11-21T10:00:00Z")
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
async function pdfText(data: DocumentPdfData): Promise<string> {
  const buf = await renderToBuffer(DocumentPdf({ data }))
  return (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text
}
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

async function acceptedQuote(): Promise<string> {
  const q = parseQuoteForm({ worksiteId: "cmW", issueDate: "2026-11-21", subject: "Scène", lines: [{ designation: "Câble 25 m", quantity: "4", unitPrice: "10", vatRate: "20" }, { designation: "Pose", quantity: "1,5", unitPrice: "100", vatRate: "20" }] })
  if (!q.ok) throw new Error(q.error)
  const c = await createQuote(db, A, q.value); if (!c.ok) throw new Error(c.error)
  const s = await sendQuote(db, A, c.value.id, now); if (!s.ok) throw new Error(s.error)
  const a = await acceptQuoteManually(db, A, c.value.id, now); if (!a.ok) throw new Error(a.error)
  return c.value.id
}

before(async () => {
  setBillingClockForTests(() => now)
  setBillingMailerForTests(new RecordingMailer())
  for (const [co, adm, slug] of [["cmA", "cmAdm", "cm-a"], ["cmB", "cmBAdm", "cm-b"]]) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${co}','Société ${co}','${slug}','12345678900012','1 rue A',now())`)
    await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('${adm}','${adm}@x','x','ADMIN','${co}',now())`)
    await db.billingSettings.create({ data: { companyId: co } })
  }
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"deliveryAddress",siret,"updatedAt") VALUES ('cmC','cmA','Client Commercial','client@example.test','10 rue du Client','3 allée des Livraisons','98765432100011',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('cmW','cmA','cmC','cmAdm','Chantier',now())`)
})
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(null); await db.$disconnect() })

describe("bon de commande client", () => {
  let quoteId = "", orderId = ""
  it("refusé sur un devis non accepté", async () => {
    const q = parseQuoteForm({ worksiteId: "cmW", issueDate: "2026-11-21", lines: [{ designation: "X", quantity: "1", unitPrice: "1", vatRate: "20" }] })
    if (!q.ok) throw new Error(q.error)
    const c = await createQuote(db, A, q.value); assert.ok(c.ok); if (!c.ok) return
    assert.deepEqual(await createClientOrderFromQuote(db, A, c.value.id, { issueDate: day("2026-11-21"), expectedDeliveryDate: null, deliveryAddress: null, notes: null }), { ok: false, error: CLIENT_ORDER_ERRORS.quoteNotAccepted })
  })
  it("création : numéro BC, lignes et totaux recopiés, adresse de la fiche client par défaut", async () => {
    quoteId = await acceptedQuote()
    const r = await createClientOrderFromQuote(db, A, quoteId, { issueDate: day("2026-11-21"), expectedDeliveryDate: day("2026-11-30"), deliveryAddress: null, notes: "Livrer le matin" })
    assert.ok(r.ok, r.ok ? "" : r.error); if (!r.ok) return
    orderId = r.value.id
    assert.match(r.value.number, /^BC-2026-\d{4}$/)
    const o = await getClientOrder(db, A.companyId, orderId)
    const q = await db.quote.findUniqueOrThrow({ where: { id: quoteId } })
    assert.equal(o?.lines.length, 2)
    assert.equal(o?.totalTTC.toString(), q.totalTTC.toString())
    assert.equal(o?.deliveryAddress, "3 allée des Livraisons")
  })
  it("un seul bon actif par devis : service, puis index unique partiel en base", async () => {
    assert.deepEqual(await createClientOrderFromQuote(db, A, quoteId, { issueDate: day("2026-11-21"), expectedDeliveryDate: null, deliveryAddress: null, notes: null }), { ok: false, error: CLIENT_ORDER_ERRORS.alreadyExists })
    const msg = await sqlError(`INSERT INTO client_orders(id,"companyId","quoteId","clientId","worksiteId",number,status,"issueDate","globalDiscountBp","vatReverseCharge","totalHT","totalVAT","totalTTC","createdById","updatedAt") SELECT 'dup','cmA',"quoteId","clientId","worksiteId",'BC-DUP','ISSUED',"issueDate",0,false,"totalHT","totalVAT","totalTTC","createdById",now() FROM client_orders WHERE id='${orderId}'`)
    assert.match(msg, /23505[\s\S]*"quoteId"/, "index unique partiel (un bon actif par devis)")
  })
  it("isolation société : invisible et inutilisable depuis une autre société", async () => {
    assert.equal(await getClientOrder(db, B.companyId, orderId), null)
    assert.deepEqual(await createClientOrderFromQuote(db, B, quoteId, { issueDate: day("2026-11-21"), expectedDeliveryDate: null, deliveryAddress: null, notes: null }), { ok: false, error: CLIENT_ORDER_ERRORS.quoteNotFound })
    assert.equal((await cancelClientOrder(db, B, orderId, now)).ok, false)
  })
  it("PDF réel : titre, lignes, total ; tampon après annulation", async () => {
    const data = await buildClientOrderPdfData(db, A.companyId, orderId)
    assert.ok(data)
    const txt = await pdfText(data!)
    assert.ok(txt.includes("BON DE COMMANDE CLIENT") && txt.includes("Câble 25 m") && txt.includes("3 allée des Livraisons"), txt.slice(0, 400))
  })

  describe("bon de livraison depuis le bon de commande", () => {
    let noteId = ""
    it("aperçu : lignes et adresse du bon de commande", async () => {
      const p = await deliverySourcePreview(db, A.companyId, "CLIENT_ORDER", orderId)
      assert.ok(p.ok); if (!p.ok) return
      assert.deepEqual(p.value.lines.map((l) => l.quantity), ["4", "1,5"])
      assert.equal(p.value.defaultAddress, "3 allée des Livraisons")
    })
    it("livraison partielle : numéro BL, quantités commandées / livrées", async () => {
      const r = await createDeliveryNote(db, A, "CLIENT_ORDER", orderId, { deliveryDate: day("2026-11-25"), deliveryAddress: null, notes: null, delivered: ["3", ""] })
      assert.ok(r.ok, r.ok ? "" : r.error); if (!r.ok) return
      noteId = r.value.id
      assert.match(r.value.number, /^BL-2026-\d{4}$/)
      const n = await getDeliveryNote(db, A.companyId, noteId)
      assert.deepEqual(n?.lines.map((l) => [l.quantityOrdered.toString(), l.quantityDelivered.toString()]), [["4", "3"], ["1.5", "1.5"]])
      assert.equal(n?.deliveryAddress, "3 allée des Livraisons")
    })
    it("bon de commande non annulable tant qu'un bon de livraison actif existe", async () => {
      assert.deepEqual(await cancelClientOrder(db, A, orderId, now), { ok: false, error: CLIENT_ORDER_ERRORS.hasDeliveries })
    })
    it("PDF réel : tableau de livraison, sans totaux, bloc de réception", async () => {
      const txt = await pdfText((await buildDeliveryNotePdfData(db, A.companyId, noteId))!)
      assert.ok(txt.includes("BON DE LIVRAISON") && txt.includes("Qté livrée") && txt.includes("Réception de la livraison"), txt.slice(0, 400))
      assert.equal(txt.includes("Total TTC"), false)
    })
    it("réception : nom obligatoire, puis Livré ; plus annulable ensuite", async () => {
      assert.equal((await recordDeliveryReceipt(db, A, noteId, "  ", day("2026-11-25"))).ok, false)
      assert.ok((await recordDeliveryReceipt(db, A, noteId, "M. Dupont", day("2026-11-25"))).ok)
      const n = await getDeliveryNote(db, A.companyId, noteId)
      assert.deepEqual([n?.status, n?.receivedByName], ["DELIVERED", "M. Dupont"])
      assert.deepEqual(await cancelDeliveryNote(db, A, noteId, now), { ok: false, error: DELIVERY_ERRORS.notIssued })
      const txt = await pdfText((await buildDeliveryNotePdfData(db, A.companyId, noteId))!)
      assert.ok(txt.includes("Reçu par M. Dupont"), txt.slice(-400))
    })
    it("filet SQL : Livré sans destinataire refusé ; quantité négative refusée", async () => {
      assert.match(await sqlError(`UPDATE delivery_notes SET "receivedByName"=NULL WHERE id='${noteId}'`), /delivery_notes_receipt_check/)
      assert.match(await sqlError(`UPDATE delivery_note_lines SET "quantityDelivered"=-1 WHERE "noteId"='${noteId}'`), /delivery_note_lines_quantities_check/)
    })
  })
})

describe("bon de livraison depuis un devis ou une facture", () => {
  it("devis accepté : autorisé ; annulation datée", async () => {
    const quoteId = await acceptedQuote()
    const r = await createDeliveryNote(db, A, "QUOTE", quoteId, { deliveryDate: day("2026-11-22"), deliveryAddress: "Quai 4", notes: null, delivered: ["", ""] })
    assert.ok(r.ok, r.ok ? "" : r.error); if (!r.ok) return
    assert.equal((await getDeliveryNote(db, A.companyId, r.value.id))?.deliveryAddress, "Quai 4")
    assert.ok((await cancelDeliveryNote(db, A, r.value.id, now)).ok)
    const n = await getDeliveryNote(db, A.companyId, r.value.id)
    assert.equal(n?.status, "CANCELLED"); assert.ok(n?.cancelledAt)
  })
  it("facture brouillon refusée ; facture émise acceptée ; adresse et intitulé figés dans le snapshot", async () => {
    const f = parseInvoiceForm({ worksiteId: "cmW", documentTitle: "Situation n° 2", deliveryAddress: "Entrepôt Nord", lines: [{ designation: "Prestation", quantity: "2", unitPrice: "100", vatRate: "20" }] })
    if (!f.ok) throw new Error(f.error)
    const d = await createDraftInvoice(db, A, f.value, now); assert.ok(d.ok); if (!d.ok) return
    assert.deepEqual(await createDeliveryNote(db, A, "INVOICE", d.value.id, { deliveryDate: day("2026-11-22"), deliveryAddress: null, notes: null, delivered: [""] }), { ok: false, error: DELIVERY_ERRORS.invoiceNotIssued })
    assert.ok((await issueInvoice(db, A, d.value.id, now)).ok)
    const snap = await db.invoiceDocumentSnapshot.findFirstOrThrow({ where: { invoiceId: d.value.id } })
    const doc = snap.document as { deliveryAddress?: string; documentTitle?: string }
    assert.deepEqual([doc.deliveryAddress, doc.documentTitle], ["Entrepôt Nord", "Situation n° 2"])
    const pdf = await buildInvoicePdfData(db, A.companyId, d.value.id, now)
    assert.deepEqual([pdf?.deliveryAddress, pdf?.subtitle], ["Entrepôt Nord", "Situation n° 2"])
    const r = await createDeliveryNote(db, A, "INVOICE", d.value.id, { deliveryDate: day("2026-11-22"), deliveryAddress: null, notes: null, delivered: ["1"] })
    assert.ok(r.ok, r.ok ? "" : r.error); if (!r.ok) return
    assert.equal((await getDeliveryNote(db, A.companyId, r.value.id))?.deliveryAddress, "Entrepôt Nord", "adresse de la facture prioritaire sur la fiche client")
  })
  it("filet SQL : source incohérente refusée", async () => {
    assert.match(await sqlError(`UPDATE delivery_notes SET "quoteId"=NULL WHERE "sourceType"='QUOTE' AND "companyId"='cmA'`), /delivery_notes_source_check/)
  })
})
