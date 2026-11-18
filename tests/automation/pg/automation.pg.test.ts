/**
 * Lot E Planificator V2 : automatisations sur une base PostgreSQL JETABLE. Brouillon inactif, approbation, une seule
 * exécution par événement (reprise et exécuteurs concurrents), événements datés antérieurs à l'activation ignorés,
 * arriéré de relances échues traité une seule fois (portée explicite, ACTIVATION_SCOPE),
 * désactivation immédiate, action ignorée journalisée, configuration et journal immuables, isolation, et AUCUN envoi
 * externe (les seules écritures sont des tâches et des notifications internes).
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh automation npm run test:automation:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as auto from "@/lib/automation/automation.service"
import * as crm from "@/lib/crm/crm.service"
import { AUTOMATION_ERRORS } from "@/lib/automation/automation.core"

// Les scénarios historiques supposent le pipeline commercial actif ; le cas « pipeline désactivé » passe crmEnabled: false.
process.env.CRM_OPPORTUNITIES_ENABLED = "true"
const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const T0 = new Date("2026-11-04T08:00:00Z")
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
let opp = "", stageRule = "", notifyRule = ""
/**
 * Attend un entrelacement RÉEL corrélé au scénario (revue coordinateur v3) : une session de CETTE base, autre que la
 * transaction détentrice `holderPid`, est en attente de verrou (`wait_event_type = 'Lock'`), BLOQUÉE PAR `holderPid`
 * (`pg_blocking_pids`), et sa requête correspond au motif attendu (`_` échappé : littéral). Aucun minutage arbitraire.
 */
async function waitLockWaiter(holderPid: number, motif: string) {
  for (let i = 0; i < 400; i++) {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> ${holderPid} AND wait_event_type = 'Lock' AND ${holderPid}::int = ANY(pg_blocking_pids(pid)) AND query ILIKE ${motif}`
    if (n >= 1) return
    await new Promise((x) => setTimeout(x, 25))
  }
  throw new Error(`aucune session bloquée par la transaction ${holderPid} sur « ${motif} » : entrelacement non obtenu`)
}
const pidOf = async (tx: { $queryRaw: PrismaClient["$queryRaw"] }) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid
const SUR_REGLE = "%automation\\_rules%for share%"
const SUR_JOURNAL = "%insert%automation\\_runs%"
async function quoteRule(name: string) {
  const id = ok(await auto.createRule(db, A, { name, trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Devis {numero}" })).id
  ok(await auto.approveAndActivate(db, A, id))
  await new Promise((x) => setTimeout(x, 20))
  return id
}
const notesOf = (ruleId: string) => db.notification.count({ where: { type: "AUTOMATION", metadata: { path: ["ruleId"], equals: ruleId } } })

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uA2','a2@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','Durand',now()),('clB','coB','Client B',now())`,
    `INSERT INTO employees(id,"userId","companyId","firstName","lastName",role,"updatedAt") VALUES ('eA','uA','coA','Ana','Martin','ADMIN',now()),('eA2','uA2','coA','Léo','Petit','EMPLOYEE',now()),('eB','uB','coB','Bob','Durand','ADMIN',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  opp = ok(await crm.createOpportunity(db, A, { title: "Façade", clientId: "clA", amountCents: BigInt(100_000) })).id
  // Changement d'étape ANTÉRIEUR à l'activation : ne doit jamais déclencher.
  ok(await crm.changeStage(db, A, opp, "QUALIFIED", null))
})
after(() => db.$disconnect())

describe("règles", () => {
  it("brouillon : aucune exécution ; responsable d'une autre entreprise refusé", async () => {
    stageRule = ok(await auto.createRule(db, A, { name: "Suivi proposition", trigger: "OPPORTUNITY_STAGE_CHANGED", stageFilter: "PROPOSAL", action: "CREATE_TASK", taskTitle: "Préparer le devis {numero} pour {client}", taskAssigneeId: "eA2", taskDueInDays: 3 })).id
    assert.deepEqual(await auto.createRule(db, A, { name: "Règle", trigger: "QUOTE_ACCEPTED", action: "CREATE_TASK", taskTitle: "Tâche", taskAssigneeId: "eB" }), { ok: false, error: AUTOMATION_ERRORS.notFound })
    ok(await crm.changeStage(db, A, opp, "PROPOSAL", null))
    assert.deepEqual(await auto.runAutomations(db), { rules: 0, done: 0, skipped: 0, duplicates: 0, errors: 0 })
    assert.equal(await db.task.count(), 0)
  })
  it("approbation : seuls les événements postérieurs déclenchent ; une seule tâche par événement, même relancé", async () => {
    ok(await auto.approveAndActivate(db, A, stageRule, new Date()))
    await new Promise((r) => setTimeout(r, 20))
    ok(await crm.changeStage(db, A, opp, "NEGOTIATION", null)) // ne correspond pas au filtre « vers proposition »
    ok(await crm.changeStage(db, A, opp, "LOST", "Abandon du projet"))
    const other = ok(await crm.createOpportunity(db, A, { title: "Toiture", clientId: "clA", amountCents: BigInt(50_000) })).id
    ok(await crm.changeStage(db, A, other, "PROPOSAL", null))
    const s1 = await auto.runAutomations(db)
    assert.deepEqual([s1.rules, s1.done], [1, 1], "un seul événement « vers proposition » postérieur à l'activation")
    const tasks = await db.task.findMany({ select: { title: true, assigneeId: true, companyId: true, createdById: true } })
    assert.equal(tasks.length, 1)
    assert.match(tasks[0].title, /^Préparer le devis OPP-\d{4}-0002 pour Durand$/)
    assert.deepEqual([tasks[0].assigneeId, tasks[0].companyId, tasks[0].createdById], ["eA2", "coA", "uA"])
    assert.deepEqual(await auto.runAutomations(db), { rules: 1, done: 0, skipped: 0, duplicates: 0, errors: 0 }, "reprise : rien de nouveau")
    assert.equal(await db.task.count(), 1)
  })
  it("exécuteurs concurrents : jamais deux actions pour un même événement", async () => {
    const third = ok(await crm.createOpportunity(db, A, { title: "Isolation", clientId: "clA", amountCents: BigInt(10_000) })).id
    ok(await crm.changeStage(db, A, third, "PROPOSAL", null))
    const [r1, r2, r3] = await Promise.all([auto.runAutomations(db), auto.runAutomations(db), auto.runAutomations(db)])
    assert.equal(r1.done + r2.done + r3.done, 1)
    assert.equal(await db.task.count(), 2)
    assert.equal(await db.automationRun.count({ where: { ruleId: stageRule } }), 2)
  })
  it("désactivation immédiate : plus aucune exécution ; réactivation sans rattrapage de la période désactivée", async () => {
    ok(await auto.disableRule(db, A, stageRule))
    const fourth = ok(await crm.createOpportunity(db, A, { title: "Peinture", clientId: "clA", amountCents: BigInt(10_000) })).id
    ok(await crm.changeStage(db, A, fourth, "PROPOSAL", null))
    assert.equal((await auto.runAutomations(db)).done, 0)
    await new Promise((r) => setTimeout(r, 20))
    ok(await auto.approveAndActivate(db, A, stageRule, new Date()))
    assert.equal((await auto.runAutomations(db)).done, 0, "l'événement de la période désactivée n'est pas rattrapé")
    assert.equal(await db.task.count(), 2)
    ok(await auto.disableRule(db, A, stageRule))
    assert.deepEqual(await auto.disableRule(db, A, stageRule), { ok: false, error: AUTOMATION_ERRORS.notActive })
  })
  it("notification interne des seuls administrateurs actifs de l'entreprise ; relance due ; journal", async () => {
    notifyRule = ok(await auto.createRule(db, A, { name: "Relances dues", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "NOTIFY_ADMINS", message: "Relancer {client} ({numero}) prévu le {date}" })).id
    ok(await auto.approveAndActivate(db, A, notifyRule))
    const due = ok(await crm.createOpportunity(db, A, { title: "Relance", clientId: "clA", amountCents: BigInt(1), nextFollowUpDate: new Date("2026-11-01T00:00:00Z") })).id
    const s = await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(s.done, 1)
    const notes = await db.notification.findMany({ select: { userId: true, companyId: true, type: true, message: true, link: true } })
    assert.deepEqual(notes.map((n) => [n.userId, n.companyId, n.type, n.link]), [["uA", "coA", "AUTOMATION", `/crm/opportunites/${due}`]], "salarié non administrateur et entreprise B exclus")
    assert.match(notes[0].message, /^Relancer Durand \(OPP-\d{4}-\d{4}\) prévu le 2026-11-01$/)
    assert.equal((await auto.runAutomations(db, { companyId: "coA" }, T0)).done, 0, "même échéance : une seule notification")
  })
  it("action impossible (responsable devenu inactif) : journalisée « ignorée », non rejouée", async () => {
    const r = ok(await auto.createRule(db, A, { name: "Tâche relance", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "CREATE_TASK", taskTitle: "Relancer {client}", taskAssigneeId: "eA2" })).id
    ok(await auto.approveAndActivate(db, A, r))
    await db.employee.update({ where: { id: "eA2" }, data: { active: false } })
    const s = await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(s.skipped, 1)
    const run = await db.automationRun.findFirst({ where: { ruleId: r }, select: { status: true, detail: true, taskId: true } })
    assert.deepEqual(run, { status: "SKIPPED", detail: AUTOMATION_ERRORS.assigneeInactive, taskId: null })
    assert.equal((await auto.runAutomations(db, { companyId: "coA" }, T0)).skipped, 0)
  })
  it("double passage à la même étape : deux événements distincts ⇒ deux exécutions", async () => {
    const r = ok(await auto.createRule(db, A, { name: "Chaque proposition", trigger: "OPPORTUNITY_STAGE_CHANGED", stageFilter: "PROPOSAL", action: "NOTIFY_ADMINS", message: "Proposition {numero}" })).id
    ok(await auto.approveAndActivate(db, A, r, new Date()))
    await new Promise((x) => setTimeout(x, 20))
    const o = ok(await crm.createOpportunity(db, A, { title: "Allers-retours", clientId: "clA", amountCents: BigInt(1) })).id
    ok(await crm.changeStage(db, A, o, "PROPOSAL", null))
    ok(await crm.changeStage(db, A, o, "NEGOTIATION", null))
    ok(await crm.changeStage(db, A, o, "PROPOSAL", null))
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r, status: "DONE" } }), 2)
    ok(await auto.disableRule(db, A, r))
  })
  it("devis accepté : une exécution par occurrence, sans rattrapage antérieur à l'activation ; déclencheur réserve refusé (lot D absent de main)", async () => {
    await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Chantier A',now())`)
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qOld','coA','wA','clA','DEV-OLD','ACCEPTED',now() - interval '1 day','uA',now())`)
    const q = ok(await auto.createRule(db, A, { name: "Devis accepté", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Devis {numero} accepté par {client} ({chantier})" })).id
    ok(await auto.approveAndActivate(db, A, q, new Date()))
    await new Promise((x) => setTimeout(x, 20))
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qNew','coA','wA','clA','DEV-NEW','ACCEPTED',now(),'uA',now())`)
    const refus = await auto.createRule(db, A, { name: "Réserve en retard", trigger: "RESERVE_OVERDUE", action: "NOTIFY_ADMINS", message: "Réserve {numero} en retard" })
    assert.equal(refus.ok, false, "déclencheur retiré sur main : refusé par la validation")
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    const qRuns = await db.automationRun.findMany({ where: { ruleId: q }, select: { eventKey: true } })
    assert.deepEqual(qRuns.map((r) => r.eventKey.split(":")[1]), ["qNew"], "devis accepté avant l'activation ignoré ; un seul passage")
    assert.ok((await db.notification.findMany({ where: { type: "AUTOMATION" }, select: { message: true } })).some((n) => n.message === "Devis DEV-NEW accepté par Durand (Chantier A)"))
    ok(await auto.disableRule(db, A, q))
  })
  it("pipeline commercial désactivé : déclencheurs d'opportunité ni créés, ni approuvés, ni exécutés ; devis accepté inchangé", async () => {
    assert.deepEqual(await auto.createRule(db, A, { name: "Sans CRM", trigger: "OPPORTUNITY_STAGE_CHANGED", action: "NOTIFY_ADMINS", message: "Étape {etape}" }, false), { ok: false, error: AUTOMATION_ERRORS.triggerUnavailable })
    const draft = ok(await auto.createRule(db, A, { name: "Brouillon relance", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "NOTIFY_ADMINS", message: "Relance {numero}" }, true)).id
    assert.deepEqual(await auto.approveAndActivate(db, A, draft, new Date(), false), { ok: false, error: AUTOMATION_ERRORS.triggerUnavailable })
    assert.equal((await db.automationRule.findUnique({ where: { id: draft }, select: { status: true } }))?.status, "DRAFT")
    const opRule = ok(await auto.createRule(db, A, { name: "Étape (CRM)", trigger: "OPPORTUNITY_STAGE_CHANGED", action: "NOTIFY_ADMINS", message: "Étape {etape}" })).id
    ok(await auto.approveAndActivate(db, A, opRule, new Date()))
    const qRule = ok(await auto.createRule(db, A, { name: "Devis (sans CRM)", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Devis {numero}" }, false)).id
    ok(await auto.approveAndActivate(db, A, qRule, new Date(), false))
    await new Promise((x) => setTimeout(x, 20))
    const o = ok(await crm.createOpportunity(db, A, { title: "Hors pipeline", clientId: "clA", amountCents: BigInt(1) })).id
    ok(await crm.changeStage(db, A, o, "QUALIFIED", null))
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qFlag','coA','wA','clA','DEV-FLAG','ACCEPTED',now(),'uA',now())`)
    const s = await auto.runAutomations(db, { companyId: "coA", crmEnabled: false }, T0)
    assert.equal(s.rules, 1, "seule la règle « devis accepté » est exécutable")
    assert.equal(await db.automationRun.count({ where: { ruleId: opRule } }), 0, "aucun journal : la règle d'opportunité attend")
    assert.deepEqual((await db.automationRun.findMany({ where: { ruleId: qRule }, select: { eventKey: true } })).map((r) => r.eventKey.split(":")[1]), ["qFlag"])
    const back = await auto.runAutomations(db, { companyId: "coA", crmEnabled: true }, T0)
    assert.ok(back.done >= 1, "pipeline réactivé : l'événement postérieur à l'approbation est traité")
    assert.equal(await db.automationRun.count({ where: { ruleId: opRule } }), 1)
    ok(await auto.disableRule(db, A, opRule))
    ok(await auto.disableRule(db, A, qRule))
  })
  it("désactivation concurrente d'une passe : action et journal restent atomiques ; rien après la désactivation", async () => {
    const r = ok(await auto.createRule(db, A, { name: "Qualifiées (concurrence)", trigger: "OPPORTUNITY_STAGE_CHANGED", stageFilter: "QUALIFIED", action: "NOTIFY_ADMINS", message: "Qualifiée {numero}" })).id
    ok(await auto.approveAndActivate(db, A, r, new Date()))
    await new Promise((x) => setTimeout(x, 20))
    for (let i = 0; i < 40; i++) {
      const o = ok(await crm.createOpportunity(db, A, { title: `Lot ${i}`, clientId: "clA", amountCents: BigInt(1) })).id
      ok(await crm.changeStage(db, A, o, "QUALIFIED", null))
    }
    const pass = auto.runAutomations(db, { companyId: "coA" }, T0)
    await new Promise((x) => setTimeout(x, 5))
    ok(await auto.disableRule(db, A, r))
    const s = await pass
    const runs = await db.automationRun.findMany({ where: { ruleId: r }, select: { eventKey: true, status: true } })
    const notes = await db.notification.findMany({ where: { type: "AUTOMATION", metadata: { path: ["ruleId"], equals: r } }, select: { metadata: true } })
    assert.ok(runs.length <= 40)
    assert.deepEqual(notes.map((n) => (n.metadata as { eventKey: string }).eventKey).sort(), runs.filter((x) => x.status === "DONE").map((x) => x.eventKey).sort(), "une notification par exécution journalisée, ni plus ni moins")
    assert.equal(new Set(runs.map((x) => x.eventKey)).size, runs.length, "jamais deux exécutions pour un événement")
    assert.ok(s.errors === 0)
    const after = await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), runs.length, "règle désactivée : plus aucune exécution")
    assert.equal(after.duplicates, 0)
  })
  it("entrelacement réel : désactivation validée pendant que l'exécuteur attend le verrou ⇒ aucune action, aucun journal", async () => {
    const r = await quoteRule("Devis (verrou désactivation)")
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qLock1','coA','wA','clA','DEV-LOCK-1','ACCEPTED',now(),'uA',now())`)
    let pass: Promise<auto.RunSummary> | undefined
    await db.$transaction(async (tx) => {
      const holder = await pidOf(tx)
      await tx.$executeRawUnsafe(`UPDATE automation_rules SET status = 'DISABLED', "disabledAt" = now(), "approvedById" = NULL, "approvedAt" = NULL WHERE id = '${r}'`)
      pass = auto.runAutomations(db, { companyId: "coA" }, T0)
      await waitLockWaiter(holder, SUR_REGLE)
    }, { timeout: 20_000 })
    const s = await pass!
    assert.equal(s.errors, 0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 0)
    assert.equal(await notesOf(r), 0)
  })
  it("entrelacement réel : désactivation puis réapprobation validées pendant l'attente ⇒ occurrences de l'ancienne approbation abandonnées", async () => {
    const r = await quoteRule("Devis (verrou réapprobation)")
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qLock2','coA','wA','clA','DEV-LOCK-2','ACCEPTED',now(),'uA',now())`)
    await new Promise((x) => setTimeout(x, 20))
    let pass: Promise<auto.RunSummary> | undefined
    await db.$transaction(async (tx) => {
      const holder = await pidOf(tx)
      await tx.$executeRawUnsafe(`UPDATE automation_rules SET status = 'DISABLED', "disabledAt" = now(), "approvedById" = NULL, "approvedAt" = NULL WHERE id = '${r}'`)
      await tx.$executeRawUnsafe(`UPDATE automation_rules SET status = 'ACTIVE', "disabledAt" = NULL, "approvedById" = 'uA', "approvedAt" = clock_timestamp(), "activatedAt" = clock_timestamp() WHERE id = '${r}'`)
      pass = auto.runAutomations(db, { companyId: "coA" }, T0)
      await waitLockWaiter(holder, SUR_REGLE)
    }, { timeout: 20_000 })
    await pass!
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 0, "aucune exécution sous l'ancienne approbation")
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 0, "devis accepté avant la nouvelle approbation : jamais rattrapé")
    ok(await auto.disableRule(db, A, r))
  })
  it("entrelacement réel : exécuteur perdant sur la clé (société, règle, événement) ⇒ son action est annulée avec la transaction", async () => {
    const r = await quoteRule("Devis (verrou doublon)")
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qLock3','coA','wA','clA','DEV-LOCK-3','ACCEPTED',now(),'uA',now())`)
    const q = await db.quote.findUniqueOrThrow({ where: { id: "qLock3" }, select: { acceptedAt: true } })
    const key = `qa:qLock3:${q.acceptedAt!.toISOString()}`
    let pass: Promise<auto.RunSummary> | undefined
    await db.$transaction(async (tx) => {
      const holder = await pidOf(tx)
      await tx.$executeRawUnsafe(`INSERT INTO automation_runs(id,"companyId","ruleId","eventKey",status,detail) VALUES ('runConcurrent','coA','${r}','${key}','SKIPPED','exécuteur concurrent simulé')`)
      pass = auto.runAutomations(db, { companyId: "coA" }, T0)
      await waitLockWaiter(holder, SUR_JOURNAL)
    }, { timeout: 20_000 })
    const s = await pass!
    assert.equal(s.duplicates, 1)
    assert.equal(await notesOf(r), 0, "notification du perdant annulée")
    assert.deepEqual((await db.automationRun.findMany({ where: { ruleId: r }, select: { id: true } })).map((x) => x.id), ["runConcurrent"])
    ok(await auto.disableRule(db, A, r))
  })
  it("progression : 201 occurrences ⇒ 200 puis 1, puis rien (aucune famine au-delà de la limite par passe)", async () => {
    const r = await quoteRule("Devis (201 occurrences)")
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") SELECT 'qMany' || g, 'coA', 'wA', 'clA', 'DEV-MANY-' || g, 'ACCEPTED', now(), 'uA', now() FROM generate_series(1, 201) g`)
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 200)
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 201, "le 201e est traité à la passe suivante")
    await auto.runAutomations(db, { companyId: "coA" }, T0)
    assert.equal(await db.automationRun.count({ where: { ruleId: r } }), 201)
    assert.equal(await notesOf(r), 201)
    ok(await auto.disableRule(db, A, r))
  })
  it("plus de 500 règles actives : aucune famine ; 501 règles d'opportunité indisponibles ne masquent pas « devis accepté »", async () => {
    await db.$executeRawUnsafe(`INSERT INTO automation_rules(id,"companyId",name,trigger,action,message,status,"approvedById","approvedAt","activatedAt","createdById","updatedAt") SELECT 'r0many' || lpad(g::text, 4, '0'), 'coA', 'Masse ' || g, 'OPPORTUNITY_STAGE_CHANGED', 'NOTIFY_ADMINS', 'Étape {etape}', 'ACTIVE', 'uA', now(), now(), 'uA', now() FROM generate_series(1, 501) g`)
    await db.$executeRawUnsafe(`INSERT INTO automation_rules(id,"companyId",name,trigger,action,message,status,"approvedById","approvedAt","activatedAt","createdById","updatedAt") VALUES ('rzzQuote','coA','Devis après la masse','QUOTE_ACCEPTED','NOTIFY_ADMINS','Devis {numero}','ACTIVE','uA',now(),now(),'uA',now())`)
    await new Promise((x) => setTimeout(x, 20))
    await db.$executeRawUnsafe(`INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"acceptedAt","createdById","updatedAt") VALUES ('qMass','coA','wA','clA','DEV-MASS','ACCEPTED',now(),'uA',now())`)
    const off = await auto.runAutomations(db, { companyId: "coA", crmEnabled: false }, T0)
    assert.equal(off.rules, 1, "pipeline désactivé : seule la règle « devis accepté » est sélectionnée")
    assert.equal(await db.automationRun.count({ where: { ruleId: "rzzQuote" } }), 1)
    const on = await auto.runAutomations(db, { companyId: "coA", crmEnabled: true }, T0)
    assert.ok(on.rules >= 502, `toutes les règles actives parcourues (${on.rules})`)
    assert.equal(await db.automationRun.count({ where: { ruleId: "rzzQuote" } }), 1, "reprise : aucun doublon")
    await db.$executeRawUnsafe(`UPDATE automation_rules SET status = 'DISABLED', "disabledAt" = now(), "approvedById" = NULL, "approvedAt" = NULL WHERE id LIKE 'r0many%' OR id = 'rzzQuote'`)
  })
  it("base : configuration figée, journal immuable, aucune exécution pour une règle inactive, jamais supprimée", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE automation_rules SET message = 'Autre message' WHERE id = '${notifyRule}'`), /configuration immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE automation_rules SET status = 'DRAFT' WHERE id = '${notifyRule}'`), /transition not allowed/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE automation_runs SET detail = 'x'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM automation_rules WHERE id = '${stageRule}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO automation_runs(id,"companyId","ruleId","eventKey",status,detail) VALUES ('rx','coA','${stageRule}','manuel:1','DONE','x')`), /not active/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE automation_rules SET status = 'ACTIVE' WHERE id = '${stageRule}'`), /automation_rules_values_check|approvedById/i, "réactivation hors service : approbation exigée par la base")
  })
  it("isolation : l'entreprise B ne voit, n'active ni ne déclenche rien de A", async () => {
    assert.deepEqual(await auto.approveAndActivate(db, B, stageRule), { ok: false, error: AUTOMATION_ERRORS.notFound })
    assert.deepEqual(await auto.disableRule(db, B, notifyRule), { ok: false, error: AUTOMATION_ERRORS.notFound }, "identifiant d'une autre entreprise : introuvable")
    assert.equal((await db.automationRule.findUnique({ where: { id: notifyRule }, select: { status: true } }))?.status, "ACTIVE")
    assert.deepEqual(await auto.runAutomations(db, { companyId: "coB" }, T0), { rules: 0, done: 0, skipped: 0, duplicates: 0, errors: 0 })
    assert.equal(await db.notification.count({ where: { companyId: "coB" } }), 0)
  })
  it("relance due : l'arriéré déjà échu à l'activation est traité UNE fois ; réapprobation sans rejeu, échéance non traitée reprise (ACTIVATION_SCOPE)", async () => {
    const before = ok(await crm.createOpportunity(db, B, { title: "Arriéré B", clientId: "clB", amountCents: BigInt(1), nextFollowUpDate: new Date("2026-11-01T00:00:00Z") })).id
    const future = ok(await crm.createOpportunity(db, B, { title: "Future B", clientId: "clB", amountCents: BigInt(1), nextFollowUpDate: new Date("2026-11-20T00:00:00Z") })).id
    const r = ok(await auto.createRule(db, B, { name: "Relances B", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "NOTIFY_ADMINS", message: "Relancer {numero} prévu le {date}" })).id
    ok(await auto.approveAndActivate(db, B, r))
    assert.equal((await auto.runAutomations(db, { companyId: "coB" }, T0)).done, 1, "arriéré échu avant l'activation : traité à la première passe")
    assert.equal((await auto.runAutomations(db, { companyId: "coB" }, T0)).done, 0, "même opportunité, même date : jamais rejouée")
    ok(await auto.disableRule(db, B, r))
    const during = ok(await crm.createOpportunity(db, B, { title: "Pendant la désactivation", clientId: "clB", amountCents: BigInt(1), nextFollowUpDate: new Date("2026-11-02T00:00:00Z") })).id
    assert.equal((await auto.runAutomations(db, { companyId: "coB" }, T0)).done, 0, "règle désactivée : rien")
    ok(await auto.approveAndActivate(db, B, r))
    assert.equal((await auto.runAutomations(db, { companyId: "coB" }, T0)).done, 1, "réapprobation : seule l'échéance non encore traitée déclenche")
    const keys = (await db.automationRun.findMany({ where: { ruleId: r }, select: { eventKey: true }, orderBy: { createdAt: "asc" } })).map((x) => x.eventKey)
    assert.deepEqual(keys, [`ofu:${before}:2026-11-01`, `ofu:${during}:2026-11-02`], `relance future (${future}) non échue : ignorée`)
    assert.equal(await db.notification.count({ where: { companyId: "coB", type: "AUTOMATION" } }), 2)
    assert.equal(await db.notification.count({ where: { companyId: "coA", metadata: { path: ["ruleId"], equals: r } } }), 0, "aucune notification hors de l'entreprise B")
    ok(await auto.disableRule(db, B, r))
  })
})
