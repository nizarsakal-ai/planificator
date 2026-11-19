/**
 * Lot H Planificator V2 : pré-paie sur une base PostgreSQL JETABLE, jeu SYNTHÉTIQUE. Ouverture unique par mois,
 * variables calculées depuis pointages et absences, primes et frais saisis, clôture refusée tant qu'un contrôle bloque,
 * instantané figé et reproductible, période clôturée immuable (service et base), clôture concurrente d'une saisie,
 * isolation. Aucun calcul de paie.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh loth_prepay npm run test:prepay:pg
 * Portage sur 90ae644 (19/11/2026) : harnais jetable de la base (tests/billing/pg/with-disposable-db.sh), deux entreprises
 * isolées, trois utilisateurs réels (clé history_logs_actorId_fkey), aucun littéral BigInt ; clôture en lecture répétable :
 * course déterministe avec une saisie validée pendant l'attente du verrou (relance sur instantané neuf, variable incluse).
 * Base jetable uniquement (Mac), jamais sur le VPS ni sur des données RH réelles.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"
import * as svc from "@/lib/payroll-prep/prepay.service"
import { getPeriodView } from "@/lib/payroll-prep/queries"
import { PREPAY_ERRORS, readSnapshot } from "@/lib/payroll-prep/prepay.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const T0 = new Date("2026-11-05T09:00:00Z")
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
let oct = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uA2','a2@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName",role,"updatedAt") VALUES ('eA','uA','coA','Ana','Martin','ADMIN',now()),('eA2','uA2','coA','Léo','Petit','EMPLOYEE',now()),('eB','uB','coB','Bob','Durand','ADMIN',now())`,
    `INSERT INTO timeclocks(id,"employeeId","companyId",date,"checkInAt","checkOutAt","updatedAt") VALUES
      ('t1','eA','coA','2026-10-01','2026-10-01T08:00:00Z','2026-10-01T16:30:00Z',now()),
      ('t2','eA','coA','2026-10-02','2026-10-02T07:00:00Z',NULL,now()),
      ('t3','eA2','coA','2026-10-14','2026-10-14T08:00:00Z','2026-10-14T12:00:00Z',now()),
      ('t4','eB','coB','2026-10-01','2026-10-01T08:00:00Z','2026-10-01T18:00:00Z',now())`,
    `INSERT INTO absences(id,"employeeId","companyId",type,status,"startDate","endDate","updatedAt") VALUES
      ('ab1','eA2','coA','VACATION','APPROVED','2026-10-12','2026-10-16',now()),
      ('ab2','eA2','coA','SICK','PENDING','2026-10-26','2026-10-26',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("périodes et variables", () => {
  it("ouverture : une par mois et par entreprise, jamais future", async () => {
    oct = ok(await svc.openPeriod(db, A, 2026, 10, T0)).id
    assert.deepEqual(await svc.openPeriod(db, A, 2026, 10, T0), { ok: false, error: PREPAY_ERRORS.exists })
    assert.deepEqual(await svc.openPeriod(db, A, 2026, 12, T0), { ok: false, error: PREPAY_ERRORS.period })
    ok(await svc.openPeriod(db, B, 2026, 10, T0))
  })
  it("variables calculées en direct ; contrôles bloquants (pointage incomplet, absence en attente)", async () => {
    const v = (await getPeriodView(db, "coA", oct))!
    assert.equal(v.provisional, true)
    const byId = Object.fromEntries(v.lines.map((l) => [l.employeeId, l]))
    assert.deepEqual(Object.keys(byId).sort(), ["eA", "eA2"], "aucun salarié d'une autre entreprise")
    assert.deepEqual([byId.eA.workedMinutes, byId.eA.workedDays], [510, 1])
    assert.deepEqual([byId.eA2.workedMinutes, byId.eA2.absenceDays.VACATION], [240, 5])
    assert.deepEqual(v.anomalies.filter((a) => a.blocking).map((a) => a.code).sort(), ["INCOMPLETE_TIMECLOCK", "PENDING_ABSENCE"])
    assert.deepEqual(await svc.closePeriod(db, A, oct, T0), { ok: false, error: PREPAY_ERRORS.blocking(2) })
  })
  it("primes et frais : salarié de l'entreprise seulement, montant et libellé contrôlés, suppression possible tant qu'ouverte", async () => {
    assert.deepEqual(await svc.addVariable(db, A, oct, { employeeId: "eB", kind: "BONUS", amount: "10", label: "Prime" }), { ok: false, error: PREPAY_ERRORS.employee })
    assert.deepEqual(await svc.addVariable(db, A, oct, { employeeId: "eA", kind: "SALARY", amount: "10", label: "Prime" }), { ok: false, error: PREPAY_ERRORS.kind })
    assert.deepEqual(await svc.addVariable(db, A, oct, { employeeId: "eA", kind: "BONUS", amount: "-10", label: "Prime" }), { ok: false, error: PREPAY_ERRORS.amount })
    const x = ok(await svc.addVariable(db, A, oct, { employeeId: "eA", kind: "BONUS", amount: "99", label: "Erreur de saisie" })).id
    ok(await svc.removeVariable(db, A, x))
    ok(await svc.addVariable(db, A, oct, { employeeId: "eA", kind: "BONUS", amount: "150,00", label: "Prime de chantier" }))
    ok(await svc.addVariable(db, A, oct, { employeeId: "eA2", kind: "EXPENSE", amount: "12,34", label: "Frais de repas" }))
    assert.deepEqual(await svc.addVariable(db, B, oct, { employeeId: "eB", kind: "BONUS", amount: "1", label: "Prime" }), { ok: false, error: PREPAY_ERRORS.notFound }, "période d'une autre entreprise")
    // Portage v2 : journal minimal rattaché à la période (société, auteur, type d'action, détail générique) ; aucun nom de
    // salarié, libellé libre ni montant dans HistoryLog.
    const logs = await db.historyLog.findMany({ where: { companyId: "coA", entityType: "PayrollPeriod", entityId: oct, detail: { in: [svc.AUDIT_VARIABLE_ADDED, svc.AUDIT_VARIABLE_REMOVED] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { actorId: true, action: true, detail: true } })
    assert.deepEqual(logs.map((l) => l.detail).sort(), ["Variable de pré-paie ajoutée.", "Variable de pré-paie ajoutée.", "Variable de pré-paie ajoutée.", "Variable de pré-paie supprimée."])
    assert.ok(logs.every((l) => l.actorId === "uA" && l.action === "UPDATED"), "auteur et type d'action")
    const tous = await db.historyLog.findMany({ where: { entityType: "PayrollPeriod", entityId: oct }, select: { detail: true } })
    for (const l of tous) assert.doesNotMatch(l.detail ?? "", /Erreur de saisie|Prime de chantier|Frais de repas|Martin|Petit|Ana|Léo|150|12,34|99/, l.detail ?? "")
  })
})

describe("clôture", () => {
  it("contrôles résolus ⇒ clôture : instantané figé, empreinte reproductible, données vivantes ultérieures sans effet", async () => {
    await db.$executeRawUnsafe(`UPDATE timeclocks SET "checkOutAt" = '2026-10-02T15:00:00Z' WHERE id = 't2'`)
    await db.$executeRawUnsafe(`UPDATE absences SET status = 'APPROVED' WHERE id = 'ab2'`)
    const r = ok(await svc.closePeriod(db, A, oct, T0))
    const row = await db.payrollPeriod.findUniqueOrThrow({ where: { id: oct }, select: { status: true, snapshot: true, snapshotSha256: true } })
    assert.equal(row.status, "CLOSED")
    assert.equal(svc.snapshotSha256(readSnapshot(row.snapshot)!), row.snapshotSha256)
    assert.equal(r.sha256, row.snapshotSha256)
    await db.$executeRawUnsafe(`INSERT INTO timeclocks(id,"employeeId","companyId",date,"checkInAt","checkOutAt","updatedAt") VALUES ('t5','eA','coA','2026-10-20','2026-10-20T08:00:00Z','2026-10-20T12:00:00Z',now())`)
    const v = (await getPeriodView(db, "coA", oct))!
    const eA = v.lines.find((l) => l.employeeId === "eA")!
    assert.deepEqual([v.provisional, v.intact, eA.workedMinutes, eA.workedDays, eA.bonusCents], [false, true, 990, 2, "15000"], "pointage ajouté après clôture ignoré")
    assert.equal(v.lines.find((l) => l.employeeId === "eA2")!.absenceDays.SICK, 1)
  })
  it("période clôturée immuable : service et base", async () => {
    assert.deepEqual(await svc.addVariable(db, A, oct, { employeeId: "eA", kind: "BONUS", amount: "1", label: "Après coup" }), { ok: false, error: PREPAY_ERRORS.closed })
    const varId = (await db.payrollManualVariable.findFirstOrThrow({ where: { periodId: oct }, select: { id: true } })).id
    assert.deepEqual(await svc.removeVariable(db, A, varId), { ok: false, error: PREPAY_ERRORS.closed })
    assert.deepEqual(await svc.closePeriod(db, A, oct, T0), { ok: false, error: PREPAY_ERRORS.closed })
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO payroll_manual_variables(id,"companyId","periodId","employeeId",kind,"amountCents",label,"createdById") VALUES ('vx','coA','${oct}','eA','BONUS',1,'Contournement','uA')`), /payroll period is closed/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM payroll_manual_variables WHERE id = '${varId}'`), /payroll period is closed/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE payroll_manual_variables SET label = 'Autre' WHERE id = '${varId}'`), /payroll variable immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE payroll_periods SET status = 'OPEN', snapshot = NULL, "snapshotSha256" = NULL, "closedById" = NULL, "closedAt" = NULL WHERE id = '${oct}'`), /closed payroll period immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM payroll_periods WHERE id = '${oct}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO payroll_periods(id,"companyId",year,month,status,snapshot,"snapshotSha256","createdById","closedById","closedAt","updatedAt") VALUES ('px','coA',2026,8,'CLOSED','{}','${"a".repeat(64)}','uA','uA',now(),now())`), /must start open/)
  })
  it("clôture et saisie concurrentes : la variable est dans l'instantané, ou refusée ; jamais perdue en silence", async () => {
    const sep = ok(await svc.openPeriod(db, A, 2026, 9, T0)).id
    const [add, close] = await Promise.all([
      svc.addVariable(db, A, sep, { employeeId: "eA", kind: "BONUS", amount: "7", label: "Course" }),
      svc.closePeriod(db, A, sep, T0),
    ])
    // Portage : après une relance, la clôture aboutit ; un second conflit rendrait l'issue métier « concurrent » (période
    // restée ouverte, saisie conservée), jamais un instantané qui omettrait une saisie validée.
    if (!close.ok) {
      assert.deepEqual(close, { ok: false, error: PREPAY_ERRORS.concurrent })
      assert.equal((await db.payrollPeriod.findUniqueOrThrow({ where: { id: sep }, select: { status: true } })).status, "OPEN")
      return
    }
    const snap = readSnapshot((await db.payrollPeriod.findUniqueOrThrow({ where: { id: sep }, select: { snapshot: true } })).snapshot)!
    const bonus = snap.lines.find((l) => l.employeeId === "eA")!.bonusCents
    if (add.ok) assert.equal(bonus, "700", "saisie validée avant la clôture : incluse")
    else { assert.deepEqual(add, { ok: false, error: PREPAY_ERRORS.closed }); assert.equal(bonus, "0") }
  })
  it("course déterministe : clôture en attente d'une saisie validée ⇒ relance sur instantané neuf, variable incluse (portage 90ae644)", async () => {
    const jun = ok(await svc.openPeriod(db, A, 2026, 6, T0)).id
    const course: { closing?: ReturnType<typeof svc.closePeriod> } = {}
    // Saisie simulée comme le service : verrou exclusif de la période, insertion, période « touchée », puis attente
    // pendant que la clôture (autre connexion, lecture répétable) attend ce verrou ; la saisie est validée ensuite.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payroll_periods" WHERE "id" = ${jun} AND "companyId" = 'coA' FOR UPDATE`
      await tx.$executeRaw`INSERT INTO "payroll_manual_variables"("id","companyId","periodId","employeeId","kind","amountCents","label","createdById") VALUES ('vrace','coA',${jun},'eA','BONUS',4200,'Course déterministe','uA')`
      await tx.$executeRaw`UPDATE "payroll_periods" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${jun}`
      course.closing = svc.closePeriod(db, A, jun, T0)
      await new Promise((r) => setTimeout(r, 500))
    }, { timeout: 15_000 })
    assert.ok(course.closing, "clôture lancée pendant la saisie")
    const close = await course.closing
    assert.ok(close.ok, close.ok ? "" : close.error)
    const row = await db.payrollPeriod.findUniqueOrThrow({ where: { id: jun }, select: { status: true, snapshot: true, snapshotSha256: true } })
    assert.equal(row.status, "CLOSED")
    const snap = readSnapshot(row.snapshot)!
    assert.equal(snap.lines.find((l) => l.employeeId === "eA")!.bonusCents, "4200", "saisie validée pendant l'attente : présente dans l'instantané")
    assert.equal(svc.snapshotSha256(snap), row.snapshotSha256)
  })
  it("conflit de sérialisation reconnu (P2034 ou SQLSTATE 40001/40P01) ; autres erreurs non", () => {
    const err = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test", meta })
    assert.equal(svc.isSerializationConflict(err("P2034")), true)
    assert.equal(svc.isSerializationConflict(err("P2010", { code: "40001" })), true)
    assert.equal(svc.isSerializationConflict(err("P2010", { code: "40P01" })), true)
    assert.equal(svc.isSerializationConflict(err("P2010", { code: "23514" })), false)
    assert.equal(svc.isSerializationConflict(err("P2002")), false)
    assert.equal(svc.isSerializationConflict(new Error("40001")), false)
  })
  it("clôture en SQL direct sans instantané ou sans empreinte : refusée par la base (revue Codex du 05/11)", async () => {
    const jul = ok(await svc.openPeriod(db, A, 2026, 7, T0)).id
    const close = (snapshot: string, sha: string) => db.$executeRawUnsafe(`UPDATE payroll_periods SET status = 'CLOSED', snapshot = ${snapshot}, "snapshotSha256" = ${sha}, "closedById" = 'uA', "closedAt" = now() WHERE id = '${jul}'`)
    await assert.rejects(close("NULL", `'${"a".repeat(64)}'`), /payroll_periods_values_check/, "instantané NULL")
    await assert.rejects(close(`'{}'`, "NULL"), /payroll_periods_values_check/, "empreinte NULL")
    await assert.rejects(close("NULL", "NULL"), /payroll_periods_values_check/, "les deux NULL")
    assert.equal((await db.payrollPeriod.findUniqueOrThrow({ where: { id: jul }, select: { status: true } })).status, "OPEN", "la période reste ouverte")
  })
  it("isolation : une autre entreprise ne lit ni ne clôture la période", async () => {
    assert.equal(await getPeriodView(db, "coB", oct), null)
    assert.deepEqual(await svc.closePeriod(db, B, oct, T0), { ok: false, error: PREPAY_ERRORS.notFound })
  })
})
