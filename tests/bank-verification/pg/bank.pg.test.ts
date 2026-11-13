// SPEC-BANK-VERIF-001 — tests PostgreSQL : enregistrement de l'IBAN, vérification réussie et échouée (refus, titulaire différent,
// autre IBAN, IBAN modifié en cours), état inconnu / rejoué / expiré / d'une autre société, prestataire en panne, filets en base,
// et absence d'effet sur le rapprochement bancaire et les paramètres de facturation.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { completeVerification, getBankAccount, recordSandboxOutcome, saveBankAccount, startVerification } from "@/lib/bank-verification/bank-account.service"
import { BankProviderError, SandboxBankVerificationProvider, type BankVerificationProvider } from "@/lib/bank-verification/provider"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "bkA", userId: "bkAdmA" }
const B = { companyId: "bkB", userId: "bkAdmB" }
const IBAN = "FR1420041010050500013M02606", IBAN2 = "DE89370400440532013000"
const sandbox = new SandboxBankVerificationProvider()
const stateOf = (url: string) => new URL(url, "http://test.local").searchParams.get("state") as string
async function must<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> { const r = await p; if (!r.ok) throw new Error(r.error); return r.value }
const account = async () => { const a = await getBankAccount(db, A); if (!a) throw new Error("compte absent"); return a }
async function start() { return stateOf((await must(startVerification(db, A, sandbox, "http://test.local/retour"))).redirectUrl) }
async function run(outcome: string) { const state = await start(); assert.equal(await recordSandboxOutcome(db, A, state, outcome), true); return { state, result: await completeVerification(db, A, sandbox, state) } }
const untouched = async () => JSON.stringify([await db.bankTransaction.count(), await db.bankStatementImport.count(), await db.billingSettings.findMany(), await db.invoicePayment.count(), await db.journalEntry.count()])
let baseline = ""

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('bkA','GALYA EVENTS','bk-a',now()),('bkB','Autre Société','bk-b',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('bkAdmA','bk-a@example.test','x','ADMIN','bkA',now()),('bkAdmB','bk-b@example.test','x','ADMIN','bkB',now())`)
  await db.billingSettings.create({ data: { companyId: "bkA", iban: "FR76 1111 2222 3333 4444 5555 666" } })
  baseline = await untouched()
})
after(async () => { await db.$disconnect() })

describe("saisie de l'IBAN", () => {
  it("refuse un IBAN invalide ou un titulaire vide ; rien à vérifier tant qu'aucun compte n'est enregistré", async () => {
    assert.equal((await saveBankAccount(db, A, { iban: "FR14 2004 1010 0505 0001 3M02 607", holderName: "GALYA EVENTS", version: null })).ok, false)
    assert.equal((await saveBankAccount(db, A, { iban: IBAN, holderName: "  ", version: null })).ok, false)
    assert.equal((await startVerification(db, A, sandbox, "http://x")).ok, false)
    assert.equal(await getBankAccount(db, A), null)
  })
  it("enregistre le compte « non vérifié », IBAN masqué, écart avec l'IBAN des factures signalé", async () => {
    await must(saveBankAccount(db, A, { iban: "fr14 2004 1010 0505 0001 3m02 606", holderName: "GALYA EVENTS SAS", version: null }))
    const a = await account()
    assert.deepEqual([a.status, a.ibanMasked, a.verifiedAt, a.differsFromInvoiceIban], ["UNVERIFIED", "FR14 •••• •••• 2606", null, true])
    assert.equal((await saveBankAccount(db, A, { iban: IBAN2, holderName: "X", version: a.version + 7 })).ok, false) // version périmée
  })
})

describe("vérification", () => {
  it("échec : refus du prestataire ⇒ « échouée », jamais « vérifié »", async () => {
    const { result } = await run("REJECTED")
    assert.deepEqual(result, { ok: true, value: { status: "FAILED" } })
    const a = await account()
    assert.deepEqual([a.status, a.failureCode, a.verifiedAt, a.provider], ["FAILED", "REJECTED", null, null])
  })
  it("échec : titulaire différent, puis autre IBAN confirmé", async () => {
    assert.deepEqual((await run("HOLDER_MISMATCH")).result, { ok: true, value: { status: "FAILED" } })
    assert.equal((await account()).failureCode, "HOLDER_MISMATCH")
    assert.deepEqual((await run("OTHER_IBAN")).result, { ok: true, value: { status: "FAILED" } })
    assert.equal((await account()).failureCode, "IBAN_MISMATCH")
  })
  it("sans réponse du prestataire : reste « en cours » ; un état forgé, d'une autre société ou sans issue serveur ne vérifie rien", async () => {
    const state = await start()
    assert.equal((await account()).status, "PENDING")
    assert.deepEqual(await completeVerification(db, A, sandbox, state), { ok: true, value: { status: "PENDING" } }) // retour direct sans passer par le prestataire
    assert.equal((await completeVerification(db, A, sandbox, "etat-invente-par-un-attaquant")).ok, false)
    assert.equal((await completeVerification(db, B, sandbox, state)).ok, false)
    assert.equal(await recordSandboxOutcome(db, B, state, "CONFIRMED"), false)
    assert.equal((await account()).status, "PENDING")
  })
  it("réussite : « vérifié » avec prestataire, date et titulaire confirmé ; état à usage unique (rejeu refusé)", async () => {
    const { state, result } = await run("CONFIRMED")
    assert.deepEqual(result, { ok: true, value: { status: "VERIFIED" } })
    const a = await account()
    assert.deepEqual([a.status, a.provider, a.verifiedHolderName, a.failureCode, a.verifiedAt instanceof Date], ["VERIFIED", "sandbox", "GALYA EVENTS SAS", null, true])
    assert.equal((await completeVerification(db, A, sandbox, state)).ok, false)
    assert.equal(await db.bankVerificationSession.count({ where: { companyId: "bkA", status: "PENDING" } }), 0)
  })
  it("deux retours simultanés du même parcours : un seul est pris en compte", async () => {
    const state = await start()
    await recordSandboxOutcome(db, A, state, "CONFIRMED")
    const results = await Promise.all([completeVerification(db, A, sandbox, state), completeVerification(db, A, sandbox, state)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal((await account()).status, "VERIFIED")
  })
  it("IBAN modifié : retour à « non vérifié », preuve effacée ; un parcours ouvert sur l'ancien IBAN est invalidé", async () => {
    const state = await start()
    await recordSandboxOutcome(db, A, state, "CONFIRMED")
    await must(saveBankAccount(db, A, { iban: IBAN2, holderName: "GALYA EVENTS SAS", version: (await account()).version }))
    const a = await account()
    assert.deepEqual([a.status, a.verifiedAt, a.provider, a.verifiedHolderName], ["UNVERIFIED", null, null, null])
    assert.equal((await completeVerification(db, A, sandbox, state)).ok, false)
    assert.equal((await account()).status, "UNVERIFIED")
  })
  it("état expiré : refusé, compte remis à « non vérifié »", async () => {
    const state = stateOf((await must(startVerification(db, A, sandbox, "http://x", new Date(Date.now() - 31 * 60 * 1000)))).redirectUrl)
    await recordSandboxOutcome(db, A, state, "CONFIRMED")
    assert.equal((await completeVerification(db, A, sandbox, state)).ok, false)
    assert.equal((await account()).status, "UNVERIFIED")
  })
  it("prestataire en panne au lancement ou au retour : aucune vérification, statut inchangé", async () => {
    const down: BankVerificationProvider = { name: "sandbox", start: async () => { throw new BankProviderError("indisponible") }, fetchResult: async () => { throw new BankProviderError("indisponible") } }
    assert.equal((await startVerification(db, A, down, "http://x")).ok, false)
    assert.equal((await account()).status, "UNVERIFIED")
    const state = await start()
    assert.equal((await completeVerification(db, A, down, state)).ok, false)
    assert.equal((await account()).status, "PENDING")
  })
})

describe("filets en base et non-régression", () => {
  it("PostgreSQL refuse « VERIFIED » sans preuve, un IBAN mal formé et deux parcours en cours pour un même compte", async () => {
    const a = await db.companyBankAccount.findUniqueOrThrow({ where: { companyId: "bkA" } })
    await assert.rejects(db.companyBankAccount.update({ where: { id: a.id }, data: { status: "VERIFIED", verifiedAt: null, provider: null } }))
    await assert.rejects(db.companyBankAccount.update({ where: { id: a.id }, data: { iban: "fr14 pas un iban" } }))
    await assert.rejects(db.bankVerificationSession.create({ data: { companyId: "bkA", accountId: a.id, provider: "sandbox", stateHash: "doublon", iban: a.iban, expiresAt: new Date(Date.now() + 60000), createdById: "bkAdmA" } }))
    await assert.rejects(db.companyBankAccount.create({ data: { companyId: "bkA", iban: IBAN, holderName: "x", createdById: "bkAdmA" } })) // un compte par société
  })
  it("isolation : l'autre société ne voit aucun compte ; rapprochement, paramètres de facturation, paiements et écritures inchangés", async () => {
    assert.equal(await getBankAccount(db, B), null)
    assert.equal(await untouched(), baseline)
  })
})
