/**
 * Lot F Planificator V2 : assistant sur une base PostgreSQL JETABLE (portage sur ab987847, 19/11/2026). Propositions liées
 * aux sources (pipeline commercial du lot E et stock du lot A, chacune seulement si son module est activé ; aucune source
 * du lot D), une seule fois par observation (y compris en concurrence), AUCUNE action sans approbation, revalidation à
 * l'approbation (périmée sinon), approbation unique en concurrence, refus définitif, isolation entre entreprises,
 * garanties de la base (fournisseur LOCAL_RULES seul, décision unique, tâche de la même entreprise, journal immuable)
 * et AUCUN appel réseau (fetch remplacé par un compteur).
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh lotf_assistant npm run test:assistant:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/assistant/assistant.service"
import * as crm from "@/lib/crm/crm.service"
import { ASSISTANT_ERRORS } from "@/lib/assistant/assistant.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const T0 = new Date("2026-11-04T08:00:00Z")
const ALL = { crm: true, stock: true }
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const originalFetch = globalThis.fetch
let networkCalls = 0
let oppA1 = ""
let oppA2 = ""
const byRule = async (companyId: string, rule: string) => (await db.assistantProposal.findFirstOrThrow({ where: { companyId, rule }, orderBy: { createdAt: "asc" }, select: { id: true } })).id
/** Proposition dont la (seule) source désigne `sourceId`. */
const bySource = async (companyId: string, sourceId: string) => {
  const ps = await db.assistantProposal.findMany({ where: { companyId }, select: { id: true, sources: true } })
  const p = ps.find((x) => Array.isArray(x.sources) && (x.sources as { id?: unknown }[])[0]?.id === sourceId)
  assert.ok(p, `proposition de la source ${sourceId}`)
  return p.id
}

before(async () => {
  globalThis.fetch = (async () => { networkCalls++; throw new Error("réseau interdit en test") }) as typeof fetch
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uA2','a2@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','Durand',now()),('clB','coB','Client B',now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName",role,"updatedAt") VALUES ('eA','uA','coA','Ana','Martin','ADMIN',now()),('eA2','uA2','coA','Léo','Petit','EMPLOYEE',now()),('eB','uB','coB','Bob','Durand','ADMIN',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Maison A',now()),('wB','coB','clB','uB','Maison B',now())`,
    `INSERT INTO warehouses(id,"companyId",name,"updatedAt") VALUES ('whA','coA','Dépôt A',now())`,
    `INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","updatedAt") VALUES ('aA','coA','Enduit','sac',10,now())`,
    `INSERT INTO stock_levels(id,"companyId","warehouseId","articleId","quantityMilli","minQuantityMilli","updatedAt") VALUES ('slA','coA','whA','aA',1000,5000,now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  oppA1 = ok(await crm.createOpportunity(db, A, { title: "Façade", clientId: "clA", worksiteId: "wA", amountCents: BigInt(100_000), nextFollowUpDate: new Date("2026-10-30T00:00:00Z") })).id
  oppA2 = ok(await crm.createOpportunity(db, A, { title: "Toiture", clientId: "clA", amountCents: BigInt(80_000), nextFollowUpDate: new Date("2026-10-25T00:00:00Z") })).id
  ok(await crm.createOpportunity(db, B, { title: "Toiture", clientId: "clB", amountCents: BigInt(50_000), nextFollowUpDate: new Date("2026-10-15T00:00:00Z") }))
})
after(async () => {
  globalThis.fetch = originalFetch
  await db.$disconnect()
})

describe("génération", () => {
  it("modules sources désactivés : aucune lecture, aucune proposition", async () => {
    assert.deepEqual(ok(await svc.generateProposals(db, A, { crm: false, stock: false }, T0)), { proposed: 0, alreadyKnown: 0 })
    assert.equal(await db.assistantProposal.count(), 0)
  })
  it("stock seul (pipeline commercial désactivé) : seule l'alerte de stock est proposée", async () => {
    assert.deepEqual(ok(await svc.generateProposals(db, A, { crm: false, stock: true }, T0)), { proposed: 1, alreadyKnown: 0 })
    assert.deepEqual((await db.assistantProposal.findMany({ where: { companyId: "coA" }, select: { rule: true } })).map((p) => p.rule), ["STOCK_BELOW_MINIMUM"])
  })
  it("une proposition par observation, avec ses sources, journalisée ; AUCUNE tâche créée sans approbation", async () => {
    assert.deepEqual(ok(await svc.generateProposals(db, A, ALL, T0)), { proposed: 2, alreadyKnown: 1 })
    const ps = await db.assistantProposal.findMany({ where: { companyId: "coA" }, orderBy: [{ rule: "asc" }, { sourceKey: "asc" }], select: { rule: true, provider: true, status: true, sources: true } })
    assert.deepEqual(ps.map((p) => [p.rule, p.provider, p.status]), [
      ["OPPORTUNITY_FOLLOW_UP_OVERDUE", "LOCAL_RULES", "PENDING"], ["OPPORTUNITY_FOLLOW_UP_OVERDUE", "LOCAL_RULES", "PENDING"], ["STOCK_BELOW_MINIMUM", "LOCAL_RULES", "PENDING"],
    ])
    const src = ps.map((p) => (p.sources as { type: string; id: string; href: string }[]).map((s) => [s.type, s.id, s.href])[0])
    assert.deepEqual(src.slice(0, 2).map((s) => s[1]).sort(), [oppA1, oppA2].sort())
    assert.ok(src.slice(0, 2).every((s) => s[0] === "Opportunity" && s[2] === `/crm/opportunites/${s[1]}`), "lien vers la fiche du pipeline commercial")
    assert.deepEqual(src[2], ["StockLevel", "slA", "/stock"])
    assert.equal(await db.assistantActionLog.count({ where: { companyId: "coA", event: "GENERATED" } }), 3)
    assert.equal(await db.task.count(), 0)
  })
  it("nouvelle analyse : rien de reproposé ; analyses concurrentes : une seule proposition par observation", async () => {
    assert.deepEqual(ok(await svc.generateProposals(db, A, ALL, T0)), { proposed: 0, alreadyKnown: 3 })
    const rs = await Promise.all([1, 2, 3].map(() => svc.generateProposals(db, B, ALL, T0)))
    assert.equal(rs.reduce((t, r) => t + ok(r).proposed, 0), 1)
    assert.equal(await db.assistantProposal.count({ where: { companyId: "coB" } }), 1)
  })
})

describe("décision humaine", () => {
  it("approbation avec ajustements : tâche créée dans l'entreprise, proposition exécutée, journal et historique", async () => {
    const id = await bySource("coA", oppA1)
    const r = ok(await svc.approveProposal(db, A, id, { title: "Appeler M. Durand", dueDate: "2026-11-06", assigneeId: "eA2" }, T0))
    assert.equal(r.executed, true)
    const taskId = (r as { taskId: string }).taskId
    const t = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { companyId: true, title: true, assigneeId: true, worksiteId: true, dueDate: true, createdById: true, priority: true, description: true } })
    assert.deepEqual([t.companyId, t.title, t.assigneeId, t.worksiteId, t.dueDate?.toISOString(), t.createdById, t.priority], ["coA", "Appeler M. Durand", "eA2", "wA", "2026-11-06T12:00:00.000Z", "uA", "MEDIUM"])
    assert.match(t.description ?? "", /Proposée par l'assistant \(règles locales/)
    const p = await db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true, decidedById: true, resultEntityType: true, resultEntityId: true } })
    assert.deepEqual(p, { status: "EXECUTED", decidedById: "uA", resultEntityType: "Task", resultEntityId: taskId })
    assert.equal(await db.assistantActionLog.count({ where: { proposalId: id, event: "EXECUTED" } }), 1)
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "Task", entityId: taskId } }), 1)
    assert.deepEqual(await svc.approveProposal(db, A, id, {}, T0), { ok: false, error: ASSISTANT_ERRORS.decided })
    assert.deepEqual(await svc.rejectProposal(db, A, id, null, T0), { ok: false, error: ASSISTANT_ERRORS.decided })
  })
  it("responsable d'une autre entreprise : refus, rien créé, proposition toujours en attente", async () => {
    const id = await bySource("coA", oppA2)
    assert.deepEqual(await svc.approveProposal(db, A, id, { assigneeId: "eB" }, T0), { ok: false, error: ASSISTANT_ERRORS.assignee })
    assert.equal(await db.task.count(), 1)
    assert.equal((await db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "PENDING")
  })
  it("isolation : une autre entreprise ne peut ni approuver ni refuser", async () => {
    const id = await bySource("coA", oppA2)
    assert.deepEqual(await svc.approveProposal(db, B, id, {}, T0), { ok: false, error: ASSISTANT_ERRORS.notFound })
    assert.deepEqual(await svc.rejectProposal(db, B, id, null, T0), { ok: false, error: ASSISTANT_ERRORS.notFound })
    assert.equal((await db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "PENDING")
  })
  it("refus avec motif : définitif, jamais reproposé", async () => {
    const id = await bySource("coA", oppA2)
    ok(await svc.rejectProposal(db, A, id, "Relance faite par téléphone", T0))
    assert.deepEqual(await db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true, decisionNote: true } }), { status: "REJECTED", decisionNote: "Relance faite par téléphone" })
    assert.equal(await db.assistantActionLog.count({ where: { proposalId: id, event: "REJECTED" } }), 1)
    assert.equal(ok(await svc.generateProposals(db, A, ALL, T0)).proposed, 0)
  })
  it("sources changées avant l'approbation : proposition périmée, aucune tâche", async () => {
    await db.$executeRawUnsafe(`UPDATE stock_levels SET "quantityMilli" = 6000 WHERE id = 'slA'`)
    const id = await byRule("coA", "STOCK_BELOW_MINIMUM")
    assert.deepEqual(ok(await svc.approveProposal(db, A, id, {}, T0)), { executed: false, obsolete: true })
    assert.equal((await db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status, "OBSOLETE")
    assert.equal(await db.assistantActionLog.count({ where: { proposalId: id, event: "OBSOLETE" } }), 1)
    assert.equal(await db.task.count(), 1)
  })
  it("approbations concurrentes d'une même proposition : une seule tâche", async () => {
    const id = await byRule("coB", "OPPORTUNITY_FOLLOW_UP_OVERDUE")
    const rs = await Promise.all([1, 2, 3].map(() => svc.approveProposal(db, B, id, {}, T0)))
    assert.equal(rs.filter((r) => r.ok).length, 1)
    assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === ASSISTANT_ERRORS.decided))
    assert.equal(await db.task.count({ where: { companyId: "coB" } }), 1)
  })
  it("module source désactivé à l'approbation : refus avant lecture de la source, proposition en attente ; reprise après réactivation", async () => {
    const oppA3 = ok(await crm.createOpportunity(db, A, { title: "Ravalement", clientId: "clA", amountCents: BigInt(30_000), nextFollowUpDate: new Date("2026-10-28T00:00:00Z") })).id
    assert.equal(ok(await svc.generateProposals(db, A, ALL, T0)).proposed, 1)
    const id = await bySource("coA", oppA3)
    const tasksBefore = await db.task.count({ where: { companyId: "coA" } })
    const logsBefore = await db.assistantActionLog.count({ where: { proposalId: id } })
    const state = () => db.assistantProposal.findUniqueOrThrow({ where: { id }, select: { status: true, decidedById: true, decidedAt: true, resultEntityId: true } })
    const pendingState = { status: "PENDING", decidedById: null, decidedAt: null, resultEntityId: null }
    // CRM désactivé (stock actif) : refus explicite, rien n'est décidé ni créé.
    assert.deepEqual(await svc.approveProposal(db, A, id, {}, T0, { crm: false, stock: true }), { ok: false, error: ASSISTANT_ERRORS.sourceDisabled })
    assert.deepEqual(await state(), pendingState)
    // Source qui ne justifierait plus l'action : toujours le refus « module désactivé », jamais « périmée » ⇒ la source
    // n'est pas relue tant que son module est désactivé.
    await db.$executeRawUnsafe(`UPDATE opportunities SET "nextFollowUpDate" = '2026-12-01' WHERE id = '${oppA3}'`)
    assert.deepEqual(await svc.approveProposal(db, A, id, {}, T0, { crm: false, stock: true }), { ok: false, error: ASSISTANT_ERRORS.sourceDisabled })
    assert.deepEqual(await state(), pendingState)
    assert.equal(await db.task.count({ where: { companyId: "coA" } }), tasksBefore)
    assert.equal(await db.assistantActionLog.count({ where: { proposalId: id } }), logsBefore, "ni décision ni journal")
    // Réactivation, source de nouveau en retard : la MÊME proposition est approuvée, une tâche créée.
    await db.$executeRawUnsafe(`UPDATE opportunities SET "nextFollowUpDate" = '2026-10-28' WHERE id = '${oppA3}'`)
    const r = ok(await svc.approveProposal(db, A, id, {}, T0, { crm: true, stock: false }))
    assert.equal(r.executed, true)
    assert.equal((await state()).status, "EXECUTED")
    assert.equal(await db.task.count({ where: { companyId: "coA" } }), tasksBefore + 1)
    assert.equal(await db.assistantActionLog.count({ where: { proposalId: id, event: "EXECUTED" } }), 1)
  })
})

describe("garanties de la base", () => {
  const ins = (extra: string, vals: string) => db.$executeRawUnsafe(`INSERT INTO assistant_proposals(id,"companyId","sourceKey",rule,provider,title,rationale,action,payload,sources,"createdById"${extra}) VALUES ('px','coA','k:x','STOCK_BELOW_MINIMUM',${vals})`)
  it("seul le fournisseur LOCAL_RULES, au moins une source, naissance en attente", async () => {
    await assert.rejects(ins("", `'EXTERNAL_LLM','Titre','Motif','CREATE_TASK','{}','[{"id":"x"}]','uA'`), /assistant_proposals_values_check/)
    await assert.rejects(ins("", `'LOCAL_RULES','Titre','Motif','CREATE_TASK','{}','[]','uA'`), /assistant_proposals_values_check/)
    await assert.rejects(ins(`,status,"decidedById","decidedAt"`, `'LOCAL_RULES','Titre','Motif','CREATE_TASK','{}','[{"id":"x"}]','uA','REJECTED','uA',now()`), /must start pending/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO assistant_proposals(id,"companyId","sourceKey",rule,provider,title,rationale,action,payload,sources,"createdById") VALUES ('py','coA','k:y','UNKNOWN_RULE','LOCAL_RULES','Titre','Motif','CREATE_TASK','{}','[{"id":"x"}]','uA')`), /assistant_proposals_values_check/, "règle hors liste fermée")
  })
  it("contenu figé, décision unique, résultat = tâche de la même entreprise, jamais supprimée ; journal immuable", async () => {
    const id = await bySource("coA", oppA1)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET title = 'Autre titre' WHERE id = '${id}'`), /content immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'REJECTED', "resultEntityType" = NULL, "resultEntityId" = NULL WHERE id = '${id}'`), /already decided/)
    await db.$executeRawUnsafe(`INSERT INTO tasks(id,"companyId",title,"createdById","updatedAt") VALUES ('tB','coB','Tâche B','uB',now())`)
    // Nouvelle observation (stock repassé sous le seuil, semaine 47) : seule proposition en attente de l'entreprise A.
    await db.$executeRawUnsafe(`UPDATE stock_levels SET "quantityMilli" = 1000 WHERE id = 'slA'`)
    assert.equal(ok(await svc.generateProposals(db, A, ALL, new Date("2026-11-20T08:00:00Z"))).proposed, 1)
    const pending = (await db.assistantProposal.findFirstOrThrow({ where: { companyId: "coA", status: "PENDING" }, select: { id: true } })).id
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'EXECUTED', "decidedById" = 'uA', "decidedAt" = now(), "resultEntityType" = 'Task', "resultEntityId" = 'tB' WHERE id = '${pending}'`), /task of the same company/)
    const taskA = (await db.task.findFirstOrThrow({ where: { companyId: "coA" }, select: { id: true } })).id
    // Valeur NULLE : exécutée sans type de résultat (tâche pourtant de la même entreprise) ⇒ refusée par le CHECK (IS NOT NULL explicite).
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'EXECUTED', "decidedById" = 'uA', "decidedAt" = now(), "resultEntityType" = NULL, "resultEntityId" = '${taskA}' WHERE id = '${pending}'`), /assistant_proposals_values_check/)
    // Formulation positive voisine : un autre type que « Task » ⇒ refusé.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'EXECUTED', "decidedById" = 'uA', "decidedAt" = now(), "resultEntityType" = 'Invoice', "resultEntityId" = '${taskA}' WHERE id = '${pending}'`), /assistant_proposals_values_check/)
    // Refusée ou périmée : sans résultat ; une décision portant un résultat ⇒ refusée.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'REJECTED', "decidedById" = 'uA', "decidedAt" = now(), "resultEntityType" = 'Task', "resultEntityId" = '${taskA}' WHERE id = '${pending}'`), /assistant_proposals_values_check/)
    // Formulation POSITIVE : exécutée avec type « Task » et tâche de la même entreprise ⇒ admise (approbation directe en base).
    await db.$executeRawUnsafe(`UPDATE assistant_proposals SET status = 'EXECUTED', "decidedById" = 'uA', "decidedAt" = now(), "resultEntityType" = 'Task', "resultEntityId" = '${taskA}' WHERE id = '${pending}'`)
    assert.equal((await db.assistantProposal.findUniqueOrThrow({ where: { id: pending }, select: { status: true } })).status, "EXECUTED")
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM assistant_proposals WHERE id = '${pending}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE assistant_action_logs SET detail = 'x'`), /lot F history immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM assistant_action_logs`), /lot F history immutable/)
  })
  it("AUCUN appel réseau pendant tout le fichier", () => {
    assert.equal(networkCalls, 0)
  })
})
