/**
 * Recette IA-6 hors production : cloisonnement de l'assistant par rôle sur une base PostgreSQL JETABLE migrée, avec les
 * VRAIES requêtes Prisma (aucune simulation de la base). Deux sociétés aux données jumelles (mêmes noms) : chaque rôle ne
 * doit voir que ses propres données, et jamais celles de l'autre société. Aucun appel réseau, aucune IA.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh copilot npm run test:copilot:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { resolveRoleContext, runRoleTool, type CopilotRole, type RoleContext } from "@/lib/copilot/copilot-roles"
import { runCopilotTool } from "@/lib/copilot/copilot-tools"
import { buildBriefing } from "@/lib/copilot/copilot-briefing"
import { reserveProposal, releaseProposal } from "@/lib/copilot/copilot-execute"
import { reserveCopilotRequest } from "@/lib/copilot/copilot-quota"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const TODAY = new Date("2026-11-24T00:00:00.000Z")
const D = (n: number) => new Date(TODAY.getTime() + n * 86_400_000)
const range = { debut: "2026-11-20", fin: "2026-12-10" }

/** Jeu de données jumeau par société (préfixe a/b) : un chef, ses deux équipiers, un employé d'une autre équipe, deux clients. */
async function seed(p: "a" | "b") {
  const companyId = `co_${p}`
  await db.company.create({ data: { id: companyId, name: `Société ${p.toUpperCase()}`, slug: `recette-${p}` } })
  const user = (id: string, role: CopilotRole, email: string) =>
    db.user.create({ data: { id: `${p}_${id}`, email: `${p}.${email}`, password: "x", role, companyId } })
  await Promise.all([
    user("admin", "ADMIN", "admin@recette.test"), user("lead", "TEAM_LEADER", "lead@recette.test"),
    user("emp", "EMPLOYEE", "emp@recette.test"), user("mate", "EMPLOYEE", "mate@recette.test"),
    user("other", "EMPLOYEE", "other@recette.test"), user("cli", "CLIENT", "cli@recette.test"),
    user("cli2", "CLIENT", "cli2@recette.test"), user("inactive", "EMPLOYEE", "inactive@recette.test"),
  ])
  const emp = (id: string, first: string, role: CopilotRole = "EMPLOYEE", active = true) =>
    db.employee.create({ data: { id: `${p}_e_${id}`, userId: `${p}_${id}`, companyId, firstName: first, lastName: p.toUpperCase(), role, active } })
  await Promise.all([emp("lead", "Lucas", "TEAM_LEADER"), emp("emp", "Emma"), emp("mate", "Malo"), emp("other", "Oscar"), emp("inactive", "Inès", "EMPLOYEE", false)])
  await db.team.create({ data: { id: `${p}_t1`, name: "Montage", companyId, leaderId: `${p}_e_lead` } })
  await db.team.create({ data: { id: `${p}_t2`, name: "Levage", companyId, leaderId: `${p}_e_other` } })
  await db.teamMember.createMany({ data: [
    { teamId: `${p}_t1`, employeeId: `${p}_e_lead` }, { teamId: `${p}_t1`, employeeId: `${p}_e_emp` }, { teamId: `${p}_t1`, employeeId: `${p}_e_mate` },
    { teamId: `${p}_t2`, employeeId: `${p}_e_other` },
  ] })
  await db.client.create({ data: { id: `${p}_c1`, name: "Mairie", companyId, email: `${p}.cli@recette.test` } })
  await db.client.create({ data: { id: `${p}_c2`, name: "Festival", companyId, email: `${p}.cli2-autre@recette.test` } })
  await db.clientProfile.create({ data: { clientId: `${p}_c1`, userId: `${p}_cli` } })
  // cli2 n'a pas de profil : repli par courriel identique (comme le portail) ⇒ client c2 si le courriel correspond.
  await db.client.update({ where: { id: `${p}_c2` }, data: { email: `${p}.cli2@recette.test` } })
  await db.worksite.create({ data: { id: `${p}_w1`, name: "Vienne", companyId, clientId: `${p}_c1`, createdById: `${p}_admin`, status: "PLANNED", startDate: D(1), endDate: D(3) } })
  await db.worksite.create({ data: { id: `${p}_w2`, name: "Lyon", companyId, clientId: `${p}_c2`, createdById: `${p}_admin`, status: "PLANNED", startDate: D(1), endDate: D(3) } })
  const a1 = await db.assignment.create({ data: { worksiteId: `${p}_w1`, teamId: `${p}_t1`, date: D(1), status: "PENDING" } })
  const a2 = await db.assignment.create({ data: { worksiteId: `${p}_w2`, teamId: `${p}_t2`, date: D(1), status: "CONFIRMED" } })
  await db.employeeAssignment.createMany({ data: [
    { assignmentId: a1.id, employeeId: `${p}_e_lead`, date: D(1) }, { assignmentId: a1.id, employeeId: `${p}_e_emp`, date: D(1) },
    { assignmentId: a1.id, employeeId: `${p}_e_mate`, date: D(1) }, { assignmentId: a2.id, employeeId: `${p}_e_other`, date: D(1) },
  ] })
  await db.absence.createMany({ data: [
    { employeeId: `${p}_e_emp`, companyId, type: "VACATION", status: "PENDING", startDate: D(5), endDate: D(6) },
    { employeeId: `${p}_e_mate`, companyId, type: "SICK", status: "APPROVED", startDate: D(2), endDate: D(2) },
    { employeeId: `${p}_e_other`, companyId, type: "TRAINING", status: "APPROVED", startDate: D(2), endDate: D(2) },
  ] })
}

async function ctx(p: "a" | "b", id: string, role: CopilotRole): Promise<RoleContext> {
  const u = await db.user.findUniqueOrThrow({ where: { id: `${p}_${id}` }, select: { id: true, email: true } })
  return resolveRoleContext(db, { id: u.id, companyId: `co_${p}`, role, email: u.email })
}
const run = async (c: RoleContext, tool: string, input: Record<string, unknown> = {}) => {
  const r = await runRoleTool(db, c, tool, input, TODAY)
  assert.ok(r.ok, `${tool} : ${JSON.stringify(r)}`)
  return r.result as Array<Record<string, unknown>>
}

before(async () => { await seed("a"); await seed("b") })
after(async () => { await db.$disconnect() })

describe("fiches liées résolues depuis la session (vraie base)", () => {
  it("employé, chef d'équipe, client par profil et client par courriel ; fiche inactive ignorée", async () => {
    assert.equal((await ctx("a", "emp", "EMPLOYEE")).employeeId, "a_e_emp")
    assert.equal((await ctx("a", "lead", "TEAM_LEADER")).employeeId, "a_e_lead")
    assert.equal((await ctx("a", "cli", "CLIENT")).clientId, "a_c1")
    assert.equal((await ctx("a", "cli2", "CLIENT")).clientId, "a_c2")
    assert.equal((await ctx("a", "inactive", "EMPLOYEE")).employeeId, null)
  })
  it("un compte de la société A présenté avec la société B ne trouve aucune fiche", async () => {
    const c = await resolveRoleContext(db, { id: "a_emp", companyId: "co_b", role: "EMPLOYEE" })
    assert.equal(c.employeeId, null)
    const cl = await resolveRoleContext(db, { id: "a_cli", companyId: "co_b", role: "CLIENT", email: "a.cli@recette.test" })
    assert.equal(cl.clientId, null)
  })
})

describe("employé : seulement lui-même", () => {
  it("son planning, ses absences ; rien des collègues ni de l'autre société", async () => {
    const c = await ctx("a", "emp", "EMPLOYEE")
    const plan = await run(c, "mon_planning", range)
    assert.deepEqual(plan.map(p => [p.date, p.chantier, p.equipe]), [["2026-11-25", "Vienne", "Montage"]])
    const abs = await run(c, "mes_absences")
    assert.deepEqual(abs.map(a => a.type), ["VACATION"])
    for (const tool of ["planning_equipe", "affectations_a_confirmer", "absences_equipe", "mes_chantiers"]) {
      assert.deepEqual(await runRoleTool(db, c, tool, range, TODAY), { ok: false, error: "Outil indisponible pour votre rôle." })
    }
  })
  it("fiche inactive : message clair, aucune donnée", async () => {
    const c = await ctx("a", "inactive", "EMPLOYEE")
    const r = await runRoleTool(db, c, "mon_planning", range, TODAY)
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /Aucune fiche employé/)
  })
})

describe("chef d'équipe : ses équipes seulement", () => {
  it("planning et affectations à confirmer de Montage, jamais Levage ni la société B", async () => {
    const c = await ctx("a", "lead", "TEAM_LEADER")
    const plan = await run(c, "planning_equipe", range)
    assert.deepEqual(plan.map(p => [p.equipe, p.chantier, p.statut]), [["Montage", "Vienne", "PENDING"]])
    const pending = await run(c, "affectations_a_confirmer")
    assert.deepEqual(pending.map(p => p.equipe), ["Montage"])
  })
  it("absences des membres de ses équipes (Malo), pas celles de l'équipe Levage (Oscar)", async () => {
    const c = await ctx("a", "lead", "TEAM_LEADER")
    const abs = await run(c, "absences_equipe", range)
    const names = abs.map(a => a.employe).sort()
    assert.deepEqual(names, ["Emma A", "Malo A"])
    assert.ok(!names.some(n => String(n).startsWith("Oscar")))
  })
})

describe("client : ses chantiers seulement", () => {
  it("Mairie voit Vienne, pas Lyon (Festival) ni les chantiers de la société B", async () => {
    const c = await ctx("a", "cli", "CLIENT")
    const ws = await run(c, "mes_chantiers")
    assert.deepEqual(ws.map(w => w.nom), ["Vienne"])
    assert.equal(ws[0].lien, "/mes-chantiers/a_w1")
    assert.deepEqual((ws[0].prochaines_interventions as Array<{ equipe: string }>).map(i => i.equipe), ["Montage"])
    for (const tool of ["mon_planning", "planning_equipe"]) assert.equal((await runRoleTool(db, c, tool, range, TODAY)).ok, false)
  })
  it("client rattaché par courriel : Festival voit Lyon seulement", async () => {
    const ws = await run(await ctx("a", "cli2", "CLIENT"), "mes_chantiers")
    assert.deepEqual(ws.map(w => w.nom), ["Lyon"])
  })
})

describe("administrateur : toute SA société, jamais l'autre", () => {
  it("planning, équipes, absences et briefing limités à la société A", async () => {
    const plan = await runCopilotTool(db, "co_a", "planning_periode", range, TODAY)
    assert.ok(plan.ok)
    const rows = (plan.result as { affectations: Array<{ lien: string }> }).affectations
    assert.equal(rows.length, 2)
    assert.ok(rows.every(r => r.lien.startsWith("/chantiers/a_")))
    const eq = await runCopilotTool(db, "co_a", "equipes", {}, TODAY)
    assert.ok(eq.ok && (eq.result as { employes_actifs: number }).employes_actifs === 4)
    const b = await buildBriefing(db, "co_a", TODAY)
    assert.ok(b.alerts.some(a => a.id === "absences"))
    const absAlert = b.alerts.find(a => a.id === "absences")!
    assert.match(absAlert.title, /^1 demande/)
  })
})

describe("garde-fous partagés (vraie base)", () => {
  it("une proposition confirmée deux fois en même temps ne s'exécute qu'une fois ; libérée, elle redevient possible", async () => {
    const input = { companyId: "co_a", actorId: "a_admin", nonce: "nonce-recette-1", kind: "TASK" }
    const results = await Promise.all([reserveProposal(db, input), reserveProposal(db, input), reserveProposal(db, input)])
    assert.deepEqual(results.filter(Boolean).length, 1)
    await releaseProposal(db, { companyId: "co_a", nonce: "nonce-recette-1" })
    assert.equal(await reserveProposal(db, input), true)
  })
  it("quota quotidien par société : la société B n'entame pas celui de A", async () => {
    const a = await Promise.all(Array.from({ length: 5 }, () => reserveCopilotRequest(db, { companyId: "co_a", actorId: "a_admin", dailyLimit: 3 })))
    assert.equal(a.filter(Boolean).length, 3)
    assert.equal(await reserveCopilotRequest(db, { companyId: "co_b", actorId: "b_admin", dailyLimit: 3 }), true)
  })
})
