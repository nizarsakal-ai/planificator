process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { Role } from "@prisma/client"
import {
  handleFetchMessageContent,
  handleGetMessageContent,
} from "@/lib/acquisition/content/message-content.handler"
import type { MessageContentRecord } from "@/lib/acquisition/content/message-content.types"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"
import { contentHashPrefix } from "@/lib/acquisition/content/content-fetch-feature-flag"

function session(role: Role, companyId: string | null = "co-route") {
  return async () => ({
    user: { id: "user-1", role, companyId },
  })
}

function assertSecurityHeaders(res: Response) {
  assert.equal(res.headers.get("Cache-Control"), "private, no-store, max-age=0")
  assert.equal(res.headers.get("Pragma"), "no-cache")
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff")
}

const sampleContent: MessageContentRecord = {
  id: "c1",
  companyId: "co-route",
  acquisitionMessageId: "msg1",
  normalizedText: "Texte OK secret-should-not-leak-in-post",
  contentHash: "abcdef0123456789deadbeef",
  sourceMimeType: "text/plain",
  sourceCharset: null,
  hadHtml: false,
  byteLengthOriginal: 8,
  fetchedAt: new Date("2026-07-19T10:00:00Z"),
  sanitizedAt: new Date("2026-07-19T10:00:00Z"),
  createdAt: new Date("2026-07-19T10:00:00Z"),
  updatedAt: new Date("2026-07-19T10:00:01Z"),
}

describe("message-content.handler routes", () => {
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    content: process.env.ACQUISITION_CONTENT_FETCH_ENABLED,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = envBackup.content
  })

  it("GET 401 sans session + headers", async () => {
    const res = await handleGetMessageContent(new Request("http://localhost"), "msg1", {
      auth: async () => null,
    })
    assert.equal(res.status, 401)
    assertSecurityHeaders(res)
  })

  it("POST 403 EMPLOYEE + headers", async () => {
    const res = await handleFetchMessageContent(new Request("http://localhost"), "msg1", {
      auth: session("EMPLOYEE"),
    })
    assert.equal(res.status, 403)
    assertSecurityHeaders(res)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "CONTENT_FORBIDDEN")
  })

  it("GET 404 cross-tenant + headers", async () => {
    const res = await handleGetMessageContent(new Request("http://localhost"), "msg1", {
      auth: session("ADMIN"),
      repository: {
        findByMessage: async () => null,
      } as never,
    })
    assert.equal(res.status, 404)
    assertSecurityHeaders(res)
  })

  it("POST succès sans normalizedText + headers", async () => {
    const source: AcquisitionMessageContentSourcePort = {
      async fetchMessageBody() {
        return {
          textPlain: "Texte OK",
          textHtml: null,
          mimeType: "text/plain",
          charset: null,
          providerMessageId: "g1",
          byteLengthOriginal: 8,
        }
      },
    }

    const res = await handleFetchMessageContent(new Request("http://localhost"), "msg1", {
      auth: session("ADMIN"),
      source,
      db: {
        acquisitionMessage: {
          findFirst: async () => ({
            id: "msg1",
            externalMessageId: "g1",
            companyId: "co-route",
          }),
        },
      } as never,
      repository: {
        findByMessage: async () => null,
        upsertNormalized: async () => ({ record: sampleContent, outcome: "FETCHED" }),
      } as never,
    })

    assert.equal(res.status, 200)
    assertSecurityHeaders(res)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.equal(body.outcome, "FETCHED")
    assert.equal(body.contentId, "c1")
    assert.equal(body.acquisitionMessageId, "msg1")
    assert.equal(body.hashPrefix, contentHashPrefix(sampleContent.contentHash))
    assert.equal(body.normalizedText, undefined)
    assert.equal(body.content, undefined)
    assert.equal(body.textHtml, undefined)
    assert.ok(!JSON.stringify(body).includes("secret-should-not-leak-in-post"))
    assert.ok(!JSON.stringify(body).includes(sampleContent.contentHash))
  })

  it("GET succès contient normalizedText + headers", async () => {
    const res = await handleGetMessageContent(new Request("http://localhost"), "msg1", {
      auth: session("ADMIN"),
      repository: {
        findByMessage: async () => sampleContent,
      } as never,
    })
    assert.equal(res.status, 200)
    assertSecurityHeaders(res)
    const body = (await res.json()) as { content: { normalizedText: string } }
    assert.equal(body.content.normalizedText, sampleContent.normalizedText)
  })
})

describe("content logs anti-fuite", () => {
  it("hashPrefix ≤ 8 caractères et pas le hash complet", () => {
    const full = "abcdef0123456789deadbeefcafe"
    const prefix = contentHashPrefix(full)
    assert.equal(prefix.length, 8)
    assert.equal(prefix, "abcdef01")
    assert.notEqual(prefix, full)
  })
})
