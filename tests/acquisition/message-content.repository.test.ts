process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Prisma } from "@prisma/client"
import {
  AcquisitionMessageContentRepository,
  type UpsertMessageContentInput,
} from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import type { MessageContentRecord } from "@/lib/acquisition/content/message-content.types"

function sanitized(text: string) {
  return sanitizeMessageBodyParts({
    textPlain: text,
    textHtml: null,
    mimeType: "text/plain",
    charset: null,
    providerMessageId: "g",
    byteLengthOriginal: Buffer.byteLength(text, "utf8"),
  })
}

function record(
  partial: Partial<MessageContentRecord> & Pick<MessageContentRecord, "normalizedText" | "contentHash">
): MessageContentRecord {
  const now = new Date()
  return {
    id: partial.id ?? "c1",
    companyId: partial.companyId ?? "co1",
    acquisitionMessageId: partial.acquisitionMessageId ?? "msg1",
    normalizedText: partial.normalizedText,
    contentHash: partial.contentHash,
    sourceMimeType: "text/plain",
    sourceCharset: null,
    hadHtml: false,
    byteLengthOriginal: Buffer.byteLength(partial.normalizedText, "utf8"),
    fetchedAt: now,
    sanitizedAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

describe("message-content.repository concurrency", () => {
  it("P2002 même hash → ALREADY_FETCHED après relecture", async () => {
    const s = sanitized("hello concurrent")
    const existing = record({
      normalizedText: s.normalizedText,
      contentHash: s.contentHash,
    })

    let createCalls = 0
    const db = {
      acquisitionMessageContent: {
        findFirst: async () => {
          // 1er find (avant create) = null ; après P2002 = existing
          if (createCalls === 0) return null
          return existing
        },
        create: async () => {
          createCalls++
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["acquisitionMessageId"] },
          })
        },
        update: async () => {
          throw new Error("must not update on same hash")
        },
      },
    }

    const repo = new AcquisitionMessageContentRepository(db as never)
    const result = await repo.upsertNormalized({
      companyId: "co1",
      acquisitionMessageId: "msg1",
      sanitized: s,
      fetchedAt: new Date(),
    })
    assert.equal(createCalls, 1)
    assert.equal(result.outcome, "ALREADY_FETCHED")
    assert.equal(result.record.id, existing.id)
  })

  it("P2002 hash différent → UPDATED", async () => {
    const sNew = sanitized("nouveau texte")
    const existing = record({
      id: "c-old",
      normalizedText: "ancien",
      contentHash: "oldhash",
    })
    let createCalls = 0
    const db = {
      acquisitionMessageContent: {
        findFirst: async () => {
          if (createCalls === 0) return null
          return existing
        },
        create: async () => {
          createCalls++
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["acquisitionMessageId"] },
          })
        },
        update: async ({ data }: { data: Record<string, unknown> }) =>
          record({
            id: existing.id,
            normalizedText: String(data.normalizedText),
            contentHash: String(data.contentHash),
          }),
      },
    }

    const repo = new AcquisitionMessageContentRepository(db as never)
    const result = await repo.upsertNormalized({
      companyId: "co1",
      acquisitionMessageId: "msg1",
      sanitized: sNew,
      fetchedAt: new Date(),
    })
    assert.equal(result.outcome, "UPDATED")
    assert.equal(result.record.contentHash, sNew.contentHash)
  })

  it("P2002 étrangère (relecture null) → erreur de persistance", async () => {
    const s = sanitized("orphan race")
    const db = {
      acquisitionMessageContent: {
        findFirst: async () => null,
        create: async () => {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["somethingElse"] },
          })
        },
      },
    }
    const repo = new AcquisitionMessageContentRepository(db as never)
    await assert.rejects(
      () =>
        repo.upsertNormalized({
          companyId: "co1",
          acquisitionMessageId: "msg1",
          sanitized: s,
          fetchedAt: new Date(),
        } satisfies UpsertMessageContentInput),
      (err: unknown) =>
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
    )
  })

  it("deux créations concurrentes simulées → une seule ligne logique", async () => {
    const s = sanitized("shared body")
    let stored: MessageContentRecord | null = null

    const db = {
      acquisitionMessageContent: {
        findFirst: async () => stored,
        create: async ({ data }: { data: MessageContentRecord }) => {
          if (stored) {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
              code: "P2002",
              clientVersion: "test",
              meta: { target: ["acquisitionMessageId"] },
            })
          }
          stored = record({
            id: "winner",
            normalizedText: data.normalizedText,
            contentHash: data.contentHash,
            companyId: data.companyId,
            acquisitionMessageId: data.acquisitionMessageId,
          })
          return stored
        },
        update: async () => {
          throw new Error("unexpected update")
        },
      },
    }

    const repo = new AcquisitionMessageContentRepository(db as never)
    const input = {
      companyId: "co1",
      acquisitionMessageId: "msg1",
      sanitized: s,
      fetchedAt: new Date(),
    }

    const [a, b] = await Promise.all([
      repo.upsertNormalized(input),
      repo.upsertNormalized(input),
    ])

    assert.ok(
      (a.outcome === "FETCHED" || a.outcome === "ALREADY_FETCHED") &&
        (b.outcome === "FETCHED" || b.outcome === "ALREADY_FETCHED")
    )
    assert.equal(a.record.contentHash, b.record.contentHash)
    assert.equal(a.record.id, "winner")
    assert.equal(b.record.id, "winner")
  })
})
