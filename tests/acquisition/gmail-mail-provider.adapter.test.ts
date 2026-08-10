process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import {
  GmailMailProviderAdapter,
  buildAcquisitionGmailLookbackQuery,
} from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import type {
  GmailHistoryListResponse,
  GmailMessageResource,
  GmailMessagesListResponse,
  GmailProfileResponse,
} from "@/lib/acquisition/connector/gmail-api.types"

const COMPANY = "company-gmail-adapter"

function sampleMessage(id: string, overrides: Partial<GmailMessageResource> = {}): GmailMessageResource {
  return {
    id,
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Aperçu du message",
    internalDate: "1720000000000",
    payload: {
      headers: [
        { name: "From", value: "contact@lauralu.fr" },
        { name: "Subject", value: "Consultation terrain" },
        { name: "Date", value: "Wed, 03 Jul 2024 10:00:00 +0000" },
        { name: "Message-ID", value: "<msg@test.local>" },
        { name: "Authorization", value: "Bearer secret-token" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          body: { size: 50, data: "c2VjcmV0IGJvZHk=" },
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "plan.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    },
    ...overrides,
  }
}

describe("GmailMailProviderAdapter", () => {
  let connectionClient: GmailConnectionClient
  let apiClient: GmailApiClient
  let listMessagesCalls: { query: string; pageToken?: string; pageSize: number }[]
  let listHistoryCalls: { startHistoryId: string; pageToken?: string; pageSize: number }[]

  beforeEach(() => {
    listMessagesCalls = []
    listHistoryCalls = []

    connectionClient = {
      getValidAccessToken: async (companyId: string) => {
        assert.equal(companyId, COMPANY)
        return "valid-token"
      },
    }

    apiClient = {
      getProfile: async () => ({ historyId: "profile-hist-99" } satisfies GmailProfileResponse),
      listHistory: async (_token, startHistoryId, pageSize, pageToken) => {
        listHistoryCalls.push({ startHistoryId, pageSize, pageToken })
        return {
          history: [{ messagesAdded: [{ message: { id: "msg-1" } }] }],
          historyId: "hist-1",
          nextPageToken: pageToken ? undefined : "hist-page-2",
        } satisfies GmailHistoryListResponse
      },
      listMessages: async (_token, query, pageSize, pageToken) => {
        listMessagesCalls.push({ query, pageSize, pageToken })
        return {
          messages: [{ id: pageToken ? "msg-p2" : "msg-1" }],
          nextPageToken: pageToken ? undefined : "page-2",
        } satisfies GmailMessagesListResponse
      },
      getMessage: async (_token, messageId) => sampleMessage(messageId),
      getAttachment: async () => ({ size: 0, data: "" }),
    }
  })

  it("connexion absente → GMAIL_NOT_CONNECTED", async () => {
    const adapter = new GmailMailProviderAdapter({
      connectionClient: {
        getValidAccessToken: async () => {
          throw new GmailProviderError({
            code: "GMAIL_NOT_CONNECTED",
            message: "Aucune connexion Gmail active pour cette entreprise",
            retryable: false,
            global: true,
          })
        },
      },
      apiClient,
    })

    await assert.rejects(
      () => adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "GMAIL_NOT_CONNECTED")
        return true
      }
    )
  })

  it("scan initial — fail-closed si aucune identité partenaire", async () => {
    const adapter = new GmailMailProviderAdapter({
      connectionClient,
      apiClient,
      lookbackDays: 14,
      domainListing: {
        listActiveIdentities: async () => ({ domains: [], emails: [] }),
        listActiveDomains: async () => [],
      },
    })

    await assert.rejects(
      () =>
        adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "NO_ACTIVE_PARTNER_IDENTITIES")
        return true
      }
    )
    assert.equal(listMessagesCalls.length, 0)
  })

  it("scan initial — préfiltre from:@domaine si domaines actifs", async () => {
    const adapter = new GmailMailProviderAdapter({
      connectionClient,
      apiClient,
      lookbackDays: 14,
      domainListing: {
        listActiveIdentities: async () => ({
          domains: ["lauralu.fr"],
          emails: [],
        }),
        listActiveDomains: async () => ["lauralu.fr"],
      },
    })

    const page = await adapter.listMessagesPage({
      companyId: COMPANY,
      cursor: null,
      pageSize: 5,
    })

    assert.equal(page.messages.length, 1)
    const expected = buildAcquisitionGmailLookbackQuery(14, {
      domains: ["lauralu.fr"],
      emails: [],
    })
    assert.equal(expected.ok, true)
    if (expected.ok) {
      assert.equal(listMessagesCalls[0].query, expected.query)
    }
    assert.ok(listMessagesCalls[0].query.includes("from:@lauralu.fr"))
    assert.equal(page.nextHistoryId, "profile-hist-99")
    assert.equal(page.paginationMode, "lookback")
  })

  it("messages.list deux pages — nextPageToken transmis", async () => {
    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })

    const page1 = await adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 5 })
    const page2 = await adapter.listMessagesPage({
      companyId: COMPANY,
      cursor: null,
      pageToken: page1.nextPageToken,
      paginationMode: "lookback",
      pageSize: 5,
    })

    assert.equal(page1.nextPageToken, "page-2")
    assert.equal(listMessagesCalls[1].pageToken, "page-2")
    assert.equal(page2.messages[0].externalMessageId, "msg-p2")
    assert.equal(page2.hasMore, false)
  })

  it("mapping From, Subject, Date, labels et snippet", async () => {
    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })
    const page = await adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 10 })
    const msg = page.messages[0]

    assert.equal(msg.fromHeader, "contact@lauralu.fr")
    assert.equal(msg.subject, "Consultation terrain")
    assert.deepEqual(msg.labels, ["INBOX", "UNREAD"])
    assert.equal(msg.snippet, "Aperçu du message")
    assert.equal(msg.receivedAt.toISOString(), new Date(1720000000000).toISOString())
    assert.equal(msg.attachments[0].filename, "plan.pdf")
  })

  it("body.data et headers sensibles absents du modèle canonique", async () => {
    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })
    const page = await adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 10 })
    const msg = page.messages[0]
    const serialized = JSON.stringify(msg)

    assert.ok(!serialized.includes("body.data"))
    assert.ok(!serialized.includes("c2VjcmV0"))
    assert.ok(!serialized.includes("secret-token"))
    assert.ok(!serialized.includes("Bearer"))
    assert.ok(!("data" in (msg.providerMetadata ?? {})))
  })

  it("vrai expéditeur non-LAURALU récupéré tel quel (rejet délégué à ingestion)", async () => {
    apiClient.getMessage = async () =>
      sampleMessage("ext-1", {
        payload: {
          headers: [{ name: "From", value: "attacker@gmail.com" }],
          mimeType: "text/plain",
        },
      })

    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })
    const page = await adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 5 })

    assert.equal(page.messages[0].fromHeader, "attacker@gmail.com")
  })

  it("historyId expiré → fallback lookback paginé sans préfiltre expéditeur", async () => {
    apiClient.listHistory = async () => {
      throw new GmailProviderError({
        code: "GMAIL_HISTORY_EXPIRED",
        message: "Gmail historyId expired or invalid",
        retryable: true,
        global: true,
      })
    }

    const adapter = new GmailMailProviderAdapter({
      connectionClient,
      apiClient,
      lookbackDays: 30,
      domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      },
    })
    const page = await adapter.listMessagesPage({
      companyId: COMPANY,
      cursor: "stale-history",
      pageSize: 10,
    })

    assert.equal(page.messages.length, 1)
    assert.equal(listMessagesCalls.length, 1)
    assert.ok(listMessagesCalls[0].query.includes("from:@lauralu.fr"))
    assert.equal(page.paginationMode, "lookback")
    assert.equal(page.nextPageToken, "page-2")
  })

  it("historyId valide — history.list deux pages et déduplication messageAdded", async () => {
    apiClient.listHistory = async (_token, startHistoryId, pageSize, pageToken) => {
      listHistoryCalls.push({ startHistoryId, pageSize, pageToken })
      if (!pageToken) {
        return {
          history: [
            {
              messagesAdded: [
                { message: { id: "dup" } },
                { message: { id: "dup" } },
                { message: { id: "unique-1" } },
              ],
            },
          ],
          historyId: "hist-mid",
          nextPageToken: "hist-tok-2",
        }
      }
      return {
        history: [{ messagesAdded: [{ message: { id: "unique-2" } }] }],
        historyId: "hist-final",
      }
    }

    apiClient.listMessages = async () => {
      throw new Error("listMessages should not be called when history succeeds")
    }

    let getMessageCalls = 0
    apiClient.getMessage = async (_token, id) => {
      getMessageCalls++
      return sampleMessage(id)
    }

    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })

    const page1 = await adapter.listMessagesPage({
      companyId: COMPANY,
      cursor: "hist-start",
      pageSize: 10,
    })
    const page2 = await adapter.listMessagesPage({
      companyId: COMPANY,
      cursor: "hist-start",
      pageToken: page1.nextPageToken,
      paginationMode: "history",
      pageSize: 10,
    })

    assert.equal(page1.messages.length, 2)
    assert.equal(getMessageCalls, 3)
    assert.equal(page1.nextHistoryId, "hist-mid")
    assert.equal(page1.paginationMode, "history")
    assert.equal(page2.messages.length, 1)
    assert.equal(page2.nextHistoryId, "hist-final")
    assert.equal(listHistoryCalls[1].pageToken, "hist-tok-2")
  })

  it("message MIME invalide → page partiellement exploitable", async () => {
    apiClient.getMessage = async (_token, id) => {
      if (id === "bad-msg") return { id: "bad-msg" }
      return sampleMessage(id)
    }
    apiClient.listMessages = async () => ({
      messages: [{ id: "good-msg" }, { id: "bad-msg" }],
    })

    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })
    const page = await adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 10 })

    assert.equal(page.messages.length, 1)
    assert.equal(page.messages[0].externalMessageId, "good-msg")
  })

  it("erreur 429 globale → retryable", async () => {
    apiClient.listMessages = async () => {
      throw new GmailProviderError({
        code: "GMAIL_RATE_LIMITED",
        message: "Gmail API rate limit exceeded",
        retryable: true,
        global: true,
      })
    }

    const adapter = new GmailMailProviderAdapter({ connectionClient, apiClient, domainListing: {
        listActiveIdentities: async () => ({ domains: ["lauralu.fr"], emails: [] }),
        listActiveDomains: async () => ["lauralu.fr"],
      } })
    await assert.rejects(
      () => adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "GMAIL_RATE_LIMITED")
        assert.equal(err.retryable, true)
        return true
      }
    )
  })

  it("aucune donnée sensible dans les erreurs propagées", async () => {
    const adapter = new GmailMailProviderAdapter({
      connectionClient: {
        getValidAccessToken: async () => {
          throw new GmailProviderError({
            code: "GMAIL_TOKEN_REFRESH_FAILED",
            message: "Échec du refresh token",
            retryable: false,
            global: true,
          })
        },
      },
      apiClient,
    })

    await assert.rejects(
      () => adapter.listMessagesPage({ companyId: COMPANY, cursor: null, pageSize: 5 }),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        const serialized = JSON.stringify(err)
        assert.ok(!serialized.includes("valid-token"))
        assert.ok(!serialized.includes("Bearer"))
        return true
      }
    )
  })
})

describe("PrismaGmailConnectionClient (refresh token)", () => {
  it("refresh échoué → GMAIL_TOKEN_REFRESH_FAILED", async () => {
    const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID
    const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET
    const previousGmailTokenEncryptionKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY

    process.env.GOOGLE_CLIENT_ID = "client-id"
    process.env.GOOGLE_CLIENT_SECRET = "client-secret"
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key-32chars-min!!"

    const { encrypt } = await import("@/lib/encryption")
    const { PrismaGmailConnectionClient } = await import(
      "@/lib/acquisition/connector/gmail-connection.client"
    )

    const mockDb = {
      gmailConnection: {
        findUnique: async () => ({
          companyId: COMPANY,
          accessToken: encrypt("old-access"),
          refreshToken: encrypt("old-refresh"),
          tokenExpiry: new Date(Date.now() - 1000),
        }),
        update: async () => ({}),
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "Token revoked" }, { status: 400 })
    ) as typeof fetch

    try {
      const client = new PrismaGmailConnectionClient(mockDb as never)
      await assert.rejects(
        () => client.getValidAccessToken(COMPANY),
        (err: unknown) => {
          assert.ok(err instanceof GmailProviderError)
          assert.equal(err.code, "GMAIL_TOKEN_REFRESH_FAILED")
          assert.ok(!err.message.includes("old-refresh"))
          return true
        }
      )
    } finally {
      globalThis.fetch = originalFetch
      if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID
      else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId
      if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET
      else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret
      if (previousGmailTokenEncryptionKey === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY
      else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = previousGmailTokenEncryptionKey
    }
  })
})

describe("PrismaGmailConnectionClient — connection diag (flag)", () => {
  const ENV_KEY = "ACQUISITION_GMAIL_DIAGNOSTIC"
  const PREFIX = "[acquisition-gmail-connection-diag]"
  let previousEnv: string | undefined
  let previousGoogleClientId: string | undefined
  let previousGoogleClientSecret: string | undefined
  let previousGmailTokenEncryptionKey: string | undefined
  let infoCalls: unknown[][]
  let originalInfo: typeof console.info
  let originalFetch: typeof globalThis.fetch

  function restoreEnvVar(key: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }

  beforeEach(() => {
    previousEnv = process.env[ENV_KEY]
    previousGoogleClientId = process.env.GOOGLE_CLIENT_ID
    previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET
    previousGmailTokenEncryptionKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY
    delete process.env[ENV_KEY]
    process.env.GOOGLE_CLIENT_ID = "client-id"
    process.env.GOOGLE_CLIENT_SECRET = "client-secret"
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key-32chars-min!!"
    infoCalls = []
    originalInfo = console.info
    console.info = (...args: unknown[]) => {
      infoCalls.push(args)
    }
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    console.info = originalInfo
    globalThis.fetch = originalFetch
    restoreEnvVar(ENV_KEY, previousEnv)
    restoreEnvVar("GOOGLE_CLIENT_ID", previousGoogleClientId)
    restoreEnvVar("GOOGLE_CLIENT_SECRET", previousGoogleClientSecret)
    restoreEnvVar("GMAIL_TOKEN_ENCRYPTION_KEY", previousGmailTokenEncryptionKey)
  })

  function diagLogs(): string[] {
    return infoCalls
      .filter((args) => typeof args[0] === "string" && (args[0] as string).startsWith(PREFIX))
      .map((args) => String(args[0]))
  }

  function assertSafeDiagPayload(raw: string): { stage: string } {
    assert.ok(raw.startsWith(`${PREFIX} `))
    const payload = JSON.parse(raw.slice(PREFIX.length + 1)) as Record<string, unknown>
    assert.deepEqual(Object.keys(payload).sort(), ["stage"])
    assert.equal(typeof payload.stage, "string")
    assert.ok(!("message" in payload))
    assert.ok(!("stack" in payload))
    assert.ok(!("errorName" in payload))
    assert.ok(!raw.includes("old-access"))
    assert.ok(!raw.includes("old-refresh"))
    assert.ok(!raw.includes("client-secret"))
    assert.ok(!raw.includes("secret-token"))
    assert.ok(!raw.includes("secret-xyz"))
    assert.ok(!raw.includes("new-access-token-value"))
    assert.ok(!raw.includes("https://"))
    assert.ok(!raw.includes("Bearer"))
    return payload as { stage: string }
  }

  async function loadClient() {
    const { encrypt } = await import("@/lib/encryption")
    const { PrismaGmailConnectionClient } = await import(
      "@/lib/acquisition/connector/gmail-connection.client"
    )
    return { encrypt, PrismaGmailConnectionClient }
  }

  function expiredConn(encrypt: (s: string) => string, overrides: Record<string, unknown> = {}) {
    return {
      companyId: COMPANY,
      accessToken: encrypt("old-access"),
      refreshToken: encrypt("old-refresh"),
      tokenExpiry: new Date(Date.now() - 1000),
      ...overrides,
    }
  }

  it("flag OFF => aucun log même si findUnique throw", async () => {
    delete process.env[ENV_KEY]
    const { PrismaGmailConnectionClient } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => {
          throw new Error("db-down secret-token-xyz")
        },
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY), /db-down/)
    assert.equal(diagLogs().length, 0)
  })

  it("flag non-true (1) => aucun log", async () => {
    process.env[ENV_KEY] = "1"
    const { PrismaGmailConnectionClient } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => {
          throw new Error("db-down")
        },
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY))
    assert.equal(diagLogs().length, 0)
  })

  it("findUnique throw => CONNECTION_LOOKUP", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => {
          throw new Error("lookup failed with secret-xyz")
        },
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY), /lookup failed/)
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "CONNECTION_LOOKUP")
  })

  it("decrypt accessToken throw => ACCESS_TOKEN_DECRYPT", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => ({
          companyId: COMPANY,
          accessToken: "not-valid-ciphertext",
          refreshToken: encrypt("old-refresh"),
          tokenExpiry: new Date(Date.now() + 60_000_000),
        }),
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY))
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "ACCESS_TOKEN_DECRYPT")
  })

  it("decrypt refreshToken throw => REFRESH_TOKEN_DECRYPT + GmailProviderError métier inchangé", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () =>
          expiredConn(encrypt, { refreshToken: "not-valid-ciphertext" }),
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(
      () => client.getValidAccessToken(COMPANY),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "GMAIL_TOKEN_REFRESH_FAILED")
        return true
      }
    )
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "REFRESH_TOKEN_DECRYPT")
  })

  it("fetch network throw => TOKEN_REFRESH_REQUEST", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => expiredConn(encrypt),
      },
    }
    globalThis.fetch = mock.fn(async () => {
      throw new Error("network down secret-token")
    }) as typeof fetch
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY), /network down/)
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "TOKEN_REFRESH_REQUEST")
  })

  it("refreshRes.json throw => TOKEN_REFRESH_PARSE", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => expiredConn(encrypt),
      },
    }
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json body")
      },
    })) as typeof fetch
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY), /invalid json/)
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "TOKEN_REFRESH_PARSE")
  })

  it("db update throw => TOKEN_PERSIST", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => expiredConn(encrypt),
        update: async () => {
          throw new Error("persist failed secret-xyz")
        },
      },
    }
    globalThis.fetch = mock.fn(async () =>
      Response.json({ access_token: "new-access-token-value", expires_in: 3600 }, { status: 200 })
    ) as typeof fetch
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(() => client.getValidAccessToken(COMPANY), /persist failed/)
    const logs = diagLogs()
    assert.equal(logs.length, 1)
    assert.equal(assertSafeDiagPayload(logs[0]!).stage, "TOKEN_PERSIST")
    assert.ok(!logs[0]!.includes("new-access-token-value"))
  })

  it("GmailProviderError métier (refresh HTTP 400) => aucun log connection-diag", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => expiredConn(encrypt),
        update: async () => ({}),
      },
    }
    globalThis.fetch = mock.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "Token revoked" }, { status: 400 })
    ) as typeof fetch
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(
      () => client.getValidAccessToken(COMPANY),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "GMAIL_TOKEN_REFRESH_FAILED")
        return true
      }
    )
    assert.equal(diagLogs().length, 0)
  })

  it("GMAIL_NOT_CONNECTED => aucun log connection-diag", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => null,
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    await assert.rejects(
      () => client.getValidAccessToken(COMPANY),
      (err: unknown) => {
        assert.ok(err instanceof GmailProviderError)
        assert.equal(err.code, "GMAIL_NOT_CONNECTED")
        return true
      }
    )
    assert.equal(diagLogs().length, 0)
  })

  it("succès token valide (non expiré) => aucun log + token métier inchangé", async () => {
    process.env[ENV_KEY] = "true"
    const { PrismaGmailConnectionClient, encrypt } = await loadClient()
    const mockDb = {
      gmailConnection: {
        findUnique: async () => ({
          companyId: COMPANY,
          accessToken: encrypt("valid-access-token"),
          refreshToken: encrypt("old-refresh"),
          tokenExpiry: new Date(Date.now() + 60_000_000),
        }),
      },
    }
    const client = new PrismaGmailConnectionClient(mockDb as never)
    const token = await client.getValidAccessToken(COMPANY)
    assert.equal(token, "valid-access-token")
    assert.equal(diagLogs().length, 0)
  })
})
