import assert from "node:assert/strict"
import { after, it } from "node:test"
import type { Message } from "@anthropic-ai/sdk/resources/messages"
import { PrismaClient } from "@prisma/client"
import { consultationSummaryConfig, reserveConsultationSummary, summarizeConsultation } from "@/lib/acquisition/assistant/consultation-summary"
import { assertSafeDisposableTestDatabaseUrl } from "./helpers/safe-test-database-url"

const url = process.env.TEST_CONSULTATION_AI_DATABASE_URL
if (!url) throw new Error("Base PostgreSQL jetable requise")
assertSafeDisposableTestDatabaseUrl(url)
const target = new URL(url)
assert.equal(target.hostname, "127.0.0.1")
assert.equal(target.pathname, "/pgtest_consultation_ai")

const db = new PrismaClient({ datasources: { db: { url } } })
after(() => db.$disconnect())

it("isole l’assistant et refuse un plafond manquant ou hors limites", () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: "fixture", CONSULTATION_AI_COMPANY_ID: "pilote", CONSULTATION_AI_DAILY_LIMIT: "20" }
  assert.equal(consultationSummaryConfig("pilote", env)?.dailyLimit, 20)
  assert.equal(consultationSummaryConfig("autre", env), null)
  assert.equal(consultationSummaryConfig("pilote", { ...env, CONSULTATION_AI_DAILY_LIMIT: "" }), null)
  assert.equal(consultationSummaryConfig("pilote", { ...env, CONSULTATION_AI_DAILY_LIMIT: "21" }), null)
})

it("réserve le quota quotidien sous concurrence sans conserver le contenu", async () => {
  const company = await db.company.create({ data: { name: "Pilote fictif", slug: "ia-fictive" } })
  const actor = await db.user.create({
    data: { companyId: company.id, email: "admin@example.test", password: "fixture", role: "ADMIN" },
  })
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => reserveConsultationSummary(db, {
    companyId: company.id, actorId: actor.id, draftId: `brouillon-${i}`, dailyLimit: 2,
  })))
  assert.equal(results.filter(Boolean).length, 2)
  const reservations = await db.historyLog.findMany({ where: { companyId: company.id, entityType: "ConsultationAIRequest" } })
  assert.equal(reservations.length, 2)
  assert.ok(reservations.every(row => row.detail === null && row.oldValue === null && row.newValue === null))
})

it("appelle uniquement Haiku 5.5 avec un message borné et aucune relance", async () => {
  const summary = await summarizeConsultation({ subject: "Fictif", text: "a".repeat(13_000) }, {
    messagesCreate: async (request, options) => {
      assert.equal(request.model, "claude-haiku-5-5")
      assert.equal(request.max_tokens, 640)
      assert.equal(request.tools, undefined)
      assert.equal(options?.maxRetries, 0)
      const content = request.messages[0].content
      assert.equal(typeof content, "string")
      const payload = JSON.parse(content as string)
      assert.equal(payload.courriel.length, 12_000)
      assert.equal(payload.tronque, true)
      return { content: [{ type: "text", text: "Résumé fictif." }] } as Message
    },
  })
  assert.equal(summary, "Résumé fictif.")
})
