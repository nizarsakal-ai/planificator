/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B1
 * Tests PostgreSQL réels — IntegrationConnection repository + contraintes.
 *
 * Base jetable uniquement via :
 *   TEST_INTEGRATION_DATABASE_URL  (prioritaire)
 *   ou TEST_ACQUISITION_DATABASE_URL (convention dépôt)
 *
 * Prérequis : `npm run test:integration:persistence:pg` (pré-vol require-pg-env).
 * Sans URL sûre : échec explicite (pas de skip silencieux).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  INTEGRATION_CONNECTION_ERROR,
  IntegrationConnectionNotFoundError,
  IntegrationConnectionPersistenceError,
  IntegrationConnectionValidationError,
} from "@/lib/integration/persistence/integration-connection.errors"
import {
  IntegrationConnectionRepository,
} from "@/lib/integration/persistence/integration-connection.repository"
import type { CreateIntegrationConnectionInput } from "@/lib/integration/persistence/integration-connection.mapper"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { CREDENTIAL_STATUSES } from "@/lib/integration/types/credential-status"
import { RUNTIME_HEALTH_STATUSES } from "@/lib/integration/types/runtime-health"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error(
    "Tests PG IntegrationConnection : fournir TEST_INTEGRATION_DATABASE_URL ou TEST_ACQUISITION_DATABASE_URL."
  )
  process.exit(1)
}
assertSafeDisposableTestDatabaseUrl(resolved.url)

const TEST_URL = resolved.url

const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } })

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function createInput(
  companyId: string,
  overrides: Partial<CreateIntegrationConnectionInput> = {}
): CreateIntegrationConnectionInput {
  return {
    companyId,
    connectorType: "fixture.connector.type",
    displayName: `Conn-${runId}`,
    status: CONNECTION_STATUSES.PENDING_AUTH,
    secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
    config: { publicFlag: true },
    ...overrides,
  }
}

describe("LOT-1B1 IntegrationConnection — PostgreSQL", () => {
  let companyA = ""
  let companyB = ""
  let repo: IntegrationConnectionRepository

  before(async () => {
    const a = await db.company.create({
      data: {
        name: `IntConn A ${runId}`,
        slug: `int-conn-a-${runId}`,
      },
    })
    const b = await db.company.create({
      data: {
        name: `IntConn B ${runId}`,
        slug: `int-conn-b-${runId}`,
      },
    })
    companyA = a.id
    companyB = b.id
    repo = new IntegrationConnectionRepository(db)
  })

  afterEach(async () => {
    await db.integrationConnection.deleteMany({
      where: { companyId: { in: [companyA, companyB].filter(Boolean) } },
    })
  })

  after(async () => {
    for (const companyId of [companyA, companyB]) {
      if (!companyId) continue
      await db.integrationConnection.deleteMany({ where: { companyId } })
      await db.company.delete({ where: { id: companyId } }).catch(() => undefined)
    }
    await db.$disconnect()
  })

  // ── Migration / schéma ───────────────────────────────────────────────────

  it("migration : table, enums, index, FK et unique (id, companyId) présents", async () => {
    const tables = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'integration_connections'
      ) AS exists
    `
    assert.equal(tables[0]?.exists, true)

    const enums = await db.$queryRaw<Array<{ typname: string }>>`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname IN (
          'IntegrationConnectionStatus',
          'IntegrationCredentialStatus',
          'IntegrationRuntimeHealth',
          'IntegrationSecretBackend'
        )
      ORDER BY t.typname
    `
    assert.deepEqual(
      enums.map((e) => e.typname),
      [
        "IntegrationConnectionStatus",
        "IntegrationCredentialStatus",
        "IntegrationRuntimeHealth",
        "IntegrationSecretBackend",
      ]
    )

    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'integration_connections'
      ORDER BY indexname
    `
    const names = indexes.map((i) => i.indexname)
    assert.ok(names.includes("integration_connections_pkey"))
    assert.ok(names.includes("integration_connections_id_companyId_key"))
    assert.ok(names.includes("integration_connections_companyId_status_idx"))
    assert.ok(names.includes("integration_connections_companyId_connectorType_idx"))

    const fks = await db.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT c.confdeltype
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'integration_connections'
        AND c.contype = 'f'
        AND c.conname = 'integration_connections_companyId_fkey'
    `
    assert.equal(fks.length, 1)
    // confdeltype 'c' = CASCADE
    assert.equal(fks[0]?.confdeltype, "c")
  })

  // ── Création ─────────────────────────────────────────────────────────────

  it("crée une connexion pour une entreprise existante (contrat + defaults)", async () => {
    const created = await repo.create(createInput(companyA))
    assert.equal(created.companyId, companyA)
    assert.equal(created.connectorType, "fixture.connector.type")
    assert.equal(created.status, CONNECTION_STATUSES.PENDING_AUTH)
    assert.equal(created.credentialStatus, CREDENTIAL_STATUSES.MISSING)
    assert.equal(created.runtimeHealth, RUNTIME_HEALTH_STATUSES.UNKNOWN)
    assert.equal(created.secretBackend, SECRET_BACKENDS.PLATFORM_ENCRYPTED)
    assert.equal(created.credentialsRef, undefined)
    assert.deepEqual(created.config, { publicFlag: true })
    assert.equal(created.schemaVersion, PLATFORM_SCHEMA_VERSION_V1)
    assert.match(created.createdAt, /Z$/)
    assert.match(created.updatedAt, /Z$/)
  })

  it("autorise deux connexions même connectorType et même displayName", async () => {
    const a = await repo.create(
      createInput(companyA, {
        connectorType: "same.type",
        displayName: "Same Name",
      })
    )
    const b = await repo.create(
      createInput(companyA, {
        connectorType: "same.type",
        displayName: "Same Name",
      })
    )
    assert.notEqual(a.id, b.id)
    const listed = await repo.listByCompany(companyA)
    assert.equal(listed.length, 2)
  })

  it("accepte credentialsRef opaque renseigné", async () => {
    const created = await repo.create(
      createInput(companyA, { credentialsRef: `cred-${runId}` })
    )
    assert.equal(created.credentialsRef, `cred-${runId}`)
  })

  // ── Isolation tenant ─────────────────────────────────────────────────────

  it("isole findById / updates / health par companyId", async () => {
    const created = await repo.create(createInput(companyA))

    const found = await repo.findById(companyA, created.id)
    assert.equal(found.id, created.id)

    await assert.rejects(
      () => repo.findById(companyB, created.id),
      (err: unknown) =>
        err instanceof IntegrationConnectionNotFoundError &&
        err.code === INTEGRATION_CONNECTION_ERROR.NOT_FOUND
    )

    await assert.rejects(
      () =>
        repo.updateStatus(companyB, created.id, CONNECTION_STATUSES.ACTIVE),
      (err: unknown) => err instanceof IntegrationConnectionNotFoundError
    )

    await assert.rejects(
      () =>
        repo.updateHealth(companyB, created.id, {
          runtimeHealth: RUNTIME_HEALTH_STATUSES.HEALTHY,
        }),
      (err: unknown) => err instanceof IntegrationConnectionNotFoundError
    )

    await assert.rejects(
      () => repo.findHealthById(companyB, created.id),
      (err: unknown) => err instanceof IntegrationConnectionNotFoundError
    )

    // La ligne n’a pas été mutée via le mauvais tenant
    const still = await repo.findById(companyA, created.id)
    assert.equal(still.status, CONNECTION_STATUSES.PENDING_AUTH)
  })

  // ── Contraintes / erreurs ────────────────────────────────────────────────

  it("companyId inexistant → PERSISTENCE sans fuite Prisma", async () => {
    await assert.rejects(
      () => repo.create(createInput("nonexistent-company-id-lot1b1")),
      (err: unknown) => {
        assert.ok(err instanceof IntegrationConnectionPersistenceError)
        assert.equal(err.code, INTEGRATION_CONNECTION_ERROR.PERSISTENCE_ERROR)
        assert.equal(err.message.includes("P2003"), false)
        assert.equal(err.message.toLowerCase().includes("foreign"), false)
        assert.equal("meta" in err, false)
        return true
      }
    )
  })

  it("input invalide → VALIDATION", async () => {
    await assert.rejects(
      () =>
        repo.create({
          companyId: companyA,
          connectorType: "fixture.connector.type",
          displayName: "X",
          status: CONNECTION_STATUSES.ACTIVE,
          secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
          config: { bad: Number.POSITIVE_INFINITY },
        }),
      (err: unknown) =>
        err instanceof IntegrationConnectionValidationError &&
        err.code === INTEGRATION_CONNECTION_ERROR.VALIDATION_ERROR
    )
  })

  it("enregistrement absent → NOT_FOUND", async () => {
    await assert.rejects(
      () => repo.findById(companyA, "missing-connection-id"),
      (err: unknown) => err instanceof IntegrationConnectionNotFoundError
    )
  })

  it("id dupliqué rejeté (PK) — contrainte composite (id, companyId) utilisable", async () => {
    const fixedId = `fixed-conn-${runId}`
    await db.integrationConnection.create({
      data: {
        id: fixedId,
        companyId: companyA,
        connectorType: "fixture.connector.type",
        displayName: "Fixed",
        status: CONNECTION_STATUSES.ACTIVE,
        secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
        config: {},
      },
    })

    await assert.rejects(
      () =>
        db.integrationConnection.create({
          data: {
            id: fixedId,
            companyId: companyA,
            connectorType: "fixture.connector.type",
            displayName: "Dup",
            status: CONNECTION_STATUSES.ACTIVE,
            secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
            config: {},
          },
        }),
      (err: unknown) =>
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
    )

    // Compound unique where (tenant isolation) fonctionne
    const viaCompound = await db.integrationConnection.findUnique({
      where: { id_companyId: { id: fixedId, companyId: companyA } },
    })
    assert.ok(viaCompound)
    const cross = await db.integrationConnection.findUnique({
      where: { id_companyId: { id: fixedId, companyId: companyB } },
    })
    assert.equal(cross, null)
  })

  it("erreur Prisma inattendue → PERSISTENCE sans cause exposée", async () => {
    const broken = {
      integrationConnection: {
        create: async () => {
          throw Object.assign(new Error("relation does not exist"), {
            code: "P2021",
            meta: { table: "secret_internal" },
            clientVersion: "0.0.0",
          })
        },
      },
    } as unknown as PrismaClient

    const brokenRepo = new IntegrationConnectionRepository(broken)
    await assert.rejects(
      () => brokenRepo.create(createInput(companyA)),
      (err: unknown) => {
        assert.ok(err instanceof IntegrationConnectionPersistenceError)
        assert.equal(err.message.includes("P2021"), false)
        assert.equal(err.message.includes("secret_internal"), false)
        assert.equal(err.message.includes("relation does not exist"), false)
        return true
      }
    )
  })

  // ── Updates ──────────────────────────────────────────────────────────────

  it("update status / health, conserve les autres champs, met à jour updatedAt", async () => {
    const created = await repo.create(
      createInput(companyA, {
        displayName: "Updatable",
        connectorType: "update.type",
      })
    )
    const beforeUpdatedAt = created.updatedAt

    // Petite pause pour garantir un updatedAt distinct
    await new Promise((r) => setTimeout(r, 20))

    const statusUpdated = await repo.updateStatus(
      companyA,
      created.id,
      CONNECTION_STATUSES.ACTIVE
    )
    assert.equal(statusUpdated.status, CONNECTION_STATUSES.ACTIVE)
    assert.equal(statusUpdated.displayName, "Updatable")
    assert.equal(statusUpdated.connectorType, "update.type")
    assert.equal(statusUpdated.credentialStatus, CREDENTIAL_STATUSES.MISSING)

    const checkAt = "2026-07-27T12:00:00.000Z"
    const healthUpdated = await repo.updateHealth(companyA, created.id, {
      runtimeHealth: RUNTIME_HEALTH_STATUSES.HEALTHY,
      lastHealthCheckAt: checkAt,
      lastStableErrorCode: null,
    })
    assert.equal(healthUpdated.runtimeHealth, RUNTIME_HEALTH_STATUSES.HEALTHY)
    assert.equal(healthUpdated.lastHealthCheckAt, checkAt)
    assert.equal(healthUpdated.status, CONNECTION_STATUSES.ACTIVE)
    assert.equal(healthUpdated.displayName, "Updatable")

    const health = await repo.findHealthById(companyA, created.id)
    assert.equal(health.connectionId, created.id)
    assert.equal(health.companyId, companyA)
    assert.equal(health.runtimeHealth, RUNTIME_HEALTH_STATUSES.HEALTHY)
    assert.equal(health.lastStableErrorCode, undefined)

    assert.ok(healthUpdated.updatedAt >= beforeUpdatedAt)
    assert.notEqual(healthUpdated.updatedAt, beforeUpdatedAt)
  })

  it("updateCredentialStatus — tenant OK, champs conservés, updatedAt, cross-tenant NOT_FOUND", async () => {
    const created = await repo.create(
      createInput(companyA, {
        displayName: "CredUpdatable",
        connectorType: "cred.type",
      })
    )
    assert.equal(created.credentialStatus, CREDENTIAL_STATUSES.MISSING)
    const beforeUpdatedAt = created.updatedAt
    await new Promise((r) => setTimeout(r, 20))

    const updated = await repo.updateCredentialStatus(
      companyA,
      created.id,
      CREDENTIAL_STATUSES.ACTIVE
    )
    assert.equal(updated.credentialStatus, CREDENTIAL_STATUSES.ACTIVE)
    assert.equal(updated.displayName, "CredUpdatable")
    assert.equal(updated.connectorType, "cred.type")
    assert.equal(updated.status, CONNECTION_STATUSES.PENDING_AUTH)
    assert.equal(updated.runtimeHealth, RUNTIME_HEALTH_STATUSES.UNKNOWN)
    assert.ok(updated.updatedAt >= beforeUpdatedAt)
    assert.notEqual(updated.updatedAt, beforeUpdatedAt)

    await assert.rejects(
      () =>
        repo.updateCredentialStatus(
          companyB,
          created.id,
          CREDENTIAL_STATUSES.EXPIRED
        ),
      (err: unknown) =>
        err instanceof IntegrationConnectionNotFoundError &&
        err.code === INTEGRATION_CONNECTION_ERROR.NOT_FOUND
    )

    const still = await repo.findById(companyA, created.id)
    assert.equal(still.credentialStatus, CREDENTIAL_STATUSES.ACTIVE)
  })

  it("updateWatermark — opaque string, null autorisé, cross-tenant NOT_FOUND", async () => {
    const created = await repo.create(
      createInput(companyA, {
        displayName: "WmUpdatable",
        connectorType: "wm.type",
      })
    )
    assert.equal(created.watermark, undefined)

    // Watermark = curseur opaque (string) — peut contenir du JSON sérialisé
    const opaque = JSON.stringify({ cursor: "abc", v: 1 })
    const withWm = await repo.updateWatermark(companyA, created.id, opaque)
    assert.equal(withWm.watermark, opaque)
    assert.equal(withWm.displayName, "WmUpdatable")
    assert.equal(withWm.connectorType, "wm.type")
    assert.equal(withWm.status, CONNECTION_STATUSES.PENDING_AUTH)

    const reread = await repo.findById(companyA, created.id)
    assert.equal(reread.watermark, opaque)

    const cleared = await repo.updateWatermark(companyA, created.id, null)
    assert.equal(cleared.watermark, undefined)
    assert.equal(cleared.displayName, "WmUpdatable")

    await assert.rejects(
      () => repo.updateWatermark(companyB, created.id, "stolen"),
      (err: unknown) => err instanceof IntegrationConnectionNotFoundError
    )

    const still = await repo.findById(companyA, created.id)
    assert.equal(still.watermark, undefined)
  })

  // ── Cascade ──────────────────────────────────────────────────────────────

  it("suppression de l’entreprise cascade les connexions (pas d’orphelin)", async () => {
    const suffix = `${runId}-cascade`
    const company = await db.company.create({
      data: { name: `Cascade ${suffix}`, slug: `int-cascade-${suffix}` },
    })
    const cascadeRepo = new IntegrationConnectionRepository(db)
    const conn = await cascadeRepo.create(createInput(company.id))

    await db.company.delete({ where: { id: company.id } })

    const orphan = await db.integrationConnection.findUnique({
      where: { id: conn.id },
    })
    assert.equal(orphan, null)
  })
})
