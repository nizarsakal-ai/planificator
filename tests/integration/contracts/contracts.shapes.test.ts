/**
 * LOT-1A STEP-5 — formes Zod des contrats + registries.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { credentialsRefSchema } from "@/lib/integration/contracts/credentials-ref"
import type { CredentialsRef } from "@/lib/integration/contracts/credentials-ref"
import {
  connectionHealthSchema,
} from "@/lib/integration/contracts/connection-health"
import {
  inboundArtifactSchema,
} from "@/lib/integration/contracts/inbound-artifact"
import {
  inboundEnvelopeSchema,
} from "@/lib/integration/contracts/inbound-envelope"
import {
  integrationConnectionSchema,
  jsonValueSchema,
  nonSecretConnectionConfigSchema,
} from "@/lib/integration/contracts/integration-connection"
import {
  normalizedMessageSchema,
} from "@/lib/integration/contracts/normalized-message"
import {
  createCapabilitySet,
  hasCapability,
} from "@/lib/integration/registry/capabilities"
import {
  createConnectorRegistry,
  CONNECTOR_REGISTRY_ERROR,
  ConnectorRegistryError,
} from "@/lib/integration/registry/connector-registry"
import {
  createPipelineRegistry,
  PIPELINE_REGISTRY_ERROR,
  PipelineRegistryError,
} from "@/lib/integration/registry/pipeline-registry"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { INTEGRATION_CAPABILITIES, type IntegrationCapability } from "@/lib/integration/types/integration-capability"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { CREDENTIAL_STATUSES } from "@/lib/integration/types/credential-status"
import { RUNTIME_HEALTH_STATUSES } from "@/lib/integration/types/runtime-health"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"

/** Fixture technique — pas une factory production. */
function asConnectorTypeFixture(value: string): ConnectorType {
  return value as ConnectorType
}

const UTC = "2026-07-26T10:00:00.000Z"

describe("CredentialsRef", () => {
  it("accepte une chaîne non vide comme CredentialsRef", () => {
    const parsed = credentialsRefSchema.parse("cred-ref-1")
    const typed: CredentialsRef = parsed
    assert.equal(typed, "cred-ref-1")
  })

  it("rejette une chaîne vide", () => {
    assert.equal(credentialsRefSchema.safeParse("").success, false)
  })
})

describe("JsonValue / config", () => {
  it("accepte les primitives JSON finies et structures", () => {
    assert.equal(jsonValueSchema.safeParse("x").success, true)
    assert.equal(jsonValueSchema.safeParse(true).success, true)
    assert.equal(jsonValueSchema.safeParse(null).success, true)
    assert.equal(jsonValueSchema.safeParse(42).success, true)
    assert.equal(jsonValueSchema.safeParse([1, "a"]).success, true)
    assert.equal(jsonValueSchema.safeParse({ a: 1 }).success, true)
  })

  it("rejette Infinity et NaN", () => {
    assert.equal(jsonValueSchema.safeParse(Infinity).success, false)
    assert.equal(jsonValueSchema.safeParse(NaN).success, false)
  })

  it("rejette undefined, Date, bigint et fonction", () => {
    assert.equal(jsonValueSchema.safeParse(undefined).success, false)
    assert.equal(jsonValueSchema.safeParse(new Date()).success, false)
    assert.equal(jsonValueSchema.safeParse(BigInt(1)).success, false)
    assert.equal(jsonValueSchema.safeParse(() => 0).success, false)
  })

  it("accepte une config sérialisable arbitraire (sans prétendre détecter un secret)", () => {
    assert.equal(
      nonSecretConnectionConfigSchema.safeParse({
        mailboxLabel: "inbox",
        nested: { enabled: true },
      }).success,
      true
    )
  })
})

describe("IntegrationConnection", () => {
  const valid = {
    id: "conn-1",
    companyId: "co-1",
    connectorType: asConnectorTypeFixture("fixture.connector.type"),
    displayName: "Fixture",
    status: CONNECTION_STATUSES.ACTIVE,
    credentialStatus: CREDENTIAL_STATUSES.ACTIVE,
    runtimeHealth: RUNTIME_HEALTH_STATUSES.HEALTHY,
    secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
    config: { publicFlag: true },
    createdAt: UTC,
    updatedAt: UTC,
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  }

  it("accepte un exemple minimal valide avec trois états séparés", () => {
    const parsed = integrationConnectionSchema.parse(valid)
    assert.equal(parsed.status, CONNECTION_STATUSES.ACTIVE)
    assert.equal(parsed.credentialStatus, CREDENTIAL_STATUSES.ACTIVE)
    assert.equal(parsed.runtimeHealth, RUNTIME_HEALTH_STATUSES.HEALTHY)
    assert.equal(parsed.connectorType, "fixture.connector.type")
  })

  it("accepte UTC Z et rejette un offset non-Z", () => {
    assert.equal(
      integrationConnectionSchema.safeParse({
        ...valid,
        createdAt: "2026-07-26T10:00:00.000Z",
      }).success,
      true
    )
    assert.equal(
      integrationConnectionSchema.safeParse({
        ...valid,
        createdAt: "2026-07-26T12:00:00.000+02:00",
      }).success,
      false
    )
  })

  it("rejette un champ inconnu (strict)", () => {
    assert.equal(
      integrationConnectionSchema.safeParse({ ...valid, canRun: true }).success,
      false
    )
  })
})

describe("ConnectionHealth", () => {
  it("accepte une shape valide et rejette champ inconnu / message brut", () => {
    const ok = {
      connectionId: "conn-1",
      companyId: "co-1",
      runtimeHealth: RUNTIME_HEALTH_STATUSES.DEGRADED,
      lastStableErrorCode: "TOKEN_EXPIRED",
    }
    assert.equal(connectionHealthSchema.safeParse(ok).success, true)
    assert.equal(
      connectionHealthSchema.safeParse({
        ...ok,
        errorMessage: "raw provider dump",
      }).success,
      false
    )
  })
})

describe("InboundArtifact", () => {
  const base = {
    id: "art-1",
    companyId: "co-1",
    connectionId: "conn-1",
    envelopeId: "env-1",
    externalArtifactId: "ext-1",
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  }

  it("accepte sans ref, fetchRef seul, storageRef seul, ou les deux", () => {
    assert.equal(inboundArtifactSchema.safeParse(base).success, true)
    assert.equal(
      inboundArtifactSchema.safeParse({ ...base, fetchRef: "fetch:1" }).success,
      true
    )
    assert.equal(
      inboundArtifactSchema.safeParse({ ...base, storageRef: "store:1" }).success,
      true
    )
    assert.equal(
      inboundArtifactSchema.safeParse({
        ...base,
        fetchRef: "fetch:1",
        storageRef: "store:1",
      }).success,
      true
    )
  })

  it("rejette taille négative et champs binaires inline", () => {
    assert.equal(
      inboundArtifactSchema.safeParse({ ...base, sizeBytes: -1 }).success,
      false
    )
    assert.equal(
      inboundArtifactSchema.safeParse({ ...base, contentBase64: "YQ==" }).success,
      false
    )
  })
})

describe("InboundEnvelope", () => {
  const valid = {
    id: "env-1",
    companyId: "co-1",
    connectionId: "conn-1",
    connectorType: asConnectorTypeFixture("fixture.connector.type"),
    externalId: "ext-msg-1",
    idempotencyKey: "idem-1",
    receivedAt: UTC,
    payloadRef: "payload:1",
    contentType: "message/rfc822",
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
  }

  it("accepte une shape valide", () => {
    assert.equal(inboundEnvelopeSchema.safeParse(valid).success, true)
  })

  it("exige payloadRef et un lifecycle connu", () => {
    const { payloadRef: _, ...withoutPayload } = valid
    assert.equal(inboundEnvelopeSchema.safeParse(withoutPayload).success, false)
    assert.equal(
      inboundEnvelopeSchema.safeParse({
        ...valid,
        lifecycleStatus: "NOT_A_STATUS",
      }).success,
      false
    )
  })

  it("rejette payload inline / draft / champ inconnu", () => {
    assert.equal(
      inboundEnvelopeSchema.safeParse({ ...valid, rawBody: "hello" }).success,
      false
    )
    assert.equal(
      inboundEnvelopeSchema.safeParse({ ...valid, draftId: "d1" }).success,
      false
    )
  })
})

describe("NormalizedMessage", () => {
  const base = {
    externalMessageId: "msg-ext-1",
    contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
  }

  it("accepte sender absent et rejette sender vide", () => {
    assert.equal(normalizedMessageSchema.safeParse(base).success, true)
    assert.equal(
      normalizedMessageSchema.safeParse({ ...base, sender: {} }).success,
      false
    )
  })

  it("accepte email seul, domain seul, ou les deux", () => {
    assert.equal(
      normalizedMessageSchema.safeParse({
        ...base,
        sender: { email: "a@b.c" },
      }).success,
      true
    )
    assert.equal(
      normalizedMessageSchema.safeParse({
        ...base,
        sender: { domain: "b.c" },
      }).success,
      true
    )
    assert.equal(
      normalizedMessageSchema.safeParse({
        ...base,
        sender: { email: "a@b.c", domain: "b.c" },
        subject: "Hello",
        bodyRef: "body:1",
        recipients: [{ email: "x@y.z" }],
      }).success,
      true
    )
  })

  it("rejette un champ provider/Gmail inconnu", () => {
    assert.equal(
      normalizedMessageSchema.safeParse({
        ...base,
        gmailThreadId: "thread",
      }).success,
      false
    )
  })
})

describe("CapabilitySet registry helpers", () => {
  it("déduplique, ordonne, freeze, et isole la source", () => {
    const source: IntegrationCapability[] = [
      INTEGRATION_CAPABILITIES.UPLOAD,
      INTEGRATION_CAPABILITIES.POLL,
      INTEGRATION_CAPABILITIES.POLL,
    ]
    const set = createCapabilitySet(source)
    assert.deepEqual([...set], [
      INTEGRATION_CAPABILITIES.POLL,
      INTEGRATION_CAPABILITIES.UPLOAD,
    ])
    assert.ok(Object.isFrozen(set))
    source.push(INTEGRATION_CAPABILITIES.CONTENT_FETCH)
    assert.equal(set.length, 2)
    assert.equal(hasCapability(set, INTEGRATION_CAPABILITIES.POLL), true)
    assert.equal(hasCapability(set, INTEGRATION_CAPABILITIES.DELTA_CURSOR), false)
  })
})

describe("ConnectorRegistry", () => {
  it("crée un registry vide et liste vide", () => {
    const registry = createConnectorRegistry()
    assert.equal(registry.size, 0)
    assert.deepEqual(registry.list(), [])
  })

  it("enregistre, lookup, et refuse doublon / famille non MESSAGE", () => {
    const type = asConnectorTypeFixture("fixture.connector.a")
    const input = {
      connectorType: type,
      family: INBOUND_FAMILY.MESSAGE,
      capabilities: [INTEGRATION_CAPABILITIES.POLL],
    }
    const registry = createConnectorRegistry([input])
    assert.equal(registry.get(type)?.connectorType, type)
    assert.equal(registry.list().length, 1)
    assert.ok(Object.isFrozen(registry.list()))
    assert.ok(Object.isFrozen(registry.get(type)?.capabilities))

    assert.throws(
      () => createConnectorRegistry([input, { ...input }]),
      (err: unknown) =>
        err instanceof ConnectorRegistryError &&
        err.code === CONNECTOR_REGISTRY_ERROR.DUPLICATE_TYPE
    )

    assert.throws(
      () =>
        createConnectorRegistry([
          {
            ...input,
            connectorType: asConnectorTypeFixture("fixture.connector.b"),
            // Cast contrôlé de test — famille hors V1
            family: "DOCUMENT" as typeof INBOUND_FAMILY.MESSAGE,
          },
        ]),
      (err: unknown) =>
        err instanceof ConnectorRegistryError &&
        err.code === CONNECTOR_REGISTRY_ERROR.FAMILY_NOT_SUPPORTED
    )
  })

  it("ne propage pas les mutations de la source d’entrée", () => {
    const caps: IntegrationCapability[] = [INTEGRATION_CAPABILITIES.POLL]
    const type = asConnectorTypeFixture("fixture.connector.c")
    const entry = {
      connectorType: type,
      family: INBOUND_FAMILY.MESSAGE,
      capabilities: caps,
    }
    const registry = createConnectorRegistry([entry])
    caps.push(INTEGRATION_CAPABILITIES.UPLOAD)
    assert.deepEqual([...(registry.get(type)?.capabilities ?? [])], [
      INTEGRATION_CAPABILITIES.POLL,
    ])
  })
})

describe("PipelineRegistry", () => {
  it("délègue admit au port injecté et refuse un pipeline inconnu", async () => {
    let calls = 0
    const registry = createPipelineRegistry({
      admit: async () => {
        calls += 1
      },
    })
    assert.ok(Object.isFrozen(registry))
    assert.ok(Object.isFrozen(registry.consultations))
    assert.equal(registry.get("consultations").pipelineId, "consultations")

    await registry.consultations.admit({
      id: "adm-1",
      companyId: "co-1",
      normalizedInboundId: "ni-1",
      routingDecisionId: "rd-1",
      sourceId: "src-1",
      pipelineId: "consultations",
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      artifactRefs: [],
      pipelineIdempotencyKey: "idem-1",
      occurredAt: UTC,
      admittedAt: UTC,
      message: {
        externalMessageId: "m1",
        contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
      },
    })
    assert.equal(calls, 1)

    assert.throws(
      () => registry.get("other" as "consultations"),
      (err: unknown) =>
        err instanceof PipelineRegistryError &&
        err.code === PIPELINE_REGISTRY_ERROR.UNKNOWN_PIPELINE
    )
  })
})
