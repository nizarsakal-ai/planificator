/**
 * LOT-2E — PostgreSQL : amorçage du pilote puis simulation sur la configuration amorcée (plan I7, I8 ; SPEC §20.4).
 * Base jetable migrée.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { applyPilotSeedPlan, buildPilotSeedPlan } from "@/lib/integration/sources/pilot-seed"
import { RoutingConfigAdminService } from "@/lib/integration/sources/routing-config-admin.service"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { RoutingConfigAuditRepository } from "@/lib/integration/persistence/routing-config-audit.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { simulateRouting } from "@/lib/integration/simulator/simulate-routing"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG LOT-2E : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
let A = "", U = ""
const admin = () => new RoutingConfigAdminService(
  new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db)),
  new PipelineBindingRepository(db), new RoutingConfigAuditRepository(db),
)
const partners = [
  { id: "p1", name: "Maison Martin", pipeline: "consultations", active: true, requireExactEmail: false, domains: [{ value: "maison-martin.fr", active: true }], emails: [] },
  { id: "p2", name: "Agence Exacte", pipeline: "consultations", active: true, requireExactEmail: true, domains: [{ value: "exacte.fr", active: true }], emails: [{ value: "devis@exacte.fr", active: true }] },
  { id: "p3", name: "Ancien", pipeline: "consultations", active: false, requireExactEmail: false, domains: [{ value: "ancien.fr", active: true }], emails: [] },
]
const msg = (email: string) => ({ externalMessageId: `sim-${run}`, contentCapabilities: [], sender: { email } })

before(async () => {
  A = (await db.company.create({ data: { name: `Seed ${run}`, slug: `seed-${run}` } })).id
  U = (await db.user.create({ data: { email: `seed-${run}@x.test`, password: "x", role: "ADMIN", companyId: A } })).id
})
after(async () => {
  await db.historyLog.deleteMany({ where: { companyId: A } })
  await db.company.deleteMany({ where: { id: A } })
  await db.user.deleteMany({ where: { id: U } })
  await db.$disconnect()
})

describe("amorçage du pilote puis simulation", () => {
  it("crée Sources actives, règles et Bindings ; audit sans valeur ; rejeu sans doublon", async () => {
    const actor = { companyId: A, userId: U, role: "ADMIN" }
    const r = await applyPilotSeedPlan(buildPilotSeedPlan(partners, []), actor, admin())
    assert.deepEqual([r.created.length, r.failed.length], [2, 0])
    const sources = await db.inboundSource.findMany({ where: { companyId: A }, include: { rules: true, bindings: true } })
    assert.ok(sources.every((s) => s.enabled && s.bindings.length === 1 && s.bindings[0]!.enabled))
    const exacte = sources.find((s) => s.displayName === "Agence Exacte")!
    assert.deepEqual(exacte.rules.map((x) => x.type), ["SENDER_EMAIL"], "email exact requis : pas de règle de domaine")
    const logs = await db.historyLog.findMany({ where: { companyId: A } })
    assert.ok(logs.length > 0)
    assert.doesNotMatch(JSON.stringify(logs), /maison-martin\.fr|devis@exacte/i)
    const replay = buildPilotSeedPlan(partners, sources.map((s) => s.displayName))
    assert.deepEqual([replay.sources.length, replay.skipped.filter((s) => s.code === "ALREADY_SEEDED").length], [0, 2])
  })
  it("simulation : MATCH sur domaine amorcé, NO_MATCH sur domaine seul quand l'email exact est requis ; aucune écriture", async () => {
    const actor = { companyId: A, userId: U, role: "ADMIN" }
    const before = await Promise.all([db.routingDecision.count({ where: { companyId: A } }), db.historyLog.count({ where: { companyId: A } }), db.normalizedInbound.count({ where: { companyId: A } }), db.inboundEnvelope.count({ where: { companyId: A } }), db.routingParityObservation.count({ where: { companyId: A } })])
    const deps = { config: new RoutingConfigSnapshotRepository(db) }
    const a = await simulateRouting(actor, { message: msg("contact@maison-martin.fr") }, deps)
    const b = await simulateRouting(actor, { message: msg("autre@exacte.fr") }, deps)
    const c = await simulateRouting(actor, { message: msg("devis@exacte.fr") }, deps)
    assert.deepEqual([a.outcome, b.outcome, c.outcome], ["MATCH", "NO_MATCH", "MATCH"])
    assert.equal(a.routingConfigurationVersion, c.routingConfigurationVersion)
    const afterCounts = await Promise.all([db.routingDecision.count({ where: { companyId: A } }), db.historyLog.count({ where: { companyId: A } }), db.normalizedInbound.count({ where: { companyId: A } }), db.inboundEnvelope.count({ where: { companyId: A } }), db.routingParityObservation.count({ where: { companyId: A } })])
    assert.deepEqual(afterCounts, before)
  })
})
