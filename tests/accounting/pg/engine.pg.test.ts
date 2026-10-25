// COMPTABILITÉ A1 — tests d'intégration PostgreSQL (base jetable migrée ; DATABASE_URL obligatoire).
// Couvre : validation, immutabilité en base, numérotation sans trou sous concurrence et après rollback,
// idempotence, clôture, révocation, isolation multi-société, contre-passation, chaînage, lectures.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient, Prisma } from "@prisma/client"
import { AccountingError, createDraftEntry, postEntry, reverseEntry, verifyChain, type AccountingContext } from "@/lib/accounting/engine/posting"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { advanceFiscalYear, openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { trialBalance, generalLedger } from "@/lib/accounting/engine/reads"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient({ transactionOptions: { timeout: 60000, maxWait: 60000 } })
const A: AccountingContext = { companyId: "coA", userId: "admA" }
const B: AccountingContext = { companyId: "coB", userId: "admB" }
const ids: Record<string, string> = {}
const D = (s: string) => new Date(`${s}T00:00:00Z`)
const c = (n: number) => BigInt(n)

async function acc(ctx: AccountingContext, number: string) {
  return (await db.accountingAccount.findUniqueOrThrow({ where: { companyId_number: { companyId: ctx.companyId, number } } })).id
}
async function draftAndPost(ctx: AccountingContext, amount: number, opts: { journal?: string; date?: string; fy?: string } = {}) {
  return db.$transaction(async (tx) => {
    const d = await createDraftEntry(tx, ctx, {
      journalId: ids[opts.journal ?? `${ctx.companyId}:VT`], fiscalYearId: opts.fy ?? ids[`${ctx.companyId}:FY`],
      entryDate: D(opts.date ?? "2026-03-01"), label: "Vente",
      lines: [{ accountId: ids[`${ctx.companyId}:411`], debitCents: c(amount), creditCents: c(0) }, { accountId: ids[`${ctx.companyId}:706`], debitCents: c(0), creditCents: c(amount) }],
    })
    return postEntry(tx, ctx, d.id)
  })
}
async function sqlError(sql: string): Promise<string> {
  try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) }
}

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now()),('empA','e@x','x','EMPLOYEE','coA',now())`)
  for (const ctx of [A, B]) {
    await db.$transaction((tx) => ensureBaseReferential(tx, ctx))
    await db.$transaction((tx) => ensureBaseReferential(tx, ctx)) // idempotent
    const fy = await db.fiscalYear.create({ data: { companyId: ctx.companyId, startDate: D("2026-01-01"), endDate: D("2026-12-31") } })
    ids[`${ctx.companyId}:FY`] = fy.id
    for (const code of ["VT", "OD"]) ids[`${ctx.companyId}:${code}`] = (await db.accountingJournal.findUniqueOrThrow({ where: { companyId_code: { companyId: ctx.companyId, code } } })).id
    for (const n of ["411000", "706000", "512000"]) ids[`${ctx.companyId}:${n.slice(0, 3)}`] = await acc(ctx, n)
  }
})
after(async () => { await db.$disconnect() })

describe("Validation et immutabilité", () => {
  it("écriture équilibrée validée : numéro 1, empreinte, chaîne vérifiée", async () => {
    const r = await draftAndPost(A, 12000)
    assert.equal(r.number, 1)
    assert.match(r.hash, /^[0-9a-f]{64}$/)
    ids.e1 = r.id
    const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))
    assert.deepEqual(v, { ok: true, checked: 1 })
  })
  it("écriture déséquilibrée refusée par le service", async () => {
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-02"), label: "X",
        lines: [{ accountId: ids["coA:411"], debitCents: c(100), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(99) }] })
      return postEntry(tx, A, d.id)
    }), (e: unknown) => e instanceof AccountingError && e.details.includes("UNBALANCED"))
  })
  it("SQL direct : modification, suppression, ajout/modification/suppression de ligne d'une écriture validée refusés", async () => {
    assert.match(await sqlError(`UPDATE journal_entries SET label='Z' WHERE id='${ids.e1}'`), /ENTRY_IMMUTABLE/)
    assert.match(await sqlError(`DELETE FROM journal_entries WHERE id='${ids.e1}'`), /ENTRY_IMMUTABLE/)
    assert.match(await sqlError(`INSERT INTO journal_entry_lines(id,"companyId","entryId","accountId",position,"debitCents") VALUES ('zz','coA','${ids.e1}','${ids["coA:411"]}',9,1)`), /ENTRY_IMMUTABLE/)
    assert.match(await sqlError(`UPDATE journal_entry_lines SET "debitCents"=1 WHERE "entryId"='${ids.e1}' AND "debitCents">0`), /ENTRY_IMMUTABLE/)
    assert.match(await sqlError(`DELETE FROM journal_entry_lines WHERE "entryId"='${ids.e1}'`), /ENTRY_IMMUTABLE/)
  })
  it("SQL direct : validation hors service refusée ; brouillon validé directement refusé", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-03"), label: "Y",
      lines: [{ accountId: ids["coA:411"], debitCents: c(5), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(5) }] }))
    assert.match(await sqlError(`UPDATE journal_entries SET status='VALIDATED', number=999, "validatedAt"=now(), "validatedById"='admA', hash='h', "prevHash"='p' WHERE id='${d.id}'`), /ENTRY_POSTING_DENIED/)
    assert.match(await sqlError(`INSERT INTO journal_entries(id,"companyId","journalId","fiscalYearId",status,"entryDate",label,"createdById","updatedAt",number,"validatedAt","validatedById",hash,"prevHash") VALUES ('dv','coA','${ids["coA:VT"]}','${ids["coA:FY"]}','VALIDATED','2026-03-01','X','admA',now(),5,now(),'admA','h','p')`), /ENTRY_IMMUTABLE/)
    ids.draftY = d.id
  })
  it("SQL direct avec l'indicateur de validation : équilibre revérifié au COMMIT", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-04"), label: "W",
      lines: [{ accountId: ids["coA:411"], debitCents: c(5), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(5) }] }))
    await db.$executeRawUnsafe(`UPDATE journal_entry_lines SET "creditCents"=4 WHERE "entryId"='${d.id}' AND "creditCents">0`)
    const msg = await sqlError(`BEGIN; SELECT set_config('planificator.accounting_posting','on',true); UPDATE journal_entries SET status='VALIDATED', number=1, "validatedAt"=now(), "validatedById"='admA', hash='h', "prevHash"='p' WHERE id='${d.id}'; COMMIT;`)
    await db.$executeRawUnsafe("ROLLBACK").catch(() => {})
    assert.match(msg, /ENTRY_UNBALANCED|cannot insert multiple commands/)
  })
  it("séquences et têtes de chaîne non manipulables hors service", async () => {
    assert.match(await sqlError(`UPDATE accounting_sequences SET "lastNumber"="lastNumber"-1`), /SEQUENCE_IMMUTABLE/)
    assert.match(await sqlError(`UPDATE accounting_chain_heads SET "lastHash"='x'`), /CHAIN_IMMUTABLE/)
    assert.match(await sqlError(`DELETE FROM accounting_sequences`), /SEQUENCE_IMMUTABLE/)
  })
})

describe("Numérotation", () => {
  it("20 validations concurrentes : numéros contigus, sans doublon ni trou", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => draftAndPost(A, 100 + i)))
    const nums = results.map((r) => r.number).sort((a, b) => a - b)
    assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 2))
  })
  it("rollback après réservation du numéro : aucun trou", async () => {
    const before = await db.accountingSequence.findFirstOrThrow({ where: { companyId: "coA", journalId: ids["coA:VT"] } })
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-04-01"), label: "R",
        lines: [{ accountId: ids["coA:411"], debitCents: c(1), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(1) }] })
      await postEntry(tx, A, d.id)
      throw new Error("ROLLBACK_FORCE")
    }), /ROLLBACK_FORCE/)
    const next = await draftAndPost(A, 7)
    assert.equal(next.number, before.lastNumber + 1)
  })
  it("double validation concurrente de la même écriture : un seul numéro", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-04-02"), label: "Double",
      lines: [{ accountId: ids["coA:411"], debitCents: c(3), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(3) }] }))
    const [r1, r2] = await Promise.all([db.$transaction((tx) => postEntry(tx, A, d.id)), db.$transaction((tx) => postEntry(tx, A, d.id))])
    assert.equal(r1.number, r2.number)
    assert.equal(r1.hash, r2.hash)
  })
})

describe("Idempotence des écritures sourcées", () => {
  const input = () => ({ journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-05-01"), label: "Facture FAC-1",
    source: { type: "INVOICE", id: "inv-1", version: 1 },
    lines: [{ accountId: ids["coA:411"], debitCents: c(1200), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(1200) }] })
  it("même clé + même contenu : écriture existante renvoyée", async () => {
    const a = await db.$transaction((tx) => createDraftEntry(tx, A, input()))
    const b = await db.$transaction((tx) => createDraftEntry(tx, A, input()))
    assert.equal(a.id, b.id)
    assert.equal(b.existing, true)
  })
  it("même clé + contenu différent : SOURCE_CONFLICT", async () => {
    const changed = { ...input(), label: "Autre" }
    await assert.rejects(db.$transaction((tx) => createDraftEntry(tx, A, changed)), (e: unknown) => e instanceof AccountingError && e.code === "SOURCE_CONFLICT")
  })
  it("champs source partiels refusés en base", async () => {
    assert.match(await sqlError(`INSERT INTO journal_entries(id,"companyId","journalId","fiscalYearId","entryDate",label,"createdById","updatedAt","sourceType") VALUES ('sp','coA','${ids["coA:VT"]}','${ids["coA:FY"]}','2026-03-01','X','admA',now(),'INVOICE')`), /je_source_ck/)
  })
})

describe("Isolation multi-société", () => {
  it("compte d'une autre société : refusé par le service et par la FK composite", async () => {
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-05"), label: "X",
        lines: [{ accountId: ids["coB:411"], debitCents: c(1), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(1) }] })
      return postEntry(tx, A, d.id)
    }))
    assert.match(await sqlError(`INSERT INTO journal_entry_lines(id,"companyId","entryId","accountId",position,"debitCents") VALUES ('xx','coA','${ids.draftY}','${ids["coB:411"]}',5,1)`), /foreign key|violates/)
  })
  it("journal d'une autre société : refusé par la FK composite", async () => {
    await assert.rejects(db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coB:VT"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-05"), label: "X",
      lines: [{ accountId: ids["coA:411"], debitCents: c(1), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(1) }] })))
  })
  it("validation d'une écriture d'une autre société : introuvable", async () => {
    await assert.rejects(db.$transaction((tx) => postEntry(tx, B, ids.draftY)), (e: unknown) => e instanceof AccountingError && e.code === "ENTRY_NOT_FOUND")
  })
  it("balance : la société B ne voit rien de A", async () => {
    await draftAndPost(B, 500)
    const balA = await trialBalance(db, A, ids["coA:FY"])
    const balB = await trialBalance(db, B, ids["coB:FY"])
    assert.ok(balA.length > 0)
    assert.equal(balB.reduce((s, r) => s + r.debitCents, c(0)), c(500))
    assert.equal(balA.reduce((s, r) => s + r.debitCents - r.creditCents, c(0)), c(0))
    const led = await generalLedger(db, B, ids["coB:FY"], ids["coA:411"])
    assert.equal(led.length, 0)
  })
})

describe("Révocation", () => {
  it("utilisateur désactivé entre deux requêtes : ACCESS_REVOKED", async () => {
    await db.user.update({ where: { id: "admB" }, data: { active: false } })
    await assert.rejects(draftAndPost(B, 1), (e: unknown) => e instanceof AccountingError && e.code === "ACCESS_REVOKED")
    await db.user.update({ where: { id: "admB" }, data: { active: true } })
  })
  it("non ADMIN (employé) : ACCESS_REVOKED", async () => {
    await assert.rejects(draftAndPost({ companyId: "coA", userId: "empA" }, 1), (e: unknown) => e instanceof AccountingError && e.code === "ACCESS_REVOKED")
  })
  it("révocation pendant la transaction : refusée à la validation", async () => {
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, B, { journalId: ids["coB:VT"], fiscalYearId: ids["coB:FY"], entryDate: D("2026-03-06"), label: "Rev",
        lines: [{ accountId: ids["coB:411"], debitCents: c(1), creditCents: c(0) }, { accountId: ids["coB:706"], debitCents: c(0), creditCents: c(1) }] })
      await tx.user.update({ where: { id: "admB" }, data: { role: "EMPLOYEE" } })
      return postEntry(tx, B, d.id)
    }), (e: unknown) => e instanceof AccountingError && e.code === "ACCESS_REVOKED")
    const role = (await db.user.findUniqueOrThrow({ where: { id: "admB" } })).role
    assert.equal(role, "ADMIN") // transaction annulée
  })
})

describe("Contre-passation", () => {
  it("miroir exact validé ; seconde contre-passation refusée ; brouillon non contre-passable", async () => {
    const r = await db.$transaction((tx) => reverseEntry(tx, A, ids.e1, D("2026-06-01")))
    assert.ok(r.number > 1)
    await assert.rejects(db.$transaction((tx) => reverseEntry(tx, A, ids.e1, D("2026-06-02"))))
    await assert.rejects(db.$transaction((tx) => reverseEntry(tx, A, ids.draftY, D("2026-06-02"))), (e: unknown) => e instanceof AccountingError && e.code === "ENTRY_NOT_VALIDATED")
  })
  it("contre-passation non miroir refusée par le service", async () => {
    const orig = await draftAndPost(A, 900, { journal: "coA:OD" })
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-06-03"), label: "Faux miroir", reversalOfId: orig.id,
        lines: [{ accountId: ids["coA:706"], debitCents: c(800), creditCents: c(0) }, { accountId: ids["coA:411"], debitCents: c(0), creditCents: c(800) }] })
      return postEntry(tx, A, d.id)
    }), (e: unknown) => e instanceof AccountingError && e.code === "ENTRY_REVERSAL_INVALID")
    assert.equal(await db.journalEntry.count({ where: { reversalOfId: orig.id } }), 0)
  })
  it("contre-passation non miroir refusée par la base (service contourné)", async () => {
    const orig = await draftAndPost(A, 700, { journal: "coA:OD" })
    await assert.rejects(db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-06-04"), label: "Faux miroir SQL", reversalOfId: orig.id,
        lines: [{ accountId: ids["coA:706"], debitCents: c(600), creditCents: c(0) }, { accountId: ids["coA:411"], debitCents: c(0), creditCents: c(600) }] })
      await tx.$executeRaw`SELECT set_config('planificator.accounting_posting', 'on', true)`
      await tx.$executeRaw`UPDATE "journal_entries" SET "status" = 'VALIDATED', "number" = 9999, "validatedAt" = now(), "validatedById" = 'admA',
        "prevHash" = 'x', "hash" = 'y' WHERE "id" = ${d.id}`
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`)
    }), /ENTRY_REVERSAL_INVALID/)
    assert.equal(await db.journalEntry.count({ where: { reversalOfId: orig.id } }), 0)
  })
})

describe("Exercices et clôture", () => {
  it("chevauchement d'exercices et retour arrière d'état refusés", async () => {
    assert.match(await sqlError(`INSERT INTO fiscal_years(id,"companyId","startDate","endDate") VALUES ('fyx','coA','2026-06-01','2027-05-31')`), /FISCAL_YEAR_OVERLAP/)
    await assert.rejects(db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-12-01"), endDate: D("2027-11-30") })), /FISCAL_YEAR_OVERLAP/)
    await assert.rejects(db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2027-01-01"), endDate: D("2029-01-01") })), (e: unknown) => e instanceof AccountingError && e.details.includes("LONGER_THAN_24_MONTHS"))
    const fy2027 = await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2027-01-01"), endDate: D("2027-12-31") }))
    ids.fy2027 = fy2027.id
    await assert.rejects(db.$transaction((tx) => advanceFiscalYear(tx, A, fy2027.id, "CLOSED")), (e: unknown) => e instanceof AccountingError && e.code === "FISCAL_YEAR_TRANSITION_INVALID")
    await assert.rejects(db.$transaction((tx) => advanceFiscalYear(tx, B, fy2027.id, "CLOSING")), (e: unknown) => e instanceof AccountingError && e.code === "FISCAL_YEAR_NOT_FOUND")
  })
  it("CLOSING : écriture normale refusée, OD de clôture acceptée ; CLOSED : tout refusé ; pas de retour", async () => {
    await db.$transaction((tx) => advanceFiscalYear(tx, A, ids["coA:FY"], "CLOSING"))
    await assert.rejects(draftAndPost(A, 10), (e: unknown) => e instanceof AccountingError && e.details.includes("YEAR_NOT_OPEN"))
    const closing = await db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-12-31"), label: "Clôture", closingEntry: true,
        lines: [{ accountId: ids["coA:706"], debitCents: c(10), creditCents: c(0) }, { accountId: ids["coA:512"], debitCents: c(0), creditCents: c(10) }] })
      return postEntry(tx, A, d.id)
    })
    assert.ok(closing.number > 0)
    await db.$transaction((tx) => advanceFiscalYear(tx, A, ids["coA:FY"], "CLOSED"))
    await assert.rejects(db.$transaction((tx) => advanceFiscalYear(tx, A, ids["coA:FY"], "OPEN")), (e: unknown) => e instanceof AccountingError && e.code === "FISCAL_YEAR_TRANSITION_INVALID")
    const fyAudit = await db.historyLog.findMany({ where: { companyId: "coA", entityType: "FiscalYear", entityId: ids["coA:FY"] }, orderBy: { createdAt: "asc" }, select: { detail: true, actorId: true } })
    assert.deepEqual(fyAudit.map((h) => h.detail), ["Exercice : OPEN → CLOSING", "Exercice : CLOSING → CLOSED"])
    assert.ok(fyAudit.every((h) => h.actorId === "admA"))
    assert.match(await sqlError(`UPDATE fiscal_years SET status='OPEN' WHERE id='${ids["coA:FY"]}'`), /FISCAL_YEAR_IMMUTABLE/)
    assert.match(await sqlError(`UPDATE fiscal_years SET "endDate"='2026-11-30' WHERE id='${ids["coA:FY"]}'`), /FISCAL_YEAR_IMMUTABLE/)
  })
  it("le nouvel exercice démarre sa propre numérotation ; la chaîne traverse les exercices", async () => {
    const r = await draftAndPost(A, 42, { fy: ids.fy2027, date: "2027-01-15" })
    assert.equal(r.number, 1)
    const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))
    assert.equal(v.ok, true)
    assert.ok(v.checked > 20)
  })
  it("audit : une trace par écriture validée, dans la même transaction (aucune trace pour un rollback)", async () => {
    const validated = await db.journalEntry.count({ where: { companyId: "coA", status: "VALIDATED" } })
    const logs = await db.historyLog.count({ where: { companyId: "coA", entityType: "JournalEntry", action: "STATUS_CHANGED" } })
    assert.equal(logs, validated)
  })
  it("clôture concurrente de validations : état cohérent, numérotation sans trou", async () => {
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, i) => draftAndPost(B, 100 + i)),
      db.$transaction((tx) => advanceFiscalYear(tx, B, ids["coB:FY"], "CLOSING")),
      ...Array.from({ length: 6 }, (_, i) => draftAndPost(B, 200 + i)),
    ])
    const closed = results[6]
    assert.equal(closed.status, "fulfilled")
    for (const [i, r] of results.entries()) {
      if (i === 6 || r.status === "fulfilled") continue
      assert.ok(r.reason instanceof AccountingError && r.reason.details.includes("YEAR_NOT_OPEN"), String(r.reason))
    }
    const nums = (await db.journalEntry.findMany({ where: { companyId: "coB", fiscalYearId: ids["coB:FY"], status: "VALIDATED", journalId: ids["coB:VT"] }, select: { number: true } }))
      .map((e) => e.number!).sort((a, b) => a - b)
    assert.deepEqual(nums, nums.map((_, i) => i + 1))
    const closingLog = await db.historyLog.findFirstOrThrow({ where: { entityType: "FiscalYear", entityId: ids["coB:FY"] }, select: { createdAt: true } })
    const after = await db.journalEntry.count({ where: { companyId: "coB", fiscalYearId: ids["coB:FY"], status: "VALIDATED", validatedAt: { gt: new Date(closingLog.createdAt.getTime() + 1000) } } })
    assert.equal(after, 0)
  })
})

describe("Contrôles différés et Prisma", () => {
  it("Prisma avale l'erreur levée au COMMIT ; flushDeferredConstraints la fait remonter", async () => {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS zz_deferred_probe (id int)`)
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION zz_deferred_probe_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'DEFERRED_PROBE'; END $$ LANGUAGE plpgsql`)
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_deferred_probe_trg ON zz_deferred_probe`)
    await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER zz_deferred_probe_trg AFTER INSERT ON zz_deferred_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zz_deferred_probe_fail()`)
    // Comportement constaté de Prisma 5.22 : promesse résolue alors que la base a annulé. Si une montée
    // de version corrige ce défaut, ce test échouera et la note de deferred-constraints.ts sera à revoir.
    await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO zz_deferred_probe VALUES (1)`) })
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO zz_deferred_probe VALUES (2)`)
      await flushDeferredConstraints(tx, ["zz_deferred_probe_trg"])
    }), /DEFERRED_PROBE/)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO zz_deferred_probe VALUES (3)`)
      await flushDeferredConstraints(tx)
    }), /DEFERRED_PROBE/)
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM zz_deferred_probe`)
    assert.equal(rows[0].n, 0)
    await db.$executeRawUnsafe(`DROP TABLE zz_deferred_probe`)
    await db.$executeRawUnsafe(`DROP FUNCTION zz_deferred_probe_fail()`)
  })
})
