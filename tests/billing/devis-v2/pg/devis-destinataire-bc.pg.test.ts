// V2 06/11/2026 — tests PostgreSQL (base JETABLE migrée, DATABASE_URL obligatoire) : destinataire des devis et bon de commande client.
// Écrits sur le VPS, NON EXÉCUTÉS sur le VPS : environnement isolé autorisé uniquement (npm run test:devis-v2:pg via with-disposable-db.sh).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { hashSignatureToken } from "@/lib/billing/quotes/quote-signature"
import { acceptQuoteManually, convertQuote, createQuote, getQuoteForSignature, runQuoteReminders, sendQuote, signQuoteByToken } from "@/lib/billing/quotes/quote.service"
import { getQuoteRecipientContext } from "@/lib/billing/quotes/quote-queries"
import { buildRecipientSuggestions } from "@/lib/billing/quotes/quote-recipient"
import { issueInvoice, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDepositInvoice } from "@/lib/billing/invoices/deposit.service"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { readDocumentSnapshot } from "@/lib/billing/pdf/document-snapshot"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const mailer = new RecordingMailer()
const now = new Date("2026-11-06T10:00:00Z")
const later = new Date("2026-11-20T10:00:00Z")
const parsed = (worksiteId = "wA") => { const r = parseQuoteForm({ worksiteId, issueDate: "2026-11-06", validUntil: "2026-12-31", subject: "Réfection Chayou", globalDiscount: "2,5", lines: [{ designation: "Pose", quantity: "2", unitPrice: "100", discount: "5", vatRate: "20" }, { designation: "Fourniture", quantity: "1", unitPrice: "50", vatRate: "10" }] }); if (!r.ok) throw new Error(r.error); return r.value }
const tokenFromLastMail = () => { const m = mailer.sent.at(-1); const t = /devis-signature\/([A-Za-z0-9_-]+)/.exec(`${m?.text ?? ""}`); if (!t) throw new Error("jeton absent"); return t[1] }
const ids: Record<string, string> = {}
/**
 * Correctif après l'échec VM du 07/11/2026 (candidat 9bccce16) : un identifiant produit par un test précédent est EXIGÉ.
 * Sans cette garde, un test amont en échec laissait l'identifiant indéfini ; Prisma ignore alors `id: undefined` dans un
 * filtre findFirst (toute facture/snapshot de la société correspond), ce qui produisait des échecs trompeurs en aval.
 * La garde ne relâche aucune assertion : elle désigne le test amont en cause.
 */
function need(key: string): string {
  const v = ids[key]
  assert.ok(typeof v === "string" && v.length > 0, `identifiant « ${key} » absent : le test qui le produit a échoué plus haut (voir le premier échec du journal)`)
  return v
}
/** Saisie de brouillon reconstruite depuis la facture (lignes hors déductions) ; `over` remplace ou retire (undefined) des champs. */
async function draftForm(over: Record<string, unknown> = {}) {
  const d = await db.invoice.findUniqueOrThrow({ where: { id: need("final") }, include: { lines: { where: { deductsDepositId: null }, orderBy: { position: "asc" } } } })
  const raw: Record<string, unknown> = { worksiteId: "wA", quoteId: need("q1"), subject: d.subject ?? "", globalDiscount: "2,5", lines: d.lines.map((l) => ({ designation: l.designation, quantity: l.quantity.toFixed(2), unitPrice: l.unitPrice.toFixed(2), discount: l.discountBp ? String(l.discountBp / 100) : "", vatRate: l.vatRate.toFixed(2).replace(/\.?0+$/, "") })), ...over }
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k]
  const f = parseInvoiceForm(raw); if (!f.ok) throw new Error(f.error); return f.value
}
const poOf = async () => (await db.invoice.findUniqueOrThrow({ where: { id: need("final") } })).clientPurchaseOrderRef

before(async () => {
  setBillingClockForTests(() => now)
  setBillingMailerForTests(mailer)
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b','98765432100019','2 rue B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Chayou SAS','compta@chayou.example','10 rue Chayou',now()),('clB','coB','Client B','compta@b.example','11 rue B',now()),('clA3','coA','Client sans e-mail',NULL,'12 rue C',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Chantier Chayou',now()),('wA2','coA','clA','admA','Chantier sans demande',now()),('wB','coB','clB','admB','Chantier B',now()),('wA3','coA','clA3','admA','Chantier client sans e-mail',now())`)
  // Consultation d'origine du chantier wA : reçue d'une plateforme (expéditeur technique), demandeur extrait = Carline Bourguine.
  const msg = await db.acquisitionMessage.create({ data: { companyId: "coA", source: "GMAIL", externalMessageId: "m-1", senderEmail: "noreply@plateforme.example", senderDomain: "plateforme.example", subject: "Demande de devis Chayou", receivedAt: now } })
  await db.worksiteImportDraft.create({ data: { companyId: "coA", acquisitionMessageId: msg.id, proposedContactName: "Carline Bourguine", proposedContactEmail: "c.bourguine@chayou.example", createdWorksiteId: "wA" } })
  // Même société B : une consultation pour son propre chantier (ne doit jamais apparaître chez A).
  const msgB = await db.acquisitionMessage.create({ data: { companyId: "coB", source: "GMAIL", externalMessageId: "m-2", senderEmail: "x@b.example", senderDomain: "b.example", subject: "B", receivedAt: now } })
  await db.worksiteImportDraft.create({ data: { companyId: "coB", acquisitionMessageId: msgB.id, proposedContactName: "Contact B", proposedContactEmail: "secret@b.example", createdWorksiteId: "wB" } })
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("destinataire des devis", () => {
  it("brouillon : le demandeur de la consultation est proposé (pas l'expéditeur technique, pas la comptabilité) ; isolation société", async () => {
    const c = await createQuote(db, A, parsed()); assert.ok(c.ok); if (!c.ok) return
    ids.q1 = c.value.id
    const ctx = await getQuoteRecipientContext(db, "coA", need("q1")); assert.ok(ctx); if (!ctx) return
    const s = buildRecipientSuggestions(ctx)
    assert.equal(s.identification, "CONSULTATION")
    assert.deepEqual(s.proposed, { name: "Carline Bourguine", email: "c.bourguine@chayou.example", source: "CONSULTATION" })
    assert.ok(!s.candidates.some((x) => x.email === "noreply@plateforme.example"))
    assert.ok(!s.candidates.some((x) => x.email === "secret@b.example"))
    assert.equal(await getQuoteRecipientContext(db, "coB", need("q1")), null)
  })
  it("envoi confirmé : courrier au destinataire choisi, destinataire effectif enregistré et historisé, adresse client inchangée", async () => {
    const before = mailer.sent.length
    const r = await sendQuote(db, A, need("q1"), now, undefined, { name: "Carline Bourguine", email: "c.bourguine@chayou.example", source: "CONSULTATION" })
    if (!r.ok) assert.fail(r.error) // message construit seulement en cas d'échec (aucune sérialisation du résultat)
    assert.equal(mailer.sent.length, before + 1); assert.equal(mailer.sent.at(-1)?.to, "c.bourguine@chayou.example")
    assert.match(`${mailer.sent.at(-1)?.text}`, /Bonjour Carline Bourguine/)
    const q = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    assert.equal(q.status, "SENT"); assert.equal(q.recipientEmail, "c.bourguine@chayou.example"); assert.equal(q.recipientName, "Carline Bourguine"); assert.equal(q.recipientSource, "CONSULTATION")
    assert.equal((await db.client.findUniqueOrThrow({ where: { id: "clA" } })).email, "compta@chayou.example")
    assert.equal(await db.billingMailLog.count({ where: { companyId: "coA", documentId: need("q1"), to: "c.bourguine@chayou.example" } }), 1)
    assert.ok(await db.historyLog.findFirst({ where: { entityId: need("q1"), detail: { contains: "Carline Bourguine <c.bourguine@chayou.example>" } } }))
    ids.token1 = tokenFromLastMail()
  })
  it("renvoi à un autre destinataire : nouveau lien, l'ancien est invalidé ; historique conservé des deux envois", async () => {
    const r = await sendQuote(db, A, need("q1"), now, undefined, { name: "Marc Chef", email: "marc@chayou.example", source: "MANUAL" })
    assert.ok(r.ok)
    const token2 = tokenFromLastMail()
    assert.notEqual(token2, ids.token1)
    assert.equal(await getQuoteForSignature(db, ids.token1, now), null) // hachage remplacé ⇒ ancien lien inconnu
    assert.equal((await getQuoteForSignature(db, token2, now))?.signable, true)
    const q = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    assert.equal(q.recipientEmail, "marc@chayou.example"); assert.equal(q.signatureTokenHash, hashSignatureToken(token2))
    const logs = await db.billingMailLog.findMany({ where: { companyId: "coA", documentId: need("q1") }, select: { to: true } })
    assert.deepEqual(logs.map((l) => l.to).sort(), ["c.bourguine@chayou.example", "marc@chayou.example"])
    assert.deepEqual((await signQuoteByToken(db, ids.token1, { signerName: "X", ipHash: null, now })).ok, false)
    ids.token2 = token2
  })
  it("relance : vers le destinataire effectif du dernier envoi", async () => {
    const { number } = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    const before = mailer.sent.length
    await runQuoteReminders(db, later)
    const sentToQ1 = mailer.sent.slice(before).filter((m) => `${m.subject}`.includes(number))
    assert.equal(sentToQ1.length, 1) // un seul courrier par exécution (palier le plus élevé)
    assert.equal(sentToQ1[0].to, "marc@chayou.example")
    assert.match(`${sentToQ1[0].text}`, /Bonjour Marc Chef/)
  })
  it("devis signé : plus d'envoi possible, destinataire et document inchangés", async () => {
    assert.ok((await signQuoteByToken(db, ids.token2, { signerName: "Marc Chef", ipHash: null, now })).ok)
    const before = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    const r = await sendQuote(db, A, need("q1"), now, undefined, { name: "Autre", email: "autre@chayou.example", source: "MANUAL" })
    assert.equal(r.ok, false)
    const afterQ = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    assert.equal(afterQ.recipientEmail, before.recipientEmail); assert.equal(afterQ.signatureTokenHash, before.signatureTokenHash); assert.equal(afterQ.status, "ACCEPTED")
  })
  it("autre société : envoi refusé, aucun courrier", async () => {
    const c = await createQuote(db, A, parsed("wA2")); assert.ok(c.ok); if (!c.ok) return
    ids.q2 = c.value.id
    const before = mailer.sent.length
    assert.equal((await sendQuote(db, B, ids.q2, now, undefined, { name: null, email: "x@y.example", source: "MANUAL" })).ok, false)
    assert.equal(mailer.sent.length, before)
  })
  it("appel interne sans destinataire (comportement antérieur) : adresse du client, rien d'enregistré comme destinataire", async () => {
    assert.ok((await sendQuote(db, A, ids.q2, now)).ok)
    assert.equal(mailer.sent.at(-1)?.to, "compta@chayou.example")
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: ids.q2 } })).recipientEmail, null)
  })
  it("repli sans destinataire APRÈS un envoi explicite : dernier destinataire effectif (jamais la comptabilité), rien n'est réécrit", async () => {
    const c = await createQuote(db, A, parsed("wA2")); assert.ok(c.ok); if (!c.ok) return
    ids.q3 = c.value.id
    assert.ok((await sendQuote(db, A, ids.q3, now, undefined, { name: "Léa Conduite", email: "lea@chayou.example", source: "MANUAL" })).ok)
    const before = await db.quote.findUniqueOrThrow({ where: { id: ids.q3 } })
    assert.ok((await sendQuote(db, A, ids.q3, now)).ok) // renvoi interne, sans destinataire confirmé
    assert.equal(mailer.sent.at(-1)?.to, "lea@chayou.example"); assert.match(`${mailer.sent.at(-1)?.text}`, /Bonjour Léa Conduite/)
    const afterQ = await db.quote.findUniqueOrThrow({ where: { id: ids.q3 } })
    assert.equal(afterQ.recipientEmail, "lea@chayou.example"); assert.equal(afterQ.recipientName, "Léa Conduite"); assert.equal(afterQ.recipientSource, "MANUAL")
    assert.notEqual(afterQ.signatureTokenHash, before.signatureTokenHash) // nouveau lien malgré tout
    assert.equal((await db.client.findUniqueOrThrow({ where: { id: "clA" } })).email, "compta@chayou.example")
  })
  it("client SANS e-mail : aucune proposition, envoi interne refusé ; destinataire manuel accepté, fiche client inchangée", async () => {
    const c = await createQuote(db, A, parsed("wA3")); assert.ok(c.ok); if (!c.ok) return
    ids.q4 = c.value.id
    const ctx = await getQuoteRecipientContext(db, "coA", ids.q4); assert.ok(ctx); if (!ctx) return
    const s = buildRecipientSuggestions(ctx)
    assert.equal(s.identification, "ABSENT"); assert.equal(s.proposed, null); assert.equal(s.candidates.length, 0)
    const before = mailer.sent.length
    assert.deepEqual(await sendQuote(db, A, ids.q4, now), { ok: false, error: "Le client n'a pas d'adresse e-mail : renseignez-la avant l'envoi." })
    assert.equal(mailer.sent.length, before); assert.equal((await db.quote.findUniqueOrThrow({ where: { id: ids.q4 } })).status, "DRAFT")
    assert.ok((await sendQuote(db, A, ids.q4, now, undefined, { name: "Paul Manuel", email: "paul.manuel@exemple.example", source: "MANUAL" })).ok)
    assert.equal(mailer.sent.at(-1)?.to, "paul.manuel@exemple.example")
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.q4 } })
    assert.equal(q.status, "SENT"); assert.equal(q.recipientEmail, "paul.manuel@exemple.example")
    assert.equal((await db.client.findUniqueOrThrow({ where: { id: "clA3" } })).email, null)
  })
})

describe("devis → facture avec bon de commande client", () => {
  it("acompte émis puis conversion avec bon de commande : référence sur devis et facture, acompte déduit une seule fois", async () => {
    const dep = await createDepositInvoice(db, A, need("q1"), { kind: "PERCENT", bp: 3000 }, now); if (!dep.ok) assert.fail(dep.error) // cause du 1er échec VM : JSON.stringify(dep) levait sur dep.value.ttcCents (BigInt) MÊME en cas de succès
    assert.ok((await issueInvoice(db, A, dep.value.id, now)).ok)
    const [c1, c2] = await Promise.all([convertQuote(db, A, need("q1"), now, { clientPurchaseOrderRef: "BC-2026-118" }), convertQuote(db, A, need("q1"), now, { clientPurchaseOrderRef: "BC-AUTRE" })])
    assert.ok(c1.ok && c2.ok); if (!c1.ok || !c2.ok) return
    assert.equal(c1.value.invoiceId, c2.value.invoiceId); assert.equal([c1.value.existing, c2.value.existing].filter(Boolean).length, 1)
    ids.final = c1.value.invoiceId
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: need("final") }, include: { lines: true } })
    const quote = await db.quote.findUniqueOrThrow({ where: { id: need("q1") } })
    assert.equal(inv.clientPurchaseOrderRef, quote.clientPurchaseOrderRef) // la première conversion gagne, la seconde n'écrase rien
    assert.ok(["BC-2026-118", "BC-AUTRE"].includes(inv.clientPurchaseOrderRef ?? ""))
    assert.equal(inv.subject, "Réfection Chayou"); assert.equal(inv.status, "DRAFT"); assert.equal(inv.globalDiscountBp, 250)
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: need("final") } }), 1)
    assert.equal(await db.invoice.count({ where: { companyId: "coA", quoteId: need("q1"), kind: "INVOICE", status: { not: "CANCELLED" } } }), 1)
    ids.poRef = inv.clientPurchaseOrderRef ?? ""
  })
  it("brouillon de facture : référence modifiable ; PDF brouillon l'affiche avec le devis source", async () => {
    const detail = await db.invoice.findUniqueOrThrow({ where: { id: need("final") }, include: { lines: { where: { deductsDepositId: null }, orderBy: { position: "asc" } } } })
    const form = parseInvoiceForm({ worksiteId: "wA", quoteId: need("q1"), subject: detail.subject ?? "", clientPurchaseOrderRef: " BC 2026/118 ", globalDiscount: "2,5", lines: detail.lines.map((l) => ({ designation: l.designation, quantity: l.quantity.toFixed(2), unitPrice: l.unitPrice.toFixed(2), discount: l.discountBp ? String(l.discountBp / 100) : "", vatRate: l.vatRate.toFixed(2).replace(/\.?0+$/, "") })) })
    if (!form.ok) assert.fail(form.error) // même défaut latent : form.value contient des montants BigInt
    assert.ok((await updateDraftInvoice(db, A, need("final"), form.value)).ok)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: need("final") } })).clientPurchaseOrderRef, "BC 2026/118")
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: need("final") } }), 1) // déduction régénérée, jamais doublée
    const pdf = await buildInvoicePdfData(db, "coA", need("final"))
    assert.ok(pdf?.meta.some((m) => m.label === "Bon de commande client" && m.value === "BC 2026/118"))
    assert.ok(pdf?.meta.some((m) => m.label === "Devis"))
    assert.equal(await buildInvoicePdfData(db, "coB", need("final")), null)
  })
  it("R1 : formulaire antérieur SANS le champ ⇒ référence préservée, même avec objet et lignes modifiés", async () => {
    const f = await draftForm({ subject: "Réfection Chayou (lot 2)" })
    f.lines[0] = { ...f.lines[0], designation: "Pose (révisée)" }
    assert.equal(f.clientPurchaseOrderRef, undefined)
    assert.ok((await updateDraftInvoice(db, A, need("final"), f)).ok)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: need("final") }, include: { lines: { where: { deductsDepositId: null }, orderBy: { position: "asc" } } } })
    assert.equal(inv.clientPurchaseOrderRef, "BC 2026/118"); assert.equal(inv.subject, "Réfection Chayou (lot 2)"); assert.equal(inv.lines[0].designation, "Pose (révisée)")
  })
  it("R1 : refus de la déduction d'acompte ⇒ ROLLBACK complet, référence saisie non écrite", async () => {
    const f = await draftForm({ clientPurchaseOrderRef: "BC-ROLLBACK", lines: [{ designation: "Reste", quantity: "1", unitPrice: "1", vatRate: "20" }] })
    const r = await updateDraftInvoice(db, A, need("final"), f)
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.equal(await poOf(), "BC 2026/118")
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: need("final") } }), 1)
  })
  it("R1 : chaîne vide explicite ⇒ effacement volontaire ; nouvelle référence ⇒ remplacée", async () => {
    assert.ok((await updateDraftInvoice(db, A, need("final"), await draftForm({ clientPurchaseOrderRef: "" }))).ok)
    assert.equal(await poOf(), null)
    assert.ok((await updateDraftInvoice(db, A, need("final"), await draftForm({ clientPurchaseOrderRef: "BC 2026/118" }))).ok)
    assert.equal(await poOf(), "BC 2026/118")
  })
  it("émission : référence figée (snapshot + déclencheur), PDF émis identique ; aucune modification ultérieure possible", async () => {
    assert.ok((await issueInvoice(db, A, need("final"), now)).ok)
    const snap = await readDocumentSnapshot(db, "coA", need("final"))
    assert.equal(snap?.document.clientPurchaseOrderRef, "BC 2026/118")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoices SET "clientPurchaseOrderRef" = 'BC-FAUX' WHERE id = '${need("final")}'`), /INVOICE_IMMUTABLE/)
    const pdf = await buildInvoicePdfData(db, "coA", need("final"))
    assert.ok(pdf?.meta.some((m) => m.label === "Bon de commande client" && m.value === "BC 2026/118")); assert.equal(pdf?.reissue.source, "SNAPSHOT")
    // R1 : pièce émise — aucune saisie (avec, vide ou sans le champ) ne la modifie.
    for (const over of [{ clientPurchaseOrderRef: "BC-APRES" }, { clientPurchaseOrderRef: "" }, {}]) {
      const r = await updateDraftInvoice(db, A, need("final"), await draftForm(over))
      assert.equal(r.ok, false); assert.equal(await poOf(), "BC 2026/118")
    }
  })
  it("facture convertie sans bon de commande : aucune référence inventée, aucune ligne au PDF", async () => {
    const c = await createQuote(db, A, parsed("wA2")); assert.ok(c.ok); if (!c.ok) return
    await sendQuote(db, A, c.value.id, now); await acceptQuoteManually(db, A, c.value.id, now)
    const conv = await convertQuote(db, A, c.value.id, now); assert.ok(conv.ok); if (!conv.ok) return
    const pdf = await buildInvoicePdfData(db, "coA", conv.value.invoiceId)
    assert.ok(!pdf?.meta.some((m) => m.label === "Bon de commande client"))
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: conv.value.invoiceId } })).clientPurchaseOrderRef, null)
  })
  it("contraintes SQL : longueur, origine et paire destinataire contrôlées en base", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE quotes SET "clientPurchaseOrderRef" = repeat('A', 65) WHERE id = '${ids.q2}'`), /quotes_client_po_ref_len_check/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE quotes SET "recipientSource" = 'AUTO', "recipientEmail" = 'a@b.example' WHERE id = '${ids.q2}'`), /quotes_recipient_source_check/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE quotes SET "recipientSource" = 'MANUAL', "recipientEmail" = NULL WHERE id = '${ids.q2}'`), /quotes_recipient_pair_check/)
  })
})
