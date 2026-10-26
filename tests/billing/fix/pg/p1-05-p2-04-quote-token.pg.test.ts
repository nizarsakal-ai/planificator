// P1-05 — L'autorité du jeton est vérifiée AU MOMENT de la décision (verrou de ligne + UPDATE conditionnel sur hachage/expiration/statut) :
// courses signature/refus vs renouvellement dans les deux ordres, signature vs refus, deux signatures, expiration pendant la requête,
// rejeu. P2-04 — validité métier dépassée ⇒ refus de l'envoi/renvoi et de la décision (aucun jeton, aucun courrier même simulé).
// Deux connexions PostgreSQL indépendantes et barrières explicites (verrou tenu, puis commit).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { QUOTE_ERRORS, transitionQuoteCore } from "@/lib/billing/quotes/quote-lifecycle.core"
import { createQuote, getQuoteForSignature, refuseQuoteByToken, runQuoteReminders, sendQuote, signQuoteByToken } from "@/lib/billing/quotes/quote.service"
import { generateSignatureToken, hashSignatureToken } from "@/lib/billing/quotes/quote-signature"
import { quoteValidityEnd } from "@/lib/billing/quotes/quote-validity"
import { A, holdTransaction, js, seedCompanies, waitFor, waitingSessions } from "./helpers"

const db = new PrismaClient()
const db2 = new PrismaClient()
const mailer = new RecordingMailer()
const NOW = new Date("2026-03-10T10:00:00Z")
const tokenOf = (r: { ok: true; value: { signatureUrl: string } } | { ok: false }) => { if (!r.ok) throw new Error("envoi refusé"); return r.value.signatureUrl.split("/devis-signature/")[1] }
async function sentQuote(validUntil: string | "" = "2026-12-31", issueDate = "2026-03-10", now = NOW): Promise<{ id: string; token: string }> {
  const p = parseQuoteForm({ worksiteId: "wA", issueDate, validUntil, lines: [{ designation: "T", quantity: "1", unitPrice: "100", vatRate: "20" }] }); if (!p.ok) throw new Error(p.error)
  const q = await createQuote(db, A, p.value); if (!q.ok) throw new Error(q.error)
  const s = await sendQuote(db, A, q.value.id, now)
  return { id: q.value.id, token: tokenOf(s) }
}
const audits = (id: string) => db.historyLog.count({ where: { entityId: id, action: "STATUS_CHANGED", detail: { contains: "signé en ligne" } } })
const row = (id: string) => db.quote.findUniqueOrThrow({ where: { id }, select: { status: true, signatureTokenHash: true, signatureTokenExpiresAt: true, signerName: true, refusedAt: true } })
/** Verrou de la ligne portant le jeton, tenu sur la connexion 2 (même protocole que la décision/le renvoi). */
async function lockRow(id: string) { const h = await holdTransaction(db2); await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${id}' FOR UPDATE`); return h }

before(async () => { setBillingMailerForTests(mailer); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("P1-05 — courses à deux sessions (barrières explicites)", () => {
  it("renouvellement committé AVANT la décision ⇒ l'ancien lien échoue (aucune décision), le nouveau reste utilisable ; une seule trace", async () => {
    const { id, token } = await sentQuote()
    const h = await holdTransaction(db2)
    // La session 2 renouvelle le jeton (même écriture conditionnelle que sendQuote) et garde la transaction ouverte.
    const fresh = generateSignatureToken()
    await h.tx.quote.updateMany({ where: { id, companyId: "coA", status: "SENT" }, data: { signatureTokenHash: fresh.hash, signatureTokenExpiresAt: quoteValidityEnd(new Date("2026-12-31T00:00:00Z")) } })
    let settled = false
    const sign = signQuoteByToken(db, token, { signerName: "Ancien lien", ipHash: null, now: NOW }).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la signature attend le verrou du renouvellement"); assert.equal(settled, false)
    await h.commit()
    assert.deepEqual(await sign, { ok: false, error: QUOTE_ERRORS.tokenInvalid })
    const r1 = await row(id); assert.equal(r1.status, "SENT"); assert.equal(r1.signerName, null); assert.equal(r1.signatureTokenHash, fresh.hash)
    assert.deepEqual(await signQuoteByToken(db, fresh.token, { signerName: "Nouveau lien", ipHash: null, now: NOW }), { ok: true, value: undefined })
    assert.equal((await row(id)).status, "ACCEPTED"); assert.equal(await audits(id), 1)
  })
  it("décision (signature) en cours ⇒ le renvoi attend puis est refusé : aucun nouveau jeton, aucun courrier (même simulé)", async () => {
    const { id, token } = await sentQuote()
    const h = await lockRow(id)
    const mailsBefore = mailer.sent.length
    const hashBefore = (await row(id)).signatureTokenHash
    let settled = false
    const resend = sendQuote(db, A, id, NOW).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); assert.equal(settled, false)
    // La session 2 (détentrice du verrou) prend la décision avec le protocole réel (relecture + transition conditionnée au hachage).
    const t = await transitionQuoteCore(h.tx, { companyId: "coA", quoteId: id, to: "ACCEPTED", actorId: "admA", now: NOW, guard: { signatureTokenHash: hashSignatureToken(token), signatureTokenExpiresAt: { gte: NOW } }, data: { signerName: "Client", signedAt: NOW } })
    assert.ok(t.ok, js(t)); await h.commit()
    const r = await resend
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /modifié entre-temps|envoyé peut être envoyé/)
    assert.equal(mailer.sent.length, mailsBefore, "aucun courrier pour un renvoi refusé")
    const after = await row(id); assert.equal(after.status, "ACCEPTED"); assert.equal(after.signatureTokenHash, hashBefore, "jeton inchangé")
  })
  it("refus vs renouvellement (deux ordres) : jamais de refus avec un jeton remplacé ; renouvellement refusé après le refus", async () => {
    // Ordre 1 : renouvellement d'abord.
    const a = await sentQuote()
    const h = await holdTransaction(db2)
    const fresh = generateSignatureToken()
    await h.tx.quote.updateMany({ where: { id: a.id, status: "SENT" }, data: { signatureTokenHash: fresh.hash } })
    const refuse = refuseQuoteByToken(db, a.token, { reason: "non", now: NOW })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await h.commit()
    assert.deepEqual(await refuse, { ok: false, error: QUOTE_ERRORS.tokenInvalid }); assert.equal((await row(a.id)).status, "SENT")
    assert.deepEqual(await refuseQuoteByToken(db, fresh.token, { reason: "non", now: NOW }), { ok: true, value: undefined })
    // Ordre 2 : refus d'abord (sous verrou), renouvellement en attente ⇒ refusé.
    const b = await sentQuote()
    const h2 = await lockRow(b.id)
    const resend = sendQuote(db, A, b.id, NOW)
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1))
    const t = await transitionQuoteCore(h2.tx, { companyId: "coA", quoteId: b.id, to: "REFUSED", actorId: "admA", now: NOW, guard: { signatureTokenHash: hashSignatureToken(b.token) }, data: { refusalReason: "trop cher" } }); assert.ok(t.ok)
    await h2.commit()
    assert.equal((await resend).ok, false); assert.equal((await row(b.id)).status, "REFUSED")
  })
  it("signature vs refus et deux signatures concurrentes ⇒ une seule décision, une seule trace ; rejeu après décision refusé", async () => {
    const { id, token } = await sentQuote()
    const h = await lockRow(id)
    const sign = signQuoteByToken(db, token, { signerName: "Session A", ipHash: null, now: NOW })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1))
    const t = await transitionQuoteCore(h.tx, { companyId: "coA", quoteId: id, to: "ACCEPTED", actorId: "admA", now: NOW, guard: { signatureTokenHash: hashSignatureToken(token) }, data: { signerName: "Session B", signedAt: NOW }, detail: "signé en ligne (session B)" }); assert.ok(t.ok)
    await h.commit()
    assert.deepEqual(await sign, { ok: false, error: QUOTE_ERRORS.notSent })
    assert.equal((await row(id)).signerName, "Session B"); assert.equal(await audits(id), 1)
    assert.deepEqual(await refuseQuoteByToken(db, token, { reason: null, now: NOW }), { ok: false, error: QUOTE_ERRORS.notSent })
    assert.deepEqual(await signQuoteByToken(db, token, { signerName: "Rejeu", ipHash: null, now: NOW }), { ok: false, error: QUOTE_ERRORS.notSent })
  })
  it("expiration pendant la requête : le jeton expire (ou la validité est dépassée) pendant l'attente du verrou ⇒ refus, aucune acceptation", async () => {
    const { id, token } = await sentQuote()
    const h = await lockRow(id)
    const sign = signQuoteByToken(db, token, { signerName: "Tardif", ipHash: null, now: NOW })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1))
    await h.tx.$executeRawUnsafe(`UPDATE quotes SET "signatureTokenExpiresAt" = '2026-03-10T09:00:00Z' WHERE id = '${id}'`)
    await h.commit()
    assert.deepEqual(await sign, { ok: false, error: QUOTE_ERRORS.tokenInvalid }); assert.equal((await row(id)).status, "SENT")
    // Validité métier dépassée pendant l'attente (jeton techniquement encore valide) ⇒ refus P2-04 à l'exécution.
    const b = await sentQuote()
    const h2 = await lockRow(b.id)
    const sign2 = signQuoteByToken(db, b.token, { signerName: "Tardif", ipHash: null, now: NOW })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1))
    await h2.tx.$executeRawUnsafe(`UPDATE quotes SET "validUntil" = '2026-03-01T00:00:00Z' WHERE id = '${b.id}'`)
    await h2.commit()
    assert.deepEqual(await sign2, { ok: false, error: QUOTE_ERRORS.expired }); assert.equal((await row(b.id)).status, "SENT")
    const pub = await getQuoteForSignature(db, b.token, NOW); assert.equal(pub?.signable, false)
  })
})

describe("P2-04 — validité métier dépassée : aucune prolongation silencieuse", () => {
  it("validUntil 01/01/2026, renvoi et signature le 01/02/2026 ⇒ refus ; aucun jeton ni courrier (même simulé) ; duplication proposée", async () => {
    const dec = new Date("2025-12-15T10:00:00Z")
    const q = await sentQuote("2026-01-01", "2025-12-01", dec)
    const before = await row(q.id); const mails = mailer.sent.length
    const feb = new Date("2026-02-01T10:00:00Z")
    const resend = await sendQuote(db, A, q.id, feb)
    assert.deepEqual(resend, { ok: false, error: QUOTE_ERRORS.expired })
    assert.deepEqual(await row(q.id), before, "aucune mise à jour du jeton"); assert.equal(mailer.sent.length, mails, "aucun courrier")
    assert.deepEqual(await signQuoteByToken(db, q.token, { signerName: "Client tardif", ipHash: null, now: feb }), { ok: false, error: QUOTE_ERRORS.tokenInvalid }) // jeton expiré avec la validité
    assert.equal((await getQuoteForSignature(db, q.token, feb))?.signable, false)
    assert.match(QUOTE_ERRORS.expired, /Dupliquez/)
    // Brouillon périmé : l'envoi initial est refusé lui aussi.
    const p = parseQuoteForm({ worksiteId: "wA", issueDate: "2025-12-01", validUntil: "2026-01-01", lines: [{ designation: "T", quantity: "1", unitPrice: "1", vatRate: "20" }] }); assert.ok(p.ok); if (!p.ok) return
    const d = await createQuote(db, A, p.value); assert.ok(d.ok); if (!d.ok) return
    assert.deepEqual(await sendQuote(db, A, d.value.id, feb), { ok: false, error: QUOTE_ERRORS.expired })
    assert.equal((await row(d.value.id)).status, "DRAFT"); assert.equal(mailer.sent.length, mails)
  })
  it("validité absente ⇒ jeton 30 jours ; validité future ⇒ jeton = fin du jour civil Europe/Paris ; bornes exactes (22:59:59 / 23:00:00 UTC en hiver) ; passage de jour et changements d'heure", async () => {
    const none = await sentQuote("")
    const rn = await row(none.id)
    // validUntil par défaut = issueDate + 30 j (paramètres) ⇒ jeton = fin de ce jour en Europe/Paris.
    const vu = (await db.quote.findUniqueOrThrow({ where: { id: none.id } })).validUntil!
    assert.equal(rn.signatureTokenExpiresAt?.toISOString(), quoteValidityEnd(vu).toISOString())
    // Devis valable jusqu'au 10/03/2026 (CET, UTC+1) : signable à 22:59:59Z, refusé à 23:00:00Z.
    const today = await sentQuote("2026-03-10")
    const lastInstant = new Date("2026-03-10T22:59:59.999Z"), firstInvalid = new Date("2026-03-10T23:00:00.000Z")
    assert.equal((await getQuoteForSignature(db, today.token, lastInstant))?.signable, true)
    assert.equal((await getQuoteForSignature(db, today.token, firstInvalid))?.signable, false)
    // À l'instant exact de fin de validité, l'expiration technique du jeton (= fin de validité) n'est pas encore « < now » : c'est la règle de validité métier qui refuse.
    assert.deepEqual(await refuseQuoteByToken(db, today.token, { reason: null, now: firstInvalid }), { ok: false, error: QUOTE_ERRORS.expired })
    assert.deepEqual(await signQuoteByToken(db, today.token, { signerName: "Trop tard", ipHash: null, now: new Date("2026-03-10T23:00:00.001Z") }), { ok: false, error: QUOTE_ERRORS.tokenInvalid })
    assert.deepEqual(await signQuoteByToken(db, today.token, { signerName: "Juste à temps", ipHash: null, now: lastInstant }), { ok: true, value: undefined })
    // Changement d'heure (29/03/2026, CEST) : validité jusqu'au 29/03 ⇒ fin = 29/03 22:00Z ; jusqu'au 28/03 ⇒ 28/03 23:00Z.
    const dst = await sentQuote("2026-03-29")
    assert.equal((await row(dst.id)).signatureTokenExpiresAt?.toISOString(), "2026-03-29T22:00:00.000Z")
    const preDst = await sentQuote("2026-03-28")
    assert.equal((await row(preDst.id)).signatureTokenExpiresAt?.toISOString(), "2026-03-28T23:00:00.000Z")
    // Automne (25/10/2026) : validité jusqu'au 24/10 ⇒ 24/10 22:00Z ; jusqu'au 25/10 ⇒ 25/10 23:00Z.
    assert.equal(quoteValidityEnd(new Date("2026-10-24T00:00:00Z")).toISOString(), "2026-10-24T22:00:00.000Z")
    assert.equal(quoteValidityEnd(new Date("2026-10-25T00:00:00Z")).toISOString(), "2026-10-25T23:00:00.000Z")
  })
  it("relances : un devis périmé est expiré au passage, jamais relancé ni doté d'un nouveau jeton ; la décision ne dépend pas du cron", async () => {
    const q = await sentQuote("2026-03-12")
    const before = await row(q.id)
    // Le 13/03 à 00:30 Paris (12/03 23:30Z) : la validité (12/03 inclus) est révolue ⇒ signature refusée AVANT tout cron.
    const late = new Date("2026-03-12T23:30:00Z")
    assert.deepEqual(await signQuoteByToken(db, q.token, { signerName: "Client tardif", ipHash: null, now: late }), { ok: false, error: QUOTE_ERRORS.tokenInvalid })
    const mails = mailer.sent.length
    const run = await runQuoteReminders(db, late)
    assert.ok(run.expired >= 1, js(run))
    const after = await row(q.id)
    assert.equal(after.status, "EXPIRED"); assert.equal(after.signatureTokenHash, before.signatureTokenHash, "aucun nouveau jeton"); assert.equal(mailer.sent.filter((m) => m.subject.includes("Relance")).length, mailer.sent.slice(0, mails).filter((m) => m.subject.includes("Relance")).length)
  })
})
