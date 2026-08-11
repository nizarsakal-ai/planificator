process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  syncAcquisitionMailForCompany,
  DEFAULT_GMAIL_PAGE_SIZE,
} from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
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

  it("erreur sur un message → PARTIAL et curseur non avancé", async () => {
    const { ingestion } = mockIngestion({
      handler: (id) => {
        if (id === "fail-1") throw new Error("INGESTION_DOWN")
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
        messages: [mail({ externalMessageId: "ok-1" }), mail({ externalMessageId: "fail-1" })],
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
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(getCursor().lastHistoryId, "hist-before")
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

describe("syncAcquisitionMailForCompany — ACQUISITION_GMAIL_DIAGNOSTIC", () => {
  const prevDiag = process.env.ACQUISITION_GMAIL_DIAGNOSTIC
  const prevAcquisition = process.env.PLANIFICATOR_ACQUISITION_ENABLED
  const infoCalls: string[] = []
  const originalInfo = console.info

  beforeEach(() => {
    infoCalls.length = 0
    console.info = (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(" "))
    }
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
  })

  afterEach(() => {
    console.info = originalInfo
    if (prevDiag === undefined) delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    else process.env.ACQUISITION_GMAIL_DIAGNOSTIC = prevDiag
    if (prevAcquisition === undefined) delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    else process.env.PLANIFICATOR_ACQUISITION_ENABLED = prevAcquisition
  })

  function diagPayloads(): Record<string, unknown>[] {
    return infoCalls
      .filter((line) => line.startsWith("[acquisition-gmail-diag] "))
      .map((line) => JSON.parse(line.slice("[acquisition-gmail-diag] ".length)))
  }

  function assertNoSensitiveLeak(forbidden: string[]) {
    const blob = infoCalls.join("\n")
    for (const s of forbidden) {
      assert.equal(blob.includes(s), false, `leak: ${s}`)
    }
    assert.equal(blob.includes("ya29."), false)
    assert.equal(/\bBearer\b/i.test(blob), false)
    assert.equal(blob.includes("\n    at "), false)
    assert.equal(blob.includes("@example.com"), false)
    assert.equal(blob.includes("https://"), false)
  }

  it("flag OFF + provider fail => aucun diag ; code public inchangé", async () => {
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const leakMsg = "Gmail secret token leak ya29.ABC Bearer xyz"
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_TOKEN_REFRESH_FAILED",
          message: leakMsg,
          retryable: false,
          global: true,
        })
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
    assert.equal(diagPayloads().length, 0)
  })

  it("seules valeurs non-strictes du flag => aucun diag", async () => {
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_UNAUTHORIZED",
          message: "leak",
          retryable: false,
          global: true,
        })
      },
    }

    for (const value of ["TRUE", "1", " true ", "", undefined] as const) {
      infoCalls.length = 0
      if (value === undefined) delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
      else process.env.ACQUISITION_GMAIL_DIAGNOSTIC = value

      const result = await syncAcquisitionMailForCompany({
        companyId: COMPANY,
        provider,
        ingestion,
        cursorRepository: repo,
        now: () => NOW,
      })

      assert.equal(result.status, "FAILED")
      assert.equal(result.error?.code, "PROVIDER_LIST_FAILED")
      assert.equal(diagPayloads().length, 0, `flag=${JSON.stringify(value)}`)
    }
  })

  it("flag ON + GMAIL_TOKEN_REFRESH_FAILED => diag allowlisté ; result.code inchangé", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const leakMsg = "invalid_grant refresh token leaked ya29.SECRET"
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_TOKEN_REFRESH_FAILED",
          message: leakMsg,
          retryable: false,
          global: true,
        })
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
    assert.equal(result.error?.retryable, true)
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "GMAIL_TOKEN_REFRESH_FAILED",
        errorName: "GmailProviderError",
        retryable: false,
      },
    ])
    assertNoSensitiveLeak([leakMsg, "invalid_grant", "ya29.SECRET", "stack"])
  })

  it("flag ON + GMAIL_UNAUTHORIZED => diag avec code allowlisté uniquement", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const leakMsg = "Gmail API unauthorized (list) Authorization: Bearer tok"
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_UNAUTHORIZED",
          message: leakMsg,
          retryable: false,
          global: true,
        })
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
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "GMAIL_UNAUTHORIZED",
        errorName: "GmailProviderError",
        retryable: false,
      },
    ])
    assertNoSensitiveLeak([leakMsg, "Authorization", "Bearer tok"])
  })

  it("flag ON + GmailProviderError code getter stateful => une lecture diag ; pas de fuite", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()

    let codeAccessCount = 0
    const evilSecond = "Bearer secret-token"
    const err = new GmailProviderError({
      code: "GMAIL_UNAUTHORIZED",
      message: "safe-message",
      retryable: false,
      global: true,
    })
    Object.defineProperty(err, "code", {
      configurable: true,
      enumerable: true,
      get() {
        codeAccessCount += 1
        // 1 = métier, 2 = unique lecture diagnostic, 3+ = double-read bug
        if (codeAccessCount <= 2) return "GMAIL_UNAUTHORIZED"
        return evilSecond
      },
    })

    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw err
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
    // métier (1) + diag (1) — pas de 2e lecture diag
    assert.equal(codeAccessCount, 2)
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "GMAIL_UNAUTHORIZED",
        errorName: "GmailProviderError",
        retryable: false,
      },
    ])
    assertNoSensitiveLeak([evilSecond, "Bearer secret-token"])
  })

  it("flag ON + code getter 2e valeur sensible => diag 1 lecture ; Bearer absent du log", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()

    let codeAccessCount = 0
    const evilSecond = "Bearer secret-token"
    const err = new GmailProviderError({
      code: "GMAIL_UNAUTHORIZED",
      message: "safe-message",
      retryable: false,
      global: true,
    })
    Object.defineProperty(err, "code", {
      configurable: true,
      enumerable: true,
      get() {
        codeAccessCount += 1
        if (codeAccessCount === 1) return "GMAIL_UNAUTHORIZED"
        return evilSecond
      },
    })

    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw err
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
    // métier consomme le 1er accès ; le diag lit une seule fois (2e) → non allowlisté
    assert.equal(codeAccessCount, 2)
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "PROVIDER_LIST_FAILED",
        errorName: "GmailProviderError",
        retryable: false,
      },
    ])
    assertNoSensitiveLeak([evilSecond, "Bearer secret-token"])
  })

  it("flag ON + retryable getter non-booléen/stateful => retryable boolean sûr", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()

    let retryableAccessCount = 0
    const evilRetryable = "Bearer secret-token"
    const err = new GmailProviderError({
      code: "GMAIL_TOKEN_REFRESH_FAILED",
      message: "safe-message",
      retryable: false,
      global: true,
    })
    Object.defineProperty(err, "retryable", {
      configurable: true,
      enumerable: true,
      get() {
        retryableAccessCount += 1
        if (retryableAccessCount === 1) return evilRetryable
        return false
      },
    })

    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw err
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
    assert.equal(retryableAccessCount, 1)
    const payloads = diagPayloads()
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0]!.phase, "provider_list")
    assert.equal(payloads[0]!.internalCode, "GMAIL_TOKEN_REFRESH_FAILED")
    assert.equal(payloads[0]!.errorName, "GmailProviderError")
    assert.equal(typeof payloads[0]!.retryable, "boolean")
    assert.equal(payloads[0]!.retryable, true)
    assertNoSensitiveLeak([evilRetryable, "Bearer secret-token"])
  })

  it("flag ON + code getter throw au 2e accès => diag retombe sans casser le métier", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()

    let codeAccessCount = 0
    const err = new GmailProviderError({
      code: "GMAIL_UNAUTHORIZED",
      message: "safe-message",
      retryable: true,
      global: true,
    })
    Object.defineProperty(err, "code", {
      configurable: true,
      enumerable: true,
      get() {
        codeAccessCount += 1
        if (codeAccessCount === 1) return "GMAIL_UNAUTHORIZED"
        throw new Error("code-getter-diag")
      },
    })

    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw err
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
    assert.equal(codeAccessCount, 2)
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "PROVIDER_LIST_FAILED",
        errorName: "GmailProviderError",
        retryable: true,
      },
    ])
  })

  it("flag OFF + code getter throw au 2e accès => pas d'accès diag", async () => {
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()

    let codeAccessCount = 0
    const err = new GmailProviderError({
      code: "GMAIL_UNAUTHORIZED",
      message: "safe-message",
      retryable: true,
      global: true,
    })
    Object.defineProperty(err, "code", {
      configurable: true,
      enumerable: true,
      get() {
        codeAccessCount += 1
        if (codeAccessCount === 1) return "GMAIL_UNAUTHORIZED"
        throw new Error("code-getter-diag")
      },
    })

    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw err
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
    assert.equal(codeAccessCount, 1)
    assert.equal(diagPayloads().length, 0)
  })

  it("flag ON + code/name arbitraires malveillants => aucune fuite", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const evilCode = "Bearer secret-token"
    const evilName = "user@example.com"
    const evilMsg = "https://evil.example/token?x=1 ya29.LEAK"
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw {
          code: evilCode,
          name: evilName,
          message: evilMsg,
        }
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
    assert.deepEqual(diagPayloads(), [
      {
        phase: "provider_list",
        internalCode: "PROVIDER_LIST_FAILED",
        errorName: "UnknownError",
        retryable: true,
      },
    ])
    assertNoSensitiveLeak([evilCode, evilName, evilMsg, "secret-token", "user@example.com"])
  })

  it("flag OFF + getters throw sur name/code => métier OK ; name non lu pour diag", async () => {
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    let nameAccessed = false
    let codeAccessed = false
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw {
          get name() {
            nameAccessed = true
            throw new Error("name-getter")
          },
          get code() {
            codeAccessed = true
            throw new Error("code-getter")
          },
          message: "should-not-matter-for-diag",
        }
      },
    }

    // Métier préexistant lit `code` via String(e.code) → l'accès peut throw.
    // On vérifie que le diagnostic OFF n'ajoute pas d'accès à `name`.
    await assert.rejects(
      () =>
        syncAcquisitionMailForCompany({
          companyId: COMPANY,
          provider,
          ingestion,
          cursorRepository: repo,
          now: () => NOW,
        }),
      (err: unknown) => err instanceof Error && err.message === "code-getter"
    )
    assert.equal(codeAccessed, true)
    assert.equal(nameAccessed, false)
    assert.equal(diagPayloads().length, 0)
  })

  it("flag OFF + getter name throw seulement => FAILED sans accès name", async () => {
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    let nameAccessed = false
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw {
          get name() {
            nameAccessed = true
            throw new Error("name-getter")
          },
          message: "plain-fail",
        }
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
    assert.equal(nameAccessed, false)
    assert.equal(diagPayloads().length, 0)
  })

  it("flag ON + cursor failure => diag littéraux uniquement", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const leakMsg = "Prisma connection failed DATABASE_URL=secret"
    const repo: AcquisitionScanCursorRepositoryPort = {
      getOrCreate: async () => {
        throw new Error(leakMsg)
      },
      saveSuccessfulPage: async () => makeCursor(),
      recordFailure: async () =>
        makeCursor({ consecutiveFailures: 1, lastErrorCode: "CURSOR_LOAD_FAILED" }),
    }
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => emptyPage(),
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "FAILED")
    assert.equal(result.error?.code, "CURSOR_LOAD_FAILED")
    assert.deepEqual(diagPayloads(), [
      {
        phase: "cursor",
        internalCode: "CURSOR_LOAD_FAILED",
        errorName: "Error",
        retryable: true,
      },
    ])
    assertNoSensitiveLeak([leakMsg, "DATABASE_URL=secret"])
  })

  it("flag ON + SUCCESS => aucun diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository(makeCursor({ lastHistoryId: null }))
    const { provider } = mockProvider([
      emptyPage({ nextHistoryId: "hist-ok", paginationMode: "lookback" }),
    ])

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(diagPayloads().length, 0)
  })

  it("flag ON + PARTIAL => aucun diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({
      handler: () => new Error("ingest boom"),
    })
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail()],
        nextPageToken: null,
        nextHistoryId: "hist-1",
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

    assert.equal(result.status, "PARTIAL")
    assert.equal(diagPayloads().length, 0)
  })

  it("flag ON + FEATURE_DISABLED SKIPPED => aucun diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({ enabled: false })
    const { repo } = mockRepository()
    let providerCalled = false
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        providerCalled = true
        return emptyPage()
      },
    }

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
    assert.equal(diagPayloads().length, 0)
  })

  it("flag ON + NO_ACTIVE_PARTNER_IDENTITIES => SKIPPED sans diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "NO_ACTIVE_PARTNER_IDENTITIES",
          message: "Aucune identité partenaire active (domaine ou email)",
          retryable: false,
          global: false,
        })
      },
    }

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      provider,
      ingestion,
      cursorRepository: repo,
      now: () => NOW,
    })

    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "NO_ACTIVE_PARTNER_IDENTITIES")
    assert.equal(diagPayloads().length, 0)
  })
})

describe("syncAcquisitionMailForCompany — message ingestion diag", () => {
  const PREFIX = "[acquisition-message-ingestion-diag]"
  const prevDiag = process.env.ACQUISITION_GMAIL_DIAGNOSTIC
  const prevAcquisition = process.env.PLANIFICATOR_ACQUISITION_ENABLED
  const infoCalls: string[] = []
  let originalInfo: typeof console.info

  beforeEach(() => {
    infoCalls.length = 0
    originalInfo = console.info
    console.info = (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(" "))
    }
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
  })

  afterEach(() => {
    console.info = originalInfo
    if (prevDiag === undefined) delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    else process.env.ACQUISITION_GMAIL_DIAGNOSTIC = prevDiag
    if (prevAcquisition === undefined) delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    else process.env.PLANIFICATOR_ACQUISITION_ENABLED = prevAcquisition
  })

  function ingestionDiagLogs(): string[] {
    return infoCalls.filter((line) => line.startsWith(PREFIX))
  }

  function parseIngestionDiag(raw: string): Record<string, unknown> {
    const payload = JSON.parse(raw.slice(PREFIX.length + 1)) as Record<string, unknown>
    assert.deepEqual(Object.keys(payload).sort(), [
      "errorCode",
      "errorName",
      "gmailMessageId",
      "retryable",
      "stage",
    ])
    return payload
  }

  it("flag OFF + ingestion throw => aucun message-ingestion-diag ; PARTIAL inchangé", async () => {
    delete process.env.ACQUISITION_GMAIL_DIAGNOSTIC
    const { ingestion } = mockIngestion({
      handler: () => {
        throw new Error("INGESTION_DOWN secret-token subject leak")
      },
    })
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "fail-msg-1" })],
        nextPageToken: null,
        nextHistoryId: "hist-x",
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

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(ingestionDiagLogs().length, 0)
  })

  it("flag ON + succès => aucun message-ingestion-diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({})
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "ok-msg-1" })],
        nextPageToken: null,
        nextHistoryId: "hist-ok",
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
    assert.equal(ingestionDiagLogs().length, 0)
  })

  it("flag ON + ingestion throw => REGISTER_INCOMING_MESSAGE + gmailMessageId", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const leak = "INGESTION_DOWN ACCESS_TOKEN_SECRET_TEST user@example.com Bearer secret"
    const { ingestion } = mockIngestion({
      handler: (id) => {
        if (id === "fail-1") throw new Error(leak)
        return {
          created: true,
          outcome: "DRAFT_CREATED",
          messageId: "ok",
          draftId: "d-ok",
        }
      },
    })
    const { repo } = mockRepository(makeCursor({ lastHistoryId: "hist-before" }))
    const { provider } = mockProvider([
      {
        messages: [
          mail({ externalMessageId: "ok-1" }),
          mail({ externalMessageId: "fail-1", fromHeader: "user@example.com", subject: "SECRET SUBJECT" }),
        ],
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
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(result.error?.code, "MESSAGE_INGESTION_FAILED")
    assert.equal(result.error?.retryable, true)

    const logs = ingestionDiagLogs()
    assert.equal(logs.length, 1)
    const payload = parseIngestionDiag(logs[0]!)
    assert.equal(payload.gmailMessageId, "fail-1")
    assert.equal(payload.stage, "REGISTER_INCOMING_MESSAGE")
    assert.equal(payload.errorName, "Error")
    assert.equal(payload.errorCode, "UNKNOWN")
    assert.equal(payload.retryable, true)
    assert.ok(!logs[0]!.includes(leak))
    assert.ok(!logs[0]!.includes("ACCESS_TOKEN_SECRET_TEST"))
    assert.ok(!logs[0]!.includes("user@example.com"))
    assert.ok(!logs[0]!.includes("SECRET SUBJECT"))
    assert.ok(!logs[0]!.includes("Bearer secret"))
  })

  it("erreur métier encapsulée (REJECTED) => aucun message-ingestion-diag", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { ingestion } = mockIngestion({
      handler: () => ({
        created: true,
        outcome: "REJECTED",
        messageId: "m-rej",
        draftId: null,
        errorCode: "SENDER_NOT_ELIGIBLE",
      }),
    })
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "rej-1" })],
        nextPageToken: null,
        nextHistoryId: "hist-rej",
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
    assert.equal(result.stats.rejected, 1)
    assert.equal(ingestionDiagLogs().length, 0)
  })

  for (const value of ["", "TRUE", "1", " true "]) {
    it(`flag "${value}" => aucun message-ingestion-diag`, async () => {
      process.env.ACQUISITION_GMAIL_DIAGNOSTIC = value
      const { ingestion } = mockIngestion({
        handler: () => {
          throw new Error("boom")
        },
      })
      const { repo } = mockRepository()
      const { provider } = mockProvider([
        {
          messages: [mail({ externalMessageId: "x-1" })],
          nextPageToken: null,
          nextHistoryId: "h",
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

      assert.equal(result.status, "PARTIAL")
      assert.equal(ingestionDiagLogs().length, 0)
    })
  }

  it("stage profond uniquement : ELIGIBILITY_RESOLVE sans REGISTER_INCOMING_MESSAGE doublon", async () => {
    process.env.ACQUISITION_GMAIL_DIAGNOSTIC = "true"
    const { registerIncomingMessage } = await import(
      "@/lib/acquisition/acquisition.service"
    )
    const err = Object.assign(new Error("resolver down"), { code: "P1001" })
    const db = {
      acquisitionMessage: {
        findUnique: async () => null,
      },
      $transaction: async () => {
        throw new Error("should not reach transaction")
      },
    }
    const ingestion: AcquisitionIngestionPort = {
      isEnabled: () => true,
      registerIncomingMessage: (input) =>
        registerIncomingMessage(input, db as never, {
          eligibilityResolver: {
            isDomainEligible: async () => {
              throw err
            },
            resolveEligibleSender: async () => {
              throw err
            },
          },
        }),
    }
    const { repo } = mockRepository()
    const { provider } = mockProvider([
      {
        messages: [mail({ externalMessageId: "deep-1", fromHeader: "user@lauralu.fr" })],
        nextPageToken: null,
        nextHistoryId: "hist-deep",
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

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    const logs = ingestionDiagLogs()
    assert.equal(logs.length, 1)
    const payload = parseIngestionDiag(logs[0]!)
    assert.equal(payload.gmailMessageId, "deep-1")
    assert.equal(payload.stage, "REGISTER_INCOMING_MESSAGE_ELIGIBILITY_RESOLVE")
    assert.equal(payload.errorCode, "P1001")
    assert.equal(payload.stage === "REGISTER_INCOMING_MESSAGE", false)
  })
})
