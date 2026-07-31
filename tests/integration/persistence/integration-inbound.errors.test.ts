/**
 * LOT-1B2 — classification erreurs Prisma (P2002) sans I/O.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  INBOUND_CONSTRAINT,
  prismaUniqueConstraintName,
} from "@/lib/integration/persistence/integration-inbound.errors"

describe("integration-inbound.errors — P2002", () => {
  it("contrainte idempotence via meta.constraint", () => {
    assert.equal(
      prismaUniqueConstraintName({
        code: "P2002",
        meta: { constraint: INBOUND_CONSTRAINT.IDEMPOTENCY },
      }),
      INBOUND_CONSTRAINT.IDEMPOTENCY
    )
  })

  it("contrainte version via meta.target fields", () => {
    assert.equal(
      prismaUniqueConstraintName({
        code: "P2002",
        meta: {
          target: ["envelopeId", "companyId", "family", "schemaVersion"],
        },
      }),
      INBOUND_CONSTRAINT.ENVELOPE_VERSION
    )
  })

  it("idempotence via meta.target fields", () => {
    assert.equal(
      prismaUniqueConstraintName({
        code: "P2002",
        meta: {
          target: ["companyId", "connectionId", "idempotencyKey"],
        },
      }),
      INBOUND_CONSTRAINT.IDEMPOTENCY
    )
  })

  it("P2002 ambigu → null (fallback PERSISTENCE côté repo)", () => {
    assert.equal(
      prismaUniqueConstraintName({
        code: "P2002",
        meta: { target: ["id"] },
      }),
      null
    )
    assert.equal(
      prismaUniqueConstraintName({ code: "P2003", meta: {} }),
      null
    )
  })
})
