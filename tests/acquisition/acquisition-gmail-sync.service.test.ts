process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  syncAcquisitionMailForCompany,
  DEFAULT_GMAIL_PAGE_SIZE,
} from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type {
  AcquisitionScanCursorRecord,
  AcquisitionScanCursorRepositoryPort,
} from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import type { CanonicalMailMessage, MailPage } from "@/lib/acquisition/connector/connector.types"
import type { RegisterIncomingMessageResult } from "@/lib/acquisition/acquisition.service"

const COMPANY = "company-sync-test"
const NOW = new Date("2026-07-18T12:00:00.000Z")

function emptyPage(overrides: Partial<MailPage> = {}): MailPage {
  return {
    messages: [],
    nextPageToken: null,
    nextHistoryId: null,
    hasMore: false,
    paginationMode: "lookback",
    ...overrides,
  }
}

function mail(overrides: Partial<CanonicalMailMessage> = {}): CanonicalMailMessage {
  return {
    externalMessageId: overrides.externalMessageId ?? "msg-1",
    threadId: "t-1",
    fromHeader: overrides.fromHeader ?? "user@lauralu.fr",
    subject: "Sujet",
    receivedAt: NOW,
    labels: [],
    snippet: null,
    attachments: [],
    providerMetadata: {},
    ...overrides,
  }
}

function makeCursor(overrides: Partial<AcquisitionScanCursorRecord> = {}): AcquisitionScanCursorRecord {
  return {
    id: "cursor-1",
    companyId: COMPANY,
    source: "GMAIL",
    lastHistoryId: "hist-0",
    lastSyncedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    ...overrides,
  }
}

function mockRepository(initial = makeCursor()) {
  let cursor = { ...initial }
  let saveCount = 0
  const savedHistoryIds: (string | null)[] = []
  const repo: AcquisitionScanCursorRepositoryPort = {
    getOrCreate: async (companyId, source) => {
      assert.equal(companyId, cursor.companyId)
      assert.equal(source, "GMAIL")
      return { ...cursor, companyId }
    },
    saveSuccessfulPage: async (companyId, source, nextHistoryId, syncedAt) => {
      saveCount++
      savedHistoryIds.push(nextHistoryId)
      cursor = {
        ...cursor,
        lastHistoryId: nextHistoryId,
        lastSyncedAt: syncedAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorAt: null,
      }
      return { ...cursor }
    },
    recordFailure: async (companyId, source, errorCode, occurredAt) => {
      cursor = {
        ...cursor,
        consecutiveFailures: cursor.consecutiveFailures + 1,
        lastErrorCode: errorCode,
        lastErrorAt: occurredAt,
      }
      return { ...cursor }
    },
  }
  return {
    repo,
    getCursor: () => cursor,
    getSaveCount: () => saveCount,
    getSavedHistoryIds: () => savedHistoryIds,
  }
}

interface ProviderCall {
  pageToken?: string | null
  paginationMode?: string
  pageSize: number
}

function mockProvider(pages: MailPage[]) {
  const calls: ProviderCall[] = []
  let call = 0
  const provider: MailProviderPort = {
    source: "GMAIL",
    listMessagesPage: async ({ pageToken, paginationMode, pageSize }) => {
      calls.push({ pageToken, paginationMode, pageSize })
      return pages[call++] ?? emptyPage()
    },
  }
  return { provider, calls }
}

function mockIngestion(options: {
  enabled?: boolean
  handler?: (id: string) => RegisterIncomingMessageResult | Error
}) {
  let calls = 0
  const ingestion: AcquisitionIngestionPort = {
    isEnabled: () => options.enabled ?? true,
    registerIncomingMessage: async (input) => {
      calls++
      const h = options.handler
      if (!h) {
        return {
          created: true,
          outcome: "DRAFT_CREATED",
          messageId: `m-${input.externalMessageId}`,
          draftId: `d-${input.externalMessageId}`,
        }
      }
      const r = h(input.externalMessageId)
      if (r instanceof Error) throw r
      return r
    },
  }
  return { ingestion, getCalls: () => calls }
}

function buildPagedProvider(
  totalMessages: number,
  pageSize: number,
  finalHistoryId: string
): { provider: MailProviderPort; calls: ProviderCall[] } {
  const totalPages = Math.ceil(totalMessages / pageSize)
  const pages: MailPage[] = []

  for (let p = 0; p < totalPages; p++) {
    const start = p * pageSize
    const count = Math.min(pageSize, totalMessages - start)
    const isLast = p === totalPages - 1
    pages.push({
      messages: Array.from({ length: count }, (_, i) =>
        mail({ externalMessageId: `msg-${start + i}` })
      ),
      nextPageToken: isLast ? null : `tok-page-${p + 2}`,
      nextHistoryId: isLast ? finalHistoryId : `hist-page-${p + 1}`,
      hasMore: !isLast,
      paginationMode: "lookback",
    })
  }

  return mockProvider(pages)
}

describe("syncAcquisitionMailForCompany", () => {
  beforeEach(() => {
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
  })

  it("feature flag désactivé → SKIPPED sans appel provider", async () => {
    let providerCalled = false
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        providerCalled = true
        return emptyPage()
      },
    }
    const { ingestion } = mockIngestion({ enabled: false })
    const { repo } = mockRepository()

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "FEATURE_DISABLED")
    assert.equal(providerCalled, false)
  })

  it("pageSize limite chaque appel provider mais pas le total global", async () => {
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const { provider, calls } = buildPagedProvider(120, 50, "hist-final")

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 3)
    assert.ok(calls.every((c) => c.pageSize === 50))
    assert.equal(result.stats.fetched, 120)
    assert.equal(result.stats.ingested, 120)
  })

  it("aucune limite globale maxMessages — 300 messages traités en une sync", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor, getSaveCount } = mockRepository()
    const { provider, calls } = buildPagedProvider(300, 50, "hist-300")

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 6)
    assert.ok(calls.every((c) => c.pageSize === 50))
    assert.equal(result.stats.fetched, 300)
    assert.equal(getSaveCount(), 1)
    assert.equal(getCursor().lastHistoryId, "hist-300")
  })

  it("doublons déjà persistés dans les premières pages → pages suivantes atteintes", async () => {
    const seen = new Set<string>()
    const { ingestion } = mockIngestion({
      handler: (id) => {
        const created = !seen.has(id)
        seen.add(id)
        return {
          created,
          outcome: "DRAFT_CREATED",
          messageId: `m-${id}`,
          draftId: created ? `d-${id}` : `d-existing-${id}`,
        }
      },
    })
    const { repo, getCursor } = mockRepository()
    const { provider, calls } = buildPagedProvider(100, 50, "hist-dedup")

    const first = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    assert.equal(first.status, "SUCCESS")
    assert.equal(calls.length, 2)
    assert.equal(first.stats.ingested, 100)

    const { provider: provider2, calls: calls2 } = buildPagedProvider(100, 50, "hist-dedup-2")
    const second = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider: provider2,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    assert.equal(second.status, "SUCCESS")
    assert.equal(calls2.length, 2)
    assert.equal(second.stats.skippedDuplicate, 100)
    assert.equal(second.stats.ingested, 0)
    assert.equal(getCursor().lastHistoryId, "hist-dedup-2")
  })

  it("page vide avec nextPageToken → page suivante appelée", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor } = mockRepository()
    const { provider, calls } = mockProvider([
      {
        messages: [],
        nextPageToken: "tok-skip-empty",
        nextHistoryId: "hist-mid",
        hasMore: true,
        paginationMode: "lookback",
      },
      {
        messages: [mail({ externalMessageId: "after-empty" })],
        nextPageToken: null,
        nextHistoryId: "hist-final",
        hasMore: false,
        paginationMode: "lookback",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 2)
    assert.equal(calls[1].pageToken, "tok-skip-empty")
    assert.equal(result.stats.ingested, 1)
    assert.equal(getCursor().lastHistoryId, "hist-final")
  })

  it("plus de deux pages traitées dans une seule synchronisation", async () => {
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const { provider, calls } = buildPagedProvider(150, 50, "hist-150")

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 3)
    assert.equal(result.stats.fetched, 150)
  })

  it("deux pages — nextPageToken transmis, curseur avancé seulement après dernière page", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor, getSaveCount, getSavedHistoryIds } = mockRepository(
      makeCursor({ lastHistoryId: "hist-0" })
    )
    const { provider, calls } = mockProvider([
      {
        messages: [mail({ externalMessageId: "p1-m1" })],
        nextPageToken: "tok-page-2",
        nextHistoryId: "hist-intermediate",
        hasMore: true,
        paginationMode: "lookback",
      },
      {
        messages: [mail({ externalMessageId: "p2-m1" })],
        nextPageToken: null,
        nextHistoryId: "hist-final",
        hasMore: false,
        paginationMode: "lookback",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 2)
    assert.equal(calls[0].pageToken, null)
    assert.equal(calls[1].pageToken, "tok-page-2")
    assert.equal(getSaveCount(), 1)
    assert.deepEqual(getSavedHistoryIds(), ["hist-final"])
    assert.equal(getCursor().lastHistoryId, "hist-final")
    assert.equal(result.stats.ingested, 2)
  })

  it("erreur page 3 → curseur non avancé", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor } = mockRepository(makeCursor({ lastHistoryId: "hist-0" }))
    let call = 0
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async ({ pageToken }) => {
        call++
        if (call <= 2) {
          return {
            messages: [mail({ externalMessageId: `p${call}` })],
            nextPageToken: `tok-${call + 1}`,
            nextHistoryId: `hist-p${call}`,
            hasMore: true,
            paginationMode: "lookback",
          }
        }
        void pageToken
        throw new Error("GMAIL_PAGE_3_DOWN")
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "FAILED")
    assert.equal(getCursor().lastHistoryId, "hist-0")
    assert.equal(result.stats.ingested, 2)
    assert.equal(call, 3)
  })

  it("maxPagesPerRun atteint → PARTIAL PAGE_LIMIT_REACHED et curseur non avancé", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor } = mockRepository(makeCursor({ lastHistoryId: "hist-0" }))
    let call = 0
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        call++
        return {
          messages: [mail({ externalMessageId: `p${call}` })],
          nextPageToken: `tok-${call + 1}`,
          nextHistoryId: `hist-p${call}`,
          hasMore: true,
          paginationMode: "lookback",
        }
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      maxPagesPerRun: 2,
      now: () => NOW,
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "PAGE_LIMIT_REACHED")
    assert.equal(result.error?.code, "PAGE_LIMIT_REACHED")
    assert.ok(!result.error?.message.includes("Bearer"))
    assert.equal(getCursor().lastHistoryId, "hist-0")
    assert.equal(call, 2)
  })

  it("erreur sur un message → PARTIAL, curseur non avancé, diagnostic sûr", async () => {
    const GMAIL_ID = "fail-gmail-full-id-secret"
    const logs: { event: string; payload: Record<string, unknown> }[] = []
    const { ingestion } = mockIngestion({
      handler: (id) => {
        if (id === GMAIL_ID) throw new Error("INGESTION_DOWN secret=should-never-log")
        return {
          created: true,
          outcome: "DRAFT_CREATED",
          messageId: "ok",
          draftId: "d-ok",
        }
      },
    })
    const { repo, getCursor } = mockRepository(makeCursor({ lastHistoryId: "hist-before" }))
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "ok-1" }), mail({ externalMessageId: GMAIL_ID })],
        nextPageToken: null,
        nextHistoryId: "hist-after",
        hasMore: false,
        paginationMode: "history",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
      logIngestionFailure: (event, payload) => {
        logs.push({ event, payload: { ...payload } })
      },
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(result.error?.code, "MESSAGE_INGESTION_FAILED")
    assert.equal(result.error?.message, "Au moins un message n'a pas pu être persisté")
    assert.equal(result.error?.causeCode, "UNKNOWN_ERROR")
    assert.equal(typeof result.error?.failedMessageRef, "string")
    assert.equal(result.error?.failedMessageRef?.length, 12)
    assert.equal(getCursor().lastHistoryId, "hist-before")

    assert.equal(logs.length, 1)
    assert.equal(logs[0].event, "MESSAGE_INGESTION_FAILED")
    assert.equal(logs[0].payload.companyId, COMPANY)
    assert.equal(logs[0].payload.step, "REGISTER_INCOMING_MESSAGE")
    assert.equal(logs[0].payload.causeCode, "UNKNOWN_ERROR")
    assert.equal(logs[0].payload.messageIdHash, result.error?.failedMessageRef)
    const serialized = JSON.stringify(logs) + JSON.stringify(result.error)
    assert.equal(serialized.includes(GMAIL_ID), false)
    assert.equal(serialized.includes("INGESTION_DOWN"), false)
    assert.equal(serialized.includes("should-never-log"), false)
  })

  it("ZodError à l'enregistrement → causeCode ZOD_VALIDATION + chemins sans valeurs", async () => {
    const { ZodError, z } = await import("zod")
    const logs: Record<string, unknown>[] = []
    const schema = z.object({ senderEmail: z.string().min(3) })
    let zodErr: InstanceType<typeof ZodError>
    try {
      schema.parse({ senderEmail: "xy" })
      assert.fail("expected ZodError")
    } catch (e) {
      assert.ok(e instanceof ZodError)
      zodErr = e
    }
    const { ingestion } = mockIngestion({
      handler: () => {
        throw zodErr
      },
    })
    const { repo, getCursor } = mockRepository(makeCursor({ lastHistoryId: "hist-z" }))
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "zod-msg-1" })],
        nextPageToken: null,
        nextHistoryId: "hist-z-after",
        hasMore: false,
        paginationMode: "lookback",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
      logIngestionFailure: (_e, payload) => logs.push({ ...payload }),
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.error?.causeCode, "ZOD_VALIDATION")
    assert.deepEqual(logs[0].zodIssuePaths, ["senderEmail"])
    assert.equal(JSON.stringify(logs).includes("xy"), false)
    assert.equal(getCursor().lastHistoryId, "hist-z")
  })

  it("Prisma P2002 non résolu → PRISMA_UNIQUE_CONSTRAINT dans le diagnostic", async () => {
    const logs: Record<string, unknown>[] = []
    const prismaErr = Object.assign(new Error("Unique constraint failed on secret-field"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    })
    const { ingestion } = mockIngestion({
      handler: () => {
        throw prismaErr
      },
    })
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "p2002-msg" })],
        nextPageToken: null,
        nextHistoryId: "h1",
        hasMore: false,
        paginationMode: "lookback",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
      logIngestionFailure: (_e, payload) => logs.push({ ...payload }),
    })

    assert.equal(result.error?.causeCode, "PRISMA_UNIQUE_CONSTRAINT")
    assert.equal(logs[0].prismaCode, "P2002")
    assert.equal(JSON.stringify(logs).includes("secret-field"), false)
    assert.equal(JSON.stringify(result.error).includes("Unique constraint"), false)
  })

  it("régression : duplicate → skippedDuplicate ; inéligible → rejected ; succès OK", async () => {
    const { ingestion } = mockIngestion({
      handler: (id) => {
        if (id === "dup-1") {
          return {
            created: false,
            outcome: "DRAFT_CREATED",
            messageId: "m-dup",
            draftId: "d-dup",
          }
        }
        if (id === "rej-1") {
          return {
            created: true,
            outcome: "REJECTED",
            messageId: "m-rej",
            draftId: null,
            errorCode: "SENDER_NOT_ELIGIBLE",
          }
        }
        return {
          created: true,
          outcome: "DRAFT_CREATED",
          messageId: "m-ok",
          draftId: "d-ok",
        }
      },
    })
    const { repo, getCursor, getSaveCount } = mockRepository(
      makeCursor({ lastHistoryId: "hist-0" })
    )
    const { provider } = mockProvider([
      {
        messages: [
          mail({ externalMessageId: "ok-new" }),
          mail({ externalMessageId: "dup-1" }),
          mail({ externalMessageId: "rej-1" }),
        ],
        nextPageToken: null,
        nextHistoryId: "hist-done",
        hasMore: false,
        paginationMode: "history",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(result.stats.ingested, 1)
    assert.equal(result.stats.skippedDuplicate, 1)
    assert.equal(result.stats.rejected, 1)
    assert.equal(result.stats.failed, 0)
    assert.equal(getSaveCount(), 1)
    assert.equal(getCursor().lastHistoryId, "hist-done")
  })

  it("history.list deux pages — pagination complète puis curseur avancé une seule fois", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor, getSaveCount, getSavedHistoryIds } = mockRepository(
      makeCursor({ lastHistoryId: "hist-0" })
    )
    const { provider, calls } = mockProvider([
      {
        messages: [mail({ externalMessageId: "h-p1" })],
        nextPageToken: "hist-tok-2",
        nextHistoryId: "hist-mid",
        hasMore: true,
        paginationMode: "history",
      },
      {
        messages: [mail({ externalMessageId: "h-p2" })],
        nextPageToken: null,
        nextHistoryId: "hist-done",
        hasMore: false,
        paginationMode: "history",
      },
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(calls.length, 2)
    assert.equal(calls[0].pageSize, DEFAULT_GMAIL_PAGE_SIZE)
    assert.equal(getSaveCount(), 1)
    assert.deepEqual(getSavedHistoryIds(), ["hist-done"])
    assert.equal(getCursor().lastHistoryId, "hist-done")
  })

  it("aucun pageToken persisté dans AcquisitionScanCursor (mock)", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor } = mockRepository()
    const { provider } = buildPagedProvider(100, 50, "hist-ok")

    await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      pageSize: 50,
      now: () => NOW,
    })

    const cursor = getCursor()
    assert.ok(!("pageToken" in cursor))
    assert.ok(!("nextPageToken" in cursor))
    assert.equal(cursor.lastHistoryId, "hist-ok")
  })

  it("échec global provider page 1 → FAILED et consecutiveFailures incrémenté", async () => {
    const { ingestion } = mockIngestion({})
    const { repo, getCursor } = mockRepository()
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new Error("GMAIL_DOWN")
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "FAILED")
    assert.equal(result.error?.code, "PROVIDER_LIST_FAILED")
    assert.equal(getCursor().consecutiveFailures, 1)
  })
})

describe("syncAcquisitionMailForCompany — isolation tenant curseur", () => {
  it("deux tenants utilisent des curseurs distincts", async () => {
    const repoA = mockRepository(makeCursor({ companyId: "tenant-a", lastHistoryId: "a-0" }))
    const repoB = mockRepository(makeCursor({ companyId: "tenant-b", lastHistoryId: "b-0" }))
    const { ingestion } = mockIngestion({})

    const providerFor = (tenant: string): MailProviderPort => ({
      source: "GMAIL",
      listMessagesPage: async ({ companyId }) => {
        assert.equal(companyId, tenant)
        return {
          messages: [mail({ externalMessageId: `${tenant}-msg` })],
          nextPageToken: null,
          nextHistoryId: `${tenant}-next`,
          hasMore: false,
          paginationMode: "history",
        }
      },
    })

    await syncAcquisitionMailForCompany({
      companyId: "tenant-a",
      provider: providerFor("tenant-a"),
      ingestion,
      cursorRepository: repoA.repo,
      now: () => NOW,
    })
    await syncAcquisitionMailForCompany({
      companyId: "tenant-b",
      provider: providerFor("tenant-b"),
      ingestion,
      cursorRepository: repoB.repo,
      now: () => NOW,
    })

    assert.equal(repoA.getCursor().lastHistoryId, "tenant-a-next")
    assert.equal(repoB.getCursor().lastHistoryId, "tenant-b-next")
  })
})
