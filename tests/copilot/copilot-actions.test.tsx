/** IA-2 : propositions d'action — jeton signé, préparation (références, conflits, devis), boucle, exécution, carte. */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
;(globalThis as { React?: typeof React }).React = React
import { Prisma } from "@prisma/client"
import { proposalSecret, signProposal, verifyProposal, PROPOSAL_TTL_MS, type ProposalPayload } from "@/lib/copilot/copilot-proposal"
import { prepareCopilotAction, COPILOT_ACTION_TOOLS } from "@/lib/copilot/copilot-actions"
import { executeProposal } from "@/lib/copilot/copilot-execute"
import { runCopilot, buildSystemPrompt } from "@/lib/copilot/copilot.core"
import { COPILOT_TOOLS } from "@/lib/copilot/copilot-tools"
import { isCopilotActionsEnabled } from "@/lib/copilot/copilot-config"
import { ProposalCardView } from "@/components/copilot/CopilotPanel"

const SECRET = "s".repeat(64)
const CTX = { companyId: "co1", userId: "u1" }
const TODAY = new Date("2026-11-24T00:00:00.000Z")
const ACTX = { ...CTX, secret: SECRET, billingEnabled: true, today: TODAY }
const TASK: ProposalPayload = { kind: "TASK", data: { title: "Relancer", description: null, priority: "MEDIUM", dueDate: null, assigneeId: null, worksiteId: null } }

describe("jeton de proposition", () => {
  it("signé, lié à l'utilisateur et à la société, expirant", () => {
    const now = Date.now()
    const t = signProposal(TASK, CTX, SECRET, now)
    const ok = verifyProposal(t, CTX, SECRET, now)
    assert.ok(ok.ok && ok.payload.kind === "TASK")
    assert.deepEqual(verifyProposal(t, { ...CTX, userId: "u2" }, SECRET, now), { ok: false, reason: "OTHER_USER" })
    assert.deepEqual(verifyProposal(t, { ...CTX, companyId: "co2" }, SECRET, now), { ok: false, reason: "OTHER_USER" })
    assert.deepEqual(verifyProposal(t, CTX, SECRET, now + PROPOSAL_TTL_MS + 1), { ok: false, reason: "EXPIRED" })
    assert.deepEqual(verifyProposal(t, CTX, "x".repeat(64), now), { ok: false, reason: "INVALID" })
  })
  it("toute modification du contenu invalide la signature", () => {
    const t = signProposal(TASK, CTX, SECRET)
    const [body, mac] = t.split(".")
    const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace("Relancer", "Supprimer")).toString("base64url")
    assert.deepEqual(verifyProposal(`${forged}.${mac}`, CTX, SECRET), { ok: false, reason: "INVALID" })
    assert.deepEqual(verifyProposal(42, CTX, SECRET), { ok: false, reason: "INVALID" })
  })
  it("secret dérivé du secret de session ; drapeau strict", () => {
    assert.equal(proposalSecret({}), null)
    const a = proposalSecret({ AUTH_SECRET: "abc" })
    assert.ok(a && a !== "abc" && a.length === 64)
    assert.equal(isCopilotActionsEnabled({ COPILOT_ACTIONS_ENABLED: "true" }), true)
    assert.equal(isCopilotActionsEnabled({ COPILOT_ACTIONS_ENABLED: "1" }), false)
  })
})

function fakeDb(opts: { conflict?: boolean } = {}) {
  const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
  const rec = (model: string, impl: (args: Record<string, unknown>) => unknown) => async (args: Record<string, unknown>) => { calls.push({ model, op: "find", args }); return impl(args) }
  const where = (a: Record<string, unknown>) => a.where as Record<string, unknown>
  const db = {
    worksite: { findFirst: rec("worksite", a => (where(a).id === "w1" && where(a).companyId === "co1" ? { id: "w1", name: "Vienne", status: "PLANNED", client: { name: "Mairie" } } : null)) },
    team: { findFirst: rec("team", a => (where(a).id === "t1" && where(a).companyId === "co1" ? { id: "t1", name: "Montage" } : null)) },
    employee: { findFirst: rec("employee", a => (where(a).id === "e1" ? { id: "e1", firstName: "Léa", lastName: "Martin" } : null)) },
    assignment: { findFirst: rec("assignment", () => (opts.conflict ? { date: TODAY, worksite: { name: "Lyon" } } : null)) },
    article: { findMany: rec("article", () => [{ id: "a1", designation: "Tente 25 m²", unit: "u", unitPrice: new Prisma.Decimal("150.00"), vatRate: new Prisma.Decimal("20") }]) },
  }
  return { db: db as never, calls }
}

describe("préparation des propositions (rien n'est écrit)", () => {
  it("aucun outil de proposition n'exécute : préparation par lectures seulement", async () => {
    const { db, calls } = fakeDb()
    await prepareCopilotAction(db, "proposer_tache", { titre: "Appeler le client", chantier_id: "w1", employe_id: "e1", echeance: "2026-11-30", priorite: "HIGH" }, ACTX)
    for (const c of calls) assert.ok(JSON.stringify(c.args.where).includes('"companyId":"co1"'), `${c.model} sans filtre société`)
    assert.ok(COPILOT_ACTION_TOOLS.every(t => t.name.startsWith("proposer_")))
  })
  it("tâche : carte lisible et jeton vérifiable", async () => {
    const { db } = fakeDb()
    const r = await prepareCopilotAction(db, "proposer_tache", { titre: "Appeler le client", chantier_id: "w1", employe_id: "e1", echeance: "2026-11-30", priorite: "HIGH" }, ACTX)
    assert.ok(r.ok)
    assert.equal(r.card.title, "Créer une tâche")
    assert.ok(r.card.details.includes("Chantier : Vienne") && r.card.details.includes("Responsable : Léa Martin"))
    const v = verifyProposal(r.card.token, CTX, SECRET)
    assert.ok(v.ok && v.payload.kind === "TASK" && v.payload.data.worksiteId === "w1" && v.payload.data.priority === "HIGH")
  })
  it("références d'une autre société ou inconnues : refus renvoyé au modèle", async () => {
    const { db } = fakeDb()
    const r = await prepareCopilotAction(db, "proposer_affectation", { chantier_id: "w-autre", equipe_id: "t1", debut: "2026-11-25" }, ACTX)
    assert.deepEqual(r, { ok: false, error: "Chantier introuvable dans cette société." })
    assert.equal((await prepareCopilotAction(db, "proposer_tache", { titre: "ab" }, ACTX)).ok, false)
    assert.equal((await prepareCopilotAction(db, "supprimer_chantier", {}, ACTX)).ok, false)
  })
  it("affectation : passé et conflit d'équipe refusés, sinon carte avec avertissement", async () => {
    assert.match((await prepareCopilotAction(fakeDb().db, "proposer_affectation", { chantier_id: "w1", equipe_id: "t1", debut: "2026-11-01" }, ACTX) as { error: string }).error, /passé/)
    const c = await prepareCopilotAction(fakeDb({ conflict: true }).db, "proposer_affectation", { chantier_id: "w1", equipe_id: "t1", debut: "2026-11-25", fin: "2026-11-27" }, ACTX)
    assert.match((c as { error: string }).error, /déjà affectée au chantier Lyon/)
    const ok = await prepareCopilotAction(fakeDb().db, "proposer_affectation", { chantier_id: "w1", equipe_id: "t1", debut: "2026-11-25", fin: "2026-11-27" }, ACTX)
    assert.ok(ok.ok)
    assert.ok(ok.card.details.some(d => d.includes("3 jours")))
    assert.match(ok.card.warning ?? "", /notification/)
  })
  it("devis : prix du catalogue, totaux calculés, module désactivé refusé", async () => {
    const r = await prepareCopilotAction(fakeDb().db, "proposer_devis", { chantier_id: "w1", objet: "Festival", lignes: [{ article_id: "a1", quantite: 2 }, { designation: "Transport", quantite: 1, prix_unitaire_ht: 80 }] }, ACTX)
    assert.ok(r.ok, JSON.stringify(r))
    assert.ok(r.card.details.some(d => /380,00\s€ HT · 456,00\s€ TTC/.test(d)), r.card.details.join(" | "))
    assert.match(r.card.warning ?? "", /rien n'est envoyé/)
    const off = await prepareCopilotAction(fakeDb().db, "proposer_devis", { chantier_id: "w1", lignes: [{ article_id: "a1", quantite: 1 }] }, { ...ACTX, billingEnabled: false })
    assert.deepEqual(off, { ok: false, error: "Le module Devis n'est pas activé." })
    const badVat = await prepareCopilotAction(fakeDb().db, "proposer_devis", { chantier_id: "w1", lignes: [{ designation: "X", quantite: 1, prix_unitaire_ht: 10, tva: 33 }] }, ACTX)
    assert.equal(badVat.ok, false)
  })
})

describe("boucle Claude avec propositions", () => {
  const history = [{ role: "user" as const, text: "Affecte Montage à Vienne demain" }]
  const replies = () => [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "p1", name: "proposer_affectation", input: { chantier_id: "w1", equipe_id: "t1", debut: "2026-11-25" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "C'est prêt : cliquez « Je confirme »." }] },
  ]
  it("collecte la carte et ne déclare rien de fait", async () => {
    const queue = replies()
    const bodies: Array<{ tools: Array<{ name: string }> }> = []
    const client = { messagesCreate: async (b: { tools: Array<{ name: string }> }) => { bodies.push(b); return queue.shift() } }
    const out = await runCopilot(client as never, fakeDb().db, { history, system: "s", companyId: "co1", today: TODAY, actions: ACTX })
    assert.equal(out.proposals.length, 1)
    assert.equal(out.proposals[0].title, "Affecter une équipe")
    assert.ok(bodies[0].tools.some(t => t.name === "proposer_devis"))
  })
  it("sans contexte d'action : outils de proposition absents (lecture seule IA-1)", async () => {
    const queue = [{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]
    const bodies: Array<{ tools: Array<{ name: string }> }> = []
    const client = { messagesCreate: async (b: { tools: Array<{ name: string }> }) => { bodies.push(b); return queue.shift() } }
    const out = await runCopilot(client as never, fakeDb().db, { history, system: "s", companyId: "co1", today: TODAY })
    assert.equal(bodies[0].tools.length, COPILOT_TOOLS.length)
    assert.deepEqual(out.proposals, [])
    assert.match(buildSystemPrompt({ userName: "N", companyName: "C", today: "2026-11-24", page: "/", actions: true }), /Je confirme/)
  })
})

describe("exécution après confirmation", () => {
  it("passe par les fonctions de l'interface avec les bons champs", async () => {
    const seen: Record<string, unknown> = {}
    const ports = {
      createTask: async (f: FormData) => { seen.task = Object.fromEntries(f); return { success: true as const } },
      assignTeam: async (f: FormData) => { seen.assign = Object.fromEntries(f); return { success: true, count: 3 } },
      createQuote: async (raw: unknown) => { seen.quote = raw; return { ok: true as const, id: "q1", number: "DEV-2026-0007" } },
      createRule: async () => ({ etat: "ok" as const, message: "" }),
    }
    assert.deepEqual(await executeProposal(TASK, ports), { ok: true, message: "Tâche créée.", href: "/dashboard" })
    assert.deepEqual(seen.task, { title: "Relancer", priority: "MEDIUM" })
    const a = await executeProposal({ kind: "ASSIGNMENT", data: { worksiteId: "w1", teamId: "t1", dateFrom: "2026-11-25", dateTo: "2026-11-27" } }, ports)
    assert.deepEqual(a, { ok: true, message: "Équipe affectée (3 jours).", href: "/chantiers/w1" })
    assert.deepEqual(seen.assign, { worksiteId: "w1", teamId: "t1", dateFrom: "2026-11-25", dateTo: "2026-11-27" })
    const q = await executeProposal({ kind: "QUOTE", data: { worksiteId: "w1", issueDate: "2026-11-24", subject: null, lines: [{ articleId: "a1", designation: "Tente", unit: "u", quantity: "2", unitPrice: "150.00", vatRate: "20" }] } }, ports)
    assert.deepEqual(q, { ok: true, message: "Brouillon de devis DEV-2026-0007 créé.", href: "/devis/q1" })
  })
  it("refus de l'interface relayé tel quel", async () => {
    const ports = {
      createTask: async () => ({ error: "Accès refusé." }),
      assignTeam: async () => ({ error: "L'équipe est déjà affectée." }),
      createQuote: async () => ({ ok: false as const, error: "Saisie invalide" }),
      createRule: async () => ({ etat: "erreur" as const, message: "" }),
    }
    assert.deepEqual(await executeProposal(TASK, ports), { ok: false, error: "Accès refusé." })
  })
})

describe("carte « Je confirme »", () => {
  const p = { token: "t", kind: "TASK" as const, title: "Créer une tâche", details: ["Titre : Relancer <b>"], warning: "Brouillon" }
  it("boutons en attente, état final ensuite, texte échappé", () => {
    const pending = renderToStaticMarkup(<ProposalCardView proposal={p} state={{ status: "pending" }} onConfirm={() => {}} onCancel={() => {}} />)
    assert.match(pending, /Je confirme/)
    assert.match(pending, /Annuler/)
    assert.match(pending, /Relancer &lt;b&gt;/)
    const done = renderToStaticMarkup(<ProposalCardView proposal={p} state={{ status: "done", message: "Tâche créée.", href: "/dashboard" }} onConfirm={() => {}} onCancel={() => {}} />)
    assert.doesNotMatch(done, /Je confirme/)
    assert.match(done, /Tâche créée\./)
    assert.match(done, /href="\/dashboard"/)
  })
})
