/**
 * Lot F Planificator V2 : assistant — règles pures (propositions liées aux sources, clés stables, revalidation,
 * ajustements à l'approbation), fournisseur externe non autorisé, aucun appel réseau.
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { ASSISTANT_ERRORS, RULE_LABEL, RULE_SOURCE, isRuleSourceEnabled, holds, isoWeek, proposeFromFacts, readPayload, readSources, sourceKeys, validateApproval, type Facts } from "@/lib/assistant/assistant.core"
import { PROVIDERS, activeProvider } from "@/lib/assistant/providers"
import { isAssistantEnabled } from "@/lib/assistant/assistant-feature-flag"
import { SYNC_ERROR_CODES } from "@/lib/connectors/connectors.core"
import { parisToday } from "@/lib/equipment/equipment.core"

const D = (s: string) => new Date(`${s}T00:00:00Z`)
const TODAY = D("2026-11-04")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

const FACTS: Facts = {
  followUps: [
    { id: "o2", number: "OPP-2026-0002", title: "Toiture", party: "Martin", worksiteId: null, nextFollowUpDate: D("2026-10-20"), open: true },
    { id: "o1", number: "OPP-2026-0001", title: "Façade", party: "Durand", worksiteId: "w1", nextFollowUpDate: D("2026-10-30"), open: true },
    { id: "o3", number: "OPP-2026-0003", title: "Aujourd'hui", party: "X", worksiteId: null, nextFollowUpDate: TODAY, open: true },
    { id: "o4", number: "OPP-2026-0004", title: "Close", party: "Y", worksiteId: null, nextFollowUpDate: D("2026-10-01"), open: false },
  ],
  stock: [
    { id: "s1", articleName: "Enduit", warehouseName: "Dépôt A", unit: "sac", quantityMilli: 1500, minQuantityMilli: 5000 },
    { id: "s2", articleName: "Vis", warehouseName: "Dépôt A", unit: "u", quantityMilli: 0, minQuantityMilli: 100_000 },
    { id: "s3", articleName: "Colle", warehouseName: "Dépôt A", unit: "u", quantityMilli: 5000, minQuantityMilli: 5000 },
    { id: "s4", articleName: "Sans seuil", warehouseName: "Dépôt A", unit: "u", quantityMilli: 0, minQuantityMilli: 0 },
  ],
}

describe("propositions", () => {
  it("une proposition par fait qui la justifie, triée, avec sa source, son motif et sa tâche proposée", () => {
    const p = proposeFromFacts(FACTS, TODAY)
    assert.deepEqual(p.map((x) => x.sourceKey), ["fu:o1:2026-10-30", "fu:o2:2026-10-20", "stk:s1:5000:2026-W45", "stk:s2:100000:2026-W45"])
    const [f1, f2, s1, s2] = p
    assert.deepEqual(f1.payload, { title: "Relancer Durand (OPP-2026-0001)", dueDate: "2026-11-04", worksiteId: "w1", priority: "MEDIUM" })
    assert.equal(f1.rationale, "Relance prévue le 2026-10-30 pour « Façade », non faite (5 jours de retard).")
    // Fiche du pipeline commercial du lot E sur cette base (pas la veille Prospection « /opportunites »).
    assert.deepEqual(f1.sources, [{ type: "Opportunity", id: "o1", label: "OPP-2026-0001 · Façade", href: "/crm/opportunites/o1", fact: "Relance prévue le 2026-10-30" }])
    assert.equal(f2.payload.priority, "HIGH", "plus de 7 jours de retard")
    assert.ok(p.every((x) => x.rule !== ("RESERVE_OVERDUE" as string)), "règle réserves reportée avec le lot D")
    assert.equal(s1.sources[0].href, "/stock")
    assert.equal(s1.rationale, "Stock de 1,5 sac pour un seuil minimal de 5 sac au dépôt Dépôt A.")
    assert.deepEqual([s1.payload.priority, s1.payload.worksiteId, s2.payload.priority], ["MEDIUM", null, "HIGH"])
    assert.ok(p.every((x) => x.sources.length === 1 && x.title.length >= 3 && x.title.length <= 200))
  })
  it("rien à proposer : relance du jour, opportunité close, stock au seuil ou sans seuil, module absent", () => {
    assert.deepEqual(proposeFromFacts({}, TODAY), [])
    assert.deepEqual(proposeFromFacts({ followUps: [FACTS.followUps![2], FACTS.followUps![3]], stock: [FACTS.stock![2], FACTS.stock![3]] }, TODAY), [])
  })
  it("un seul module source : seules ses propositions (CRM sans stock, stock sans CRM)", () => {
    assert.deepEqual(proposeFromFacts({ followUps: FACTS.followUps }, TODAY).map((x) => x.rule), ["OPPORTUNITY_FOLLOW_UP_OVERDUE", "OPPORTUNITY_FOLLOW_UP_OVERDUE"])
    assert.deepEqual(proposeFromFacts({ stock: FACTS.stock }, TODAY).map((x) => x.rule), ["STOCK_BELOW_MINIMUM", "STOCK_BELOW_MINIMUM"])
  })
  it("clés stables : même observation ⇒ même clé ; nouvelle date de relance ou nouveau seuil ou nouvelle semaine ⇒ nouvelle clé", () => {
    assert.equal(sourceKeys.followUp("o1", D("2026-10-30")), sourceKeys.followUp("o1", D("2026-10-30")))
    assert.notEqual(sourceKeys.followUp("o1", D("2026-10-30")), sourceKeys.followUp("o1", D("2026-11-02")))
    assert.notEqual(sourceKeys.stock("s1", 5000, TODAY), sourceKeys.stock("s1", 6000, TODAY))
    assert.equal(sourceKeys.stock("s1", 5000, D("2026-11-02")), sourceKeys.stock("s1", 5000, D("2026-11-08")), "même semaine ISO (lundi → dimanche)")
    assert.notEqual(sourceKeys.stock("s1", 5000, D("2026-11-08")), sourceKeys.stock("s1", 5000, D("2026-11-09")))
    assert.deepEqual([isoWeek(D("2026-11-04")), isoWeek(D("2021-01-01")), isoWeek(D("2024-12-30")), isoWeek(D("2026-01-01")), isoWeek(D("2027-01-01"))], ["2026-W45", "2020-W53", "2025-W01", "2026-W01", "2026-W53"])
    // Revue indépendante : la semaine est celle du jour civil de PARIS (parisToday rend minuit UTC de ce jour).
    assert.equal(isoWeek(parisToday(new Date("2026-11-08T23:30:00Z"))), "2026-W46", "lundi 9 novembre à 0 h 30 à Paris (UTC+1)")
    assert.equal(isoWeek(parisToday(new Date("2026-11-08T21:30:00Z"))), "2026-W45", "dimanche 8 novembre à 22 h 30 à Paris")
    assert.equal(isoWeek(parisToday(new Date("2026-11-10T08:00:00Z"))), isoWeek(parisToday(new Date("2026-11-09T08:00:00Z"))), "lundi et mardi : même semaine")
  })
  it("revalidation : même test qu'à la génération", () => {
    assert.equal(holds.followUp({ ...FACTS.followUps![1] }, TODAY), true)
    assert.equal(holds.followUp({ ...FACTS.followUps![1], nextFollowUpDate: D("2026-11-10") }, TODAY), false, "relance faite et replanifiée")
    assert.equal(holds.followUp({ ...FACTS.followUps![1], open: false }, TODAY), false)
    assert.equal(holds.stock({ ...FACTS.stock![0], quantityMilli: 6000 }), false, "réapprovisionné")
  })
})

describe("module source actif (génération et approbation)", () => {
  it("chaque règle a son module source ; approbation possible seulement si ce module est activé", () => {
    assert.deepEqual(Object.keys(RULE_SOURCE).sort(), Object.keys(RULE_LABEL).sort(), "toute règle a un module source")
    assert.deepEqual(RULE_SOURCE, { OPPORTUNITY_FOLLOW_UP_OVERDUE: "crm", STOCK_BELOW_MINIMUM: "stock" })
    assert.equal(isRuleSourceEnabled("OPPORTUNITY_FOLLOW_UP_OVERDUE", { crm: true, stock: false }), true)
    assert.equal(isRuleSourceEnabled("OPPORTUNITY_FOLLOW_UP_OVERDUE", { crm: false, stock: true }), false)
    assert.equal(isRuleSourceEnabled("STOCK_BELOW_MINIMUM", { crm: true, stock: false }), false)
    assert.equal(isRuleSourceEnabled("STOCK_BELOW_MINIMUM", { crm: false, stock: true }), true)
    assert.equal(isRuleSourceEnabled("OPPORTUNITY_FOLLOW_UP_OVERDUE", { crm: "true" as unknown as boolean, stock: true }), false, "drapeau strictement true")
    assert.equal(isRuleSourceEnabled("RESERVE_OVERDUE", { crm: false, stock: false }), true, "règle inconnue : relecture puis péremption")
    assert.match(ASSISTANT_ERRORS.sourceDisabled, /reste en attente/)
  })
})

describe("approbation", () => {
  const payload = { title: "Relancer Durand (OPP-2026-0001)", dueDate: "2026-11-04", worksiteId: "w1", priority: "MEDIUM" as const }
  it("intitulé et échéance ajustables ; échéance à midi UTC du jour choisi ; responsable facultatif", () => {
    assert.deepEqual(validateApproval(payload, {}), { ok: true, value: { title: payload.title, dueDate: new Date("2026-11-04T12:00:00Z"), assigneeId: null } })
    assert.deepEqual(validateApproval(payload, { title: "  Appeler M. Durand ", dueDate: "2026-11-06", assigneeId: "e1" }), { ok: true, value: { title: "Appeler M. Durand", dueDate: new Date("2026-11-06T12:00:00Z"), assigneeId: "e1" } })
    assert.deepEqual(validateApproval(payload, { title: "ab" }), { ok: false, error: ASSISTANT_ERRORS.title })
    assert.deepEqual(validateApproval(payload, { dueDate: "2026-02-31" }), { ok: false, error: ASSISTANT_ERRORS.dueDate })
    assert.deepEqual(validateApproval({ ...payload, dueDate: "" }, { dueDate: "" }), { ok: true, value: { title: payload.title, dueDate: null, assigneeId: null } })
  })
  it("relecture prudente des JSON stockés ; liens de source internes seulement", () => {
    assert.deepEqual(readPayload(payload), payload)
    for (const bad of [null, [], { ...payload, priority: "LOW" }, { ...payload, title: 1 }, { ...payload, worksiteId: 3 }]) assert.equal(readPayload(bad), null)
    const s = { type: "Opportunity", id: "o1", label: "L", href: "/crm/opportunites/o1", fact: "F" }
    assert.deepEqual(readSources([s, { ...s, href: "//evil.example" }, { ...s, href: "https://evil.example" }, { ...s, type: "User" }, { ...s, type: "WorksiteReserve" }, null]), [s], "type réserve du lot D non reconnu dans ce lot")
    assert.deepEqual(readSources({}), [])
  })
})

describe("fournisseur et réseau", () => {
  it("seul LOCAL_RULES est utilisable ; le fournisseur d'IA externe est déclaré non autorisé", () => {
    assert.equal(activeProvider().id, "LOCAL_RULES")
    assert.deepEqual(PROVIDERS.filter((p) => p.usable).map((p) => p.id), ["LOCAL_RULES"])
    assert.equal(PROVIDERS.find((p) => p.id === "EXTERNAL_LLM")?.usable, false)
    assert.equal(isAssistantEnabled({}), false)
    assert.equal(isAssistantEnabled({ ASSISTANT_ENABLED: "true" }), true)
    const sql = readFileSync("prisma/migrations/20261119120000_v2_lot_f_connectors_assistant/migration.sql", "utf8")
    assert.match(sql, /"provider" = 'LOCAL_RULES'/, "la base refuse tout autre fournisseur")
    const rules = /"rule" IN \(([^)]+)\)/.exec(sql)![1].split(",").map((r) => r.trim().replace(/'/g, ""))
    // SQL v6 conservé à l'identique : la base admet encore RESERVE_OVERDUE (règle reportée avec le lot D), que ce lot ne
    // produit jamais ; toute règle du code est admise par la base.
    assert.ok(Object.keys(RULE_LABEL).every((r) => rules.includes(r)), "toute règle du code est admise en base")
    assert.deepEqual(rules.filter((r) => !(r in RULE_LABEL)), ["RESERVE_OVERDUE"], "seul écart : la règle reportée du lot D")
    const codes = /"errorCode" IN \(([^)]+)\)/.exec(sql)![1].split(",").map((r) => r.trim().replace(/'/g, ""))
    assert.deepEqual(codes, [...SYNC_ERROR_CODES], "même liste fermée de codes d'erreur en base")
  })
  it("contrôle statique : aucun module réseau, aucun SDK d'IA, aucune variable d'environnement lue par l'assistant", () => {
    const files = [...readdirSync("src/lib/assistant").map((f) => `src/lib/assistant/${f}`), "src/lib/actions/assistant.actions.ts", "src/app/(dashboard)/assistant/page.tsx"]
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"))
      assert.doesNotMatch(c, /\bfetch\(|from "node:(?:http|https|net|tls)"|from "(?:http|https|axios|undici|node-fetch)"|https?:\/\/|openai|anthropic|@ai-sdk|ollama|groq|mistral|deepseek/i, f)
      if (!f.endsWith("assistant-feature-flag.ts")) assert.doesNotMatch(c, /process\.env/, f)
    }
  })
})
