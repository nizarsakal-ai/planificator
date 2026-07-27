/**
 * LOT-1B1 STEP-2 — mapper IntegrationConnection (unitaires, sans DB).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { IntegrationConnection as IntegrationConnectionRow } from "@prisma/client"
import {
  INTEGRATION_CONNECTION_ERROR,
  IntegrationConnectionValidationError,
} from "@/lib/integration/persistence/integration-connection.errors"
import {
  dateToIsoUtcZ,
  mapRowToConnectionHealth,
  mapRowToIntegrationConnection,
  toPrismaCreateData,
} from "@/lib/integration/persistence/integration-connection.mapper"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { CREDENTIAL_STATUSES } from "@/lib/integration/types/credential-status"
import { RUNTIME_HEALTH_STATUSES } from "@/lib/integration/types/runtime-health"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

const UTC = "2026-07-26T10:00:00.000Z"

function baseRow(
  overrides: Partial<IntegrationConnectionRow> = {}
): IntegrationConnectionRow {
  return {
    id: "conn-1",
    companyId: "co-1",
    connectorType: "fixture.connector.type",
    displayName: "Fixture",
    status: CONNECTION_STATUSES.ACTIVE,
    credentialStatus: CREDENTIAL_STATUSES.ACTIVE,
    runtimeHealth: RUNTIME_HEALTH_STATUSES.HEALTHY,
    secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
    credentialsRef: "cred-ref-1",
    config: { publicFlag: true },
    watermark: "wm-1",
    lastSuccessfulRunAt: new Date(UTC),
    lastFailedRunAt: null,
    lastHealthCheckAt: new Date(UTC),
    lastStableErrorCode: "TOKEN_EXPIRED",
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    createdAt: new Date(UTC),
    updatedAt: new Date(UTC),
    ...overrides,
  }
}

describe("mapRowToIntegrationConnection", () => {
  it("mappe une row complète vers le contrat LOT-1A", () => {
    const mapped = mapRowToIntegrationConnection(baseRow())
    assert.equal(mapped.id, "conn-1")
    assert.equal(mapped.companyId, "co-1")
    assert.equal(mapped.connectorType, "fixture.connector.type")
    assert.equal(mapped.status, CONNECTION_STATUSES.ACTIVE)
    assert.equal(mapped.credentialStatus, CREDENTIAL_STATUSES.ACTIVE)
    assert.equal(mapped.runtimeHealth, RUNTIME_HEALTH_STATUSES.HEALTHY)
    assert.equal(mapped.secretBackend, SECRET_BACKENDS.PLATFORM_ENCRYPTED)
    assert.equal(mapped.credentialsRef, "cred-ref-1")
    assert.deepEqual(mapped.config, { publicFlag: true })
    assert.equal(mapped.watermark, "wm-1")
    assert.equal(mapped.lastSuccessfulRunAt, UTC)
    assert.equal(mapped.lastFailedRunAt, undefined)
    assert.equal(mapped.createdAt, UTC)
    assert.equal(mapped.schemaVersion, PLATFORM_SCHEMA_VERSION_V1)
  })

  it("accepte les trois machines d’état indépendantes", () => {
    const mapped = mapRowToIntegrationConnection(
      baseRow({
        status: CONNECTION_STATUSES.ACTIVE,
        credentialStatus: CREDENTIAL_STATUSES.EXPIRED,
        runtimeHealth: RUNTIME_HEALTH_STATUSES.DEGRADED,
      })
    )
    assert.equal(mapped.status, CONNECTION_STATUSES.ACTIVE)
    assert.equal(mapped.credentialStatus, CREDENTIAL_STATUSES.EXPIRED)
    assert.equal(mapped.runtimeHealth, RUNTIME_HEALTH_STATUSES.DEGRADED)
  })

  it("garde credentialsRef opaque (pas de résolution)", () => {
    const mapped = mapRowToIntegrationConnection(
      baseRow({ credentialsRef: "opaque-handle-only" })
    )
    assert.equal(mapped.credentialsRef, "opaque-handle-only")
  })

  it("accepte LEGACY_GMAIL et PLATFORM_ENCRYPTED", () => {
    assert.equal(
      mapRowToIntegrationConnection(
        baseRow({ secretBackend: SECRET_BACKENDS.LEGACY_GMAIL })
      ).secretBackend,
      SECRET_BACKENDS.LEGACY_GMAIL
    )
    assert.equal(
      mapRowToIntegrationConnection(
        baseRow({ secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED })
      ).secretBackend,
      SECRET_BACKENDS.PLATFORM_ENCRYPTED
    )
  })

  it("produit des dates ISO UTC Z", () => {
    const mapped = mapRowToIntegrationConnection(baseRow())
    assert.match(mapped.createdAt, /Z$/)
    assert.equal(mapped.createdAt, dateToIsoUtcZ(new Date(UTC)))
  })

  it("rejette une config Json non conforme", () => {
    assert.throws(
      () =>
        mapRowToIntegrationConnection(
          baseRow({ config: Number.NaN as unknown as object })
        ),
      (err: unknown) =>
        err instanceof IntegrationConnectionValidationError &&
        err.code === INTEGRATION_CONNECTION_ERROR.VALIDATION_ERROR
    )
  })

  it("rejette un schemaVersion inconnu (strict contrat)", () => {
    assert.throws(
      () =>
        mapRowToIntegrationConnection(baseRow({ schemaVersion: "9.9.9" })),
      (err: unknown) => err instanceof IntegrationConnectionValidationError
    )
  })
})

describe("mapRowToConnectionHealth", () => {
  it("projette la vue santé sans message brut", () => {
    const health = mapRowToConnectionHealth(baseRow())
    assert.equal(health.connectionId, "conn-1")
    assert.equal(health.companyId, "co-1")
    assert.equal(health.runtimeHealth, RUNTIME_HEALTH_STATUSES.HEALTHY)
    assert.equal(health.lastSuccessfulRunAt, UTC)
    assert.equal(health.lastStableErrorCode, "TOKEN_EXPIRED")
    assert.equal("errorMessage" in health, false)
  })

  it("omet lastStableErrorCode quand null", () => {
    const health = mapRowToConnectionHealth(
      baseRow({ lastStableErrorCode: null })
    )
    assert.equal(health.lastStableErrorCode, undefined)
  })
})

describe("toPrismaCreateData", () => {
  it("valide config et status/secretBackend obligatoires", () => {
    const data = toPrismaCreateData({
      companyId: "co-1",
      connectorType: "fixture.connector.type",
      displayName: "Fixture",
      status: CONNECTION_STATUSES.PENDING_AUTH,
      secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
      config: { nested: { enabled: true } },
    })
    assert.equal(data.status, CONNECTION_STATUSES.PENDING_AUTH)
    assert.deepEqual(data.config, { nested: { enabled: true } })
  })

  it("rejette un champ inconnu (strict)", () => {
    assert.throws(
      () =>
        toPrismaCreateData({
          companyId: "co-1",
          connectorType: "fixture.connector.type",
          displayName: "Fixture",
          status: CONNECTION_STATUSES.ACTIVE,
          secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
          config: {},
          // @ts-expect-error — champ hors contrat create
          unexpected: true,
        }),
      (err: unknown) => err instanceof IntegrationConnectionValidationError
    )
  })

  it("rejette Infinity dans config", () => {
    assert.throws(
      () =>
        toPrismaCreateData({
          companyId: "co-1",
          connectorType: "fixture.connector.type",
          displayName: "Fixture",
          status: CONNECTION_STATUSES.ACTIVE,
          secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
          config: { bad: Number.POSITIVE_INFINITY },
        }),
      (err: unknown) => err instanceof IntegrationConnectionValidationError
    )
  })
})
