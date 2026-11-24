/** IA-5 : automatisations écrites en français — règle de la liste fermée, brouillon, modules, exécution, lecture. */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { actionToolsFor, prepareCopilotAction } from "@/lib/copilot/copilot-actions"
import { executeProposal } from "@/lib/copilot/copilot-execute"
import { verifyProposal } from "@/lib/copilot/copilot-proposal"
import { runCopilotTool } from "@/lib/copilot/copilot-tools"
import { buildSystemPrompt } from "@/lib/copilot/copilot.core"

const SECRET = "s".repeat(64)
const TODAY = new Date("2026-11-24T00:00:00.000Z")
const CTX = { companyId: "co1", userId: "u1", secret: SECRET, billingEnabled: true, today: TODAY, automationsEnabled: true, crmEnabled: true }
const db = {
  employee: { findFirst: async (a: { where: { id: string; companyId: string } }) => (a.where.id === "e1" && a.where.companyId === "co1" ? { firstName: "Léa", lastName: "Martin" } : null) },
} as never

describe("proposer_automatisation", () => {
  it("offert seulement si le module Automatisations est actif", () => {
    assert.ok(actionToolsFor({ automationsEnabled: true }).some(t => t.name === "proposer_automatisation"))
    assert.ok(!actionToolsFor({ automationsEnabled: false }).some(t => t.name === "proposer_automatisation"))
  })
  it("tâche après un devis accepté : carte lisible, brouillon, jeton vérifiable", async () => {
    const r = await prepareCopilotAction(db, "proposer_automatisation", {
      nom: "Préparer le chantier après signature", declencheur: "QUOTE_ACCEPTED", action: "CREATE_TASK",
      titre_tache: "Planifier le chantier {chantier}", responsable_id: "e1", echeance_jours: 2,
    }, CTX)
    assert.ok(r.ok, JSON.stringify(r))
    assert.equal(r.card.title, "Créer une règle d'automatisation")
    assert.ok(r.card.details.includes("Quand : Devis accepté"))
    assert.ok(r.card.details.includes("Responsable : Léa Martin"))
    assert.ok(r.card.details.includes("Échéance : 2 jour(s) après"))
    assert.match(r.card.warning ?? "", /brouillon/)
    const v = verifyProposal(r.card.token, { companyId: "co1", userId: "u1" }, SECRET)
    assert.ok(v.ok && v.payload.kind === "AUTOMATION" && v.payload.data.taskDueInDays === 2)
  })
  it("notification à l'arrivée en négociation : filtre d'étape affiché", async () => {
    const r = await prepareCopilotAction(db, "proposer_automatisation", {
      nom: "Alerte négociation", declencheur: "OPPORTUNITY_STAGE_CHANGED", etape: "NEGOTIATION", action: "NOTIFY_ADMINS", message: "{titre} passe en négociation",
    }, CTX)
    assert.ok(r.ok)
    assert.ok(r.card.details.some(d => d.includes("Négociation")))
  })
  it("refus : module coupé, pipeline coupé, hors liste, champs invalides, responsable d'une autre société", async () => {
    const base = { nom: "Règle test", declencheur: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Devis {numero} accepté" }
    assert.deepEqual(await prepareCopilotAction(db, "proposer_automatisation", base, { ...CTX, automationsEnabled: false }), { ok: false, error: "Le module Automatisations n'est pas activé." })
    assert.match((await prepareCopilotAction(db, "proposer_automatisation", { ...base, declencheur: "OPPORTUNITY_FOLLOW_UP_DUE" }, { ...CTX, crmEnabled: false }) as { error: string }).error, /pipeline commercial/)
    for (const bad of [
      { ...base, declencheur: "EVERY_MONDAY" },
      { ...base, action: "SEND_EMAIL" },
      { ...base, message: "x" },
      { ...base, etape: "WON" },
      { ...base, action: "CREATE_TASK", titre_tache: "Ok tâche", echeance_jours: 400 },
      { ...base, action: "CREATE_TASK", titre_tache: "Ok tâche", responsable_id: "e-autre" },
    ]) assert.equal((await prepareCopilotAction(db, "proposer_automatisation", bad, CTX)).ok, false, JSON.stringify(bad))
  })
})

describe("exécution et lecture", () => {
  it("création par l'action du module, en brouillon", async () => {
    let sent: Record<string, unknown> = {}
    const ports = {
      createTask: async () => ({ success: true as const }), assignTeam: async () => ({ success: true }), createQuote: async () => ({ ok: true as const, id: "q", number: "n" }),
      createRule: async (f: FormData) => { sent = Object.fromEntries(f); return { etat: "ok" as const, message: "Règle créée en brouillon" } },
    }
    const r = await executeProposal({ kind: "AUTOMATION", data: { name: "Règle", trigger: "QUOTE_ACCEPTED", stageFilter: null, action: "CREATE_TASK", taskTitle: "Planifier", taskAssigneeId: null, taskDueInDays: 0, message: null } }, ports)
    assert.deepEqual(r, { ok: true, message: "Règle créée en brouillon : approuvez-la dans Automatisations pour l'activer.", href: "/automatisations" })
    assert.deepEqual(sent, { name: "Règle", trigger: "QUOTE_ACCEPTED", action: "CREATE_TASK", taskTitle: "Planifier", taskDueInDays: "0" })
    const ko = await executeProposal({ kind: "AUTOMATION", data: { name: "Règle", trigger: "QUOTE_ACCEPTED", stageFilter: null, action: "NOTIFY_ADMINS", taskTitle: null, taskAssigneeId: null, taskDueInDays: null, message: "x" } },
      { ...ports, createRule: async () => ({ etat: "erreur" as const, message: "Message obligatoire (3 à 500 caractères)." }) })
    assert.deepEqual(ko, { ok: false, error: "Message obligatoire (3 à 500 caractères)." })
  })
  it("outil automatisations : règles de la société, module coupé signalé", async () => {
    const prev = process.env.AUTOMATIONS_ENABLED
    const calls: unknown[] = []
    const rdb = { automationRule: { findMany: async (a: unknown) => { calls.push(a); return [{ name: "R1", status: "DRAFT", trigger: "QUOTE_ACCEPTED", action: "CREATE_TASK" }] } } } as never
    try {
      process.env.AUTOMATIONS_ENABLED = "true"
      const r = await runCopilotTool(rdb, "co1", "automatisations", {}, TODAY)
      assert.ok(r.ok)
      assert.deepEqual((r.result as { regles: unknown[] }).regles, [{ nom: "R1", statut: "brouillon", quand: "Devis accepté", alors: "Créer une tâche interne" }])
      assert.ok(JSON.stringify(calls[0]).includes('"companyId":"co1"'))
      process.env.AUTOMATIONS_ENABLED = "false"
      assert.deepEqual(await runCopilotTool(rdb, "co1", "automatisations", {}, TODAY), { ok: true, result: { module_desactive: true } })
    } finally {
      if (prev === undefined) delete process.env.AUTOMATIONS_ENABLED; else process.env.AUTOMATIONS_ENABLED = prev
    }
  })
  it("prompt : liste fermée et brouillon expliqués", () => {
    const s = buildSystemPrompt({ userName: "N", companyName: "C", today: "2026-11-24", page: "/", actions: true })
    assert.match(s, /liste fermée/)
    assert.match(s, /brouillon/)
  })
})
