// Lot C1 — tests PostgreSQL (base jetable migrée ; DATABASE_URL obligatoire) : cycle complet, signature par jeton,
// conversion concurrente, isolation multi-société, relances idempotentes, import, non-régression drapeau OFF.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { hashSignatureToken } from "@/lib/billing/quotes/quote-signature"
import {
  acceptQuoteManually, convertQuote, createQuote, deleteDraftQuote, duplicateQuote, expireQuote, exportQuotesCsv, getQuoteForSignature, importQuotes,
  refuseQuote, runQuoteReminders, sendQuote, signQuoteByToken, updateQuote,
} from "@/lib/billing/quotes/quote.service"
import { listQuotes } from "@/lib/billing/quotes/quote-queries"
import { buildQuotePdfData } from "@/lib/billing/pdf/quote-pdf"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const mailer = new RecordingMailer()
const now = new Date("2026-03-10T10:00:00Z")
const form = (over: Record<string, unknown> = {}) => ({ worksiteId: "wA", issueDate: "2026-03-10", validUntil: "2026-04-10", subject: "Toiture", lines: [{ designation: "Tuiles", quantity: "10", unitPrice: "12,50", vatRate: "20" }, { designation: "Pose", unit: "h", quantity: "2", unitPrice: "40", discount: "10", vatRate: "10" }], ...over })
const parsed = (over: Record<string, unknown> = {}) => { const r = parseQuoteForm(form(over)); if (!r.ok) throw new Error(r.error); return r.value }

before(async () => {
  setBillingClockForTests(() => now) // R3 : horloge de décision déterministe dans les tests
  setBillingMailerForTests(mailer)
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b',NULL,NULL,now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test',now()),('clA2','coA','Client A2',NULL,now()),('clB','coB','Client B','client-b@example.test',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wA2','coA','clA2','admA','Sans mail',now()),('wB','coB','clB','admB','Maison B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO articles(id,"companyId",designation,"unitPrice","vatRate","updatedAt") VALUES ('artB','coB','Article B',10,20,now())`)
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

const ids: Record<string, string> = {}

describe("Création, modification, duplication, suppression", () => {
  it("crée un brouillon numéroté avec totaux exacts et lignes (remise de ligne stockée dans lineHT)", async () => {
    const r = await createQuote(db, A, parsed())
    assert.ok(r.ok); if (!r.ok) return
    ids.q1 = r.value.id
    assert.equal(r.value.number, "DEV-2026-0001")
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.q1 }, include: { lines: { orderBy: { position: "asc" } } } })
    assert.equal(q.totalHT.toFixed(2), "197.00"); assert.equal(q.totalVAT.toFixed(2), "32.20"); assert.equal(q.totalTTC.toFixed(2), "229.20")
    assert.equal(q.lines[1].lineHT.toFixed(2), "72.00"); assert.equal(q.lines[1].discountBp, 1000); assert.equal(q.lines[0].vatRate.toFixed(2), "20.00")
    assert.equal(q.clientId, "clA")
    assert.equal((await db.historyLog.count({ where: { entityType: "Quote", entityId: ids.q1, action: "CREATED" } })), 1)
  })
  it("validité par défaut = paramètres (30 j) quand absente", async () => {
    const r = await createQuote(db, A, parsed({ validUntil: "" }))
    assert.ok(r.ok); if (!r.ok) return
    ids.q2 = r.value.id
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: ids.q2 } })).validUntil?.toISOString(), "2026-04-09T00:00:00.000Z")
  })
  it("refuse un chantier ou un article d'une autre société", async () => {
    assert.deepEqual(await createQuote(db, B, parsed()), { ok: false, error: "Chantier introuvable." })
    assert.deepEqual(await createQuote(db, A, parsed({ lines: [{ articleId: "artB", designation: "x", quantity: "1", unitPrice: "1", vatRate: "20" }] })), { ok: false, error: "Article introuvable." })
  })
  it("modifie un brouillon (totaux recalculés) ; la société B ne voit ni ne modifie le devis de A", async () => {
    const r = await updateQuote(db, A, ids.q2, parsed({ lines: [{ designation: "Seule", quantity: "1", unitPrice: "100", vatRate: "5.5" }], globalDiscount: "10" }))
    assert.equal(r.ok, true)
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.q2 }, include: { lines: true } })
    assert.equal(q.totalHT.toFixed(2), "90.00"); assert.equal(q.totalVAT.toFixed(2), "4.95"); assert.equal(q.lines.length, 1); assert.equal(q.globalDiscountBp, 1000)
    assert.deepEqual(await updateQuote(db, B, ids.q2, parsed()), { ok: false, error: "Chantier introuvable." })
    assert.equal((await listQuotes(db, "coB", {})).total, 0)
    assert.equal((await listQuotes(db, "coA", { search: "toiture" })).total, 2)
    assert.equal(await buildQuotePdfData(db, "coB", ids.q1), null)
    assert.ok((await buildQuotePdfData(db, "coA", ids.q1))?.seller.lines.some((l) => l === "SIREN 123456789"))
  })
  it("duplique (nouveau numéro, brouillon) et supprime un brouillon ; un devis envoyé n'est pas supprimable", async () => {
    const d = await duplicateQuote(db, A, ids.q2, now)
    assert.ok(d.ok); if (!d.ok) return
    assert.equal(d.value.number, "DEV-2026-0003")
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: d.value.id } })).status, "DRAFT")
    assert.equal((await deleteDraftQuote(db, A, d.value.id)).ok, true)
    assert.equal(await db.quote.findUnique({ where: { id: d.value.id } }), null)
    assert.deepEqual(await deleteDraftQuote(db, B, ids.q2), { ok: false, error: "Devis introuvable." })
  })
})

describe("Envoi, signature par jeton, refus, expiration", () => {
  it("envoi : exige un e-mail client, passe en SENT, stocke le hachage du jeton, journalise un courrier SIMULATED", async () => {
    const noMail = await createQuote(db, A, parsed({ worksiteId: "wA2" }))
    assert.ok(noMail.ok); if (!noMail.ok) return
    assert.deepEqual(await sendQuote(db, A, noMail.value.id, now), { ok: false, error: "Le client n'a pas d'adresse e-mail : renseignez-la avant l'envoi." })
    const before = mailer.sent.length
    const r = await sendQuote(db, A, ids.q1, now)
    assert.ok(r.ok); if (!r.ok) return
    assert.equal(r.value.status, "SIMULATED")
    const token = r.value.signatureUrl.split("/devis-signature/")[1]
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    ids.token1 = token
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.q1 } })
    assert.equal(q.status, "SENT"); assert.equal(q.signatureTokenHash, hashSignatureToken(token)); // P2-04 : expiration du jeton = fin du jour civil de validité en Europe/Paris (10/04/2026, heure d'été : 22:00 UTC).
    assert.equal(q.signatureTokenExpiresAt?.toISOString(), "2026-04-10T22:00:00.000Z")
    assert.equal(mailer.sent.length, before + 1); assert.ok(mailer.sent.at(-1)?.text.includes(token))
    const log = await db.billingMailLog.findFirst({ where: { documentId: ids.q1 } })
    assert.equal(log?.status, "SIMULATED"); assert.equal(log?.kind, "QUOTE_SENT")
    assert.deepEqual(await sendQuote(db, B, ids.q1, now), { ok: false, error: "Devis introuvable." })
  })
  it("page publique : jeton valide ⇒ devis lisible (sans session) ; expiré ⇒ état seul ; jeton inconnu ⇒ null", async () => {
    const v = await getQuoteForSignature(db, ids.token1, now)
    assert.equal(v?.number, "DEV-2026-0001"); assert.equal(v?.signable, true); assert.equal(v?.company.name, "Société A")
    const late = await getQuoteForSignature(db, ids.token1, new Date("2026-05-01T00:00:00Z"))
    assert.equal(late?.signable, false); assert.ok(late && !("lines" in late), "contenu non exposé si jeton expiré")
    assert.equal(await getQuoteForSignature(db, "A".repeat(43), now), null)
    assert.equal(await getQuoteForSignature(db, "../x", now), null)
  })
  it("renvoi : nouveau jeton, l'ancien devient invalide", async () => {
    const r = await sendQuote(db, A, ids.q1, now)
    assert.ok(r.ok); if (!r.ok) return
    const token2 = r.value.signatureUrl.split("/devis-signature/")[1]
    assert.notEqual(token2, ids.token1)
    assert.equal(await getQuoteForSignature(db, ids.token1, now), null)
    ids.token1 = token2
  })
  it("signature : nom requis, jeton expiré refusé, puis ACCEPTED avec trace ; réutilisation refusée", async () => {
    assert.equal((await signQuoteByToken(db, ids.token1, { signerName: "A", ipHash: null, now })).ok, false)
    assert.deepEqual(await signQuoteByToken(db, ids.token1, { signerName: "Jean Client", ipHash: "h", now: new Date("2026-05-01T00:00:00Z") }), { ok: false, error: "Lien de signature invalide ou expiré." })
    const r = await signQuoteByToken(db, ids.token1, { signerName: "Jean Client", ipHash: "h".repeat(64), now })
    assert.deepEqual(r, { ok: true, value: undefined })
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.q1 } })
    assert.equal(q.status, "ACCEPTED"); assert.equal(q.signerName, "Jean Client"); assert.equal(q.signedAt?.toISOString(), now.toISOString()); assert.equal(q.signatureIpHash, "h".repeat(64))
    assert.deepEqual(await signQuoteByToken(db, ids.token1, { signerName: "Encore", ipHash: null, now }), { ok: false, error: "Ce devis n'est pas en attente de signature." })
    assert.ok((await db.historyLog.findFirst({ where: { entityId: ids.q1, action: "STATUS_CHANGED" }, orderBy: { createdAt: "desc" } }))?.detail?.includes("signé en ligne"))
  })
  it("refus et expiration manuels ; acceptation manuelle", async () => {
    const s = await createQuote(db, A, parsed()); assert.ok(s.ok); if (!s.ok) return
    assert.deepEqual(await refuseQuote(db, A, s.value.id, "trop cher", now), { ok: false, error: "Changement de statut non autorisé." })
    await sendQuote(db, A, s.value.id, now)
    assert.equal((await refuseQuote(db, A, s.value.id, "trop cher", now)).ok, true)
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: s.value.id } })).refusalReason, "trop cher")
    const e = await createQuote(db, A, parsed()); assert.ok(e.ok); if (!e.ok) return
    assert.equal((await expireQuote(db, A, e.value.id, now)).ok, true)
    const m = await createQuote(db, A, parsed()); assert.ok(m.ok); if (!m.ok) return
    await sendQuote(db, A, m.value.id, now)
    assert.equal((await acceptQuoteManually(db, A, m.value.id, now)).ok, true)
    ids.qManual = m.value.id
  })
})

describe("Conversion en facture", () => {
  it("suppression concurrente : le devis envoyé entre-temps garde ses lignes", async () => {
    const d = await createQuote(db, A, parsed()); assert.ok(d.ok); if (!d.ok) return
    await sendQuote(db, A, d.value.id, now)
    assert.deepEqual(await deleteDraftQuote(db, A, d.value.id), { ok: false, error: "Seul un brouillon peut être supprimé." })
    assert.equal(await db.quoteLine.count({ where: { quoteId: d.value.id } }), 2)
  })
  it("deux conversions concurrentes ⇒ une seule facture brouillon (numéro provisoire), devis CONVERTED, totaux copiés", async () => {
    const results = await Promise.all([convertQuote(db, A, ids.q1, now), convertQuote(db, A, ids.q1, now)])
    assert.ok(results.every((r) => r.ok))
    const okRes = results.filter((r): r is { ok: true; value: { invoiceId: string; invoiceNumber: string; existing: boolean } } => r.ok)
    assert.equal(new Set(okRes.map((r) => r.value.invoiceId)).size, 1)
    assert.equal(okRes.filter((r) => !r.value.existing).length, 1)
    const invoices = await db.invoice.findMany({ where: { quoteId: ids.q1 }, include: { lines: true } })
    assert.equal(invoices.length, 1)
    assert.equal(invoices[0].status, "DRAFT"); assert.match(invoices[0].number, /^PROV-2026-\d{4}$/); assert.equal(invoices[0].totalTTC.toFixed(2), "229.20"); assert.equal(invoices[0].lines.length, 2); assert.equal(invoices[0].lines[1].discountBp, 1000)
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: ids.q1 } })).status, "CONVERTED")
    ids.inv1 = invoices[0].id
  })
  it("non converti sans acceptation ; autre société ⇒ introuvable ; troisième appel idempotent", async () => {
    assert.deepEqual(await convertQuote(db, A, ids.q2, now), { ok: false, error: "Seul un devis accepté peut être converti en facture." })
    assert.deepEqual(await convertQuote(db, B, ids.q1, now), { ok: false, error: "Devis introuvable." })
    const r = await convertQuote(db, A, ids.q1, now)
    assert.deepEqual(r, { ok: true, value: { invoiceId: ids.inv1, invoiceNumber: (await db.invoice.findUniqueOrThrow({ where: { id: ids.inv1 } })).number, existing: true } })
  })
})

describe("Relances et expiration automatiques (job idempotent)", () => {
  it("un seul courrier par devis et par exécution (palier le plus élevé), jamais deux fois le même palier ; expiration des devis dépassés", async () => {
    const r = await createQuote(db, A, parsed({ validUntil: "2026-12-31" })); assert.ok(r.ok); if (!r.ok) return
    await sendQuote(db, A, r.value.id, now)
    const old = await createQuote(db, A, parsed({ validUntil: "2026-03-15" })); assert.ok(old.ok); if (!old.ok) return
    await sendQuote(db, A, old.value.id, now)
    const before = mailer.sent.length
    const t8 = new Date("2026-03-18T10:00:00Z")
    const hashBefore = (await db.quote.findUniqueOrThrow({ where: { id: r.value.id } })).signatureTokenHash
    // Devis SENT dus à J+8 (envoyés le 10/03, validité ≥ 18/03, client avec e-mail) : ceux des tests précédents comptent aussi.
    const dueCount = await db.quote.count({ where: { status: "SENT", sentAt: { lte: new Date("2026-03-15T00:00:00Z") }, validUntil: { gte: new Date("2026-03-18T00:00:00Z") }, client: { email: { not: null } } } })
    assert.ok(dueCount >= 1)
    const run1 = await runQuoteReminders(db, t8)
    assert.equal(run1.expired, 1)
    // J+8 : paliers 3 et 7 dus ⇒ UN courrier par devis (J+7), J+3 marqué sauté.
    assert.deepEqual(run1.reminders, [{ step: 3, sent: 0 }, { step: 7, sent: dueCount }, { step: 15, sent: 0 }])
    const run2 = await runQuoteReminders(db, t8)
    assert.deepEqual(run2, { expired: 0, reminders: [{ step: 3, sent: 0 }, { step: 7, sent: 0 }, { step: 15, sent: 0 }] })
    assert.equal(mailer.sent.length, before + dueCount)
    const q = await db.quote.findUniqueOrThrow({ where: { id: r.value.id } })
    assert.ok(q.reminderJ3SentAt && q.reminderJ7SentAt && !q.reminderJ15SentAt)
    assert.equal(q.signatureTokenHash, hashBefore, "lien non expiré : jeton conservé")
    assert.ok(!mailer.sent.at(-1)?.text.includes("/devis-signature/"), "pas de nouveau lien tant que l'ancien est valable")
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: old.value.id } })).status, "EXPIRED")
    assert.equal(await db.billingMailLog.count({ where: { documentId: r.value.id, kind: "QUOTE_REMINDER_J3" } }), 0)
    assert.equal(await db.billingMailLog.count({ where: { documentId: r.value.id, kind: "QUOTE_REMINDER_J7" } }), 1)
    const run3 = await runQuoteReminders(db, new Date("2026-03-26T10:00:00Z"))
    assert.deepEqual(run3.reminders, [{ step: 3, sent: 0 }, { step: 7, sent: 0 }, { step: 15, sent: dueCount }])
    // Jeton expiré (validité 10/04 dépassée) : la relance régénère le lien.
    const late = await createQuote(db, A, parsed({ validUntil: "2026-12-31" })); assert.ok(late.ok); if (!late.ok) return
    await sendQuote(db, A, late.value.id, now)
    await db.$executeRawUnsafe(`UPDATE quotes SET "signatureTokenExpiresAt" = '2026-03-11' WHERE id = '${late.value.id}'`)
    const run4 = await runQuoteReminders(db, new Date("2026-03-14T10:00:00Z"))
    assert.equal(run4.reminders[0].sent, 1)
    assert.ok(mailer.sent.at(-1)?.text.includes("/devis-signature/"))
    assert.notEqual((await db.quote.findUniqueOrThrow({ where: { id: late.value.id } })).signatureTokenHash, null)
  })
})

describe("Import et export CSV", () => {
  it("import : devis créés par référence, référence déjà importée ignorée, chantier inconnu invalide", async () => {
    const csv = "reference;chantier;designation;quantite;prix_unitaire_ht;tva\nIMP-1;Maison A;Tuiles;2;10;20\nIMP-1;Maison A;Pose;1;50;10\nIMP-2;Inconnu;X;1;1;20"
    const r1 = await importQuotes(db, A, csv, now)
    assert.equal(r1.imported.length, 1); assert.equal(r1.invalid.length, 1); assert.equal(r1.skipped.length, 0)
    const r2 = await importQuotes(db, A, csv, now)
    assert.equal(r2.imported.length, 0); assert.equal(r2.skipped.length, 1)
    const q = await db.quote.findFirstOrThrow({ where: { companyId: "coA", importRef: "IMP-1" }, include: { lines: true } })
    assert.equal(q.lines.length, 2); assert.equal(q.totalTTC.toFixed(2), "79.00")
    // La société B peut importer la même référence (unicité par société).
    const r3 = await importQuotes(db, B, "reference;chantier;designation;quantite;prix_unitaire_ht;tva\nIMP-1;Maison B;X;1;1;20", now)
    assert.equal(r3.imported.length, 1)
  })
  it("export : BOM, séparateur ; et cellules neutralisées ; filtré par société", async () => {
    const csv = await exportQuotesCsv(db, "coA", {})
    assert.ok(csv.startsWith("﻿Numéro;Statut"))
    assert.ok(csv.includes("DEV-2026-0001;Converti"))
    assert.ok(!csv.includes("Maison B"))
  })
})

describe("Non-régression Lot B (drapeau OFF : chemins existants inchangés)", () => {
  it("les déclencheurs Lot B restent actifs sur la facture issue d'une conversion (contenu figé après émission)", async () => {
    await db.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='${ids.inv1}'`)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoice_lines SET designation='X' WHERE "invoiceId"='${ids.inv1}'`), /INVOICE_IMMUTABLE/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoices SET status='DRAFT' WHERE id='${ids.inv1}'`), /INVOICE_IMMUTABLE/)
  })
})
