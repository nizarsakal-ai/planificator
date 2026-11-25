/**
 * Assistant IA, étape 2 : onglets Propositions et Journal sur base PostgreSQL JETABLE migrée, deux sociétés jumelles.
 * Vraies requêtes : chaque source n'est lue que pour le tenant validé par SA garde ; aucune ligne de l'autre société.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh onglets npm run test:copilot:onglets:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { MAX_JOURNAL_ROWS, readJournal, readPendingProposals } from "@/lib/copilot/copilot-tabs"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 24, h, m))

async function seed(p: "a" | "b") {
  const companyId = `co_${p}`
  await db.company.create({ data: { id: companyId, name: `Société ${p}`, slug: `onglets-${p}` } })
  await db.user.create({ data: { id: `${p}_admin`, email: `${p}.admin@onglets.test`, password: "x", role: "ADMIN", companyId } })
  const base = { companyId, provider: "LOCAL_RULES", rationale: "Seuil dépassé", action: "CREATE_TASK" as const, payload: { title: "x", dueDate: "2026-11-30", worksiteId: null, priority: "MEDIUM" }, sources: [{ type: "StockLevel", id: "s", label: "l", href: "/stock", fact: "f" }], createdById: `${p}_admin` }
  await db.assistantProposal.create({ data: { ...base, id: `${p}_p1`, sourceKey: `${p}:stk:1`, rule: "STOCK_BELOW_MINIMUM", title: `Réapprovisionner ${p.toUpperCase()}`, createdAt: at(8) } })
  // Une proposition naît toujours en attente (déclencheur) : création, puis refus.
  await db.assistantProposal.create({ data: { ...base, id: `${p}_p2`, sourceKey: `${p}:stk:2`, rule: "STOCK_BELOW_MINIMUM", title: `Refusée ${p.toUpperCase()}`, createdAt: at(7) } })
  await db.assistantProposal.update({ where: { id: `${p}_p2` }, data: { status: "REJECTED", decidedById: `${p}_admin`, decidedAt: at(9) } })
  await db.assistantActionLog.create({ data: { companyId, proposalId: `${p}_p1`, event: "GENERATED", actorId: `${p}_admin`, detail: `Proposée ${p.toUpperCase()}`, createdAt: at(8) } })
  await db.assistantActionLog.create({ data: { companyId, proposalId: `${p}_p2`, event: "REJECTED", actorId: `${p}_admin`, detail: `Refusée ${p.toUpperCase()}`, createdAt: at(9) } })
  await db.historyLog.create({ data: { companyId, actorId: `${p}_admin`, action: "CREATED", entityType: "CopilotAction", entityId: `${p}-nonce`, detail: "Assistant IA : TASK", createdAt: at(10) } })
  await db.historyLog.create({ data: { companyId, actorId: `${p}_admin`, action: "CREATED", entityType: "CopilotRequest", createdAt: at(11) } }) // quota : jamais dans le journal
}

before(async () => { await seed("a"); await seed("b") })
after(async () => { await db.$disconnect() })

const A = { ok: true as const, companyId: "co_a" }

describe("onglet Propositions (vraie base)", () => {
  it("seulement les propositions EN ATTENTE de la société validée", async () => {
    const rows = await readPendingProposals(db, A)
    assert.deepEqual(rows.map((r) => r.title), ["Réapprovisionner A"])
    assert.equal(rows[0].href, "/assistant#proposition-a_p1")
  })
  it("garde refusée : aucune ligne", async () => {
    assert.deepEqual(await readPendingProposals(db, { ok: false, status: 403 }), [])
  })
})

describe("onglet Journal (vraie base)", () => {
  it("deux gardes ok (société A) : règles et assistant IA de A seulement, triés par date, sans compteur de quota", async () => {
    const rows = await readJournal(db, { rules: A, copilotAdmin: A })
    assert.deepEqual(rows.map((r) => [r.source, r.detail]), [
      ["assistant-ia", "Tâche créée"], ["regles", "Refusée A"], ["regles", "Proposée A"],
    ])
    assert.ok(rows.length <= MAX_JOURNAL_ROWS)
    assert.ok(!rows.some((r) => /B\b/.test(r.detail)), "aucune ligne de la société B")
  })
  it("lot F refusé : seulement l'assistant IA de A", async () => {
    const rows = await readJournal(db, { rules: { ok: false, status: 404 }, copilotAdmin: A })
    assert.deepEqual(rows.map((r) => r.source), ["assistant-ia"])
  })
  it("copilote refusé : seulement les règles de A", async () => {
    const rows = await readJournal(db, { rules: A, copilotAdmin: { ok: false, status: 403 } })
    assert.deepEqual([...new Set(rows.map((r) => r.source))], ["regles"])
  })
  it("gardes sur deux sociétés différentes : rien de la société des règles (B)", async () => {
    const rows = await readJournal(db, { rules: { ok: true, companyId: "co_b" }, copilotAdmin: A })
    assert.deepEqual(rows.map((r) => [r.source, r.detail]), [["assistant-ia", "Tâche créée"]])
  })
  it("aucune garde : aucune ligne", async () => {
    assert.deepEqual(await readJournal(db, { rules: { ok: false, status: 403 }, copilotAdmin: { ok: false, status: 403 } }), [])
  })
})
