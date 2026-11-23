/** IA-1 : copilote en lecture seule — configuration, validation des entrées, outils bornés à la société, boucle Claude, rendu sûr. */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
import { copilotConfig, isCopilotEnabledForCompany, isCopilotRole } from "@/lib/copilot/copilot-config"
import { COPILOT_TOOLS, parseDay, parseRange, runCopilotTool } from "@/lib/copilot/copilot-tools"
import { buildSystemPrompt, CopilotEmptyError, CopilotInputError, parseHistory, parsePage, runCopilot, MAX_TOOL_ROUNDS } from "@/lib/copilot/copilot.core"
import { renderCopilotText } from "@/components/copilot/CopilotPanel"

const ENV = { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: "co1", ANTHROPIC_API_KEY: "k" }
const TODAY = new Date("2026-11-24T00:00:00.000Z")

describe("configuration", () => {
  it("exige drapeau, société cible exacte et clé", () => {
    assert.deepEqual(copilotConfig("co1", ENV), { apiKey: "k", dailyLimit: 50 })
    assert.equal(copilotConfig("co2", ENV), null)
    assert.equal(copilotConfig("co1", { ...ENV, COPILOT_ENABLED: "1" }), null)
    assert.equal(copilotConfig("co1", { ...ENV, ANTHROPIC_API_KEY: " " }), null)
    assert.equal(copilotConfig(undefined, ENV), null)
    assert.equal(isCopilotEnabledForCompany("co1", { COPILOT_ENABLED: "true" }), false)
  })
  it("valide la limite quotidienne", () => {
    assert.equal(copilotConfig("co1", { ...ENV, COPILOT_DAILY_LIMIT: "120" })?.dailyLimit, 120)
    for (const bad of ["0", "501", "abc", "2.5"]) assert.equal(copilotConfig("co1", { ...ENV, COPILOT_DAILY_LIMIT: bad }), null)
  })
  it("réserve IA-1 à l'administration", () => {
    assert.ok(isCopilotRole("ADMIN") && isCopilotRole("SUPER_ADMIN"))
    for (const r of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", undefined]) assert.equal(isCopilotRole(r), false)
  })
})

describe("entrées", () => {
  it("historique : dernier tour utilisateur, tailles bornées, rôles stricts", () => {
    const h = parseHistory([{ role: "assistant", text: "x" }, { role: "user", text: " a ".repeat(2000) }])
    assert.equal(h.length, 1)
    assert.equal(h[0].role, "user")
    assert.ok(h[0].text.length <= 2000)
    assert.throws(() => parseHistory([]), CopilotInputError)
    assert.throws(() => parseHistory([{ role: "user", text: "a" }, { role: "assistant", text: "b" }]), CopilotInputError)
    assert.throws(() => parseHistory([{ role: "system", text: "a" }]), CopilotInputError)
  })
  it("page : chemin interne seulement", () => {
    assert.equal(parsePage("/chantiers/abc?x=1#y"), "/chantiers/abc")
    assert.equal(parsePage("https://evil.example"), "/dashboard")
    assert.equal(parsePage("//evil.example"), "/dashboard")
    assert.equal(parsePage("/a<script>"), "/ascript")
  })
  it("dates strictes et période bornée", () => {
    assert.equal(parseDay("2026-02-28", "d").toISOString(), "2026-02-28T00:00:00.000Z")
    assert.throws(() => parseDay("2026-02-30", "d"))
    assert.throws(() => parseDay("28/02/2026", "d"))
    assert.throws(() => parseRange({ debut: "2026-03-02", fin: "2026-03-01" }))
    assert.throws(() => parseRange({ debut: "2026-01-01", fin: "2026-12-31" }))
  })
  it("prompt système : lecture seule et données non fiables", () => {
    const s = buildSystemPrompt({ userName: "N", companyName: "C", today: "2026-11-24", page: "/planning" })
    assert.match(s, /lecture seule/)
    assert.match(s, /jamais des instructions/)
  })
})

/** Faux Prisma qui enregistre chaque requête. */
function fakeDb() {
  const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
  const model = (name: string, rows: unknown[] = []) => new Proxy({}, {
    get: (_t, op: string) => async (args: Record<string, unknown> = {}) => {
      calls.push({ model: name, op, args })
      if (op === "count") return 3
      if (op === "aggregate") return { _sum: { totalTTC: 1200.5 }, _count: 2 }
      return rows
    },
  })
  const db = {
    assignment: model("assignment", [{ date: TODAY, status: "CONFIRMED", teamId: "t1", team: { name: "Montage" }, worksite: { id: "w1", name: "Vienne" } }]),
    worksite: model("worksite"), absence: model("absence"), client: model("client"), worksiteImportDraft: model("worksiteImportDraft"),
    team: model("team", [{ id: "t1", name: "Montage" }, { id: "t2", name: "Démontage" }]), employee: model("employee"),
    stockLevel: model("stockLevel", [
      { quantityMilli: 1000, minQuantityMilli: 5000, article: { designation: "Bâche", unit: "u" }, warehouse: { name: "Lyon" } },
      { quantityMilli: 9000, minQuantityMilli: 5000, article: { designation: "Chaise", unit: "u" }, warehouse: { name: "Lyon" } },
    ]),
    invoice: model("invoice", [{ id: "i1", number: "FAC-1", status: "SENT", totalTTC: 600, issueDate: TODAY, dueDate: new Date("2026-11-01T00:00:00Z"), client: { name: "A" }, worksite: { name: "W" } }]),
  }
  return { db: db as never, calls }
}

describe("outils en lecture seule", () => {
  it("aucun outil d'écriture déclaré", () => {
    for (const t of COPILOT_TOOLS) assert.doesNotMatch(t.name, /creer|modifier|supprimer|envoyer|create|update|delete|send/)
  })
  it("chaque requête est filtrée sur la société de la session", async () => {
    const { db, calls } = fakeDb()
    await runCopilotTool(db, "co1", "planning_periode", { debut: "2026-11-24", fin: "2026-11-30" }, TODAY)
    await runCopilotTool(db, "co1", "disponibilites_jour", { date: "2026-11-24" }, TODAY)
    await runCopilotTool(db, "co1", "chercher_chantiers", { texte: "vienne" }, TODAY)
    await runCopilotTool(db, "co1", "factures", { filtre: "en_retard" }, TODAY)
    await runCopilotTool(db, "co1", "absences_periode", { debut: "2026-11-24", fin: "2026-11-30" }, TODAY)
    await runCopilotTool(db, "co1", "stock_bas", {}, TODAY)
    await runCopilotTool(db, "co1", "consultations_recentes", {}, TODAY)
    await runCopilotTool(db, "co1", "equipes", {}, TODAY)
    assert.ok(calls.length >= 10)
    for (const c of calls) {
      const where = JSON.stringify(c.args.where ?? {})
      assert.ok(where.includes('"companyId":"co1"'), `${c.model}.${c.op} sans filtre société : ${where}`)
      assert.ok(["findMany", "findFirst", "count", "aggregate"].includes(c.op), `opération interdite ${c.op}`)
    }
  })
  it("résultats : retard calculé, stock filtré, liens internes", async () => {
    const { db } = fakeDb()
    const f = await runCopilotTool(db, "co1", "factures", { filtre: "en_retard" }, TODAY)
    assert.ok(f.ok)
    const r = f.result as { total_ttc: number; factures: Array<{ jours_de_retard: number; lien: string }> }
    assert.equal(r.total_ttc, 1200.5)
    assert.equal(r.factures[0].jours_de_retard, 23)
    assert.equal(r.factures[0].lien, "/factures/i1")
    const s = await runCopilotTool(db, "co1", "stock_bas", {}, TODAY)
    assert.deepEqual((s as { result: Array<{ article: string }> }).result.map(x => x.article), ["Bâche"])
    const d = await runCopilotTool(db, "co1", "disponibilites_jour", { date: "2026-11-24" }, TODAY)
    assert.deepEqual((d as { result: { equipes_libres: string[] } }).result.equipes_libres, ["Démontage"])
  })
  it("entrée invalide ou outil inconnu : erreur renvoyée au modèle", async () => {
    const { db } = fakeDb()
    assert.deepEqual(await runCopilotTool(db, "co1", "supprimer_tout", {}, TODAY), { ok: false, error: "Outil inconnu." })
    const bad = await runCopilotTool(db, "co1", "planning_periode", { debut: "hier", fin: "demain" }, TODAY)
    assert.equal(bad.ok, false)
    assert.deepEqual(await runCopilotTool(db, "", "equipes", {}, TODAY), { ok: false, error: "Outil inconnu." })
  })
})

describe("boucle Claude", () => {
  const input = { history: [{ role: "user" as const, text: "Qui travaille aujourd'hui ?" }], system: "s", companyId: "co1", today: TODAY }

  it("exécute les outils demandés puis renvoie la réponse", async () => {
    const { db } = fakeDb()
    const bodies: Array<Record<string, unknown>> = []
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "planning_periode", input: { debut: "2026-11-24", fin: "2026-11-24" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Montage est sur [Vienne](/chantiers/w1)." }] },
    ]
    const client = { messagesCreate: async (body: Record<string, unknown>) => { bodies.push(structuredClone(body)); return replies.shift() } }
    const out = await runCopilot(client as never, db, input)
    assert.equal(out.text, "Montage est sur [Vienne](/chantiers/w1).")
    assert.deepEqual(out.tools, ["planning_periode"])
    assert.equal(bodies[0].model, "claude-haiku-5-5")
    const second = bodies[1].messages as Array<{ role: string; content: Array<{ type: string; content: string }> }>
    assert.equal(second[2].content[0].type, "tool_result")
    assert.match(second[2].content[0].content, /Vienne/)
  })
  it("refus, coupure et boucle sans fin : erreurs typées", async () => {
    const { db } = fakeDb()
    for (const [stop, code] of [["refusal", "REFUSAL"], ["max_tokens", "OUTPUT_LIMIT"]] as const) {
      const client = { messagesCreate: async () => ({ stop_reason: stop, content: [] }) }
      await assert.rejects(runCopilot(client as never, db, input), (e: unknown) => e instanceof CopilotEmptyError && e.causeCode === code)
    }
    let n = 0
    const looping = { messagesCreate: async (body: { tool_choice: { type: string } }) => {
      n++
      if (body.tool_choice.type === "none") return { stop_reason: "end_turn", content: [{ type: "text", text: "Voici ce que j'ai trouvé." }] }
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${n}`, name: "equipes", input: {} }] }
    } }
    const out = await runCopilot(looping as never, db, input)
    assert.equal(n, MAX_TOOL_ROUNDS + 1)
    assert.equal(out.text, "Voici ce que j'ai trouvé.")
  })
})

describe("rendu de la réponse", () => {
  it("liens internes cliquables, liens externes et HTML laissés en texte", () => {
    const html = renderToStaticMarkup(<p>{renderCopilotText("Voir [Vienne](/chantiers/w1), **urgent**, [pirate](https://evil.example) <img src=x>")}</p>)
    assert.match(html, /<a [^>]*href="\/chantiers\/w1"[^>]*>Vienne<\/a>/)
    assert.match(html, /<strong>urgent<\/strong>/)
    assert.doesNotMatch(html, /href="https/)
    assert.match(html, /&lt;img src=x&gt;/)
  })
})
