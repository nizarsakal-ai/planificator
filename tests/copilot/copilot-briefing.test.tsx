/** IA-3 : briefing du jour et veille — calcul déterministe, filtre société, ordre des alertes, pastille, rendu. */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
import { badgeCount, buildBriefing } from "@/lib/copilot/copilot-briefing"
import { COPILOT_TOOLS, runCopilotTool } from "@/lib/copilot/copilot-tools"
import { currentCopilotBadge, publishCopilotBadge } from "@/components/copilot/copilot-events"
import { BriefingView, BRIEFING_PROMPT } from "@/components/copilot/CopilotPanel"
import { parisToday } from "@/lib/copilot/copilot-date"

const TODAY = new Date("2026-11-24T00:00:00.000Z")

function fakeDb(empty = false) {
  const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
  const m = (model: string, findMany: unknown[] | ((a: Record<string, unknown>) => unknown[]), count = 0) => ({
    findMany: async (args: Record<string, unknown>) => { calls.push({ model, op: "findMany", args }); return empty ? [] : typeof findMany === "function" ? findMany(args) : findMany },
    count: async (args: Record<string, unknown>) => { calls.push({ model, op: "count", args }); return empty ? 0 : count },
  })
  const status = (a: Record<string, unknown>) => (a.where as { status?: unknown }).status
  const db = {
    assignment: m("assignment", a => {
      if (status(a) === "PENDING") return [{ team: { name: "Montage" } }]
      if (status(a) === "REFUSED") return [{ date: new Date("2026-11-26T00:00:00Z"), team: { name: "Levage" }, worksite: { id: "w2", name: "Lyon" } }]
      return [{ teamId: "t1", team: { name: "Montage" }, worksite: { id: "w1", name: "Vienne" } }]
    }),
    team: m("team", [{ id: "t1", name: "Montage" }, { id: "t2", name: "Démontage" }]),
    absence: m("absence", [{ employee: { firstName: "Léa", lastName: "Martin" } }], 2),
    invoice: m("invoice", a => ((a.where as { dueDate: { lt?: Date } }).dueDate.lt ? [{ totalTTC: 1000 }, { totalTTC: 234.5 }] : [{ totalTTC: 600 }])),
    worksite: m("worksite", a => (Array.isArray((a.where as { status: { in: string[] } }).status.in) && (a.where as { status: { in: string[] } }).status.in.includes("PLANNED")
      ? [{ id: "w3", name: "Grenoble", startDate: new Date("2026-11-28T00:00:00Z"), _count: { assignments: 0 } }, { id: "w4", name: "Annecy", startDate: TODAY, _count: { assignments: 2 } }]
      : [{ id: "w5", name: "Valence" }])),
    stockLevel: m("stockLevel", [{ quantityMilli: 1, minQuantityMilli: 5 }, { quantityMilli: 9, minQuantityMilli: 5 }]),
    worksiteImportDraft: m("worksiteImportDraft", [], 3),
  }
  return { db: db as never, calls }
}

describe("briefing déterministe", () => {
  it("chaque lecture est filtrée sur la société, aucune écriture", async () => {
    const { db, calls } = fakeDb()
    await buildBriefing(db, "co1", TODAY)
    assert.equal(calls.length, 12)
    for (const c of calls) {
      assert.ok(JSON.stringify(c.args.where).includes('"companyId":"co1"'), `${c.model}.${c.op} sans filtre société`)
      assert.ok(["findMany", "count"].includes(c.op))
    }
    await assert.rejects(buildBriefing(db, "", TODAY))
  })
  it("journée et alertes classées par urgence", async () => {
    const b = await buildBriefing(fakeDb().db, "co1", TODAY)
    assert.equal(b.date, "2026-11-24")
    assert.deepEqual(b.today.worksites, [{ name: "Vienne", teams: ["Montage"], href: "/chantiers/w1" }])
    assert.deepEqual(b.today.freeTeams, ["Démontage"])
    assert.deepEqual(b.today.absent, ["Léa Martin"])
    assert.deepEqual(b.alerts.map(a => a.id), ["overdue", "refused", "unstaffed", "pending", "overrun", "absences", "due-soon", "stock", "consultations"])
    const overdue = b.alerts[0]
    assert.equal(overdue.title, "2 factures en retard")
    assert.match(overdue.detail, /1\s234,50\s€/)
    assert.match(b.alerts.find(a => a.id === "unstaffed")!.detail, /Grenoble/)
    assert.doesNotMatch(b.alerts.find(a => a.id === "unstaffed")!.detail, /Annecy/)
    assert.equal(b.alerts.find(a => a.id === "stock")!.title, "1 article sous le seuil de stock")
    assert.equal(badgeCount(b), 6)
  })
  it("aucune donnée : aucune alerte, pastille à zéro", async () => {
    const b = await buildBriefing(fakeDb(true).db, "co1", TODAY)
    assert.deepEqual(b.alerts, [])
    assert.equal(badgeCount(b), 0)
  })
  it("outil briefing_du_jour disponible pour l'assistant", async () => {
    assert.ok(COPILOT_TOOLS.some(t => t.name === "briefing_du_jour"))
    const r = await runCopilotTool(fakeDb().db, "co1", "briefing_du_jour", {}, TODAY)
    assert.ok(r.ok)
    assert.equal((r.result as { alerts: Array<{ urgence: string }> }).alerts[0].urgence, "urgent")
  })
  it("jour de Paris (minuit passé à Paris, encore la veille en UTC)", () => {
    assert.equal(parisToday(new Date("2026-11-23T23:30:00Z")), "2026-11-24")
  })
})

describe("pastille et rendu", () => {
  it("pastille bornée et gardée pour les composants montés plus tard", () => {
    publishCopilotBadge(4)
    assert.equal(currentCopilotBadge(), 4)
    publishCopilotBadge(250)
    assert.equal(currentCopilotBadge(), 99)
    publishCopilotBadge(-1)
    assert.equal(currentCopilotBadge(), 0)
  })
  it("briefing affiché avec liens internes et bouton d'analyse", async () => {
    const b = await buildBriefing(fakeDb().db, "co1", TODAY)
    const html = renderToStaticMarkup(<BriefingView data={{ ...b, badge: badgeCount(b) }} onAnalyze={() => {}} />)
    assert.match(html, /Briefing du jour/)
    assert.match(html, /href="\/factures"/)
    assert.match(html, /2 factures en retard/)
    assert.match(html, /Analyser et proposer des actions/)
    assert.match(BRIEFING_PROMPT, /briefing/)
    const calm = renderToStaticMarkup(<BriefingView data={{ date: "2026-11-24", today: { worksites: [], freeTeams: [], absent: [] }, alerts: [], badge: 0 }} onAnalyze={() => {}} />)
    assert.match(calm, /Aucune alerte/)
  })
})
