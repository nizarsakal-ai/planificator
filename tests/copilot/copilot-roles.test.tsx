/** IA-6 : rôles (employé, chef d'équipe, client) limités à leurs droits, ouverture progressive, rôle maître et expert. */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
import { allowedCopilotRoles, isCopilotRoleAllowed, resolveRoleContext, runRoleTool, ROLE_TOOLS, type RoleContext } from "@/lib/copilot/copilot-roles"
import { EXPERT_MODEL, EXPERTS, parseExpertInput } from "@/lib/copilot/copilot-expert"
import { buildSystemPrompt, runCopilot } from "@/lib/copilot/copilot.core"
import { isCopilotExpertEnabled } from "@/lib/copilot/copilot-config"
import { INTRO, SUGGESTIONS } from "@/components/copilot/CopilotPanel"

const TODAY = new Date("2026-11-24T00:00:00.000Z")
const EMP: RoleContext = { role: "EMPLOYEE", companyId: "co1", userId: "u1", employeeId: "e1", clientId: null }
const LEAD: RoleContext = { ...EMP, role: "TEAM_LEADER" }
const CLI: RoleContext = { role: "CLIENT", companyId: "co1", userId: "u9", employeeId: null, clientId: "c1" }

describe("ouverture progressive", () => {
  it("administration seule par défaut, liste explicite sinon, rôles inconnus ignorés", () => {
    assert.deepEqual([...allowedCopilotRoles({})].sort(), ["ADMIN", "SUPER_ADMIN"])
    assert.deepEqual([...allowedCopilotRoles({ COPILOT_ROLES: "admin, team_leader,EMPLOYEE,ROOT" })].sort(), ["ADMIN", "EMPLOYEE", "TEAM_LEADER"])
    assert.equal(isCopilotRoleAllowed("CLIENT", {}), false)
    assert.equal(isCopilotRoleAllowed("CLIENT", { COPILOT_ROLES: "ADMIN,CLIENT" }), true)
    assert.equal(isCopilotExpertEnabled({ COPILOT_EXPERT_ENABLED: "true" }), true)
    assert.equal(isCopilotExpertEnabled({}), false)
  })
})

describe("fiches liées résolues côté serveur", () => {
  const db = {
    employee: { findFirst: async (a: { where: Record<string, unknown> }) => (a.where.userId === "u1" && a.where.companyId === "co1" && a.where.active === true ? { id: "e1" } : null) },
    clientProfile: { findFirst: async (a: { where: { userId: string } }) => (a.where.userId === "u9" ? { clientId: "c1" } : null) },
    client: { findFirst: async (a: { where: Record<string, unknown> }) => (a.where.email === "x@y.fr" && a.where.companyId === "co1" ? { id: "c2" } : null) },
  } as never
  it("employé, client par profil, client par courriel (repli du portail)", async () => {
    assert.equal((await resolveRoleContext(db, { id: "u1", companyId: "co1", role: "EMPLOYEE" })).employeeId, "e1")
    assert.equal((await resolveRoleContext(db, { id: "u1", companyId: "co2", role: "EMPLOYEE" })).employeeId, null)
    assert.equal((await resolveRoleContext(db, { id: "u9", companyId: "co1", role: "CLIENT" })).clientId, "c1")
    assert.equal((await resolveRoleContext(db, { id: "u8", companyId: "co1", role: "CLIENT", email: "x@y.fr" })).clientId, "c2")
  })
})

function roleDb() {
  const calls: Array<{ model: string; args: Record<string, unknown> }> = []
  const m = (model: string, rows: unknown[]) => ({ findMany: async (args: Record<string, unknown>) => { calls.push({ model, args }); return rows } })
  const db = {
    employeeAssignment: m("employeeAssignment", [{ date: TODAY, assignment: { status: "CONFIRMED", team: { name: "Montage" }, worksite: { name: "Vienne", address: "1 rue" } } }]),
    absence: m("absence", [{ type: "VACATION", status: "PENDING", startDate: TODAY, endDate: TODAY, employee: { firstName: "Léa", lastName: "M" } }]),
    assignment: m("assignment", [{ date: TODAY, status: "PENDING", team: { name: "Montage" }, worksite: { name: "Vienne", address: null } }]),
    teamMember: m("teamMember", [{ employeeId: "e2" }, { employeeId: "e3" }]),
    worksite: m("worksite", [{ id: "w1", name: "Vienne", status: "PLANNED", startDate: TODAY, endDate: null, address: "1 rue", assignments: [{ date: TODAY, team: { name: "Montage" } }] }]),
  }
  return { db: db as never, calls }
}

describe("outils limités au rôle", () => {
  it("employé : seulement son planning et ses absences, filtrés sur SA fiche et SA société", async () => {
    assert.deepEqual(ROLE_TOOLS.EMPLOYEE.map(t => t.name), ["mon_planning", "mes_absences"])
    const { db, calls } = roleDb()
    const r = await runRoleTool(db, EMP, "mon_planning", { debut: "2026-11-24", fin: "2026-11-30" }, TODAY)
    assert.ok(r.ok)
    assert.deepEqual((r.result as Array<{ chantier: string }>)[0].chantier, "Vienne")
    const where = JSON.stringify(calls[0].args.where)
    assert.ok(where.includes('"employeeId":"e1"') && where.includes('"companyId":"co1"'))
    assert.deepEqual(await runRoleTool(db, EMP, "planning_equipe", { debut: "2026-11-24", fin: "2026-11-30" }, TODAY), { ok: false, error: "Outil indisponible pour votre rôle." })
    assert.deepEqual(await runRoleTool(db, EMP, "mes_chantiers", {}, TODAY), { ok: false, error: "Outil indisponible pour votre rôle." })
  })
  it("chef d'équipe : équipes qu'il dirige seulement", async () => {
    const { db, calls } = roleDb()
    await runRoleTool(db, LEAD, "affectations_a_confirmer", {}, TODAY)
    assert.ok(JSON.stringify(calls[0].args.where).includes('"leaderId":"e1"'))
    const abs = await runRoleTool(db, LEAD, "absences_equipe", { debut: "2026-11-24", fin: "2026-11-30" }, TODAY)
    assert.ok(abs.ok)
    assert.ok(JSON.stringify(calls[2].args.where).includes('"in":["e2","e3"]'))
  })
  it("client : seulement ses chantiers ; sans fiche liée, message clair", async () => {
    const { db, calls } = roleDb()
    const r = await runRoleTool(db, CLI, "mes_chantiers", {}, TODAY)
    assert.ok(r.ok)
    assert.equal((r.result as Array<{ lien: string }>)[0].lien, "/mes-chantiers/w1")
    const where = JSON.stringify(calls[0].args.where)
    assert.ok(where.includes('"clientId":"c1"') && where.includes('"companyId":"co1"'))
    const none = await runRoleTool(db, { ...CLI, clientId: null }, "mes_chantiers", {}, TODAY)
    assert.equal(none.ok, false)
    assert.equal((await runRoleTool(db, { ...EMP, employeeId: null }, "mes_absences", {}, TODAY)).ok, false)
  })
})

describe("boucle selon le rôle", () => {
  it("un employé ne reçoit que ses outils ; un outil de la société demandé est refusé", async () => {
    const { db } = roleDb()
    const bodies: Array<{ tools: Array<{ name: string }>; messages: Array<{ content: unknown }> }> = []
    const queue = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "factures", input: { filtre: "impayees" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Je ne peux pas." }] },
    ]
    const client = { messagesCreate: async (b: { tools: Array<{ name: string }>; messages: Array<{ content: unknown }> }) => { bodies.push(structuredClone(b)); return queue.shift() } }
    await runCopilot(client as never, db, { history: [{ role: "user", text: "Factures ?" }], system: "s", companyId: "co1", today: TODAY, role: EMP })
    assert.deepEqual(bodies[0].tools.map(t => t.name), ["mon_planning", "mes_absences"])
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /Outil indisponible pour votre rôle/)
  })
  it("prompt adapté : employé et client, sans briefing ni actions", () => {
    const e = buildSystemPrompt({ userName: "Léa", companyName: "Galya", today: "2026-11-24", page: "/", actions: true, role: "EMPLOYEE" })
    assert.match(e, /Léa, employé de la société Galya/)
    assert.doesNotMatch(e, /briefing_du_jour|proposer_/)
    const c = buildSystemPrompt({ userName: "M. Dupont", companyName: "Galya", today: "2026-11-24", page: "/", role: "CLIENT" })
    assert.match(c, /client de Galya/)
    assert.match(c, /Ne parle jamais d'autres clients/)
  })
})

describe("rôle maître et expert", () => {
  const adminRole: RoleContext = { role: "ADMIN", companyId: "co1", userId: "u0", employeeId: null, clientId: null }
  const fakeDbAdmin = { assignment: { findMany: async () => [] }, absence: { findMany: async () => [] }, team: { findMany: async () => [] } } as never

  it("entrée de l'expert validée", () => {
    assert.deepEqual(parseExpertInput({ domaine: "planning", question: "Organise la semaine 49" }), { domain: "planning", question: "Organise la semaine 49" })
    assert.ok("error" in parseExpertInput({ domaine: "juridique", question: "Organise" }))
    assert.ok("error" in parseExpertInput({ domaine: "planning", question: "?" }))
  })
  it("le maître consulte l'expert (modèle plus puissant, outils du domaine), une fois, quota réservé", async () => {
    const bodies: Array<{ model: string; tools: Array<{ name: string }> }> = []
    const queue = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e1", name: "consulter_expert", input: { domaine: "planning", question: "Organise la semaine 49" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Plan : lundi Montage sur Vienne…" }] }, // réponse de l'expert
      { stop_reason: "end_turn", content: [{ type: "text", text: "Voici le plan proposé par l'expert." }] },
    ]
    const client = { messagesCreate: async (b: { model: string; tools: Array<{ name: string }> }) => { bodies.push(structuredClone(b)); return queue.shift() } }
    let reserved = 0
    const out = await runCopilot(client as never, fakeDbAdmin, {
      history: [{ role: "user", text: "Organise la semaine 49" }], system: "s", companyId: "co1", today: TODAY, role: adminRole,
      expert: { companyName: "Galya", todayStr: "2026-11-24", reserve: async () => { reserved++; return true } },
    })
    assert.equal(out.text, "Voici le plan proposé par l'expert.")
    assert.equal(reserved, 1)
    assert.ok(bodies[0].tools.some(t => t.name === "consulter_expert"))
    assert.equal(bodies[1].model, EXPERT_MODEL)
    assert.deepEqual(bodies[1].tools.map(t => t.name).sort(), [...EXPERTS.planning.tools].sort())
    assert.ok(!bodies[1].tools.some(t => t.name === "consulter_expert" || t.name.startsWith("proposer_")))
  })
  it("quota épuisé : expert non consulté, le maître répond quand même", async () => {
    const bodies: Array<{ model: string; messages: unknown[] }> = []
    const queue = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "e1", name: "consulter_expert", input: { domaine: "finance", question: "Analyse les retards" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Réponse simple." }] },
    ]
    const client = { messagesCreate: async (b: { model: string; messages: unknown[] }) => { bodies.push(structuredClone(b)); return queue.shift() } }
    const out = await runCopilot(client as never, fakeDbAdmin, {
      history: [{ role: "user", text: "Analyse" }], system: "s", companyId: "co1", today: TODAY, role: adminRole,
      expert: { companyName: "Galya", todayStr: "2026-11-24", reserve: async () => false },
    })
    assert.equal(out.text, "Réponse simple.")
    assert.equal(bodies.length, 2)
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /Limite quotidienne/)
  })
  it("expert absent pour un employé, et sans drapeau", async () => {
    const bodies: Array<{ tools: Array<{ name: string }> }> = []
    const client = { messagesCreate: async (b: { tools: Array<{ name: string }> }) => { bodies.push(b); return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } } }
    await runCopilot(client as never, roleDb().db, { history: [{ role: "user", text: "a" }], system: "s", companyId: "co1", today: TODAY, role: EMP, expert: { companyName: "G", todayStr: "2026-11-24", reserve: async () => true } })
    await runCopilot(client as never, fakeDbAdmin, { history: [{ role: "user", text: "a" }], system: "s", companyId: "co1", today: TODAY, role: adminRole })
    for (const b of bodies) assert.ok(!b.tools.some(t => t.name === "consulter_expert"))
  })
})

describe("panneau selon le public", () => {
  it("suggestions et introduction propres à chaque rôle", () => {
    assert.match(SUGGESTIONS.employee.join(" "), /je travaille demain/)
    assert.match(SUGGESTIONS.client.join(" "), /mes chantiers/)
    assert.doesNotMatch(SUGGESTIONS.client.join(" "), /factures/)
    const html = renderToStaticMarkup(<p>{INTRO.team}</p>)
    assert.match(html, /vos équipes/)
  })
})
