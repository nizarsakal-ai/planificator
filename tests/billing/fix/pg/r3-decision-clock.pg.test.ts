// R3 (revue Codex R2, 26/10/2026) — l'instant de la décision est RELU après l'acquisition du verrou. Reproduction Codex : jeton
// expirant 700 ms après le début ; une seconde session verrouille le devis ; la signature démarre AVANT l'expiration, attend le
// verrou et ne reprend qu'APRÈS l'expiration réelle (aucune colonne modifiée pendant l'attente : seul le temps réel a passé) ⇒ REFUS.
// Variantes : refus par lien ; passage naturel de la validité métier (horloge contrôlable ancrée à 22:59:59,900 Paris + temps réel
// écoulé) ; renvoi (sendQuote) ; décision à temps toujours acceptée ; horloge non monotone. Deux connexions, barrières explicites.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { QUOTE_ERRORS } from "@/lib/billing/quotes/quote-lifecycle.core"
import { createQuote, refuseQuoteByToken, sendQuote, signQuoteByToken } from "@/lib/billing/quotes/quote.service"
import { A, NOW, holdTransaction, js, seedCompanies, waitFor, waitingSessions, useTestClock } from "./helpers"

const db = new PrismaClient(), db2 = new PrismaClient()
const mailer = new RecordingMailer()
const tokenOf = (r: { ok: true; value: { signatureUrl: string } } | { ok: false; error: string }) => { if (!r.ok) throw new Error(r.error); return r.value.signatureUrl.split("/devis-signature/")[1] }
async function sentQuote(validUntil = "2026-12-31", now = NOW): Promise<{ id: string; token: string }> {
  const p = parseQuoteForm({ worksiteId: "wA", issueDate: now.toISOString().slice(0, 10), validUntil, lines: [{ designation: "T", quantity: "1", unitPrice: "100", vatRate: "20" }] }); if (!p.ok) throw new Error(p.error)
  const q = await createQuote(db, A, p.value); if (!q.ok) throw new Error(q.error)
  return { id: q.value.id, token: tokenOf(await sendQuote(db, A, q.value.id, now, () => now)) }
}
const row = (id: string) => db.quote.findUniqueOrThrow({ where: { id }, select: { status: true, signerName: true, signedAt: true, refusedAt: true, signatureTokenHash: true, signatureTokenExpiresAt: true } })
async function lockRow(id: string) { const h = await holdTransaction(db2); await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${id}' FOR UPDATE`); return h }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const real = () => new Date()

before(async () => { useTestClock(); setBillingMailerForTests(mailer); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(() => NOW); await db.$disconnect(); await db2.$disconnect() })

describe("R3 — expiration naturelle pendant l'attente du verrou (horloge réelle, aucune colonne modifiée pendant l'attente)", () => {
  it("reproduction Codex (signature) : started < expires < finished ⇒ refus, devis toujours SENT, aucune signature", async () => {
    const { id, token } = await sentQuote()
    const expires = new Date(Date.now() + 700)
    await db.quote.update({ where: { id }, data: { signatureTokenExpiresAt: expires } }) // AVANT le scénario (comme Codex), jamais pendant l'attente
    const h = await lockRow(id)
    const started = new Date()
    const signing = signQuoteByToken(db, token, { signerName: "Codex test", ipHash: null, now: started, clock: real })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la signature attend le verrou")
    await sleep(Math.max(0, expires.getTime() - Date.now() + 200))
    await h.commit()
    const r = await signing; const finished = new Date()
    assert.ok(started < expires && expires < finished, js({ started, expires, finished }))
    assert.deepEqual(r, { ok: false, error: QUOTE_ERRORS.tokenInvalid })
    const q = await row(id); assert.equal(q.status, "SENT"); assert.equal(q.signerName, null)
  })
  it("refus par lien : même protocole ⇒ refus de la décision après expiration réelle ; le devis n'est pas REFUSED", async () => {
    const { id, token } = await sentQuote()
    const expires = new Date(Date.now() + 600)
    await db.quote.update({ where: { id }, data: { signatureTokenExpiresAt: expires } })
    const h = await lockRow(id)
    const refusing = refuseQuoteByToken(db, token, { reason: "trop tard", now: new Date(), clock: real })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1))
    await sleep(Math.max(0, expires.getTime() - Date.now() + 200)); await h.commit()
    assert.deepEqual(await refusing, { ok: false, error: QUOTE_ERRORS.tokenInvalid })
    assert.equal((await row(id)).status, "SENT"); assert.equal((await row(id)).refusedAt, null)
  })
  it("à temps : la même attente qui se termine AVANT l'expiration est acceptée ; signedAt = instant de décision (≥ début de requête)", async () => {
    const { id, token } = await sentQuote()
    const expires = new Date(Date.now() + 5000)
    await db.quote.update({ where: { id }, data: { signatureTokenExpiresAt: expires } })
    const h = await lockRow(id)
    const started = new Date()
    const signing = signQuoteByToken(db, token, { signerName: "À temps", ipHash: null, now: started, clock: real })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await sleep(300); await h.commit()
    assert.deepEqual(await signing, { ok: true, value: undefined })
    const q = await row(id); assert.equal(q.status, "ACCEPTED"); assert.ok(q.signedAt && q.signedAt.getTime() >= started.getTime() + 300, "signedAt relu après l'attente, pas le début de la requête")
    assert.ok(q.signedAt && q.signedAt < expires)
  })
})

describe("R3 — passage naturel du jour métier (horloge contrôlable : instant ancré + temps réel écoulé) et renvoi", () => {
  it("validité jusqu'au 10/03/2026 (fin 23:00:00Z) : décision démarrée à 22:59:59,900Z, verrou tenu 400 ms ⇒ l'horloge relue dépasse la fin de validité ⇒ refus P2-04, sans mutation de validUntil", async () => {
    const { id, token } = await sentQuote("2026-03-10")
    const t0 = new Date("2026-03-10T22:59:59.900Z"); const anchor = Date.now()
    const clock = () => new Date(t0.getTime() + (Date.now() - anchor)) // horloge contrôlable : t0 + temps réel écoulé
    const h = await lockRow(id)
    const signing = signQuoteByToken(db, token, { signerName: "Minuit", ipHash: null, now: clock(), clock })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await sleep(400); await h.commit()
    const r = await signing
    // Le jeton (= fin de validité 23:00:00Z) est aussi dépassé : l'erreur est « lien expiré » (jeton) — dans tous les cas, aucune acceptation.
    assert.equal(r.ok, false); assert.ok([QUOTE_ERRORS.tokenInvalid, QUOTE_ERRORS.expired].includes((r as { error: string }).error as never), js(r))
    assert.equal((await row(id)).status, "SENT")
    assert.equal((await row(id)).signatureTokenExpiresAt?.toISOString(), "2026-03-10T23:00:00.000Z", "aucune colonne modifiée")
    // Contrôle : la même décision à 22:59:59,900Z SANS attente est acceptée (borne incluse).
    const ok = await sentQuote("2026-03-10")
    assert.deepEqual(await signQuoteByToken(db, ok.token, { signerName: "Juste à temps", ipHash: null, now: t0, clock: () => t0 }), { ok: true, value: undefined })
  })
  it("renvoi (sendQuote) : validité relue après le verrou ⇒ renvoi refusé si la validité a expiré pendant l'attente ; aucun jeton, aucun courrier", async () => {
    const { id } = await sentQuote("2026-03-10", new Date("2026-03-09T10:00:00Z"))
    const before = await row(id); const mails = mailer.sent.length
    const t0 = new Date("2026-03-10T22:59:59.900Z"); const anchor = Date.now()
    const clock = () => new Date(t0.getTime() + (Date.now() - anchor))
    const h = await lockRow(id)
    const resend = sendQuote(db, A, id, clock(), clock)
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await sleep(400); await h.commit()
    assert.deepEqual(await resend, { ok: false, error: QUOTE_ERRORS.expired })
    assert.deepEqual(await row(id), before, "aucune mise à jour du jeton"); assert.equal(mailer.sent.length, mails)
  })
  it("horloge non monotone : une horloge relue antérieure au début de requête ne rajeunit pas la décision (instant = max)", async () => {
    const { id, token } = await sentQuote("2026-03-10")
    const start = new Date("2026-03-10T23:00:00.001Z") // déjà expiré au début
    const r = await signQuoteByToken(db, token, { signerName: "Retour en arrière", ipHash: null, now: start, clock: () => new Date("2026-03-10T22:00:00Z") })
    assert.deepEqual(r, { ok: false, error: QUOTE_ERRORS.tokenInvalid }); assert.equal((await row(id)).status, "SENT")
  })
})
