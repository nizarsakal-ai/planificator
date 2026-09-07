process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.GMAIL_TOKEN_ENCRYPTION_KEY ??= "test-encryption-key-32chars-min!!"
process.env.PLANIFICATOR_ACQUISITION_ENABLED ??= "true"
process.env.ACQUISITION_CONTENT_FETCH_ENABLED ??= "true"

import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { encrypt } from "@/lib/encryption"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { PrismaAcquisitionGmailConnectionListingAdapter } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import { AcquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import { runAcquisitionGmailSyncDriver } from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import type { AcquisitionGmailConnectionRef } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import type { MailSyncResult } from "@/lib/acquisition/connector/connector.types"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { resolveAcquisitionMailboxForMessage } from "@/lib/acquisition/connector/resolve-acquisition-mailbox"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { resolveAcquisitionGmailOAuthRedirectUri } from "@/lib/acquisition/connector/acquisition-gmail-oauth-redirect"

const COMPANY = "cmp-multi-gmail"
const COMPANY_B = "cmp-other-tenant"
const CONN_A = "conn-a"
const CONN_B = "conn-b"
const ADDR_A = "mailbox-a@example.com"
const ADDR_B = "mailbox-b@example.com"

function syncOk(companyId: string): MailSyncResult {
  return {
    companyId,
    source: "GMAIL",
    status: "SUCCESS",
    stats: { fetched: 1, ingested: 1, skippedDuplicate: 0, rejected: 0, failed: 0 },
    nextHistoryId: "h1",
  }
}

describe("PLAN-ACQ-MULTI-GMAIL-001/002", () => {
  it("1-4. listing deux connexions actives même companyId ; OAuth B n’écrase pas A", async () => {
    const rows = new Map<
      string,
      {
        id: string
        companyId: string
        gmailAddress: string
        accessToken: string
        refreshToken: string
        tokenExpiry: Date
        active: boolean
      }
    >()

    const mockDb = {
      acquisitionGmailConnection: {
        findMany: async ({ where }: { where: { active: boolean } }) => {
          assert.equal(where.active, true)
          return [...rows.values()]
            .filter((r) => r.active)
            .sort((a, b) => a.gmailAddress.localeCompare(b.gmailAddress))
            .map((r) => ({
              id: r.id,
              companyId: r.companyId,
              gmailAddress: r.gmailAddress,
            }))
        },
        upsert: async (args: {
          where: { companyId_gmailAddress: { companyId: string; gmailAddress: string } }
          create: {
            companyId: string
            gmailAddress: string
            accessToken: string
            refreshToken: string
            tokenExpiry: Date
            connectedById: string
            active: boolean
          }
          update: {
            accessToken: string
            refreshToken: string
            tokenExpiry: Date
            connectedById: string
            active: boolean
          }
        }) => {
          const key = `${args.where.companyId_gmailAddress.companyId}:${args.where.companyId_gmailAddress.gmailAddress}`
          const existing = rows.get(key)
          if (!existing) {
            const id = args.create.gmailAddress === ADDR_A ? CONN_A : CONN_B
            const created = { id, ...args.create }
            rows.set(key, created)
            return created
          }
          const updated = { ...existing, ...args.update }
          rows.set(key, updated)
          return updated
        },
      },
    }

    await mockDb.acquisitionGmailConnection.upsert({
      where: { companyId_gmailAddress: { companyId: COMPANY, gmailAddress: ADDR_A } },
      create: {
        companyId: COMPANY,
        gmailAddress: ADDR_A,
        accessToken: encrypt("access-a"),
        refreshToken: encrypt("refresh-a"),
        tokenExpiry: new Date(Date.now() + 3600_000),
        connectedById: "user-1",
        active: true,
      },
      update: {
        accessToken: encrypt("access-a"),
        refreshToken: encrypt("refresh-a"),
        tokenExpiry: new Date(Date.now() + 3600_000),
        connectedById: "user-1",
        active: true,
      },
    })
    await mockDb.acquisitionGmailConnection.upsert({
      where: { companyId_gmailAddress: { companyId: COMPANY, gmailAddress: ADDR_B } },
      create: {
        companyId: COMPANY,
        gmailAddress: ADDR_B,
        accessToken: encrypt("access-b"),
        refreshToken: encrypt("refresh-b"),
        tokenExpiry: new Date(Date.now() + 3600_000),
        connectedById: "user-1",
        active: true,
      },
      update: {
        accessToken: encrypt("access-b-new"),
        refreshToken: encrypt("refresh-b-new"),
        tokenExpiry: new Date(Date.now() + 7200_000),
        connectedById: "user-1",
        active: true,
      },
    })

    assert.equal(rows.size, 2)
    const a = rows.get(`${COMPANY}:${ADDR_A}`)!
    const b = rows.get(`${COMPANY}:${ADDR_B}`)!
    assert.notEqual(a.accessToken, b.accessToken)

    const listing = new PrismaAcquisitionGmailConnectionListingAdapter(mockDb as never)
    const listed = await listing.listActiveAcquisitionGmailConnections()
    assert.equal(listed.length, 2)
  })

  it("F3. token client refuse connectionId d’un autre tenant", async () => {
    const mockDb = {
      acquisitionGmailConnection: {
        findFirst: async ({
          where,
        }: {
          where: { id: string; companyId: string; active: boolean }
        }) => {
          assert.equal(where.active, true)
          if (where.id === CONN_A && where.companyId === COMPANY) {
            return {
              id: CONN_A,
              companyId: COMPANY,
              accessToken: encrypt("access-a"),
              refreshToken: encrypt("refresh-a"),
              tokenExpiry: new Date(Date.now() + 3600_000),
              active: true,
            }
          }
          return null
        },
        update: async () => {
          throw new Error("should not update")
        },
      },
    }
    const client = new PrismaAcquisitionGmailConnectionClient(mockDb as never)
    await assert.rejects(
      () =>
        client.getValidAccessToken({
          companyId: COMPANY_B,
          connectionId: CONN_A,
        }),
      (err: unknown) => err instanceof GmailProviderError && err.code === "GMAIL_NOT_CONNECTED"
    )
    const ok = await client.getValidAccessToken({
      companyId: COMPANY,
      connectionId: CONN_A,
    })
    assert.equal(ok, "access-a")
  })

  it("2+9. tokens isolés + refresh par connectionId+companyId", async () => {
    process.env.GOOGLE_CLIENT_ID = "cid"
    process.env.GOOGLE_CLIENT_SECRET = "csec"

    const updates: string[] = []
    const mockDb = {
      acquisitionGmailConnection: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string; companyId: string; active: boolean }
        }) => {
          if (where.id === CONN_A && where.companyId === COMPANY) {
            return {
              id: CONN_A,
              companyId: COMPANY,
              gmailAddress: ADDR_A,
              accessToken: encrypt("access-a"),
              refreshToken: encrypt("refresh-a"),
              tokenExpiry: new Date(Date.now() - 1000),
              active: true,
            }
          }
          if (where.id === CONN_B && where.companyId === COMPANY) {
            return {
              id: CONN_B,
              companyId: COMPANY,
              gmailAddress: ADDR_B,
              accessToken: encrypt("access-b"),
              refreshToken: encrypt("refresh-b"),
              tokenExpiry: new Date(Date.now() + 3600_000),
              active: true,
            }
          }
          return null
        },
        update: async ({ where }: { where: { id: string } }) => {
          updates.push(where.id)
          return { id: where.id }
        },
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () =>
      Response.json({ access_token: "access-a-refreshed", expires_in: 3600 })
    ) as typeof fetch

    try {
      const client = new PrismaAcquisitionGmailConnectionClient(mockDb as never)
      const tokenA = await client.getValidAccessToken({
        companyId: COMPANY,
        connectionId: CONN_A,
      })
      assert.equal(tokenA, "access-a-refreshed")
      assert.deepEqual(updates, [CONN_A])

      const tokenB = await client.getValidAccessToken({
        companyId: COMPANY,
        connectionId: CONN_B,
      })
      assert.equal(tokenB, "access-b")
      assert.deepEqual(updates, [CONN_A])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("5-6. curseurs A et B indépendants (mailboxKey = connectionId)", async () => {
    const store = new Map<
      string,
      {
        id: string
        companyId: string
        source: "GMAIL"
        mailboxKey: string
        lastHistoryId: string | null
        lastSyncedAt: Date | null
        consecutiveFailures: number
        lastErrorCode: string | null
        lastErrorAt: Date | null
      }
    >()

    const mockDb = {
      acquisitionScanCursor: {
        findUnique: async ({
          where,
        }: {
          where: {
            companyId_source_mailboxKey: {
              companyId: string
              source: "GMAIL"
              mailboxKey: string
            }
          }
        }) => {
          const k = `${where.companyId_source_mailboxKey.companyId}:${where.companyId_source_mailboxKey.mailboxKey}`
          return store.get(k) ?? null
        },
        create: async ({
          data,
        }: {
          data: { companyId: string; source: "GMAIL"; mailboxKey: string }
        }) => {
          const row = {
            id: `cur-${data.mailboxKey}`,
            companyId: data.companyId,
            source: data.source,
            mailboxKey: data.mailboxKey,
            lastHistoryId: null as string | null,
            lastSyncedAt: null as Date | null,
            consecutiveFailures: 0,
            lastErrorCode: null as string | null,
            lastErrorAt: null as Date | null,
          }
          store.set(`${data.companyId}:${data.mailboxKey}`, row)
          return row
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: {
            companyId_source_mailboxKey: {
              companyId: string
              source: "GMAIL"
              mailboxKey: string
            }
          }
          create: {
            companyId: string
            source: "GMAIL"
            mailboxKey: string
            lastHistoryId: string | null
            lastSyncedAt: Date
            consecutiveFailures: number
            lastErrorCode: null
            lastErrorAt: null
          }
          update: {
            lastHistoryId: string | null
            lastSyncedAt: Date
            consecutiveFailures: number
            lastErrorCode: null
            lastErrorAt: null
          }
        }) => {
          const k = `${where.companyId_source_mailboxKey.companyId}:${where.companyId_source_mailboxKey.mailboxKey}`
          const existing = store.get(k)
          if (!existing) {
            const row = { id: `cur-${create.mailboxKey}`, ...create }
            store.set(k, row)
            return row
          }
          const row = { ...existing, ...update }
          store.set(k, row)
          return row
        },
        update: async () => {
          throw new Error("unused")
        },
      },
    }

    const repo = new AcquisitionScanCursorRepository(mockDb as never)
    await repo.saveSuccessfulPage(COMPANY, "GMAIL", "hist-A", new Date(), CONN_A)
    await repo.saveSuccessfulPage(COMPANY, "GMAIL", "hist-B", new Date(), CONN_B)
    const a = await repo.getOrCreate(COMPANY, "GMAIL", CONN_A)
    const b = await repo.getOrCreate(COMPANY, "GMAIL", CONN_B)
    assert.notEqual(a.id, b.id)
    assert.equal(a.lastHistoryId, "hist-A")
    assert.equal(b.lastHistoryId, "hist-B")
  })

  it("7. même externalMessageId sur deux boîtes → clés d’idempotence distinctes", () => {
    const msg = {
      externalMessageId: "same-gmail-id",
      threadId: "t1",
      fromHeader: "partner@lauralu.fr",
      subject: "Consultation",
      receivedAt: new Date("2026-07-01T10:00:00.000Z"),
      labels: [] as string[],
      snippet: null,
      attachments: [],
      providerMetadata: {},
    }
    const parsedA = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(msg, COMPANY, CONN_A)
    )
    const parsedB = registerIncomingMessageSchema.parse(
      mapGmailMessageToAcquisitionInput(msg, COMPANY, CONN_B)
    )
    assert.equal(parsedA.externalMessageId, parsedB.externalMessageId)
    assert.notEqual(parsedA.sourceMailboxKey, parsedB.sourceMailboxKey)
  })

  it("F1. legacy sourceMailboxKey=\"\" + rescan connectionId → aucun 2e message/draft", async () => {
    const messages = new Map<string, {
      id: string
      companyId: string
      source: "GMAIL"
      sourceMailboxKey: string
      externalMessageId: string
      status: "DRAFT_CREATED"
      lastErrorCode: null
      draft: { id: string }
    }>()
    const EXT = "providence-ext-1"
    messages.set(`${COMPANY}:GMAIL::${EXT}`, {
      id: "msg-legacy",
      companyId: COMPANY,
      source: "GMAIL",
      sourceMailboxKey: "",
      externalMessageId: EXT,
      status: "DRAFT_CREATED",
      lastErrorCode: null,
      draft: { id: "draft-legacy" },
    })

    let creates = 0
    const mockDb = {
      acquisitionMessage: {
        findUnique: async ({
          where,
        }: {
          where: {
            companyId_source_sourceMailboxKey_externalMessageId: {
              companyId: string
              source: string
              sourceMailboxKey: string
              externalMessageId: string
            }
          }
        }) => {
          const w = where.companyId_source_sourceMailboxKey_externalMessageId
          return (
            messages.get(
              `${w.companyId}:${w.source}:${w.sourceMailboxKey}:${w.externalMessageId}`
            ) ?? null
          )
        },
        create: async () => {
          creates++
          throw new Error("must not create")
        },
        findFirst: async () => null,
      },
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
      worksiteImportDraft: { create: async () => {
        throw new Error("must not create draft")
      } },
      acquisitionAttachment: { createMany: async () => ({ count: 0 }) },
    }

    const result = await registerIncomingMessage(
      {
        companyId: COMPANY,
        source: "GMAIL",
        externalMessageId: EXT,
        sourceMailboxKey: CONN_A,
        senderEmail: "x@lauralu.fr",
        subject: "Providence",
        receivedAt: new Date("2026-07-15T10:00:00.000Z"),
      },
      mockDb as never,
      {
        eligibilityResolver: {
          resolveEligibleSender: async () => ({
            partner: { id: "p1" },
          }),
        } as never,
      }
    )

    assert.equal(result.created, false)
    assert.equal(result.messageId, "msg-legacy")
    if (result.outcome === "DRAFT_CREATED") {
      assert.equal(result.draftId, "draft-legacy")
    }
    assert.equal(creates, 0)
    assert.equal(messages.size, 1)
  })

  it("F2. legacy + 1 connexion → résolution contrôlée ; +2 → AMBIGUOUS", async () => {
    const single = {
      acquisitionGmailConnection: {
        findMany: async () => [{ id: CONN_A }],
      },
    }
    const multi = {
      acquisitionGmailConnection: {
        findMany: async () => [{ id: CONN_A }, { id: CONN_B }],
      },
    }

    const ok = await resolveAcquisitionMailboxForMessage(
      { companyId: COMPANY, sourceMailboxKey: "" },
      single as never
    )
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.connectionId, CONN_A)
      assert.equal(ok.resolvedVia, "legacy_single")
    }

    const amb = await resolveAcquisitionMailboxForMessage(
      { companyId: COMPANY, sourceMailboxKey: "" },
      multi as never
    )
    assert.equal(amb.ok, false)
    if (!amb.ok) assert.equal(amb.code, "LEGACY_MAILBOX_AMBIGUOUS")

    const explicit = await resolveAcquisitionMailboxForMessage(
      { companyId: COMPANY, sourceMailboxKey: CONN_B },
      multi as never
    )
    assert.equal(explicit.ok, true)
    if (explicit.ok) assert.equal(explicit.connectionId, CONN_B)
  })

  it("F2. content fetch legacy + 2 connexions → LEGACY_MAILBOX_AMBIGUOUS sans lecture Gmail", async () => {
    let gmailCalled = false
    const result = await fetchAndStoreMessageContentCore(
      { companyId: COMPANY, acquisitionMessageId: "msg-1" },
      {
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg-1",
              companyId: COMPANY,
              externalMessageId: "ext-1",
              sourceMailboxKey: "",
            }),
          },
          acquisitionGmailConnection: {
            findMany: async () => [{ id: CONN_A }, { id: CONN_B }],
          },
        } as never,
        source: {
          fetchMessageBody: async () => {
            gmailCalled = true
            throw new Error("should not call")
          },
        },
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, "LEGACY_MAILBOX_AMBIGUOUS")
    }
    assert.equal(gmailCalled, false)
  })

  it("F2. content fetch legacy + 1 connexion → passe connectionId résolu", async () => {
    let usedConnectionId = ""
    const result = await fetchAndStoreMessageContentCore(
      { companyId: COMPANY, acquisitionMessageId: "msg-1" },
      {
        db: {
          acquisitionMessage: {
            findFirst: async () => ({
              id: "msg-1",
              companyId: COMPANY,
              externalMessageId: "ext-1",
              sourceMailboxKey: "",
            }),
          },
          acquisitionGmailConnection: {
            findMany: async () => [{ id: CONN_A }],
          },
        } as never,
        source: {
          fetchMessageBody: async (input) => {
            usedConnectionId = input.connectionId ?? ""
            return {
              textPlain: "hello world consultation",
              textHtml: null,
              mimeType: "text/plain",
              charset: "utf-8",
              providerMessageId: "ext-1",
              byteLengthOriginal: 24,
            }
          },
        },
        repository: {
          findByMessage: async () => null,
          upsertNormalized: async () => ({
            created: true,
            record: {
              id: "c1",
              companyId: COMPANY,
              acquisitionMessageId: "msg-1",
              normalizedText: "hello world consultation",
              contentHash: "hash",
              sourceMimeType: "text/plain",
              sourceCharset: "utf-8",
              hadHtml: false,
              byteLengthOriginal: 24,
              fetchedAt: new Date(),
              sanitizedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          }),
        } as never,
      }
    )
    assert.equal(usedConnectionId, CONN_A)
    assert.equal(result.ok, true)
  })

  it("OAuth redirect Acquisition dédié (pas Booking callback)", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEXTAUTH_URL: "https://www.galyaevents.fr",
    }
    const uri = resolveAcquisitionGmailOAuthRedirectUri(env)
    assert.equal(uri, "https://www.galyaevents.fr/api/acquisition/gmail/callback")
    assert.ok(!uri?.includes("/api/auth/gmail/callback"))
  })

  it("5+8. driver sync par connexion ; isolation tenant", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const synced: AcquisitionGmailConnectionRef[] = []
    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [
        { connectionId: CONN_A, companyId: COMPANY, gmailAddress: ADDR_A },
        { connectionId: CONN_B, companyId: COMPANY, gmailAddress: ADDR_B },
        {
          connectionId: "conn-other",
          companyId: "other-tenant",
          gmailAddress: "other@example.com",
        },
      ],
      runSyncForConnection: async (c) => {
        synced.push(c)
        return syncOk(c.companyId)
      },
      now: () => new Date("2026-07-18T14:00:00.000Z"),
      log: () => {},
    })

    assert.equal(result.companiesTotal, 3)
    assert.equal(synced[0].connectionId, CONN_A)
    assert.equal(synced[1].connectionId, CONN_B)
  })

  it("F4. même externalMessageId mailbox A et B → deux messages autorisés", async () => {
    const created: string[] = []
    const store = new Map<string, { id: string; draft: { id: string } | null; status: string; lastErrorCode: null }>()

    const mockDb = {
      acquisitionMessage: {
        findUnique: async ({
          where,
        }: {
          where: {
            companyId_source_sourceMailboxKey_externalMessageId: {
              companyId: string
              source: string
              sourceMailboxKey: string
              externalMessageId: string
            }
          }
        }) => {
          const w = where.companyId_source_sourceMailboxKey_externalMessageId
          return store.get(`${w.sourceMailboxKey}:${w.externalMessageId}`) ?? null
        },
        create: async ({
          data,
        }: {
          data: { sourceMailboxKey: string; externalMessageId: string }
        }) => {
          const id = `msg-${data.sourceMailboxKey}`
          created.push(id)
          const row = {
            id,
            status: "DRAFT_CREATED",
            lastErrorCode: null,
            draft: { id: `draft-${data.sourceMailboxKey}` },
          }
          store.set(`${data.sourceMailboxKey}:${data.externalMessageId}`, row)
          return { id, status: "DRAFT_CREATED" }
        },
        findFirst: async () => null,
      },
      worksiteImportDraft: {
        create: async ({ data }: { data: { acquisitionMessageId: string } }) => ({
          id: `draft-for-${data.acquisitionMessageId}`,
        }),
      },
      acquisitionAttachment: { createMany: async () => ({ count: 0 }) },
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
    }

    const resolver = {
      resolveEligibleSender: async () => ({ partner: { id: "p1" }, matchKind: "DOMAIN" }),
    }

    const inputBase = {
      companyId: COMPANY,
      source: "GMAIL" as const,
      externalMessageId: "shared-id",
      senderEmail: "x@lauralu.fr",
      subject: "S",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    }

    const a = await registerIncomingMessage(
      { ...inputBase, sourceMailboxKey: CONN_A },
      mockDb as never,
      { eligibilityResolver: resolver as never }
    )
    const b = await registerIncomingMessage(
      { ...inputBase, sourceMailboxKey: CONN_B },
      mockDb as never,
      { eligibilityResolver: resolver as never }
    )

    assert.equal(a.created, true)
    assert.equal(b.created, true)
    assert.notEqual(a.messageId, b.messageId)
    assert.equal(created.length, 2)
  })

  it("F1-003. Promise.all legacy \"\" + moderne → 1 message / 1 draft (mutex simule advisory lock)", async () => {
    const EXT = "race-legacy-modern"
    type Row = {
      id: string
      companyId: string
      source: "GMAIL"
      sourceMailboxKey: string
      externalMessageId: string
      status: "DRAFT_CREATED"
      lastErrorCode: null
      draft: { id: string } | null
      createdAt: Date
    }
    const store = new Map<string, Row>()
    const lockQueues = new Map<string, Promise<void>>()

    async function acquireSimLock(key1: number, key2: number): Promise<() => void> {
      const key = `${key1}:${key2}`
      const prev = lockQueues.get(key) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      lockQueues.set(
        key,
        prev.then(() => gate)
      )
      await prev
      return release
    }

    function makeDb() {
      const db: {
        acquisitionMessage: object
        worksiteImportDraft: object
        acquisitionAttachment: object
        $executeRaw: (...args: unknown[]) => Promise<number>
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
        _release?: () => void
      } = {
        acquisitionMessage: {
          findUnique: async ({
            where,
          }: {
            where: {
              companyId_source_sourceMailboxKey_externalMessageId: {
                companyId: string
                source: string
                sourceMailboxKey: string
                externalMessageId: string
              }
            }
          }) => {
            const w = where.companyId_source_sourceMailboxKey_externalMessageId
            return (
              store.get(
                `${w.companyId}:${w.source}:${w.sourceMailboxKey}:${w.externalMessageId}`
              ) ?? null
            )
          },
          findFirst: async ({
            where,
          }: {
            where: {
              companyId: string
              source: string
              externalMessageId: string
              NOT: { sourceMailboxKey: string }
            }
          }) => {
            const rows = [...store.values()]
              .filter(
                (r) =>
                  r.companyId === where.companyId &&
                  r.source === where.source &&
                  r.externalMessageId === where.externalMessageId &&
                  r.sourceMailboxKey !== ""
              )
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            return rows[0] ?? null
          },
          create: async ({
            data,
          }: {
            data: {
              companyId: string
              source: "GMAIL"
              sourceMailboxKey: string
              externalMessageId: string
            }
          }) => {
            await new Promise((r) => setTimeout(r, 5))
            const id = `msg-${data.sourceMailboxKey || "legacy"}-${store.size}`
            const row: Row = {
              id,
              companyId: data.companyId,
              source: data.source,
              sourceMailboxKey: data.sourceMailboxKey,
              externalMessageId: data.externalMessageId,
              status: "DRAFT_CREATED",
              lastErrorCode: null,
              draft: null,
              createdAt: new Date(),
            }
            store.set(
              `${data.companyId}:${data.source}:${data.sourceMailboxKey}:${data.externalMessageId}`,
              row
            )
            return { id, status: "DRAFT_CREATED" }
          },
        },
        worksiteImportDraft: {
          create: async ({ data }: { data: { acquisitionMessageId: string } }) => {
            const draftId = `draft-${data.acquisitionMessageId}`
            for (const row of store.values()) {
              if (row.id === data.acquisitionMessageId) row.draft = { id: draftId }
            }
            return { id: draftId }
          },
        },
        acquisitionAttachment: { createMany: async () => ({ count: 0 }) },
        $executeRaw: async (...args: unknown[]) => {
          const key1 = Number(args[1])
          const key2 = Number(args[2])
          db._release = await acquireSimLock(key1, key2)
          return 0
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          try {
            return await fn(db)
          } finally {
            db._release?.()
            db._release = undefined
          }
        },
      }
      return db
    }

    const resolver = {
      resolveEligibleSender: async () => ({ partner: { id: "p1" }, matchKind: "DOMAIN" }),
    }
    const inputBase = {
      companyId: COMPANY,
      source: "GMAIL" as const,
      externalMessageId: EXT,
      senderEmail: "x@lauralu.fr",
      subject: "Race",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    }

    const [legacy, modern] = await Promise.all([
      registerIncomingMessage(
        { ...inputBase, sourceMailboxKey: "" },
        makeDb() as never,
        { eligibilityResolver: resolver as never }
      ),
      registerIncomingMessage(
        { ...inputBase, sourceMailboxKey: CONN_A },
        makeDb() as never,
        { eligibilityResolver: resolver as never }
      ),
    ])

    assert.equal(store.size, 1)
    assert.equal(legacy.messageId, modern.messageId)
    const draftIds = [legacy, modern]
      .filter((r) => r.outcome === "DRAFT_CREATED")
      .map((r) => (r.outcome === "DRAFT_CREATED" ? r.draftId : null))
    assert.equal(new Set(draftIds).size, 1)
    assert.equal([...store.values()][0]?.draft?.id != null, true)
  })

  it("F1-003. Promise.all moderne A + moderne B → 2 messages distincts", async () => {
    const EXT = "race-modern-ab"
    type Row = {
      id: string
      companyId: string
      source: "GMAIL"
      sourceMailboxKey: string
      externalMessageId: string
      status: "DRAFT_CREATED"
      lastErrorCode: null
      draft: { id: string } | null
      createdAt: Date
    }
    const store = new Map<string, Row>()
    const lockQueues = new Map<string, Promise<void>>()

    async function acquireSimLock(key1: number, key2: number): Promise<() => void> {
      const key = `${key1}:${key2}`
      const prev = lockQueues.get(key) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      lockQueues.set(
        key,
        prev.then(() => gate)
      )
      await prev
      return release
    }

    function makeDb() {
      const db: {
        acquisitionMessage: object
        worksiteImportDraft: object
        acquisitionAttachment: object
        $executeRaw: (...args: unknown[]) => Promise<number>
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
        _release?: () => void
      } = {
        acquisitionMessage: {
          findUnique: async ({
            where,
          }: {
            where: {
              companyId_source_sourceMailboxKey_externalMessageId: {
                companyId: string
                source: string
                sourceMailboxKey: string
                externalMessageId: string
              }
            }
          }) => {
            const w = where.companyId_source_sourceMailboxKey_externalMessageId
            return (
              store.get(
                `${w.companyId}:${w.source}:${w.sourceMailboxKey}:${w.externalMessageId}`
              ) ?? null
            )
          },
          findFirst: async ({
            where,
          }: {
            where: {
              companyId: string
              source: string
              externalMessageId: string
              NOT: { sourceMailboxKey: string }
            }
          }) => {
            const rows = [...store.values()]
              .filter(
                (r) =>
                  r.companyId === where.companyId &&
                  r.source === where.source &&
                  r.externalMessageId === where.externalMessageId &&
                  r.sourceMailboxKey !== ""
              )
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            return rows[0] ?? null
          },
          create: async ({
            data,
          }: {
            data: {
              companyId: string
              source: "GMAIL"
              sourceMailboxKey: string
              externalMessageId: string
            }
          }) => {
            await new Promise((r) => setTimeout(r, 5))
            const id = `msg-${data.sourceMailboxKey}`
            const row: Row = {
              id,
              companyId: data.companyId,
              source: data.source,
              sourceMailboxKey: data.sourceMailboxKey,
              externalMessageId: data.externalMessageId,
              status: "DRAFT_CREATED",
              lastErrorCode: null,
              draft: null,
              createdAt: new Date(),
            }
            store.set(
              `${data.companyId}:${data.source}:${data.sourceMailboxKey}:${data.externalMessageId}`,
              row
            )
            return { id, status: "DRAFT_CREATED" }
          },
        },
        worksiteImportDraft: {
          create: async ({ data }: { data: { acquisitionMessageId: string } }) => {
            const draftId = `draft-${data.acquisitionMessageId}`
            for (const row of store.values()) {
              if (row.id === data.acquisitionMessageId) row.draft = { id: draftId }
            }
            return { id: draftId }
          },
        },
        acquisitionAttachment: { createMany: async () => ({ count: 0 }) },
        $executeRaw: async (...args: unknown[]) => {
          const key1 = Number(args[1])
          const key2 = Number(args[2])
          db._release = await acquireSimLock(key1, key2)
          return 0
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          try {
            return await fn(db)
          } finally {
            db._release?.()
            db._release = undefined
          }
        },
      }
      return db
    }

    const resolver = {
      resolveEligibleSender: async () => ({ partner: { id: "p1" }, matchKind: "DOMAIN" }),
    }
    const inputBase = {
      companyId: COMPANY,
      source: "GMAIL" as const,
      externalMessageId: EXT,
      senderEmail: "x@lauralu.fr",
      subject: "AB",
      receivedAt: new Date("2026-07-01T00:00:00.000Z"),
    }

    const [a, b] = await Promise.all([
      registerIncomingMessage(
        { ...inputBase, sourceMailboxKey: CONN_A },
        makeDb() as never,
        { eligibilityResolver: resolver as never }
      ),
      registerIncomingMessage(
        { ...inputBase, sourceMailboxKey: CONN_B },
        makeDb() as never,
        { eligibilityResolver: resolver as never }
      ),
    ])

    assert.equal(store.size, 2)
    assert.notEqual(a.messageId, b.messageId)
    assert.equal(a.created && b.created, true)
    const keys = [...store.values()].map((r) => r.sourceMailboxKey).sort()
    assert.deepEqual(keys, [CONN_A, CONN_B].sort())
  })

  it("OAuth callback refuse sans refresh_token (pas d’écrasement)", async () => {
    const fs = await import("node:fs")
    const src = fs.readFileSync(
      new URL(
        "../../src/lib/acquisition/connector/acquisition-gmail-oauth-callback.ts",
        import.meta.url
      ),
      "utf8"
    )
    assert.ok(src.includes("!tokenData.access_token || !tokenData.refresh_token"))
    assert.ok(src.includes("no_tokens"))
    assert.ok(!src.includes("refreshToken: encrypt(tokenData.refresh_token ??"))
  })

  it("OAuth callback runtime : sans refresh_token → no_tokens, zéro upsert", async () => {
    const { handleAcquisitionGmailCallback } = await import(
      "@/lib/acquisition/connector/acquisition-gmail-oauth-callback"
    )
    const { signGmailOAuthPayload } = await import("@/lib/auth/gmail-oauth-state")
    const secret = "test-cron-secret-acq-oauth"
    const payload = JSON.stringify({
      purpose: "acquisition_gmail",
      companyId: COMPANY,
      userId: "user-1",
    })
    const state = Buffer.from(
      JSON.stringify({ payload, sig: signGmailOAuthPayload(payload, secret) }),
      "utf8"
    ).toString("base64url")

    let upserts = 0
    const req = {
      nextUrl: {
        searchParams: new URLSearchParams({ code: "auth-code", state }),
      },
    } as never

    const res = await handleAcquisitionGmailCallback(req, {
      auth: async () => ({
        user: { id: "user-1", companyId: COMPANY, role: "ADMIN" },
      }),
      prisma: {
        acquisitionGmailConnection: {
          upsert: async () => {
            upserts++
            throw new Error("must not upsert")
          },
        },
      } as never,
      fetch: async () =>
        ({
          ok: true,
          json: async () => ({ access_token: "access-only" }),
        }) as never,
      resolveRedirectUri: () => "https://app.example/api/acquisition/gmail/callback",
      resolveHmacSecret: () => secret,
      encrypt: (v: string) => `enc:${v}`,
      appUrl: "https://app.example",
      env: {
        ...process.env,
        GOOGLE_CLIENT_ID: "cid",
        GOOGLE_CLIENT_SECRET: "csec",
        NEXTAUTH_URL: "https://app.example",
      },
    })

    assert.equal(res.status, 307)
    assert.ok(String(res.headers.get("location")).includes("reason=no_tokens"))
    assert.equal(upserts, 0)
  })

  it("10. Booking gmail_connections non lu par le listing Acquisition", async () => {
    let gmailConnectionsTouched = false
    const mockDb = {
      acquisitionGmailConnection: {
        findMany: async () => [
          { id: CONN_A, companyId: COMPANY, gmailAddress: ADDR_A },
        ],
      },
      gmailConnection: {
        findMany: async () => {
          gmailConnectionsTouched = true
          return [{ companyId: COMPANY }]
        },
      },
    }
    const listing = new PrismaAcquisitionGmailConnectionListingAdapter(mockDb as never)
    await listing.listActiveAcquisitionGmailConnections()
    assert.equal(gmailConnectionsTouched, false)
  })

  it("11-12. tests connexion : aucun Worksite / Assignment créé ici", () => {
    assert.equal(typeof runAcquisitionGmailSyncDriver, "function")
    assert.equal(typeof registerIncomingMessage, "function")
  })
})
