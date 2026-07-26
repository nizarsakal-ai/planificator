/**
 * LOT-1A STEP-5 — PipelineAdmission sans connectorType / provider.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  pipelineAdmissionSchema,
  type PipelineAdmission,
} from "@/lib/integration/contracts/pipeline-admission"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"

const UTC = "2026-07-26T10:00:00.000Z"

const validAdmission = {
  id: "adm-1",
  companyId: "co-1",
  normalizedInboundId: "ni-1",
  routingDecisionId: "rd-1",
  sourceId: "src-1",
  pipelineId: "consultations" as const,
  schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  artifactRefs: ["art-1"],
  pipelineIdempotencyKey: "idem-1",
  occurredAt: UTC,
  admittedAt: UTC,
  message: {
    externalMessageId: "ext-1",
    contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
  },
}

/** Preuve TypeScript : connectorType n’est pas une clé de PipelineAdmission. */
type AssertNoConnectorTypeOnAdmission =
  "connectorType" extends keyof PipelineAdmission ? never : true
const _staticNoConnectorType: AssertNoConnectorTypeOnAdmission = true
void _staticNoConnectorType

describe("PipelineAdmission boundary", () => {
  it("accepte consultations et refuse un autre pipelineId", () => {
    const parsed = pipelineAdmissionSchema.parse(validAdmission)
    assert.equal(parsed.pipelineId, "consultations")
    assert.equal("connectorType" in parsed, false)
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        pipelineId: "billing",
      }).success,
      false
    )
  })

  it("exige les identifiants de liaison et l’idempotence", () => {
    for (const key of [
      "normalizedInboundId",
      "routingDecisionId",
      "sourceId",
      "pipelineIdempotencyKey",
    ] as const) {
      const copy = { ...validAdmission }
      delete (copy as Record<string, unknown>)[key]
      assert.equal(pipelineAdmissionSchema.safeParse(copy).success, false, key)
    }
  })

  it("rejette connectorType / provider / envelope brute / draft", () => {
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        connectorType: "x",
      }).success,
      false
    )
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        message: {
          ...validAdmission.message,
          connectorType: "x",
        },
      }).success,
      false
    )
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        gmailThreadId: "t",
      }).success,
      false
    )
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        payloadRef: "payload:1",
      }).success,
      false
    )
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        rawMime: "From: a",
      }).success,
      false
    )
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        worksiteImportDraftId: "d1",
      }).success,
      false
    )
  })

  it("garde artifactRefs comme liste d’IDs et message conforme", () => {
    const parsed = pipelineAdmissionSchema.parse(validAdmission)
    assert.deepEqual(parsed.artifactRefs, ["art-1"])
    assert.equal(parsed.message.externalMessageId, "ext-1")
    assert.equal(
      pipelineAdmissionSchema.safeParse({
        ...validAdmission,
        artifactRefs: [{ id: "not-opaque" }],
      }).success,
      false
    )
  })
})
