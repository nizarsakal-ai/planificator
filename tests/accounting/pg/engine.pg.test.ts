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
type TxC = Parameters<Parameters<typeof db.$transaction>[0]>[0]
/** Exécute fn dans une transaction, sous un rôle donné (ou le propriétaire), indicateur moteur forgé, contrôles différés forcés. */
async function forged(role: "acc_app" | "owner", fn: (tx: TxC) => Promise<unknown>): Promise<string> {
  try {
    await db.$transaction(async (tx) => {
      if (role === "acc_app") await tx.$executeRawUnsafe(`SET LOCAL ROLE acc_app`)
      await tx.$executeRawUnsafe(`SELECT set_config('planificator.accounting_engine', 'on', true)`)
      await fn(tx)
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`)
    })
    return "NO_ERROR"
  } catch (e) { return String((e as Error).message) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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
  it("fonction SQL de validation appelée directement (service contourné) : équilibre revérifié", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-03-04"), label: "W",
      lines: [{ accountId: ids["coA:411"], debitCents: c(5), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(5) }] }))
    await db.$executeRawUnsafe(`UPDATE journal_entry_lines SET "creditCents"=4 WHERE "entryId"='${d.id}' AND "creditCents">0`)
    await assert.rejects(db.$transaction((tx) => tx.$queryRaw`SELECT * FROM accounting_post_entry('coA', ${d.id}, 'admA')`), /ENTRY_UNBALANCED/)
    assert.equal((await db.journalEntry.findUniqueOrThrow({ where: { id: d.id } })).status, "DRAFT")
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
  it("créations concurrentes même clé + même contenu : une seule écriture, l'autre renvoie l'existante", async () => {
    const inp = { ...input(), source: { type: "INVOICE", id: "inv-c", version: 1 } }
    const [a, b] = await Promise.all([db.$transaction((tx) => createDraftEntry(tx, A, inp)), db.$transaction((tx) => createDraftEntry(tx, A, inp))])
    assert.equal(a.id, b.id)
    assert.deepEqual([a.existing, b.existing].sort(), [false, true])
  })
  it("créations concurrentes même clé + contenus divergents : une réussit, l'autre SOURCE_CONFLICT (pas d'erreur d'unicité)", async () => {
    const one = { ...input(), source: { type: "INVOICE", id: "inv-d", version: 1 } }
    const two = { ...one, label: "Divergent" }
    const r = await Promise.allSettled([db.$transaction((tx) => createDraftEntry(tx, A, one)), db.$transaction((tx) => createDraftEntry(tx, A, two))])
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1)
    const rej = r.find((x) => x.status === "rejected") as PromiseRejectedResult
    assert.ok(rej.reason instanceof AccountingError && rej.reason.code === "SOURCE_CONFLICT", String(rej.reason))
  })
  it("brouillon sourcé modifié en SQL après création : validation refusée (SOURCE_HASH_MISMATCH)", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, A, { ...input(), source: { type: "INVOICE", id: "inv-m", version: 1 } }))
    await db.$executeRawUnsafe(`UPDATE journal_entries SET label='Modifié' WHERE id='${d.id}'`)
    await assert.rejects(db.$transaction((tx) => postEntry(tx, A, d.id)), (e: unknown) => e instanceof AccountingError && e.code === "SOURCE_HASH_MISMATCH")
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
  it("révocation concurrente validée PENDANT l'attente de postEntry : la validation voit la révocation", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, B, { journalId: ids["coB:VT"], fiscalYearId: ids["coB:FY"], entryDate: D("2026-03-07"), label: "RevC",
      lines: [{ accountId: ids["coB:411"], debitCents: c(2), creditCents: c(0) }, { accountId: ids["coB:706"], debitCents: c(0), creditCents: c(2) }] }))
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => { locked = r })
    const revoker = db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: "admB" }, data: { active: false } })
      locked()
      await gate
    })
    await isLocked
    let settled = false
    const poster = db.$transaction((tx) => postEntry(tx, B, d.id)).finally(() => { settled = true })
    poster.catch(() => {})
    await sleep(400)
    assert.equal(settled, false, "postEntry doit attendre le verrou d'autorité")
    release()
    await revoker
    await assert.rejects(poster, (e: unknown) => e instanceof AccountingError && e.code === "ACCESS_REVOKED")
    assert.equal((await db.journalEntry.findUniqueOrThrow({ where: { id: d.id } })).status, "DRAFT")
    await db.user.update({ where: { id: "admB" }, data: { active: true } })
  })
  it("révocation lancée pendant une validation : elle attend la fin de la validation (sérialisation)", async () => {
    const d = await db.$transaction((tx) => createDraftEntry(tx, B, { journalId: ids["coB:VT"], fiscalYearId: ids["coB:FY"], entryDate: D("2026-03-08"), label: "RevD",
      lines: [{ accountId: ids["coB:411"], debitCents: c(3), creditCents: c(0) }, { accountId: ids["coB:706"], debitCents: c(0), creditCents: c(3) }] }))
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let posted!: () => void
    const isPosted = new Promise<void>((r) => { posted = r })
    const poster = db.$transaction(async (tx) => { const r = await postEntry(tx, B, d.id); posted(); await gate; return r })
    await isPosted
    let revoked = false
    const revoker = db.user.update({ where: { id: "admB" }, data: { active: false } }).then(() => { revoked = true })
    await sleep(400)
    assert.equal(revoked, false, "la révocation doit attendre la fin de la validation")
    release()
    const r = await poster
    await revoker
    assert.ok(r.number > 0)
    await db.user.update({ where: { id: "admB" }, data: { active: true } })
  })
})

describe("Frontière de privilèges (rôle applicatif non propriétaire, indicateur forgé)", () => {
  before(async () => {
    await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_app') THEN CREATE ROLE acc_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`)
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO acc_app`)
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acc_app`)
  })
  const draft = (label: string, date: string) => db.$transaction((tx) => createDraftEntry(tx, A, { journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"], entryDate: D(date), label,
    lines: [{ accountId: ids["coA:411"], debitCents: c(8), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(8) }] }))
  it("acc_app + indicateur : validation directe d'un brouillon refusée", async () => {
    const d = await draft("Forge 1", "2026-03-10")
    const msg = await forged("acc_app", (tx) => tx.$executeRawUnsafe(`UPDATE journal_entries SET status='VALIDATED', number=999, "validatedAt"=now(), "validatedById"='admA', hash='fake', "prevHash"='fake' WHERE id='${d.id}'`))
    assert.match(msg, /ENTRY_POSTING_DENIED/)
  })
  it("acc_app + indicateur : incrément de compteur sans écriture refusé", async () => {
    assert.match(await forged("acc_app", (tx) => tx.$executeRawUnsafe(`UPDATE accounting_sequences SET "lastNumber"="lastNumber"+1 WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}'`)), /SEQUENCE_IMMUTABLE/)
  })
  it("acc_app + indicateur : tête de chaîne vers une entrée absente refusée", async () => {
    assert.match(await forged("acc_app", (tx) => tx.$executeRawUnsafe(`UPDATE accounting_chain_heads SET "lastEntryId"='INEXISTANT', "lastHash"='FAUX' WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}'`)), /CHAIN_IMMUTABLE/)
  })
  it("acc_app + indicateur : changement d'état d'exercice hors service refusé", async () => {
    assert.match(await forged("acc_app", (tx) => tx.$executeRawUnsafe(`UPDATE fiscal_years SET status='CLOSING' WHERE id='${ids["coB:FY"]}'`)), /FISCAL_YEAR_TRANSITION_DENIED/)
  })
  it("propriétaire + indicateur (défense en profondeur) : faux numéro / fausse empreinte / compteur sans écriture / tête invalide refusés", async () => {
    const d = await draft("Forge 2", "2026-03-11")
    const seq = await db.accountingSequence.findFirstOrThrow({ where: { companyId: "coA", journalId: ids["coA:VT"], fiscalYearId: ids["coA:FY"] } })
    const head = await db.accountingChainHead.findUniqueOrThrow({ where: { companyId_journalId: { companyId: "coA", journalId: ids["coA:VT"] } } })
    assert.match(await forged("owner", (tx) => tx.$executeRawUnsafe(`UPDATE journal_entries SET status='VALIDATED', number=999, "validatedAt"=now(), "validatedById"='admA', hash='fake', "prevHash"='${head.lastHash}', "prevEntryId"='${head.lastEntryId}' WHERE id='${d.id}'`)), /ENTRY_INTEGRITY/)
    assert.match(await forged("owner", async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE accounting_sequences SET "lastNumber"=${seq.lastNumber + 1} WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}' AND "fiscalYearId"='${ids["coA:FY"]}'`)
      await tx.$executeRawUnsafe(`UPDATE journal_entries SET status='VALIDATED', number=${seq.lastNumber + 1}, "validatedAt"=now(), "validatedById"='admA', hash='fake', "prevHash"='${head.lastHash}', "prevEntryId"='${head.lastEntryId}' WHERE id='${d.id}'`)
    }), /ENTRY_INTEGRITY: empreinte/)
    assert.match(await forged("owner", (tx) => tx.$executeRawUnsafe(`UPDATE accounting_sequences SET "lastNumber"=${seq.lastNumber + 1} WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}' AND "fiscalYearId"='${ids["coA:FY"]}'`)), /SEQUENCE_INTEGRITY/)
    assert.match(await forged("owner", (tx) => tx.$executeRawUnsafe(`UPDATE accounting_chain_heads SET "lastEntryId"='INEXISTANT', "lastHash"='FAUX' WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}'`)), /CHAIN_INTEGRITY/)
    assert.equal((await db.journalEntry.findUniqueOrThrow({ where: { id: d.id } })).status, "DRAFT")
  })
  it("acc_app via le service (fonction SECURITY DEFINER) : validation acceptée, numéro, chaîne et audit cohérents", async () => {
    const d = await draft("Par le service", "2026-03-12")
    const r = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE acc_app`)
      return postEntry(tx, A, d.id)
    })
    assert.ok(r.number > 0)
    assert.equal(await db.historyLog.count({ where: { entityType: "JournalEntry", entityId: d.id } }), 1)
    const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))
    assert.equal(v.ok, true, JSON.stringify(v))
  })
})

describe("Forme canonique SQL = TypeScript", () => {
  it("libellés et références difficiles (guillemets, échappements, NFD→NFC, emoji, U+2028) : empreinte SQL recalculée à l'identique en TS", async () => {
    const tricky = 'Écriture "spéciale" \\ / \n ligne\tTab e\u0301 😀 \u2028 fin'
    const r = await db.$transaction(async (tx) => {
      const d = await createDraftEntry(tx, A, { journalId: ids["coA:OD"], fiscalYearId: ids["coA:FY"], entryDate: D("2026-07-01"), documentDate: D("2026-06-30"),
        documentRef: "Réf-ü\u0308", label: tricky,
        lines: [{ accountId: ids["coA:411"], debitCents: c(999999999999), creditCents: c(0), label: tricky, vatRateBp: 2000 }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(999999999999) }] })
      return postEntry(tx, A, d.id)
    })
    const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:OD"]))
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.match(r.hash, /^[0-9a-f]{64}$/)
  })
})

describe("Plusieurs écritures et journaux dans une même transaction, en concurrence", () => {
  it("4 transactions × 2 journaux (ordres opposés) : toutes validées, numéros contigus, chaînes intactes", async () => {
    const one = (tx: TxC, journal: string, amount: number) => createDraftEntry(tx, A, { journalId: ids[journal], fiscalYearId: ids["coA:FY"], entryDate: D("2026-07-02"), label: "Multi",
      lines: [{ accountId: ids["coA:411"], debitCents: c(amount), creditCents: c(0) }, { accountId: ids["coA:706"], debitCents: c(0), creditCents: c(amount) }] }).then((d) => postEntry(tx, A, d.id))
    await Promise.all([0, 1, 2, 3].map((i) => db.$transaction(async (tx) => {
      const order = i % 2 ? ["coA:VT", "coA:OD"] : ["coA:OD", "coA:VT"]
      for (const j of order) await one(tx, j, 10 + i)
    })))
    for (const j of ["coA:VT", "coA:OD"]) {
      const v = await db.$transaction((tx) => verifyChain(tx, A, ids[j]))
      assert.equal(v.ok, true, JSON.stringify(v))
    }
  })
})

describe("Vérificateur de chaîne : altérations détectées", () => {
  it("libellé altéré (déclencheurs désactivés par un superutilisateur) : HASH_MISMATCH ; tête reculée : UNREACHABLE_ENTRIES", async () => {
    const head = await db.accountingChainHead.findUniqueOrThrow({ where: { companyId_journalId: { companyId: "coA", journalId: ids["coA:VT"] } } })
    const tip = await db.journalEntry.findUniqueOrThrow({ where: { id: head.lastEntryId! } })
    await db.$executeRawUnsafe(`ALTER TABLE journal_entries DISABLE TRIGGER USER`)
    try {
      await db.$executeRawUnsafe(`UPDATE journal_entries SET label='altéré' WHERE id='${tip.id}'`)
      const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))
      assert.equal(v.reason, "HASH_MISMATCH")
      await db.$executeRawUnsafe(`UPDATE journal_entries SET label=$1 WHERE id='${tip.id}'`, tip.label)
    } finally { await db.$executeRawUnsafe(`ALTER TABLE journal_entries ENABLE TRIGGER USER`) }
    await db.$executeRawUnsafe(`ALTER TABLE accounting_chain_heads DISABLE TRIGGER USER`)
    try {
      await db.$executeRawUnsafe(`UPDATE accounting_chain_heads SET "lastEntryId"='${tip.prevEntryId}', "lastHash"='${tip.prevHash}' WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}'`)
      const v = await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))
      assert.equal(v.reason, "UNREACHABLE_ENTRIES")
      await db.$executeRawUnsafe(`UPDATE accounting_chain_heads SET "lastEntryId"='${head.lastEntryId}', "lastHash"='${head.lastHash}' WHERE "companyId"='coA' AND "journalId"='${ids["coA:VT"]}'`)
    } finally { await db.$executeRawUnsafe(`ALTER TABLE accounting_chain_heads ENABLE TRIGGER USER`) }
    assert.equal((await db.$transaction((tx) => verifyChain(tx, A, ids["coA:VT"]))).ok, true)
  })
})

describe("Contre-passation", () => {
  it("miroir exact validé ; seconde contre-passation refusée ; brouillon non contre-passable", async () => {
    const r = await db.$transaction((tx) => reverseEntry(tx, A, ids.e1, { entryDate: D("2026-06-01") }))
    assert.ok(r.number > 1)
    await assert.rejects(db.$transaction((tx) => reverseEntry(tx, A, ids.e1, { entryDate: D("2026-06-02") })))
    await assert.rejects(db.$transaction((tx) => reverseEntry(tx, A, ids.draftY, { entryDate: D("2026-06-02") })), (e: unknown) => e instanceof AccountingError && e.code === "ENTRY_NOT_VALIDATED")
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
      await tx.$queryRaw`SELECT * FROM accounting_post_entry('coA', ${d.id}, 'admA')`
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
    ids.closing = closing.id
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
    // Correction postérieure à la clôture : contre-passation dans l'exercice suivant (refusée dans l'exercice clos).
    await assert.rejects(db.$transaction((tx) => reverseEntry(tx, A, ids.closing, { entryDate: D("2026-12-31") })), (e: unknown) => e instanceof AccountingError && e.details.includes("YEAR_NOT_OPEN"))
    const rev = await db.$transaction((tx) => reverseEntry(tx, A, ids.closing, { entryDate: D("2027-01-16"), fiscalYearId: ids.fy2027 }))
    assert.equal(rev.number, 1)
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
