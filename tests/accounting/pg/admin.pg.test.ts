// COMPTABILITÉ A2 — tests PostgreSQL des compléments de service (admin.ts) et des lectures d'écran (queries.ts).
// Base jetable migrée (DATABASE_URL obligatoire). Sociétés dédiées (coC, coD) : indépendant de engine.pg.test.ts.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { AccountingError, createDraftEntry, postEntry, type AccountingContext } from "@/lib/accounting/engine/posting"
import { createAccount, deleteDraftEntry, initializeAccounting, setAccountActive } from "@/lib/accounting/engine/admin"
import { advanceFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { accountingSummary, getEntryDetail, listAccounts, listEntries } from "@/lib/accounting/engine/queries"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient({ transactionOptions: { timeout: 60000, maxWait: 60000 } })
const C: AccountingContext = { companyId: "coC", userId: "admC" }
const D: AccountingContext = { companyId: "coD", userId: "admD" }
const SA_C: AccountingContext = { companyId: "coC", userId: "saC" }
const ids: Record<string, string> = {}
const day = (s: string) => new Date(`${s}T00:00:00Z`)
const c = (n: number) => BigInt(n)

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "NO_ERROR" } catch (e) { return e instanceof AccountingError ? e.code : String((e as Error).message) }
}
async function draft(ctx: AccountingContext, amount: number) {
  return db.$transaction((tx) => createDraftEntry(tx, ctx, {
    journalId: ids[`${ctx.companyId}:OD`], fiscalYearId: ids[`${ctx.companyId}:FY`], entryDate: day("2026-04-01"), label: "Saisie",
    lines: [{ accountId: ids[`${ctx.companyId}:512`], debitCents: c(amount), creditCents: c(0) }, { accountId: ids[`${ctx.companyId}:706`], debitCents: c(0), creditCents: c(amount) }],
  }))
}

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coC','C','c',now()),('coD','D','d',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES
    ('admC','ac@x','x','ADMIN','coC',now()),('admD','ad@x','x','ADMIN','coD',now()),
    ('saC','sa@x','x','SUPER_ADMIN','coC',now()),('empC','ec@x','x','EMPLOYEE','coC',now())`)
  for (const ctx of [C, D]) {
    await db.$transaction((tx) => initializeAccounting(tx, ctx))
    await db.$transaction((tx) => initializeAccounting(tx, ctx)) // idempotent
    ids[`${ctx.companyId}:FY`] = (await db.fiscalYear.create({ data: { companyId: ctx.companyId, startDate: day("2026-01-01"), endDate: day("2026-12-31") } })).id
    ids[`${ctx.companyId}:OD`] = (await db.accountingJournal.findUniqueOrThrow({ where: { companyId_code: { companyId: ctx.companyId, code: "OD" } } })).id
    for (const n of ["512000", "706000"]) ids[`${ctx.companyId}:${n.slice(0, 3)}`] = (await db.accountingAccount.findUniqueOrThrow({ where: { companyId_number: { companyId: ctx.companyId, number: n } } })).id
  }
})
after(async () => { await db.$disconnect() })

describe("createAccount / setAccountActive", () => {
  it("crée un compte, journalise l'audit, refuse doublon et numéro invalide", async () => {
    const { id } = await db.$transaction((tx) => createAccount(tx, C, { number: " 6061 ", label: "Fournitures" }))
    const a = await db.accountingAccount.findUniqueOrThrow({ where: { id } })
    assert.equal(a.number, "6061"); assert.equal(a.companyId, "coC")
    assert.equal(await db.historyLog.count({ where: { entityId: id, action: "CREATED", companyId: "coC", actorId: "admC" } }), 1)
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, C, { number: "6061", label: "Bis" }))), "ACCOUNT_NUMBER_TAKEN")
    for (const number of ["9123", "06", "12", "1234567890123", "60a1"]) {
      assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, C, { number, label: "X" }))), "ACCOUNT_NUMBER_INVALID", number)
    }
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, C, { number: "6062", label: "   " }))), "LABEL_INVALID")
    // Même numéro dans une autre société : autorisé (référentiels indépendants).
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, D, { number: "6061", label: "Fournitures D" }))), "NO_ERROR")
  })

  it("désactive/réactive un compte de SA société, jamais celui d'une autre", async () => {
    const id = ids["coC:706"]
    await db.$transaction((tx) => setAccountActive(tx, C, id, false))
    assert.equal((await db.accountingAccount.findUniqueOrThrow({ where: { id } })).active, false)
    await db.$transaction((tx) => setAccountActive(tx, C, id, true))
    assert.equal((await db.accountingAccount.findUniqueOrThrow({ where: { id } })).active, true)
    assert.equal(await code(() => db.$transaction((tx) => setAccountActive(tx, D, id, false))), "ACCOUNT_NOT_FOUND")
    assert.equal((await db.accountingAccount.findUniqueOrThrow({ where: { id } })).active, true)
  })
})

describe("deleteDraftEntry", () => {
  it("supprime un brouillon et ses lignes, avec audit", async () => {
    const d = await draft(C, 1000)
    await db.$transaction((tx) => deleteDraftEntry(tx, C, d.id))
    assert.equal(await db.journalEntry.count({ where: { id: d.id } }), 0)
    assert.equal(await db.journalEntryLine.count({ where: { entryId: d.id } }), 0)
    assert.equal(await db.historyLog.count({ where: { entityId: d.id, action: "DELETED", companyId: "coC" } }), 1)
  })

  it("refuse une écriture validée (service) et une écriture d'une autre société", async () => {
    const d = await draft(C, 2000)
    await db.$transaction((tx) => postEntry(tx, C, d.id))
    assert.equal(await code(() => db.$transaction((tx) => deleteDraftEntry(tx, C, d.id))), "ENTRY_NOT_DRAFT")
    const other = await draft(C, 3000)
    assert.equal(await code(() => db.$transaction((tx) => deleteDraftEntry(tx, D, other.id))), "ENTRY_NOT_FOUND")
    assert.equal(await db.journalEntry.count({ where: { id: { in: [d.id, other.id] } } }), 2)
  })

  it("la base refuse aussi la suppression directe d'une écriture validée", async () => {
    const d = await draft(C, 4000)
    await db.$transaction((tx) => postEntry(tx, C, d.id))
    const msg = await code(() => db.$executeRawUnsafe(`DELETE FROM journal_entries WHERE id='${d.id}'`))
    assert.notEqual(msg, "NO_ERROR")
    assert.equal(await db.journalEntry.count({ where: { id: d.id } }), 1)
  })

  it("fonctionne sous un rôle applicatif non propriétaire (cas de production)", async () => {
    await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_app2') THEN CREATE ROLE acc_app2 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`)
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO acc_app2`)
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acc_app2`)
    const d = await draft(C, 5000)
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE acc_app2`)
      await deleteDraftEntry(tx, C, d.id)
      await createAccount(tx, C, { number: "6063", label: "Petit matériel" })
    })
    assert.equal(await db.journalEntry.count({ where: { id: d.id } }), 0)
    assert.equal(await db.accountingAccount.count({ where: { companyId: "coC", number: "6063" } }), 1)
  })
})

describe("Autorisation revérifiée en transaction (SPEC-ACC-A2 §7)", () => {
  it("SUPER_ADMIN : autorisé pour sa société de rattachement", async () => {
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, SA_C, { number: "6064", label: "SA" }))), "NO_ERROR")
  })
  it("SUPER_ADMIN : refusé pour une autre société dont il n'est pas membre", async () => {
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, { companyId: "coD", userId: "saC" }, { number: "6065", label: "SA" }))), "ACCESS_REVOKED")
  })
  it("EMPLOYEE et ADMIN d'une autre société : refusés", async () => {
    assert.equal(await code(() => db.$transaction((tx) => initializeAccounting(tx, { companyId: "coC", userId: "empC" }))), "ACCESS_REVOKED")
    assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, { companyId: "coC", userId: "admD" }, { number: "6066", label: "X" }))), "ACCESS_REVOKED")
  })
  it("SUPER_ADMIN : refusé si sa société est désactivée", async () => {
    await db.company.update({ where: { id: "coC" }, data: { active: false } })
    try {
      assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, SA_C, { number: "6068", label: "SA" }))), "ACCESS_REVOKED")
    } finally { await db.company.update({ where: { id: "coC" }, data: { active: true } }) }
  })
  it("ADMIN désactivé : refusé", async () => {
    await db.user.update({ where: { id: "admD" }, data: { active: false } })
    try {
      assert.equal(await code(() => db.$transaction((tx) => createAccount(tx, D, { number: "6067", label: "X" }))), "ACCESS_REVOKED")
    } finally { await db.user.update({ where: { id: "admD" }, data: { active: true } }) }
  })
})

describe("Brouillons : exercice saisissable et date dans l'exercice (contrôle serveur, pas seulement l'écran)", () => {
  const lines = (co: string) => [{ accountId: ids[`${co}:512`], debitCents: c(10), creditCents: c(0) }, { accountId: ids[`${co}:706`], debitCents: c(0), creditCents: c(10) }]
  it("exercice d'une autre société : introuvable", async () => {
    assert.equal(await code(() => db.$transaction((tx) => createDraftEntry(tx, C, { journalId: ids["coC:OD"], fiscalYearId: ids["coD:FY"], entryDate: day("2026-04-01"), label: "X", lines: lines("coC") }))), "FISCAL_YEAR_NOT_FOUND")
  })
  it("date hors exercice : refusée", async () => {
    assert.equal(await code(() => db.$transaction((tx) => createDraftEntry(tx, C, { journalId: ids["coC:OD"], fiscalYearId: ids["coC:FY"], entryDate: day("2019-01-01"), label: "X", lines: lines("coC") }))), "ENTRY_INVALID")
  })
  it("exercice en clôture : refusé hors écriture de clôture, accepté pour une écriture de clôture (OD)", async () => {
    const fy = await db.fiscalYear.create({ data: { companyId: "coC", startDate: day("2025-01-01"), endDate: day("2025-12-31") } })
    await db.$transaction((tx) => advanceFiscalYear(tx, C, fy.id, "CLOSING"))
    const base = { journalId: ids["coC:OD"], fiscalYearId: fy.id, entryDate: day("2025-12-31"), label: "Clôture", lines: lines("coC") }
    assert.equal(await code(() => db.$transaction((tx) => createDraftEntry(tx, C, base))), "ENTRY_INVALID")
    assert.equal(await code(() => db.$transaction((tx) => createDraftEntry(tx, C, { ...base, closingEntry: true }))), "NO_ERROR")
  })
})

describe("Lectures d'écran : toujours filtrées par la société du contexte", () => {
  it("listEntries / getEntryDetail / listAccounts / accountingSummary", async () => {
    const d = await draft(D, 777)
    const forC = await listEntries(db, C, {})
    assert.ok(forC.rows.length > 0)
    assert.ok(forC.rows.every((r) => r.id !== d.id))
    assert.equal(await getEntryDetail(db, C, d.id), null)
    const detail = await getEntryDetail(db, D, d.id)
    assert.equal(detail?.lines.length, 2)
    const drafts = await listEntries(db, D, { status: "DRAFT", fiscalYearId: ids["coD:FY"] })
    assert.ok(drafts.rows.some((r) => r.id === d.id && r.totalCents === c(777)))
    assert.equal((await listEntries(db, D, { fiscalYearId: ids["coC:FY"] })).total, 0, "exercice d'une autre société : aucun résultat")
    const accountsD = await listAccounts(db, D)
    assert.equal(accountsD.find((a) => a.id === ids["coD:512"])?.lineCount, 1)
    const s = await accountingSummary(db, D)
    assert.equal(s.initialized, true); assert.equal(s.drafts, 1); assert.equal(s.openYear?.id, ids["coD:FY"])
    const page = await listEntries(db, C, { page: -5 })
    assert.equal(page.page, 1)
  })
})
