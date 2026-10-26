// Cycle R2 — défauts de MÊME FAMILLE que R2/R3/R5 relevés par l'audit interne (lecture puis décision sans verrou, horloge figée,
// calcul puis persistance sans instantané) et corrigés dans ce cycle :
// A1 acompte créé/émis après l'émission du solde ; A2 deux factures de solde pour un devis ; A4 deux factures fournisseur identiques
// validées en concurrence ; A5 courrier de renvoi bâti sur une lecture périmée ; A6 relance écrasant un jeton renouvelé ;
// C1 périodes de déclaration TVA chevauchantes ou non terminées. Deux connexions PostgreSQL indépendantes, barrières explicites.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { QUOTE_ERRORS, replaceQuoteDraftCore } from "@/lib/billing/quotes/quote-lifecycle.core"
import { createQuote, runQuoteReminders, sendQuote, signQuoteByToken } from "@/lib/billing/quotes/quote.service"
import { generateSignatureToken } from "@/lib/billing/quotes/quote-signature"
import { createDraftInvoice, issueInvoice, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { DEPOSIT_ERRORS, createDepositInvoice } from "@/lib/billing/invoices/deposit.service"
import { issueInvoiceCore } from "@/lib/billing/invoices/invoice-c2.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { lockInvoiceRow } from "@/lib/billing/invoices/invoice.service"
import { SUPPLIER_ERRORS, createSupplierInvoice, validateSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { VAT_DECLARATION_ERRORS, declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, D, NOW, holdTransaction, js, seedCompanies, waitFor, waitingSessions, useTestClock } from "./helpers"
import { acceptedQuote, finalDraft, issuedDeposit } from "./fixtures"

const db = new PrismaClient(), db2 = new PrismaClient()
const mailer = new RecordingMailer()
const L = [{ designation: "Prestation", quantity: "1", unitPrice: "1000", vatRate: "20" }]

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setBillingMailerForTests(mailer); await seedCompanies(db)
  await db.$transaction((tx) => ensureBaseReferential(tx, A)); await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") }))
})
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(() => NOW); await db.$disconnect(); await db2.$disconnect() })

describe("A1 — acompte et émission du solde sérialisés par le verrou du devis", () => {
  it("création d'acompte pendant l'émission (non committée) du solde ⇒ attend, puis refusée « solde déjà émis » ; émission d'un acompte brouillon après solde émis ⇒ refusée", async () => {
    const quoteId = await acceptedQuote(db, A, "wA", L)
    const final = await finalDraft(db, A, quoteId)
    // Un acompte brouillon créé AVANT l'émission du solde (chemin : il sera refusé à l'émission du solde ? non : l'émission du solde refuse si un acompte brouillon existe ;
    // le scénario A1 est l'inverse : l'acompte arrive PENDANT l'émission).
    const h = await holdTransaction(db2)
    const issue = await issueInvoiceCore(h.tx, { companyId: "coA", invoiceId: final, actorId: "admA", now: NOW, paymentTermsDays: 30, nextLegalNumber: (t, y) => nextDocumentNumber(t, "coA", "INVOICE", y), lockInvoice: lockInvoiceRow, extraChecks: async (t, inv) => (await import("@/lib/billing/invoices/deposit.service")).depositIssueChecks(t, "coA", inv) })
    assert.ok(issue.ok, js(issue))
    let settled = false
    const creating = createDepositInvoice(db, A, quoteId, { kind: "PERCENT", bp: 3000 }, NOW).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la création d'acompte attend le verrou du devis tenu par l'émission"); assert.equal(settled, false)
    await h.commit()
    assert.deepEqual(await creating, { ok: false, error: DEPOSIT_ERRORS.finalIssued })
    assert.equal(await db.invoice.count({ where: { quoteId, kind: "DEPOSIT" } }), 0, "aucun acompte créé sur un devis dont le solde est émis")
    // Seconde barrière : un acompte brouillon qui existerait malgré tout (donnée héritée insérée par SQL direct après l'émission du solde)
    // ne peut pas être émis : la branche DEPOSIT refuse sous verrou du devis.
    const q2 = await acceptedQuote(db, A, "wA", L)
    const f2 = await finalDraft(db, A, q2)
    const issued = await issueInvoice(db, A, f2, NOW); assert.ok(issued.ok, js(issued))
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"createdById","updatedAt","totalHT","totalVAT","totalTTC") VALUES ('dep-legacy','coA','wA','clA','${q2}','PROV-2026-LEGACY','DRAFT','DEPOSIT','admA',now(),300,60,360)`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('dep-legacy-l','dep-legacy','Acompte 30 %',1,300,20,300)`)
    assert.deepEqual(await issueInvoice(db, A, "dep-legacy", NOW), { ok: false, error: DEPOSIT_ERRORS.finalIssued })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: "dep-legacy" } })).status, "DRAFT")
  })
})

describe("Ordre des verrous devis → facture → acomptes (revue interne, constat 1 ; S2)", () => {
  it("émission du solde tenue (devis puis facture verrouillés) ; modification concurrente du brouillon lié au devis ⇒ attend (sur le devis) puis refusée « plus un brouillon » ; aucun interblocage", async () => {
    const quoteId = await acceptedQuote(db, A, "wA", L)
    const final = await finalDraft(db, A, quoteId)
    const h = await holdTransaction(db2)
    const issue = await issueInvoiceCore(h.tx, { companyId: "coA", invoiceId: final, actorId: "admA", now: NOW, paymentTermsDays: 30, nextLegalNumber: (t, y) => nextDocumentNumber(t, "coA", "INVOICE", y), lockInvoice: lockInvoiceRow, extraChecks: async (t, inv) => (await import("@/lib/billing/invoices/deposit.service")).depositIssueChecks(t, "coA", inv) })
    assert.ok(issue.ok, js(issue))
    const form = parseInvoiceForm({ worksiteId: "wA", quoteId, lines: [{ designation: "Prestation", quantity: "1", unitPrice: "1200", vatRate: "20" }] }); assert.ok(form.ok); if (!form.ok) return
    let settled = false
    const updating = updateDraftInvoice(db, A, final, form.value).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la modification attend le verrou du devis (pris en premier, S2)"); assert.equal(settled, false)
    await h.commit()
    const r = await updating
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /brouillon/)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: final }, include: { lines: true } })
    assert.equal(inv.status, "SENT"); assert.equal(inv.totalTTC.toString(), "1200"); assert.equal(inv.lines[0].unitPrice.toString(), "1000")
  })
})

describe("A2 — une seule facture de solde non annulée par devis (service + index partiel)", () => {
  it("deux créations concurrentes de brouillon lié au même devis ⇒ une seule réussit ; la seconde reçoit « déjà lié » ; mise à jour vers un devis déjà lié refusée ; SQL direct refusé", async () => {
    const quoteId = await acceptedQuote(db, A, "wA", L)
    const form = parseInvoiceForm({ worksiteId: "wA", quoteId, lines: L }); assert.ok(form.ok); if (!form.ok) return
    const [r1, r2] = await Promise.all([createDraftInvoice(db, A, form.value, NOW), createDraftInvoice(db, A, form.value, NOW)])
    assert.deepEqual([r1.ok, r2.ok].sort(), [false, true], js([r1, r2]))
    assert.equal([r1, r2].find((r) => !r.ok && r.error === "Ce devis est déjà lié à une facture."), [r1, r2].find((r) => !r.ok))
    assert.equal(await db.invoice.count({ where: { quoteId, kind: "INVOICE", status: { not: "CANCELLED" } } }), 1)
    // Mise à jour d'un autre brouillon vers ce devis : refusée (lecture + index), aucun doublon.
    const other = parseInvoiceForm({ worksiteId: "wA", lines: L }); assert.ok(other.ok); if (!other.ok) return
    const d2 = await createDraftInvoice(db, A, other.value, NOW); assert.ok(d2.ok); if (!d2.ok) return
    const u = await updateDraftInvoice(db, A, d2.value.id, form.value); assert.equal(u.ok, false); assert.match((u as { error: string }).error, /déjà lié/)
    // SQL direct : l'index partiel refuse.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoices SET "quoteId" = '${quoteId}' WHERE id = '${d2.value.id}'`), /already exists|23505/)
    // Un brouillon annulé libère le devis.
    const first = await db.invoice.findFirstOrThrow({ where: { quoteId, kind: "INVOICE", status: { not: "CANCELLED" } } })
    await db.$executeRawUnsafe(`UPDATE invoices SET status = 'CANCELLED' WHERE id = '${first.id}'`)
    const r3 = await createDraftInvoice(db, A, form.value, NOW); assert.ok(r3.ok, js(r3))
  })
})

describe("A4 — une seule facture fournisseur validée par (fournisseur, numéro)", () => {
  it("deux saisies du même document validées en concurrence ⇒ une validée et comptabilisée, l'autre refusée (rollback) ; une seule écriture HA", async () => {
    const mk = () => createSupplierInvoice(db, A, { supplierName: "Fournisseur Doublon", siret: null, number: "FD-2026-001", date: D("2026-03-05"), dueDate: null, totalHTCents: BigInt(10000), vatCents: BigInt(2000), totalTTCCents: BigInt(12000), vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: null, ocr: null })
    const a = await mk(), b = await mk(); assert.ok(a.ok && b.ok); if (!a.ok || !b.ok) return
    const [va, vb] = await Promise.all([validateSupplierInvoice(db, A, a.value.id), validateSupplierInvoice(db2, A, b.value.id)])
    assert.deepEqual([va.ok, vb.ok].sort(), [false, true], js([va, vb]))
    assert.equal(([va, vb].find((r) => !r.ok) as { error: string }).error, SUPPLIER_ERRORS.duplicateNumber)
    assert.equal(await db.supplierInvoice.count({ where: { companyId: "coA", number: "FD-2026-001", status: "VALIDATED" } }), 1)
    assert.equal(await db.supplier.count({ where: { companyId: "coA", name: "Fournisseur Doublon" } }), 1, "un seul fournisseur homonyme créé (verrou par nom)")
    assert.equal(await db.journalEntry.count({ where: { companyId: "coA", journal: { code: "HA" } } }), 1, "une seule écriture d'achat")
    // SQL direct : l'index partiel refuse une seconde validation du même numéro.
    const pending = (await db.supplierInvoice.findFirstOrThrow({ where: { companyId: "coA", number: "FD-2026-001", status: "PENDING" } }))
    const sup = await db.supplier.findFirstOrThrow({ where: { companyId: "coA", name: "Fournisseur Doublon" } })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE supplier_invoices SET status = 'VALIDATED', "supplierId" = '${sup.id}' WHERE id = '${pending.id}'`), /already exists|23505/)
  })
})

describe("A5/A6 — renvoi et relance : données relues sous verrou, jeton protégé", () => {
  it("A5 : le courrier de renvoi reflète la modification committée pendant l'attente du verrou (montant, validité) — jamais la lecture initiale", async () => {
    const p = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", validUntil: "2026-12-31", lines: L }); assert.ok(p.ok); if (!p.ok) return
    const q = await createQuote(db, A, p.value); assert.ok(q.ok); if (!q.ok) return
    const h = await holdTransaction(db2)
    await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q.value.id}' FOR UPDATE`)
    const edited = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", validUntil: "2026-11-30", lines: [{ designation: "Prestation", quantity: "1", unitPrice: "2000", vatRate: "20" }] }); assert.ok(edited.ok); if (!edited.ok) return
    const rep = await replaceQuoteDraftCore(h.tx, { companyId: "coA", quoteId: q.value.id, actorId: "admA", header: { issueDate: new Date("2026-03-10T00:00:00Z"), validUntil: edited.value.validUntil, subject: null, notes: null, paymentTerms: null, globalDiscountBp: 0, vatReverseCharge: false, totalHT: "2000.00", totalVAT: "400.00", totalTTC: "2400.00" }, lines: [{ articleId: null, designation: "Prestation", description: null, unit: "u", quantity: "1.00", unitPrice: "2000.00", vatRate: "20.00", lineHT: "2000.00", discountBp: 0, position: 0 }] })
    assert.ok(rep.ok, js(rep))
    const mails = mailer.sent.length
    const sending = sendQuote(db, A, q.value.id, NOW, () => NOW)
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await h.commit()
    const r = await sending; assert.ok(r.ok, js(r))
    const mail = mailer.sent[mails]; assert.ok(mail)
    assert.match(mail.text ?? mail.html ?? "", /2\D?400,00/, "montant relu sous verrou (2 400 €), pas 1 200 €"); assert.match(mail.text ?? mail.html ?? "", /30\/11\/2026/)
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: q.value.id } })).signatureTokenExpiresAt?.toISOString(), "2026-11-30T23:00:00.000Z", "jeton = fin de la validité relue")
  })
  it("A6 : un renvoi committé entre la lecture des candidats et la relance ⇒ la relance ne remplace pas le jeton frais (garde sur le hachage) ; le nouveau lien reste signable", async () => {
    const p = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-02-01", validUntil: "2026-12-31", lines: L }); assert.ok(p.ok); if (!p.ok) return
    const q = await createQuote(db, A, p.value); assert.ok(q.ok); if (!q.ok) return
    const t0 = new Date("2026-02-01T10:00:00Z")
    const s = await sendQuote(db, A, q.value.id, t0, () => t0); assert.ok(s.ok); if (!s.ok) return
    // Jeton rendu expiré (comme un jeton de 30 j dépassé) pour que la relance veuille en générer un nouveau.
    await db.quote.update({ where: { id: q.value.id }, data: { signatureTokenExpiresAt: new Date("2026-02-20T00:00:00Z") } })
    // Barrière : la relance lit ses candidats pendant que la session 2 tient le verrou ; la session 2 renvoie (nouveau hachage) et committe ; la relance tente sa réclamation.
    const h = await holdTransaction(db2)
    await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q.value.id}' FOR UPDATE`)
    const fresh = generateSignatureToken()
    const late = new Date("2026-03-10T10:00:00Z")
    const run = runQuoteReminders(db, late)
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la relance attend le verrou au moment de réclamer la ligne")
    await h.tx.quote.updateMany({ where: { id: q.value.id, status: "SENT" }, data: { signatureTokenHash: fresh.hash, signatureTokenExpiresAt: new Date("2026-12-31T23:00:00Z") } })
    await h.commit()
    const report = await run
    const after = await db.quote.findUniqueOrThrow({ where: { id: q.value.id } })
    assert.equal(after.signatureTokenHash, fresh.hash, "le jeton renouvelé n'est pas écrasé par la relance")
    assert.equal(after.reminderJ15SentAt, null, "la relance n'a pas été marquée envoyée pour ce devis")
    assert.deepEqual(await signQuoteByToken(db, fresh.token, { signerName: "Client", ipHash: null, now: late, clock: () => late }), { ok: true, value: undefined })
    void report
  })
})

describe("C1 — périodes de déclaration TVA : ni chevauchement, ni période non terminée", () => {
  it("janvier déclaré ⇒ 15 janv → 15 févr refusé (chevauche) ; période se terminant aujourd'hui ou après ⇒ refusée ; périodes disjointes acceptées ; message explicite", async () => {
    setBillingClockForTests(() => new Date("2026-10-26T10:00:00Z"))
    const jan = await declareVat(db, A, D("2026-01-01"), D("2026-01-31"), "DEBITS"); assert.ok(jan.ok, js(jan))
    const ov = await declareVat(db, A, D("2026-01-15"), D("2026-02-15"), "DEBITS")
    assert.equal(ov.ok, false); assert.ok((ov as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.overlaps), js(ov)); assert.match((ov as { error: string }).error, /2026-01-01 → 2026-01-31/)
    assert.deepEqual(await declareVat(db, A, D("2025-12-15"), D("2026-01-01"), "DEBITS"), { ok: false, error: `${VAT_DECLARATION_ERRORS.overlaps} (2026-01-01 → 2026-01-31)` })
    assert.deepEqual(await declareVat(db, A, D("2026-10-01"), D("2026-10-31"), "DEBITS"), { ok: false, error: VAT_DECLARATION_ERRORS.notEnded })
    assert.deepEqual(await declareVat(db, A, D("2026-10-01"), D("2026-10-26"), "DEBITS"), { ok: false, error: VAT_DECLARATION_ERRORS.notEnded }, "le dernier jour n'est pas terminé")
    const feb = await declareVat(db, A, D("2026-02-01"), D("2026-02-28"), "DEBITS"); assert.ok(feb.ok, js(feb))
    assert.equal(await db.vatDeclaration.count({ where: { companyId: "coA" } }), 2)
    // Concurrence DÉTERMINISTE : deux déclarations chevauchantes (deux connexions) suspendues après leur première lecture (instantané
    // SERIALIZABLE pris, aucune ne voit l'autre), relâchées ensemble ⇒ conflit de sérialisation pour l'une, rejouée avec un nouvel
    // instantané ⇒ refus « chevauche » ; une seule ligne enregistrée.
    const gate: { release?: () => void; paused: number } = { paused: 0 }; const open = new Promise<void>((r) => { gate.release = r })
    const hook = (client: PrismaClient) => client.$extends({ query: { vatDeclaration: { async findFirst({ args, query }) { const r = await query(args); if (gate.paused < 2) { gate.paused++; await open } return r } } } }) as unknown as PrismaClient
    const px = declareVat(hook(db), A, D("2026-03-01"), D("2026-03-31"), "DEBITS"), py = declareVat(hook(db2), A, D("2026-03-15"), D("2026-04-15"), "DEBITS")
    assert.ok(await waitFor(async () => gate.paused === 2), "les deux déclarations ont pris leur instantané"); gate.release!()
    const [x, y] = await Promise.all([px, py])
    assert.deepEqual([x.ok, y.ok].sort(), [false, true], js([x, y]))
    assert.ok(([x, y].find((r) => !r.ok) as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.overlaps), js([x, y]))
    assert.equal(await db.vatDeclaration.count({ where: { companyId: "coA" } }), 3)
    void QUOTE_ERRORS; void issuedDeposit
  })
})
