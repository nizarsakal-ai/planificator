/**
 * Lot E Planificator V2 : opportunités sur une base PostgreSQL JETABLE. Création avec liens (client, chantier, devis,
 * consultation, responsable), refus des liens d'une autre entreprise (service et base), étapes, figement d'une
 * opportunité close, relances, historique append-only, audit.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh crm npm run test:crm:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/crm/crm.service"
import { CRM_ERRORS } from "@/lib/crm/crm.core"
import { getOpportunity, listOpportunities } from "@/lib/crm/queries"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const NOW = new Date("2026-11-04T09:00:00Z")
const ok = <T>(r: svc.CrmResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const base = { title: "Rénovation façade", amountCents: BigInt(1_200_000) }
let o1 = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','Client A',now()),('clA2','coA','Client A2',now()),('clB','coB','Client B',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Chantier A',now()),('wB','coB','clB','uB','Chantier B',now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName","updatedAt") VALUES ('eA','uA','coA','Ana','Martin',now()),('eB','uB','coB','Bob','Durand',now())`,
    `INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt") VALUES ('qA','coA','wA','clA','DEV-2026-0001','uA',now()),('qB','coB','wB','clB','DEV-2026-0001','uB',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("opportunités", () => {
  it("création avec client, chantier, devis du même client et responsable ; numéro ; événement et audit", async () => {
    const r = ok(await svc.createOpportunity(db, A, { ...base, clientId: "clA", worksiteId: "wA", quoteId: "qA", ownerEmployeeId: "eA", stage: "QUALIFIED" }))
    o1 = r.id
    assert.match(r.number, /^OPP-\d{4}-0001$/)
    const o = (await getOpportunity(db, "coA", o1))!
    assert.deepEqual([o.stage, o.probabilityBp, o.amountCents, o.quote?.number], ["QUALIFIED", 2500, BigInt(1_200_000), "DEV-2026-0001"])
    assert.deepEqual(o.events.map((e) => e.type), ["CREATED"])
    assert.equal(await db.historyLog.count({ where: { entityType: "Opportunity", entityId: o1, action: "CREATED" } }), 1)
  })
  it("prospect sans fiche client ; étape initiale close refusée (ramenée à « piste »)", async () => {
    const r = ok(await svc.createOpportunity(db, A, { ...base, prospectName: "M. Prospect", stage: "WON" }))
    assert.equal((await db.opportunity.findUnique({ where: { id: r.id }, select: { stage: true } }))?.stage, "LEAD")
  })
  it("liens d'une autre entreprise ou devis d'un autre client : refusés sans écriture", async () => {
    const before = [await db.opportunity.count(), await db.historyLog.count()]
    for (const extra of [{ clientId: "clB" }, { clientId: "clA", worksiteId: "wB" }, { clientId: "clA", quoteId: "qB" }, { clientId: "clA", ownerEmployeeId: "eB" }, { clientId: "clA", consultationDraftId: "inexistant" }]) {
      assert.deepEqual(await svc.createOpportunity(db, A, { ...base, ...extra }), { ok: false, error: CRM_ERRORS.notFound }, JSON.stringify(extra))
    }
    assert.deepEqual(await svc.createOpportunity(db, A, { ...base, clientId: "clA2", quoteId: "qA" }), { ok: false, error: CRM_ERRORS.quoteClient })
    assert.deepEqual([await db.opportunity.count(), await db.historyLog.count()], before)
  })
  it("base : consultation d'une autre entreprise ou inexistante refusée par déclencheur ; client d'une autre entreprise par clé composite", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO opportunities(id,"companyId",number,title,"clientId","probabilityBp","createdById","updatedAt","consultationDraftId") VALUES ('ox','coA','OPP-X','Titre','clA',1000,'uA',now(),'draft-inconnu')`), /same company/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO opportunities(id,"companyId",number,title,"clientId","probabilityBp","createdById","updatedAt") VALUES ('oy','coA','OPP-Y','Titre','clB',1000,'uA',now())`), /opportunities_clientId_companyId_fkey|foreign key/i)
  })
  it("étapes : proposition, relance avec prochaine date, puis gagnée ; figée ensuite (service et base)", async () => {
    assert.deepEqual(ok(await svc.changeStage(db, A, o1, "PROPOSAL", null, NOW)), { stage: "PROPOSAL" })
    ok(await svc.recordFollowUp(db, A, o1, "Appel au client, devis relu", new Date("2026-11-12T00:00:00Z")))
    ok(await svc.changeStage(db, A, o1, "WON", null, NOW))
    const o = (await getOpportunity(db, "coA", o1))!
    assert.deepEqual([o.stage, o.probabilityBp, o.nextFollowUpDate], ["WON", 10000, null])
    assert.deepEqual(o.events.map((e) => e.type), ["STAGE_CHANGED", "FOLLOW_UP_DONE", "STAGE_CHANGED", "CREATED"])
    assert.deepEqual(await svc.changeStage(db, A, o1, "LOST", "Erreur", NOW), { ok: false, error: CRM_ERRORS.closed })
    assert.deepEqual(await svc.updateOpportunity(db, A, o1, { ...base, clientId: "clA" }), { ok: false, error: CRM_ERRORS.closed })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE opportunities SET "amountCents" = 1 WHERE id = '${o1}'`), /closed opportunity immutable/)
    ok(await svc.addNote(db, A, o1, "Chantier planifié en janvier"))
  })
  it("perdue : motif obligatoire ; probabilité 0 ; base : incohérence d'état refusée", async () => {
    const id = ok(await svc.createOpportunity(db, A, { ...base, clientId: "clA" })).id
    assert.deepEqual(await svc.changeStage(db, A, id, "LOST", "", NOW), { ok: false, error: CRM_ERRORS.lostReason })
    ok(await svc.changeStage(db, A, id, "LOST", "Concurrent moins cher", NOW))
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO opportunities(id,"companyId",number,title,"clientId",stage,"probabilityBp","createdById","updatedAt") VALUES ('oz','coA','OPP-Z','Titre','clA','WON',5000,'uA',now())`), /opportunities_values_check/)
  })
  it("historique append-only ; opportunité jamais supprimée", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE opportunity_events SET note = 'x'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM opportunity_events`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM opportunities WHERE id = '${o1}'`), /cannot be deleted/)
  })
  it("isolation : B ne voit ni ne modifie les opportunités de A", async () => {
    assert.equal(await getOpportunity(db, "coB", o1), null)
    assert.equal((await listOpportunities(db, "coB", NOW)).items.length, 0)
    assert.deepEqual(await svc.addNote(db, B, o1, "Tentative"), { ok: false, error: CRM_ERRORS.notFound })
    const open = ok(await svc.createOpportunity(db, A, { ...base, clientId: "clA" })).id
    assert.deepEqual(await svc.changeStage(db, B, open, "PROPOSAL", null, NOW), { ok: false, error: CRM_ERRORS.notFound })
  })
})
