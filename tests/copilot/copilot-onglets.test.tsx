/**
 * Assistant IA, étape 2 : onglets décidés par le serveur, gardes DISTINCTES par source du Journal, limitées aux
 * administrateurs du tenant concerné ; accès direct aux routes refusé aux rôles non autorisés.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
import { copilotAdminGuardCore, resolveAssistantAccessCore } from "@/lib/copilot/copilot-guards"
import { journalDenial, readJournal, readPendingProposals, resolveCopilotTabs, type SourceGuard } from "@/lib/copilot/copilot-tabs"
import { assistantDenialStatus } from "@/lib/assistant/access"
import { CopilotTabBar } from "@/components/copilot/CopilotTabs"

const A = "co_a", B = "co_b"
const COPILOT_ENV = { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: A, ANTHROPIC_API_KEY: "k" }
const user = (role: string, companyId: string | null = A) => ({ id: "u1", role, companyId })
/** Garde du lot F telle que la calcule rulesSourceGuard, pour une cible de lot F donnée (null = lot inactif). */
const rules = (pilot: string | null, role: string, companyId: string | null = A): SourceGuard => {
  const r = resolveAssistantAccessCore(pilot, { user: user(role, companyId) })
  return r.ok ? { ok: true, companyId: r.context.companyId } : { ok: false, status: assistantDenialStatus(r.reason) }
}
const admin = (role: string, companyId: string | null = A) => copilotAdminGuardCore(user(role, companyId), COPILOT_ENV)

describe("onglets décidés par le serveur (6 profils du cadrage)", () => {
  const tabs = (pilot: string | null, role: string, companyId = A, copilotVisible = true) =>
    resolveCopilotTabs({ copilotVisible, rules: rules(pilot, role, companyId), copilotAdmin: admin(role, companyId) })
  it("administrateur, lot F actif : Discussion, Propositions, Journal", () => {
    assert.deepEqual(tabs(A, "ADMIN"), ["discussion", "propositions", "journal"])
    assert.deepEqual(tabs(A, "SUPER_ADMIN"), ["discussion", "propositions", "journal"])
  })
  it("administrateur, lot F inactif : Discussion et Journal", () => {
    assert.deepEqual(tabs(null, "ADMIN"), ["discussion", "journal"])
  })
  it("administrateur d'une autre société que la cible du lot F : pas de Propositions", () => {
    assert.deepEqual(resolveCopilotTabs({ copilotVisible: true, rules: rules(B, "ADMIN"), copilotAdmin: admin("ADMIN") }), ["discussion", "journal"])
  })
  it("chef d'équipe, employé, client : Discussion seule (aucune barre d'onglets)", () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) assert.deepEqual(tabs(A, role), ["discussion"], role)
  })
  it("copilote non visible : aucun onglet", () => {
    assert.deepEqual(tabs(A, "ADMIN", A, false), [])
  })
})

describe("garde d'administration du copilote (source Assistant IA)", () => {
  it("404 si copilote non configuré pour la société, 401 sans session, 403 non administrateur, ok sinon", () => {
    assert.deepEqual(copilotAdminGuardCore(user("ADMIN", B), COPILOT_ENV), { ok: false, status: 404 })
    assert.deepEqual(copilotAdminGuardCore(user("ADMIN", A), { ...COPILOT_ENV, COPILOT_ENABLED: "false" }), { ok: false, status: 404 })
    assert.deepEqual(copilotAdminGuardCore({ companyId: A }, COPILOT_ENV), { ok: false, status: 401 })
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) assert.deepEqual(copilotAdminGuardCore(user(role), COPILOT_ENV), { ok: false, status: 403 }, role)
    assert.deepEqual(copilotAdminGuardCore(user("ADMIN"), COPILOT_ENV), { ok: true, companyId: A })
  })
})

describe("accès direct aux routes : refus par profil", () => {
  it("journal : refusé à tout rôle non administrateur et sans session ; 404 si aucun module", () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) assert.equal(journalDenial(rules(A, role), admin(role)), 403, role)
    assert.equal(journalDenial({ ok: false, status: 401 }, { ok: false, status: 401 }), 401)
    assert.equal(journalDenial({ ok: false, status: 404 }, { ok: false, status: 404 }), 404)
    assert.equal(journalDenial(rules(null, "ADMIN"), admin("ADMIN")), null, "admin lot inactif : journal du copilote autorisé")
  })
  it("propositions : statut de la garde du lot F (404 lot inactif, 403 non administrateur)", () => {
    assert.deepEqual(rules(null, "ADMIN"), { ok: false, status: 404 })
    assert.deepEqual(rules(A, "EMPLOYEE"), { ok: false, status: 403 })
  })
  it("chaque route refait SA garde (câblage)", () => {
    const p = readFileSync("src/app/api/assistant/propositions/route.ts", "utf8")
    assert.ok(p.includes("const guard = await rulesSourceGuard()") && p.includes("readPendingProposals(prisma, guard)"))
    const j = readFileSync("src/app/api/assistant/journal/route.ts", "utf8")
    assert.ok(j.includes("Promise.all([rulesSourceGuard(), copilotAdminGuard()])") && j.includes("readJournal(prisma, { rules, copilotAdmin })"))
    const g = readFileSync("src/lib/copilot/copilot-guards.ts", "utf8")
    assert.ok(g.includes("const r = await resolveAssistantAccess()"), "garde du lot F = garde de la route /assistant")
  })
})

/** Faux Prisma qui enregistre les requêtes. */
function fakeDb() {
  const calls: Array<{ model: string; where: Record<string, unknown> }> = []
  const at = (s: string) => new Date(`2026-11-24T${s}:00.000Z`)
  const db = {
    assistantProposal: { findMany: async (a: { where: Record<string, unknown> }) => { calls.push({ model: "proposal", where: a.where }); return [{ id: "p1", rule: "STOCK_BELOW_MINIMUM", title: "Réapprovisionner", createdAt: at("08:00") }] } },
    assistantActionLog: { findMany: async (a: { where: Record<string, unknown> }) => { calls.push({ model: "rulesLog", where: a.where }); return [{ id: "l1", event: "EXECUTED", detail: "Tâche créée", createdAt: at("09:00") }] } },
    historyLog: { findMany: async (a: { where: Record<string, unknown> }) => { calls.push({ model: "copilotLog", where: a.where }); return [{ id: "h1", detail: "Assistant IA : QUOTE", createdAt: at("10:00") }] } },
  }
  return { db: db as never, calls }
}

describe("lecture par source, limitée au tenant de SA garde", () => {
  it("deux sources autorisées, même société : journal fusionné par date, source sur chaque ligne", async () => {
    const { db, calls } = fakeDb()
    const rows = await readJournal(db, { rules: { ok: true, companyId: A }, copilotAdmin: { ok: true, companyId: A } })
    assert.deepEqual(rows.map((r) => [r.source, r.event, r.detail]), [["assistant-ia", "Confirmée", "Brouillon de devis créé"], ["regles", "Exécutée", "Tâche créée"]])
    for (const c of calls) assert.equal(c.where.companyId, A)
    assert.equal(calls.find((c) => c.model === "copilotLog")!.where.entityType, "CopilotAction")
  })
  it("garde du lot F refusée : la source « règles » n'est jamais lue", async () => {
    const { db, calls } = fakeDb()
    const rows = await readJournal(db, { rules: { ok: false, status: 404 }, copilotAdmin: { ok: true, companyId: A } })
    assert.ok(rows.every((r) => r.source === "assistant-ia"))
    assert.ok(!calls.some((c) => c.model === "rulesLog"))
  })
  it("garde du copilote refusée : la source « Assistant IA » n'est jamais lue", async () => {
    const { db, calls } = fakeDb()
    const rows = await readJournal(db, { rules: { ok: true, companyId: A }, copilotAdmin: { ok: false, status: 403 } })
    assert.ok(rows.every((r) => r.source === "regles"))
    assert.ok(!calls.some((c) => c.model === "copilotLog"))
  })
  it("gardes validant deux sociétés différentes : la source « règles » est écartée", async () => {
    const { db, calls } = fakeDb()
    const rows = await readJournal(db, { rules: { ok: true, companyId: B }, copilotAdmin: { ok: true, companyId: A } })
    assert.ok(rows.every((r) => r.source === "assistant-ia"))
    assert.ok(!calls.some((c) => c.where.companyId === B))
  })
  it("propositions : aucune lecture sans garde ; champs d'affichage seulement, lien vers /assistant", async () => {
    const { db, calls } = fakeDb()
    assert.deepEqual(await readPendingProposals(db, { ok: false, status: 403 }), [])
    assert.equal(calls.length, 0)
    const [p] = await readPendingProposals(db, { ok: true, companyId: A })
    assert.deepEqual(Object.keys(p).sort(), ["createdAt", "href", "id", "rule", "title"])
    assert.equal(p.href, "/assistant#proposition-p1")
    assert.equal(p.rule, "Stock sous le seuil minimal")
  })
})

describe("barre d'onglets", () => {
  it("rien avec un seul onglet ; sinon tablist accessible", () => {
    assert.equal(renderToStaticMarkup(<CopilotTabBar tabs={["discussion"]} active="discussion" onChange={() => {}} />), "")
    const html = renderToStaticMarkup(<CopilotTabBar tabs={["discussion", "propositions", "journal"]} active="journal" onChange={() => {}} pendingCount={2} />)
    assert.match(html, /role="tablist"/)
    assert.equal((html.match(/role="tab"/g) ?? []).length, 3)
    assert.match(html, /aria-selected="true"[^>]*>Journal/)
    assert.match(html, /Propositions<span[^>]*>2<\/span>/)
  })
  it("/assistant compatible : ancre de proposition, garde et confirmations inchangées", () => {
    const page = readFileSync("src/app/(dashboard)/assistant/page.tsx", "utf8")
    assert.ok(page.includes('id={`proposition-${p.id}`}'))
    assert.ok(page.includes("const ctx = await assistantPageAccess()"))
    assert.ok(page.indexOf("if (!ctx) return <AdminOnlyNotice />") < page.indexOf("loadAssistantPage(prisma"))
  })
})
