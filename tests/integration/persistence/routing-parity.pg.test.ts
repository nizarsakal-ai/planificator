/**
 * LOT-2D — PostgreSQL : shadow matching de bout en bout et table de parité (SPEC LOT-2 §14, §20.2, §20.3 ; plan I5).
 * Base jetable migrée.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { RoutingParityObservationRepository } from "@/lib/integration/persistence/routing-parity-observation.repository"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import { RoutingShadowService, hashExternalId } from "@/lib/integration/shadow/routing-shadow.service"
import { mapCanonicalMailToShadowDto } from "@/lib/acquisition/connector/mail-shadow-dto.mapper"
import { MailShadowBridgeService } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG LOT-2D : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
let A = "", conn = ""

function shadow() {
  const env = {
    INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
    INTEGRATION_ROUTING_ENABLED: "true",
    INTEGRATION_ROUTING_SHADOW_ENABLED: "true",
    INTEGRATION_ROUTING_COMPANY_ALLOWLIST: A,
  }
  const envelopes = new InboundEnvelopeRepository(db)
  const normalized = new NormalizedInboundRepository(db)
  return new RoutingShadowService({
    env,
    log: () => undefined,
    observations: new RoutingParityObservationRepository(db),
    router: new TenantRouterService({ env, normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db), log: () => undefined }),
    findNormalizedId: async (companyId, connectionId, key) => {
      const e = await envelopes.findByIdempotencyKey(companyId, connectionId, key).catch(() => null)
      if (!e) return null
      return (await normalized.findByEnvelopeVersion(companyId, e.id, "MESSAGE", "1.0.0")).id
    },
  })
}

async function seed(key: string, sender: string) {
  const env = await new InboundEnvelopeRepository(db).createIdempotent({
    companyId: A, connectionId: conn, externalId: key, idempotencyKey: key,
    receivedAt: "2026-11-22T10:00:00.000Z", payloadRef: `mail:${key}`, contentType: "application/json",
  })
  await new NormalizedInboundRepository(db).create({
    companyId: A, connectionId: conn, envelopeId: env.id, family: "MESSAGE",
    occurredAt: "2026-11-22T09:00:00.000Z", receivedAt: "2026-11-22T10:00:00.000Z", normalizedHash: `h-${key}`, artifactRefs: [],
    message: { externalMessageId: key, contentCapabilities: [], sender: { email: sender } },
  })
  return env.id
}
const input = (key: string, legacyOutcome: string) => ({ companyId: A, connectionId: conn, idempotencyKey: key, externalId: key, legacyOutcome, deadlineAtMs: Date.now() + 60_000 })
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  A = (await db.company.create({ data: { name: `Par ${run}`, slug: `par-${run}` } })).id
  conn = (await db.integrationConnection.create({ data: { companyId: A, connectorType: "platform.mail.legacy", displayName: `Par ${run}`, status: "ACTIVE", secretBackend: "LEGACY_GMAIL", config: {} } })).id
  const write = new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db))
  const src = await write.createSource({ companyId: A, displayName: "Maison Martin" })
  await write.createRule({ companyId: A, sourceId: src.id, type: "SENDER_DOMAIN", value: "maison-martin.fr" })
  const b = await new PipelineBindingRepository(db).create({ companyId: A, sourceId: src.id })
  await new PipelineBindingRepository(db).setEnabled(A, b.id, true)
  await write.setSourceEnabled(A, src.id, true)
})
after(async () => {
  await db.company.deleteMany({ where: { id: A } })
  await db.$disconnect()
})

describe("shadow matching de bout en bout", () => {
  it("un en-tête Gmail avec nom affiché donne une parité positive sur le domaine réel", async () => {
    const key = "from-display-name"
    const mapped = mapCanonicalMailToShadowDto({
      externalMessageId: key, fromHeader: '"Maison Martin" <Devis@MAISON-MARTIN.FR>',
      receivedAt: new Date("2026-11-22T10:00:00.000Z"), subject: "Consultation fictive",
      threadId: null, labels: [], snippet: null, attachments: [], providerMetadata: {},
    }, { companyId: A, connectionId: conn })
    assert.ok(mapped.ok)
    await new MailShadowBridgeService(db).project(mapped.dto, { stats: createMailShadowRunStats() })
    assert.deepEqual(await shadow().observe(input(key, "DRAFT_CREATED")), {
      status: "OBSERVED", parityOutcome: "PARITY_MATCH", recorded: true,
    })
  })

  it("admit legacy × MATCH → PARITY_MATCH ; décision et observation liées ; Envelope inchangée ; aucun brouillon", async () => {
    const key = `k1${run}`
    const envelopeId = await seed(key, "contact@maison-martin.fr")
    const before = await db.inboundEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
    const draftsBefore = await db.worksiteImportDraft.count({ where: { companyId: A } })
    const r = await shadow().observe(input(key, "DRAFT_CREATED"))
    assert.deepEqual(r, { status: "OBSERVED", parityOutcome: "PARITY_MATCH", recorded: true })
    const obs = await db.routingParityObservation.findFirstOrThrow({ where: { companyId: A, externalIdHash: hashExternalId(key) } })
    const decision = await db.routingDecision.findUniqueOrThrow({ where: { id: obs.routingDecisionId! } })
    assert.deepEqual([obs.legacyOutcome, obs.routerOutcome, decision.outcome, obs.routingConfigurationVersion], ["ADMIT", "MATCH", "MATCH", decision.routingConfigurationVersion])
    assert.deepEqual(obs.explainedCodes, ["EXPLAINED_MATCH_NO_DRAFT"])
    const afterEnv = await db.inboundEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
    assert.deepEqual([afterEnv.lifecycleStatus, afterEnv.updatedAt.getTime()], [before.lifecycleStatus, before.updatedAt.getTime()])
    assert.equal(await db.worksiteImportDraft.count({ where: { companyId: A } }), draftsBefore)
  })
  it("rejeu du même message : ni nouvelle décision ni nouvelle observation", async () => {
    const key = `k2${run}`
    await seed(key, "contact@maison-martin.fr")
    await shadow().observe(input(key, "DRAFT_CREATED"))
    const again = await shadow().observe(input(key, "DRAFT_CREATED"))
    assert.ok(again.status === "OBSERVED" && again.recorded === false)
    assert.equal(await db.routingParityObservation.count({ where: { companyId: A, externalIdHash: hashExternalId(key) } }), 1)
  })
  it("admit legacy × NO_MATCH → PARITY_LEGACY_ONLY ; message inconnu → PARITY_UNCOMPARABLE sans décision", async () => {
    await seed(`k3${run}`, "x@autre.fr")
    assert.equal((await shadow().observe(input(`k3${run}`, "DRAFT_CREATED"))).status, "OBSERVED")
    const o = await db.routingParityObservation.findFirstOrThrow({ where: { externalIdHash: hashExternalId(`k3${run}`) } })
    assert.deepEqual([o.parityOutcome, o.routerOutcome], ["PARITY_LEGACY_ONLY", "NO_MATCH"])
    await shadow().observe(input(`absent${run}`, "REJECTED"))
    const u = await db.routingParityObservation.findFirstOrThrow({ where: { externalIdHash: hashExternalId(`absent${run}`) } })
    assert.deepEqual([u.parityOutcome, u.comparisonCode, u.routingDecisionId, u.normalizedInboundId], ["PARITY_UNCOMPARABLE", "NORMALIZED_NOT_FOUND", null, null])
  })
})

describe("garde-fous en base", () => {
  it("UPDATE refusé ; codes hors liste, hash invalide, décision sans outcome, parité impossible refusés", async () => {
    const h = "b".repeat(64)
    const ins = (cols: string, vals: string) => `INSERT INTO integration_routing_parity_observations(id,"companyId","externalIdHash",${cols}) VALUES ('${Math.random().toString(36).slice(2)}','${A}',${vals})`
    assert.equal(await sqlError(ins(`"legacyOutcome","parityOutcome"`, `'${h}','UNKNOWN','PARITY_UNCOMPARABLE'`)), "NO_ERROR")
    const id = (await db.routingParityObservation.findFirstOrThrow({ where: { companyId: A, externalIdHash: h } })).id
    assert.match(await sqlError(`UPDATE integration_routing_parity_observations SET "parityOutcome" = 'PARITY_ERROR' WHERE id = '${id}'`), /immutable/)
    assert.match(await sqlError(ins(`"legacyOutcome","parityOutcome"`, `'${h}','ADMIT','PARITY_MATCH'`)), /values_check/, "PARITY_MATCH sans décision Router")
    assert.match(await sqlError(ins(`"legacyOutcome","parityOutcome"`, `'not-a-hash','UNKNOWN','PARITY_UNCOMPARABLE'`)), /values_check/)
    assert.match(await sqlError(ins(`"legacyOutcome","parityOutcome","explainedCodes"`, `'${h}','UNKNOWN','PARITY_UNCOMPARABLE','{EXPLAINED_AUTRE}'`)), /values_check/)
    assert.match(await sqlError(ins(`"legacyOutcome","parityOutcome","routerOutcome"`, `'${h}','ADMIT','PARITY_UNCOMPARABLE','MATCH'`)), /values_check/, "outcome Router sans décision")
    assert.match(await sqlError(ins(`"legacyOutcome","parityOutcome","parityBaselineCode"`, `'${h}','UNKNOWN','PARITY_UNCOMPARABLE','L2'`)), /values_check/)
  })
  it("suppression du message normalisé : observations et décisions partent en cascade", async () => {
    const key = `k4${run}`
    const envelopeId = await seed(key, "contact@maison-martin.fr")
    await shadow().observe(input(key, "DRAFT_CREATED"))
    await db.inboundEnvelope.delete({ where: { id: envelopeId } })
    assert.equal(await db.routingParityObservation.count({ where: { externalIdHash: hashExternalId(key) } }), 0)
  })
})
