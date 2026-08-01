/**
 * LOT-1C — resolve-once + connection_missing une fois.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveMailShadowConnectionOnce } from "@/lib/acquisition/connector/mail-shadow-connection.once"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import type { IntegrationConnection } from "@/lib/integration/contracts/integration-connection"

function conn(over: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "conn1",
    companyId: "co1",
    connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
    displayName: "Mail",
    status: CONNECTION_STATUSES.ACTIVE,
    credentialStatus: "MISSING",
    runtimeHealth: "UNKNOWN",
    secretBackend: SECRET_BACKENDS.LEGACY_GMAIL,
    config: {},
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as IntegrationConnection
}

describe("mail-shadow-connection.once", () => {
  it("retourne l’unique Connection éligible", async () => {
    const stats = createMailShadowRunStats()
    let listCalls = 0
    const repo = {
      listByCompany: async () => {
        listCalls++
        return [conn()]
      },
    }
    const r = await resolveMailShadowConnectionOnce(
      "co1",
      stats,
      repo as never
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.connectionId, "conn1")
    assert.equal(listCalls, 1)
    assert.equal(stats.connectionMissingLogged, 0)
  })

  it("connection_missing journalisé au plus une fois", async () => {
    const stats = createMailShadowRunStats()
    const repo = { listByCompany: async () => [] }
    const a = await resolveMailShadowConnectionOnce("co1", stats, repo as never)
    const b = await resolveMailShadowConnectionOnce("co1", stats, repo as never)
    assert.equal(a.ok, false)
    assert.equal(b.ok, false)
    assert.equal(stats.connectionMissingLogged, 1)
  })

  it("ambiguïté N>1 → not ok", async () => {
    const stats = createMailShadowRunStats()
    const repo = {
      listByCompany: async () => [conn({ id: "a" }), conn({ id: "b" })],
    }
    const r = await resolveMailShadowConnectionOnce("co1", stats, repo as never)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, "ambiguous")
  })
})
