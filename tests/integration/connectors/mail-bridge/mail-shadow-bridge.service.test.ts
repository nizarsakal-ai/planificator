/**
 * LOT-1C — Bridge service : convergence A–F + anti-écrasement.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MailShadowBridgeService } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { IntegrationInboundLifecycleConflictError } from "@/lib/integration/persistence/integration-inbound.errors"
import { IntegrationInboundNormalizedVersionConflictError } from "@/lib/integration/persistence/integration-inbound.errors"
import { IntegrationInboundNotFoundError } from "@/lib/integration/persistence/integration-inbound.errors"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import type { InboundEnvelope } from "@/lib/integration/contracts/inbound-envelope"
import type { NormalizedInbound } from "@/lib/integration/contracts/normalized-inbound"
import type { IntegrationConnection } from "@/lib/integration/contracts/integration-connection"

function dto(over: Record<string, unknown> = {}) {
  return {
    companyId: "co1",
    connectionId: "conn1",
    externalId: "ext1",
    idempotencyKey: "idem1",
    receivedAt: "2026-08-01T10:00:00.000Z",
    occurredAt: "2026-08-01T09:00:00.000Z",
    payloadRef: "payload-ref",
    contentType: "message/rfc822",
    message: {
      externalMessageId: "ext1",
      contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
    },
    ...over,
  }
}

function connection(
  over: Partial<IntegrationConnection> = {}
): IntegrationConnection {
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

function envelope(
  over: Partial<InboundEnvelope> = {}
): InboundEnvelope {
  return {
    id: "env1",
    companyId: "co1",
    connectionId: "conn1",
    connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
    externalId: "ext1",
    idempotencyKey: "idem1",
    receivedAt: "2026-08-01T10:00:00.000Z",
    payloadRef: "payload-ref",
    contentType: "message/rfc822",
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
    ...over,
  } as InboundEnvelope
}

function normalizedRow(): NormalizedInbound {
  return {
    id: "n1",
    companyId: "co1",
    connectionId: "conn1",
    envelopeId: "env1",
    family: "MESSAGE",
    occurredAt: "2026-08-01T09:00:00.000Z",
    receivedAt: "2026-08-01T10:00:00.000Z",
    normalizedHash: "hash",
    artifactRefs: [],
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    message: {
      externalMessageId: "ext1",
      contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
    },
  }
}

type TransitionCall = {
  expectedStatuses: string[]
  targetStatus: string
}

function buildBridge(opts: {
  connection?: IntegrationConnection | null
  createEnvelope?: () => Promise<InboundEnvelope>
  findNormalized?: () => Promise<NormalizedInbound>
  createNormalized?: () => Promise<NormalizedInbound>
  transitions?: TransitionCall[]
  transitionImpl?: (input: {
    expectedStatuses: string[]
    targetStatus: string
  }) => Promise<InboundEnvelope>
  findEnvelopeAfter?: () => Promise<InboundEnvelope>
}) {
  const transitions: TransitionCall[] = opts.transitions ?? []
  const connectionRepo = {
    findById: async () => {
      if (opts.connection === null) {
        const { IntegrationConnectionNotFoundError } = await import(
          "@/lib/integration/persistence/integration-connection.errors"
        )
        throw new IntegrationConnectionNotFoundError()
      }
      return opts.connection ?? connection()
    },
  }
  const envelopeRepo = {
    findByIdempotencyKey: async () => {
      throw new IntegrationInboundNotFoundError()
    },
    createIdempotent:
      opts.createEnvelope ?? (async () => envelope()),
    findById:
      opts.findEnvelopeAfter ?? (async () => envelope({ lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED })),
    transitionLifecycle: async (input: {
      expectedStatuses: string[]
      targetStatus: string
    }) => {
      transitions.push({
        expectedStatuses: input.expectedStatuses,
        targetStatus: input.targetStatus,
      })
      if (opts.transitionImpl) return opts.transitionImpl(input)
      return envelope({ lifecycleStatus: input.targetStatus as InboundEnvelope["lifecycleStatus"] })
    },
  }
  const normalizedRepo = {
    findByEnvelopeVersion: async () => {
      if (opts.findNormalized) return opts.findNormalized()
      throw new IntegrationInboundNotFoundError()
    },
    create:
      opts.createNormalized ?? (async () => normalizedRow()),
  }

  const bridge = new MailShadowBridgeService(undefined as never, {
    connectionRepo: connectionRepo as never,
    envelopeRepo: envelopeRepo as never,
    normalizedRepo: normalizedRepo as never,
  })
  return { bridge, transitions }
}

describe("mail-shadow-bridge.service convergence", () => {
  it("A — RECEIVED sans Normalized → create + CAS NORMALIZED", async () => {
    const { bridge, transitions } = buildBridge({})
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.ok(stats.normalized >= 1)
    assert.ok(
      transitions.some(
        (t) =>
          t.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED &&
          t.expectedStatuses.includes(ENVELOPE_LIFECYCLE_STATUSES.RECEIVED)
      )
    )
  })

  it("B — RECEIVED avec Normalized → CAS NORMALIZED sans create", async () => {
    let created = 0
    const { bridge, transitions } = buildBridge({
      findNormalized: async () => normalizedRow(),
      createNormalized: async () => {
        created++
        return normalizedRow()
      },
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(created, 0)
    assert.ok(stats.normalized >= 1)
    assert.equal(
      transitions.some(
        (t) => t.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
      ),
      false
    )
  })

  it("C — NORMALIZED avec Normalized → duplicate", async () => {
    const { bridge, transitions } = buildBridge({
      createEnvelope: async () =>
        envelope({ lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED }),
      findNormalized: async () => normalizedRow(),
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(stats.duplicate, 1)
    assert.equal(transitions.length, 0)
  })

  it("D — NORMALIZED sans Normalized → inconsistent, pas FAILED", async () => {
    const { bridge, transitions } = buildBridge({
      createEnvelope: async () =>
        envelope({ lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED }),
      findNormalized: async () => {
        throw new IntegrationInboundNotFoundError()
      },
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(stats.inconsistent, 1)
    assert.equal(
      transitions.some(
        (t) => t.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
      ),
      false
    )
  })

  it("E — NORMALIZE_FAILED → no-op sans retry", async () => {
    const { bridge, transitions } = buildBridge({
      createEnvelope: async () =>
        envelope({
          lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED,
        }),
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(stats.normalizeFailed, 1)
    assert.equal(transitions.length, 0)
  })

  it("F — VERSION_CONFLICT → reconcile, pas FAILED si succès", async () => {
    const { bridge, transitions } = buildBridge({
      createNormalized: async () => {
        throw new IntegrationInboundNormalizedVersionConflictError()
      },
      findEnvelopeAfter: async () =>
        envelope({ lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED }),
      // After conflict, findNormalized is called again in reconcile —
      // first miss during ensure, then present in reconcile.
      findNormalized: (() => {
        let n = 0
        return async () => {
          n++
          if (n === 1) throw new IntegrationInboundNotFoundError()
          return normalizedRow()
        }
      })(),
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(
      transitions.some(
        (t) => t.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
      ),
      false
    )
    assert.ok(stats.duplicate + stats.normalized >= 1)
  })

  it("anti-écrasement : CAS FAILED conflict + concurrent NORMALIZED → pas FAILED gagnant", async () => {
    let createCalls = 0
    let normLookups = 0
    let phase: "init" | "after_failed_cas" = "init"
    const transitions: TransitionCall[] = []

    const connectionRepo = {
      findById: async () => connection(),
    }
    const envelopeRepo = {
      findByIdempotencyKey: async () => {
        throw new IntegrationInboundNotFoundError()
      },
      createIdempotent: async () => envelope(),
      findById: async () => {
        if (phase === "after_failed_cas") {
          return envelope({
            lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED,
          })
        }
        return envelope()
      },
      transitionLifecycle: async (input: {
        expectedStatuses: string[]
        targetStatus: string
      }) => {
        transitions.push({
          expectedStatuses: input.expectedStatuses,
          targetStatus: input.targetStatus,
        })
        if (
          input.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
        ) {
          phase = "after_failed_cas"
          throw new IntegrationInboundLifecycleConflictError()
        }
        return envelope({
          lifecycleStatus:
            input.targetStatus as InboundEnvelope["lifecycleStatus"],
        })
      },
    }
    const normalizedRepo = {
      findByEnvelopeVersion: async () => {
        normLookups++
        if (phase === "after_failed_cas") return normalizedRow()
        throw new IntegrationInboundNotFoundError()
      },
      create: async () => {
        createCalls++
        throw new Error("serialize boom")
      },
    }

    const bridge = new MailShadowBridgeService(undefined as never, {
      connectionRepo: connectionRepo as never,
      envelopeRepo: envelopeRepo as never,
      normalizedRepo: normalizedRepo as never,
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })

    assert.equal(createCalls, 1)
    const failedCalls = transitions.filter(
      (t) => t.targetStatus === ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
    )
    assert.equal(failedCalls.length, 1)
    assert.deepEqual(failedCalls[0]!.expectedStatuses, [
      ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
    ])
    assert.ok(stats.duplicate >= 1)
    assert.ok(normLookups >= 2)
  })

  it("lifecycle inattendu → unexpectedLifecycle", async () => {
    const { bridge } = buildBridge({
      createEnvelope: async () =>
        envelope({ lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.ROUTED }),
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(stats.unexpectedLifecycle, 1)
  })

  it("connection absente → no-op sans throw", async () => {
    const { bridge } = buildBridge({ connection: null })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(), { stats })
    assert.equal(stats.normalized, 0)
  })
})
