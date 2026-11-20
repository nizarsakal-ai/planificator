// Modèles de design des PDF (20/11/2026) — tests PostgreSQL (base jetable migrée) avec les vrais services :
// brouillon = choix du document ?? réglage société ; émission ⇒ design FIGÉ (snapshot de la facture, colonnes du devis à l'envoi) ;
// un changement ultérieur du réglage ou une écriture directe sur la pièce émise ne change plus son apparence ; filet SQL des couleurs.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice } from "@/lib/billing/invoices/invoice.service"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { buildQuotePdfData } from "@/lib/billing/pdf/quote-pdf"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { DEFAULT_PDF_DESIGN, designToStored, type PdfDesign } from "@/lib/billing/pdf/design"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "dsA", userId: "dsAdm" }
const now = new Date("2026-11-20T10:00:00Z")
const MODERN: PdfDesign = { template: "MODERN", primary: "#4f46e5", secondary: "#4338ca", layout: "QUICK", showClientIds: false, showBankDetails: true }
const BAND: PdfDesign = { template: "BAND", primary: "#047857", secondary: "#065f46", layout: "COMPLETE", showClientIds: true, showBankDetails: false }
const invoiceForm = () => { const r = parseInvoiceForm({ worksiteId: "dsW", lines: [{ designation: "Prestation", quantity: "1", unitPrice: "100", vatRate: "20" }] }); if (!r.ok) throw new Error(r.error); return r.value }
async function setCompanyDesign(d: PdfDesign) { await db.billingSettings.update({ where: { companyId: A.companyId }, data: designToStored(d) }) }
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  setBillingClockForTests(() => now)
  setBillingMailerForTests(new RecordingMailer())
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('dsA','Société Design','ds-a','12345678900012','1 rue A',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('dsAdm','ds@x','x','ADMIN','dsA',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,siret,"updatedAt") VALUES ('dsC','dsA','Client Design','client@example.test','10 rue du Client','98765432100011',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('dsW','dsA','dsC','dsAdm','Chantier',now())`)
  await db.billingSettings.create({ data: { companyId: A.companyId, iban: "FR7630006000011234567890189", bic: "AGRIFRPP" } })
})
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(null); await db.$disconnect() })

describe("factures", () => {
  let invoiceId = ""
  it("réglage par défaut d'une société = rendu historique « Classique »", async () => {
    const r = await createDraftInvoice(db, A, invoiceForm(), now); assert.ok(r.ok); if (!r.ok) return
    invoiceId = r.value.id
    assert.deepEqual((await buildInvoicePdfData(db, A.companyId, invoiceId, now))?.design, DEFAULT_PDF_DESIGN)
  })
  it("brouillon : suit le réglage de la société, puis le choix propre au document", async () => {
    await setCompanyDesign(BAND)
    assert.deepEqual((await buildInvoicePdfData(db, A.companyId, invoiceId, now))?.design, BAND)
    await db.invoice.update({ where: { id: invoiceId }, data: designToStored(MODERN) })
    const data = await buildInvoicePdfData(db, A.companyId, invoiceId, now)
    assert.deepEqual(data?.design, MODERN)
    assert.deepEqual(data?.bank, { iban: "FR7630006000011234567890189", bic: "AGRIFRPP" })
    assert.equal(data?.stamp, null, "pas de tampon sur un brouillon")
  })
  it("émission : design figé dans le snapshot ; réglage ou colonnes modifiés ensuite ⇒ apparence inchangée", async () => {
    const issued = await issueInvoice(db, A, invoiceId, now); assert.ok(issued.ok)
    const snap = await db.invoiceDocumentSnapshot.findFirstOrThrow({ where: { invoiceId } })
    assert.deepEqual((snap.document as { design?: unknown }).design, MODERN)
    await setCompanyDesign({ ...BAND, template: "MINIMAL" })
    await db.$executeRawUnsafe(`UPDATE invoices SET "pdfTemplate"='CLASSIC', "pdfPrimaryColor"='#9f1239' WHERE id='${invoiceId}'`)
    assert.deepEqual((await buildInvoicePdfData(db, A.companyId, invoiceId, now))?.design, MODERN)
  })
  it("tampon « Payée » une fois la facture soldée", async () => {
    await db.$executeRawUnsafe(`UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='${invoiceId}'`)
    assert.deepEqual((await buildInvoicePdfData(db, A.companyId, invoiceId, now))?.stamp, { label: "Payée", tone: "success" })
  })
  it("facture émise avant les modèles (snapshot sans design) ⇒ Classique historique, même si un design est choisi ensuite", async () => {
    const r = await createDraftInvoice(db, A, invoiceForm(), now); assert.ok(r.ok); if (!r.ok) return
    const id = r.value.id
    // Émission « à l'ancienne » : passage hors brouillon puis snapshot au format antérieur (document sans champ design).
    await db.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now(), number='FAC-LEGACY-0001' WHERE id='${id}'`)
    const legacyDocument = { worksiteName: "Chantier", quoteNumber: null, creditedInvoice: null, subject: null, notes: null, paymentTerms: null, mentions: ["Paiement à 30 jours."], footer: null, vatReverseCharge: false }
    await db.invoiceDocumentSnapshot.create({ data: { companyId: A.companyId, invoiceId: id, schemaVersion: 1, seller: { name: "Société Design", lines: [] }, buyer: { name: "Client Design", lines: [] }, document: legacyDocument } })
    await db.$executeRawUnsafe(`UPDATE invoices SET "pdfTemplate"='MODERN', "pdfPrimaryColor"='#4f46e5', "pdfSecondaryColor"='#4338ca' WHERE id='${id}'`)
    const data = await buildInvoicePdfData(db, A.companyId, id, now)
    assert.deepEqual(data?.design, DEFAULT_PDF_DESIGN)
    assert.equal(data?.bank, null, "aucune coordonnée bancaire inventée pour un snapshot antérieur")
  })
})

describe("devis", () => {
  it("brouillon suit la société ; à l'envoi le design effectif est écrit sur le devis et ne change plus", async () => {
    await setCompanyDesign(BAND)
    const q = parseQuoteForm({ worksiteId: "dsW", issueDate: "2026-11-20", lines: [{ designation: "Pose", quantity: "1", unitPrice: "50", vatRate: "20" }] })
    if (!q.ok) throw new Error(q.error)
    const cq = await createQuote(db, A, q.value); assert.ok(cq.ok); if (!cq.ok) return
    assert.deepEqual((await buildQuotePdfData(db, A.companyId, cq.value.id))?.design, BAND)
    const sent = await sendQuote(db, A, cq.value.id, now); assert.ok(sent.ok, sent.ok ? "" : sent.error)
    const row = await db.quote.findUniqueOrThrow({ where: { id: cq.value.id } })
    assert.deepEqual([row.pdfTemplate, row.pdfPrimaryColor, row.pdfLayout], ["BAND", "#047857", "COMPLETE"])
    await setCompanyDesign(MODERN)
    assert.deepEqual((await buildQuotePdfData(db, A.companyId, cq.value.id))?.design, BAND, "réglage modifié après l'envoi : sans effet")
  })
  it("devis envoyé avant les modèles (colonnes vides) ⇒ Classique historique", async () => {
    const q = parseQuoteForm({ worksiteId: "dsW", issueDate: "2026-11-20", lines: [{ designation: "Pose", quantity: "1", unitPrice: "50", vatRate: "20" }] })
    if (!q.ok) throw new Error(q.error)
    const cq = await createQuote(db, A, q.value); assert.ok(cq.ok); if (!cq.ok) return
    await db.$executeRawUnsafe(`UPDATE quotes SET status='SENT', "sentAt"=now() WHERE id='${cq.value.id}'`)
    assert.deepEqual((await buildQuotePdfData(db, A.companyId, cq.value.id))?.design, DEFAULT_PDF_DESIGN)
  })
})

describe("filet SQL", () => {
  it("couleur hors format #rrggbb refusée en base (société, facture, devis)", async () => {
    assert.match(await sqlError(`UPDATE billing_settings SET "pdfPrimaryColor"='bleu' WHERE "companyId"='dsA'`), /billing_settings_pdf_colors_check/)
    assert.match(await sqlError(`UPDATE invoices SET "pdfSecondaryColor"='#FFF' WHERE "companyId"='dsA'`), /invoices_pdf_colors_check/)
    assert.match(await sqlError(`UPDATE quotes SET "pdfPrimaryColor"='#12345' WHERE "companyId"='dsA'`), /quotes_pdf_colors_check/)
  })
})
