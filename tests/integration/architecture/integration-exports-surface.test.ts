/**
 * LOT-1A STEP-5 — surface publique sans barrel global.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as inboundFamily from "@/lib/integration/types/inbound-family"
import * as connectorType from "@/lib/integration/types/connector-type"
import * as schemaVersion from "@/lib/integration/types/schema-version"
import * as pipelineAdmission from "@/lib/integration/contracts/pipeline-admission"
import * as routingDecision from "@/lib/integration/contracts/routing-decision"
import * as runtimeAbstractions from "@/lib/integration/contracts/runtime-abstractions"
import * as capabilities from "@/lib/integration/registry/capabilities"
import * as connectorRegistry from "@/lib/integration/registry/connector-registry"
import * as pipelineRegistry from "@/lib/integration/registry/pipeline-registry"

describe("LOT-1A export surface", () => {
  it("expose les contrats et registries critiques", () => {
    assert.equal(typeof routingDecision.routingDecisionSchema, "object")
    assert.equal(typeof pipelineAdmission.pipelineAdmissionSchema, "object")
    assert.equal(typeof capabilities.createCapabilitySet, "function")
    assert.equal(typeof connectorRegistry.createConnectorRegistry, "function")
    assert.equal(typeof pipelineRegistry.createPipelineRegistry, "function")
    assert.equal(
      pipelineAdmission.PIPELINE_ID_CONSULTATIONS,
      "consultations"
    )
    assert.equal(schemaVersion.PLATFORM_SCHEMA_VERSION_V1, "1.0.0")
  })

  it("n’expose pas DOCUMENT/EVENT actifs ni ConnectorType concret", () => {
    assert.deepEqual(Object.keys(inboundFamily.INBOUND_FAMILY), ["MESSAGE"])
    assert.deepEqual([...inboundFamily.INBOUND_FAMILY_VALUES], ["MESSAGE"])
    assert.equal("DOCUMENT" in inboundFamily.INBOUND_FAMILY, false)
    assert.equal("EVENT" in inboundFamily.INBOUND_FAMILY, false)
    assert.equal("CONNECTOR_TYPES" in connectorType, false)
    assert.equal("LEGACY_GMAIL_MAIL" in connectorType, false)
    assert.equal("MESSAGE_UPLOAD" in connectorType, false)
  })

  it("n’expose ni register() globale ni instance mutable de registry", () => {
    assert.equal("register" in connectorRegistry, false)
    assert.equal("register" in pipelineRegistry, false)
    assert.equal("defaultRegistry" in connectorRegistry, false)
    assert.equal("globalRegistry" in pipelineRegistry, false)
    const empty = connectorRegistry.createConnectorRegistry()
    assert.equal(empty.size, 0)
  })

  it("n’expose pas de runtime concret", () => {
    assert.equal("createGmailRuntime" in runtimeAbstractions, false)
    assert.equal("GmailRuntime" in runtimeAbstractions, false)
    assert.equal(typeof runtimeAbstractions.integrationRuntimeContextSchema, "object")
    assert.equal(
      typeof (runtimeAbstractions as { IntegrationConnectorRuntimePort?: unknown })
        .IntegrationConnectorRuntimePort,
      "undefined"
    )
  })
})
