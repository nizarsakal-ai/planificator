process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { Prisma } from "@prisma/client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { fetchAndStoreMessageContent } from "@/lib/acquisition/content/message-content.service"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"
import type { MessageContentRecord } from "@/lib/acquisition/content/message-content.types"
import type { UpsertMessageContentInput } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"

function actor(role: "ADMIN" | "TEAM_LEADER" | "EMPLOYEE" = "ADMIN") {
  return { userId: "u1", role, companyId: "co1" as string | null }
}

describe("message-content.service", () => {
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    content: process.env.ACQUISITION_CONTENT_FETCH_ENABLED,
    maxNorm: process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    delete process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = envBackup.content
    process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES = envBackup.maxNorm
  })

  it("refuse si flag OFF", async () => {
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "false"
    const result = await fetchAndStoreMessageContent({
      actor: actor(),
      acquisitionMessageId: "msg1",
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "CONTENT_FETCH_DISABLED")
      assert.equal(result.outcome, "DISABLED")
    }
  })

  it("refuse TEAM_LEADER", async () => {
    const result = await fetchAndStoreMessageContent({
      actor: actor("TEAM_LEADER"),
      acquisitionMessageId: "msg1",
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "CONTENT_FORBIDDEN")
  })

  it("fetch + upsert happy path et ALREADY_FETCHED", async () => {
    const store = new Map<string, MessageContentRecord>()
    const source: AcquisitionMessageContentSourcePort = {
      async fetchMessageBody() {
        return {
          textPlain: "Consultation LAURALU chantier X",
          textHtml: null,
          mimeType: "text/plain",
          charset: "utf-8",
          providerMessageId: "gmail-1",
          byteLengthOriginal: 32,
        }
      },
    }

    const repository = {
      async findByMessage(companyId: string, acquisitionMessageId: string) {
        return store.get(`${companyId}:${acquisitionMessageId}`) ?? null
      },
      async upsertNormalized(input: UpsertMessageContentInput) {
        const key = `${input.companyId}:${input.acquisitionMessageId}`
        const existing = store.get(key)
        if (existing && existing.contentHash === input.sanitized.contentHash) {
          return { record: existing, outcome: "ALREADY_FETCHED" as const }
        }
        const record: MessageContentRecord = {
          id: existing?.id ?? "content-1",
          companyId: input.companyId,
          acquisitionMessageId: input.acquisitionMessageId,
          normalizedText: input.sanitized.normalizedText,
          contentHash: input.sanitized.contentHash,
          sourceMimeType: input.sanitized.sourceMimeType,
          sourceCharset: input.sanitized.sourceCharset,
          hadHtml: input.sanitized.hadHtml,
          byteLengthOriginal: input.sanitized.byteLengthOriginal,
          fetchedAt: input.fetchedAt,
          sanitizedAt: input.sanitized.sanitizedAt,
          createdAt: existing?.createdAt ?? input.fetchedAt,
          updatedAt: input.fetchedAt,
        }
        store.set(key, record)
        return {
          record,
          outcome: existing ? ("UPDATED" as const) : ("FETCHED" as const),
        }
      },
    }

    const db = {
      acquisitionMessage: {
        findFirst: async () => ({
          id: "msg1",
          externalMessageId: "gmail-1",
          companyId: "co1",
        }),
      },
    }

    const first = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      { db: db as never, source, repository: repository as never }
    )
    assert.equal(first.ok, true)
    if (first.ok) {
      assert.equal(first.outcome, "FETCHED")
      assert.equal(first.idempotent, false)
    }

    const second = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      { db: db as never, source, repository: repository as never }
    )
    assert.equal(second.ok, true)
    if (second.ok) {
      assert.equal(second.outcome, "ALREADY_FETCHED")
      assert.equal(second.idempotent, true)
    }
  })

  it("refuse contenu normalisé trop volumineux sans appeler le repository", async () => {
    process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES = "10"
    let repoCalled = false
    const source: AcquisitionMessageContentSourcePort = {
      async fetchMessageBody() {
        return {
          textPlain: "abcdefghijklmnop", // > 10 bytes utf8
          textHtml: null,
          mimeType: "text/plain",
          charset: null,
          providerMessageId: "g",
          byteLengthOriginal: 16,
        }
      },
    }
    const result = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      {
        source,
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg1",
              externalMessageId: "g",
              companyId: "co1",
            }),
          },
        } as never,
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async () => {
            repoCalled = true
            throw new Error("should not persist")
          },
        } as never,
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "ACQUISITION_CONTENT_TOO_LARGE")
      assert.equal(result.outcome, "ACQUISITION_CONTENT_TOO_LARGE")
    }
    assert.equal(repoCalled, false)
  })

  it("accepte exactement à la limite UTF-8", async () => {
    process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES = "20"
    // 10 × 'é' = 20 bytes
    const text = "é".repeat(10)
    const sanitized = sanitizeMessageBodyParts({
      textPlain: text,
      textHtml: null,
      mimeType: "text/plain",
      charset: "utf-8",
      providerMessageId: "g",
      byteLengthOriginal: 20,
    })
    assert.equal(sanitized.byteLengthNormalized, 20)

    const source: AcquisitionMessageContentSourcePort = {
      async fetchMessageBody() {
        return {
          textPlain: text,
          textHtml: null,
          mimeType: "text/plain",
          charset: "utf-8",
          providerMessageId: "g",
          byteLengthOriginal: 20,
        }
      },
    }
    const result = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      {
        source,
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg1",
              externalMessageId: "g",
              companyId: "co1",
            }),
          },
        } as never,
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async (input: UpsertMessageContentInput) => ({
            record: {
              id: "c1",
              companyId: input.companyId,
              acquisitionMessageId: input.acquisitionMessageId,
              normalizedText: input.sanitized.normalizedText,
              contentHash: input.sanitized.contentHash,
              sourceMimeType: input.sanitized.sourceMimeType,
              sourceCharset: input.sanitized.sourceCharset,
              hadHtml: input.sanitized.hadHtml,
              byteLengthOriginal: input.sanitized.byteLengthOriginal,
              fetchedAt: input.fetchedAt,
              sanitizedAt: input.sanitized.sanitizedAt,
              createdAt: input.fetchedAt,
              updatedAt: input.fetchedAt,
            },
            outcome: "FETCHED" as const,
          }),
        } as never,
      }
    )
    assert.equal(result.ok, true)
  })

  it("refuse un octet au-dessus avec Unicode", async () => {
    process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES = "20"
    // 10 × 'é' = 20 bytes + 'a' = 21
    const text = `${"é".repeat(10)}a`
    const result = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      {
        source: {
          async fetchMessageBody() {
            return {
              textPlain: text,
              textHtml: null,
              mimeType: "text/plain",
              charset: "utf-8",
              providerMessageId: "g",
              byteLengthOriginal: 21,
            }
          },
        },
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg1",
              externalMessageId: "g",
              companyId: "co1",
            }),
          },
        } as never,
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async () => {
            throw new Error("must not persist")
          },
        } as never,
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "ACQUISITION_CONTENT_TOO_LARGE")
  })

  it("mappe Gmail NOT_FOUND", async () => {
    const result = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      {
        source: {
          async fetchMessageBody() {
            throw new GmailProviderError({
              code: "GMAIL_MESSAGE_NOT_FOUND",
              message: "gone",
              retryable: false,
              global: false,
            })
          },
        },
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg1",
              externalMessageId: "gmail-missing",
              companyId: "co1",
            }),
          },
        } as never,
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async () => {
            throw new Error("should not upsert")
          },
        } as never,
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "GMAIL_MESSAGE_NOT_FOUND")
  })

  it("ne fuit pas de détail Gmail dans le message public", async () => {
    const result = await fetchAndStoreMessageContent(
      { actor: actor(), acquisitionMessageId: "msg1" },
      {
        source: {
          async fetchMessageBody() {
            throw new GmailProviderError({
              code: "GMAIL_UNAUTHORIZED",
              message: "Bearer ya29.secret-token-leak",
              retryable: false,
              global: true,
            })
          },
        },
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg1",
              externalMessageId: "g",
              companyId: "co1",
            }),
          },
        } as never,
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async () => {
            throw new Error("no")
          },
        } as never,
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(!result.message.includes("Bearer"))
      assert.ok(!result.message.includes("ya29"))
    }
  })

  it("logs uniquement hashPrefix (anti-fuite)", async () => {
    const logs: string[] = []
    const original = console.info
    console.info = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      const text = "Contenu log test UNIQUE_SECRET_BODY"
      const source: AcquisitionMessageContentSourcePort = {
        async fetchMessageBody() {
          return {
            textPlain: text,
            textHtml: null,
            mimeType: "text/plain",
            charset: null,
            providerMessageId: "g",
            byteLengthOriginal: text.length,
          }
        },
      }
      const sanitized = sanitizeMessageBodyParts({
        textPlain: text,
        textHtml: null,
        mimeType: "text/plain",
        charset: null,
        providerMessageId: "g",
        byteLengthOriginal: text.length,
      })
      await fetchAndStoreMessageContent(
        { actor: actor(), acquisitionMessageId: "msg1" },
        {
          source,
          db: {
            acquisitionMessage: {
              findFirst: async () => ({
                id: "msg1",
                externalMessageId: "g",
                companyId: "co1",
              }),
            },
          } as never,
          repository: {
            findByMessage: async () => null,
            upsertNormalized: async (input: UpsertMessageContentInput) => ({
              record: {
                id: "c-log",
                companyId: input.companyId,
                acquisitionMessageId: input.acquisitionMessageId,
                normalizedText: input.sanitized.normalizedText,
                contentHash: input.sanitized.contentHash,
                sourceMimeType: input.sanitized.sourceMimeType,
                sourceCharset: input.sanitized.sourceCharset,
                hadHtml: input.sanitized.hadHtml,
                byteLengthOriginal: input.sanitized.byteLengthOriginal,
                fetchedAt: input.fetchedAt,
                sanitizedAt: input.sanitized.sanitizedAt,
                createdAt: input.fetchedAt,
                updatedAt: input.fetchedAt,
              },
              outcome: "FETCHED" as const,
            }),
          } as never,
        }
      )
      const joined = logs.join("\n")
      assert.ok(joined.includes("hashPrefix"))
      assert.ok(!joined.includes(sanitized.contentHash))
      assert.ok(!joined.includes("UNIQUE_SECRET_BODY"))
      assert.ok(!joined.includes("normalizedText"))
    } finally {
      console.info = original
    }
  })
})
