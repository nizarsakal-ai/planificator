/**
 * LOT-2A — PostgreSQL InboundSource / InboundSourceRule + identité atomique.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import {
  InboundSourceConflictError,
  InboundSourceIdentityRequiredError,
  InboundSourceNotFoundError,
} from "@/lib/integration/persistence/inbound-source.errors"
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error(
    "Tests PG LOT-2A : fournir TEST_INTEGRATION_DATABASE_URL ou TEST_ACQUISITION_DATABASE_URL."
  )
  process.exit(1)
}
assertSafeDisposableTestDatabaseUrl(resolved.url)

const TEST_URL = resolved.url
const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } })
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

describe("LOT-2A InboundSource / Rule — PostgreSQL", () => {
  let companyA = ""
  let companyB = ""
  let sources: InboundSourceRepository
  let rules: InboundSourceRuleRepository
  let write: InboundSourceWriteService

  before(async () => {
    const tables = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'integration_inbound_sources'
      ) AS exists
    `
    assert.equal(tables[0]?.exists, true, "migration LOT-2A requise")

    const binding = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'integration_pipeline_bindings'
      ) AS exists
    `
    assert.equal(
      binding[0]?.exists,
      false,
      "aucune table PipelineBinding en LOT-2A"
    )

    const a = await db.company.create({
      data: { name: `Src A ${runId}`, slug: `src-a-${runId}` },
    })
    const b = await db.company.create({
      data: { name: `Src B ${runId}`, slug: `src-b-${runId}` },
    })
    companyA = a.id
    companyB = b.id
    sources = new InboundSourceRepository(db)
    rules = new InboundSourceRuleRepository(db)
    const identityTx = new InboundSourceIdentityTx(db)
    write = new InboundSourceWriteService(sources, rules, identityTx)
  })

  afterEach(async () => {
    await db.inboundSourceRule.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.inboundSource.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
  })

  after(async () => {
    await db.inboundSourceRule.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.inboundSource.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.company.deleteMany({
      where: { id: { in: [companyA, companyB] } },
    })
    await db.$disconnect()
  })

  it("CRUD Source enabled=false + Rule + cascade ; activation via write-service", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "Partenaires",
    })
    assert.equal(src.enabled, false)

    const rule = await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_DOMAIN",
      value: "@Example.COM",
    })
    assert.equal(rule.normalizedValue, "example.com")

    const enabled = await write.setSourceEnabled(companyA, src.id, true)
    assert.equal(enabled.enabled, true)

    await db.inboundSource.delete({
      where: { id_companyId: { id: src.id, companyId: companyA } },
    })
    await assert.rejects(
      () => rules.findById(companyA, rule.id),
      InboundSourceNotFoundError
    )
  })

  it("unicité + isolation tenant + identité avant enable", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "A",
    })
    await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_EMAIL",
      value: "a@b.co",
    })
    await assert.rejects(
      () =>
        write.createRule({
          companyId: companyA,
          sourceId: src.id,
          type: "SENDER_EMAIL",
          value: "A@B.CO",
        }),
      InboundSourceConflictError
    )

    const srcB = await write.createSource({
      companyId: companyB,
      displayName: "B",
    })
    await write.createRule({
      companyId: companyB,
      sourceId: srcB.id,
      type: "SENDER_EMAIL",
      value: "a@b.co",
    })

    await assert.rejects(
      () => sources.findById(companyB, src.id),
      InboundSourceNotFoundError
    )

    const alone = await write.createSource({
      companyId: companyA,
      displayName: "Alone",
    })
    await assert.rejects(
      () => write.setSourceEnabled(companyA, alone.id, true),
      InboundSourceIdentityRequiredError
    )
  })

  it("FK composite : rule sur mauvaise company refuse", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "FK",
    })
    await assert.rejects(
      () =>
        rules.create({
          companyId: companyB,
          sourceId: src.id,
          type: "SENDER_EMAIL",
          value: "x@y.zz",
          normalizedValue: "x@y.zz",
        }),
      InboundSourceNotFoundError
    )
  })

  it("rollback : disable dernière identité refuse sans mutation", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "Rollback",
    })
    const rule = await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_EMAIL",
      value: "solo@ex.com",
    })
    await write.setSourceEnabled(companyA, src.id, true)

    await assert.rejects(
      () => write.setRuleEnabled(companyA, rule.id, false),
      InboundSourceIdentityRequiredError
    )

    const still = await rules.findById(companyA, rule.id)
    assert.equal(still.enabled, true)
    const source = await sources.findById(companyA, src.id)
    assert.equal(source.enabled, true)
  })

  it("concurrence : Source active conserve ≥1 identité", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "Concurrent",
    })
    const r1 = await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_EMAIL",
      value: "a@ex.com",
    })
    const r2 = await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_DOMAIN",
      value: "ex.com",
    })
    await write.setSourceEnabled(companyA, src.id, true)

    const results = await Promise.allSettled([
      write.setRuleEnabled(companyA, r1.id, false),
      write.setRuleEnabled(companyA, r2.id, false),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)

    const source = await sources.findById(companyA, src.id)
    assert.equal(source.enabled, true)
    const identityLeft = await rules.countEnabledIdentityBySource(
      companyA,
      src.id
    )
    assert.ok(identityLeft >= 1)
  })

  it("repo.disable désactive ; pas d’activation publique via repo", async () => {
    const src = await write.createSource({
      companyId: companyA,
      displayName: "DisableOnly",
    })
    await write.createRule({
      companyId: companyA,
      sourceId: src.id,
      type: "SENDER_EMAIL",
      value: "z@ex.com",
    })
    await write.setSourceEnabled(companyA, src.id, true)
    const disabled = await sources.disable(companyA, src.id)
    assert.equal(disabled.enabled, false)
    assert.equal(
      typeof (sources as { setEnabled?: unknown }).setEnabled,
      "undefined"
    )
    assert.equal(
      typeof (rules as { setEnabled?: unknown }).setEnabled,
      "undefined"
    )
  })
})
