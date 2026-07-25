process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ZodError, z } from "zod"
import {
  classifyAcquisitionIngestionError,
  hashExternalMessageId,
  buildAcquisitionIngestionFailureLogPayload,
} from "@/lib/acquisition/connector/acquisition-ingestion-error"

describe("classifyAcquisitionIngestionError", () => {
  it("ZodError → ZOD_VALIDATION avec chemins uniquement (pas de valeurs)", () => {
    const schema = z.object({
      senderEmail: z.string().min(3),
      attachments: z.array(z.object({ filename: z.string().min(1) })),
    })
    let error: unknown
    try {
      schema.parse({ senderEmail: "ab", attachments: [{ filename: "" }] })
    } catch (e) {
      error = e
    }
    assert.ok(error instanceof ZodError)
    const classified = classifyAcquisitionIngestionError(error, "REGISTER_INCOMING_MESSAGE")
    assert.equal(classified.causeCode, "ZOD_VALIDATION")
    assert.equal(classified.errorName, "ZodError")
    assert.ok(classified.zodIssuePaths?.includes("senderEmail"))
    assert.ok(classified.zodIssuePaths?.includes("attachments.0.filename"))
    const serialized = JSON.stringify(classified)
    assert.equal(serialized.includes("ab"), false)
    assert.equal(serialized.includes('"message"'), false)
  })

  it("Prisma P2002 → PRISMA_UNIQUE_CONSTRAINT", () => {
    const error = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["companyId", "source", "externalMessageId"], modelName: "AcquisitionMessage" },
    })
    const classified = classifyAcquisitionIngestionError(error, "REGISTER_INCOMING_MESSAGE")
    assert.equal(classified.causeCode, "PRISMA_UNIQUE_CONSTRAINT")
    assert.equal(classified.prismaCode, "P2002")
    const serialized = JSON.stringify(classified)
    assert.equal(serialized.includes("Unique constraint"), false)
    assert.equal(serialized.includes("externalMessageId"), false)
  })

  it("Prisma P2003 → PRISMA_FOREIGN_KEY", () => {
    const error = { name: "PrismaClientKnownRequestError", code: "P2003" }
    const classified = classifyAcquisitionIngestionError(error, "REGISTER_INCOMING_MESSAGE")
    assert.equal(classified.causeCode, "PRISMA_FOREIGN_KEY")
    assert.equal(classified.prismaCode, "P2003")
  })

  it("Prisma autre code connu → PRISMA_DATABASE_ERROR", () => {
    const error = { name: "PrismaClientKnownRequestError", code: "P2022" }
    const classified = classifyAcquisitionIngestionError(error, "REGISTER_INCOMING_MESSAGE")
    assert.equal(classified.causeCode, "PRISMA_DATABASE_ERROR")
    assert.equal(classified.prismaCode, "P2022")
  })

  it("Error standard en register → UNKNOWN_ERROR", () => {
    const classified = classifyAcquisitionIngestionError(
      new Error("db down with secret=abc"),
      "REGISTER_INCOMING_MESSAGE"
    )
    assert.equal(classified.causeCode, "UNKNOWN_ERROR")
    assert.equal(classified.errorName, "Error")
    const serialized = JSON.stringify(classified)
    assert.equal(serialized.includes("secret"), false)
    assert.equal(serialized.includes("db down"), false)
  })

  it("Error en map → MAPPER_ERROR", () => {
    const classified = classifyAcquisitionIngestionError(
      new TypeError("unexpected"),
      "MAP_GMAIL_MESSAGE"
    )
    assert.equal(classified.causeCode, "MAPPER_ERROR")
    assert.equal(classified.errorName, "TypeError")
  })
})

describe("hashExternalMessageId / log payload", () => {
  it("hash tronqué stable 12 hex, indépendant de l'id brut dans le payload", () => {
    const id = "19f9abcd1234eeff"
    const h1 = hashExternalMessageId(id)
    const h2 = hashExternalMessageId(id)
    assert.equal(h1, h2)
    assert.match(h1, /^[a-f0-9]{12}$/)
    assert.notEqual(h1, id)

    const payload = buildAcquisitionIngestionFailureLogPayload({
      companyId: "company-1",
      externalMessageId: id,
      step: "REGISTER_INCOMING_MESSAGE",
      error: new Error("boom"),
    })
    assert.equal(payload.messageIdHash, h1)
    assert.equal(payload.companyId, "company-1")
    assert.equal(payload.causeCode, "UNKNOWN_ERROR")
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes(id), false)
    assert.equal(serialized.includes("boom"), false)
  })
})
