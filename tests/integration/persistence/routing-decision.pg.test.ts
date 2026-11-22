/**
 * LOT-2C — PostgreSQL : décisions du Router (SPEC LOT-2 §9.2, §19, §20.2).
 * Idempotence, concurrence `Promise.all`, isolation tenant, garde-fous en base, Envelope inchangée. Base jetable migrée.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG LOT-2C : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
const RCV = "rcv1_" + "a".repeat(64)
let A = "", B = "", connA = "", connB = ""

const ON = { INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true", INTEGRATION_ROUTING_ENABLED: "true", INTEGRATION_ROUTING_COMPANY_ALLOWLIST: "" }
const router = () => new TenantRouterService({
  normalized: new NormalizedInboundRepository(db),
  config: new RoutingConfigSnapshotRepository(db),
  decisions: new RoutingDecisionRepository(db),
  env: { ...ON, INTEGRATION_ROUTING_COMPANY_ALLOWLIST: `${A},${B}` },
  log: () => undefined,
})

async function seedNormalized(companyId: string, connectionId: string, key: string, sender = "contact@maison-martin.fr") {
  const env = await new InboundEnvelopeRepository(db).createIdempotent({
    companyId, connectionId, externalId: `ext-${key}`, idempotencyKey: `idem-${key}`,
    receivedAt: "2026-11-22T10:00:00.000Z", payloadRef: `p-${key}`, contentType: "application/json",
  })
  const n = await new NormalizedInboundRepository(db).create({
    companyId, connectionId, envelopeId: env.id, family: "MESSAGE",
    occurredAt: "2026-11-22T09:00:00.000Z", receivedAt: "2026-11-22T10:00:00.000Z", normalizedHash: `h-${key}`, artifactRefs: [],
    message: { externalMessageId: `m-${key}`, contentCapabilities: [], sender: { email: sender }, subject: "Demande de devis" },
  })
  return { envelopeId: env.id, normalizedId: n.id }
}
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  A = (await db.company.create({ data: { name: `Rd A ${run}`, slug: `rd-a-${run}` } })).id
  B = (await db.company.create({ data: { name: `Rd B ${run}`, slug: `rd-b-${run}` } })).id
  for (const [co, set] of [[A, (v: string) => (connA = v)], [B, (v: string) => (connB = v)]] as const) {
    const c = await db.integrationConnection.create({ data: { companyId: co, connectorType: "fixture.connector", displayName: `Rd ${run}`, status: "ACTIVE", secretBackend: "PLATFORM_ENCRYPTED", config: {} } })
    set(c.id)
  }
  // Configuration de A : Source active « Maison Martin » (identité domaine) + Binding actif.
  const write = new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db))
  const src = await write.createSource({ companyId: A, displayName: "Maison Martin" })
  await write.createRule({ companyId: A, sourceId: src.id, type: "SENDER_DOMAIN", value: "maison-martin.fr" })
  const b = await new PipelineBindingRepository(db).create({ companyId: A, sourceId: src.id })
  await new PipelineBindingRepository(db).setEnabled(A, b.id, true)
  await write.setSourceEnabled(A, src.id, true)
})
after(async () => {
  await db.company.deleteMany({ where: { id: { in: [A, B] } } })
  await db.$disconnect()
})

describe("Router de bout en bout (shadow)", () => {
  it("MATCH persisté ; rejeu : même décision, une seule ligne ; Envelope inchangée", async () => {
    const { envelopeId, normalizedId } = await seedNormalized(A, connA, `m1${run}`)
    const before = await db.inboundEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
    const a = await router().route({ companyId: A, normalizedInboundId: normalizedId })
    const b = await router().route({ companyId: A, normalizedInboundId: normalizedId })
    assert.ok(a.status === "DECIDED" && b.status === "DECIDED")
    assert.deepEqual([a.decision.outcome, a.decision.pipelineIds, a.reused], ["MATCH", ["consultations"], false])
    assert.deepEqual([b.decision.id, b.decision.outcome, b.reused], [a.decision.id, "MATCH", true])
    assert.equal(await db.routingDecision.count({ where: { normalizedInboundId: normalizedId } }), 1)
    const afterEnv = await db.inboundEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
    assert.deepEqual([afterEnv.lifecycleStatus, afterEnv.updatedAt.getTime()], [before.lifecycleStatus, before.updatedAt.getTime()])
  })
  it("société sans configuration : NO_MATCH ; la configuration de A n'est jamais lue pour B", async () => {
    const { normalizedId } = await seedNormalized(B, connB, `b1${run}`)
    const r = await router().route({ companyId: B, normalizedInboundId: normalizedId })
    assert.ok(r.status === "DECIDED")
    assert.deepEqual([r.decision.outcome, r.decision.reasonCode], ["NO_MATCH", "NO_ENABLED_SOURCE"])
  })
  it("NormalizedInbound d'une autre société : introuvable, aucune décision", async () => {
    const { normalizedId } = await seedNormalized(B, connB, `b2${run}`)
    await assert.rejects(router().route({ companyId: A, normalizedInboundId: normalizedId }))
    assert.equal(await db.routingDecision.count({ where: { normalizedInboundId: normalizedId } }), 0)
  })
})

describe("Dépôt idempotent", () => {
  it("Promise.all concurrent sur la même clé : une seule ligne, même décision pour tous", async () => {
    const { normalizedId } = await seedNormalized(A, connA, `c1${run}`)
    const repo = new RoutingDecisionRepository(db)
    const input = { companyId: A, normalizedInboundId: normalizedId, outcome: "NO_MATCH" as const, matchedSourceIds: [], pipelineIds: [], routingConfigurationVersion: RCV }
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.record(input)))
    assert.equal(new Set(results.map((r) => r.decision.id)).size, 1)
    assert.equal(results.filter((r) => !r.reused).length, 1)
    assert.equal(await db.routingDecision.count({ where: { normalizedInboundId: normalizedId } }), 1)
  })
  it("rejeu avec un autre outcome : l'outcome stocké reste l'original", async () => {
    const { normalizedId } = await seedNormalized(A, connA, `c2${run}`)
    const repo = new RoutingDecisionRepository(db)
    const base = { companyId: A, normalizedInboundId: normalizedId, matchedSourceIds: [], pipelineIds: [], routingConfigurationVersion: RCV }
    await repo.record({ ...base, outcome: "NO_MATCH" })
    const again = await repo.record({ ...base, outcome: "ERROR", reasonCode: "X" })
    assert.deepEqual([again.reused, again.decision.outcome], [true, "NO_MATCH"])
  })
})

describe("garde-fous en base", () => {
  it("UPDATE refusé ; DUPLICATE, empreinte invalide, incohérence outcome ↔ listes refusés ; NormalizedInbound d'une autre société refusé", async () => {
    const { normalizedId } = await seedNormalized(A, connA, `g1${run}`)
    const ins = (id: string, outcome: string, matched: string, pipes: string, rcv = RCV, co = A) =>
      `INSERT INTO integration_routing_decisions(id,"companyId","normalizedInboundId",outcome,"matchedSourceIds","pipelineIds","routingConfigurationVersion") VALUES ('${id}${run}','${co}','${normalizedId}','${outcome}','${matched}','${pipes}','${rcv}')`
    assert.equal(await sqlError(ins("ok", "NO_MATCH", "{}", "{}")), "NO_ERROR")
    assert.match(await sqlError(`UPDATE integration_routing_decisions SET outcome = 'ERROR' WHERE id = 'ok${run}'`), /routing decision is immutable/)
    assert.match(await sqlError(ins("d1", "DUPLICATE", "{}", "{}", "rcv1_" + "b".repeat(64))), /values_check/)
    assert.match(await sqlError(ins("d2", "NO_MATCH", "{}", "{}", "v1")), /values_check/)
    assert.match(await sqlError(ins("d3", "MATCH", "{s1}", "{}", "rcv1_" + "c".repeat(64))), /values_check/)
    assert.match(await sqlError(ins("d4", "AMBIGUOUS_SOURCE", "{s1}", "{}", "rcv1_" + "d".repeat(64))), /values_check/)
    assert.match(await sqlError(ins("d5", "MATCH", "{s1}", "{autre}", "rcv1_" + "e".repeat(64))), /values_check/)
    assert.match(await sqlError(ins("d6", "NO_MATCH", "{}", "{}", "rcv1_" + "f".repeat(64), B)), /normalized_fkey/)
  })
  it("suppression du NormalizedInbound : ses décisions partent en cascade", async () => {
    const { envelopeId, normalizedId } = await seedNormalized(A, connA, `g2${run}`)
    await new RoutingDecisionRepository(db).record({ companyId: A, normalizedInboundId: normalizedId, outcome: "NO_MATCH", matchedSourceIds: [], pipelineIds: [], routingConfigurationVersion: RCV })
    await db.inboundEnvelope.delete({ where: { id: envelopeId } })
    assert.equal(await db.routingDecision.count({ where: { normalizedInboundId: normalizedId } }), 0)
  })
})
