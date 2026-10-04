process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { runAcquisitionGmailSyncDriver } from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import type { MailSyncResult } from "@/lib/acquisition/connector/connector.types"
import type { AcquisitionGmailConnectionRef } from "@/lib/acquisition/persistence/acquisition-gmail-connection.listing.adapter"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { safeInternalErrorCode } from "@/lib/acquisition/connector/acquisition-gmail-cron.errors"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type { AcquisitionScanCursorRepositoryPort } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"

describe("safeInternalErrorCode", () => {
  it("code Gmail / Prisma conforme → code ; texte libre → name ; inconnu → UNKNOWN_ERROR", () => {
    assert.equal(
      safeInternalErrorCode(
        new GmailProviderError({ code: "GMAIL_UNAUTHORIZED", message: "Bearer x", retryable: false, global: true })
      ),
      "GMAIL_UNAUTHORIZED"
    )
    assert.equal(safeInternalErrorCode(Object.assign(new Error("pw"), { code: "P1001" })), "P1001")
    assert.equal(safeInternalErrorCode(Object.assign(new Error("m"), { code: "has spaces ya29" })), "Error")
    assert.equal(safeInternalErrorCode("ya29.raw string"), "UNKNOWN_ERROR")
    assert.equal(safeInternalErrorCode(null), "UNKNOWN_ERROR")
  })
})

const NOW = new Date("2026-07-18T14:00:00.000Z")

function conn(companyId: string): AcquisitionGmailConnectionRef {
  return {
    connectionId: `conn-${companyId}`,
    companyId,
    gmailAddress: `${companyId}@example.com`,
  }
}

function syncResult(overrides: Partial<MailSyncResult> = {}): MailSyncResult {
  return {
    companyId: overrides.companyId ?? "company-1",
    source: "GMAIL",
    status: overrides.status ?? "SUCCESS",
    stats: overrides.stats ?? {
      fetched: 1,
      ingested: 1,
      skippedDuplicate: 0,
      rejected: 0,
      failed: 0,
    },
    nextHistoryId: overrides.nextHistoryId ?? "hist-1",
    ...overrides,
  }
}

describe("runAcquisitionGmailSyncDriver", () => {
  beforeEach(() => {
    delete process.env.ACQUISITION_GMAIL_CRON_ENABLED
  })

  it("feature flag OFF → SKIPPED immédiat sans listing", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "false"
    const events: string[] = []
    let listCalled = false

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => {
        listCalled = true
        return [conn("c1")]
        },
      runSyncForConnection: async () => syncResult(),
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
    assert.equal(listCalled, false)
    assert.deepEqual(events, ["SYNC_START", "FLAG_SKIP", "SYNC_FINISHED"])
  })

  it("cron ON + master OFF → MASTER_DISABLED sans listing", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    let listCalled = false
    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => {
        listCalled = true
        return [conn("c1")]
        },
      runSyncForConnection: async () => syncResult(),
      now: () => NOW,
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "MASTER_DISABLED")
    assert.equal(listCalled, false)
  })

  it("listCompanyIds() lève une exception → FAILED + SYNC_FINISHED", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const events: string[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => {
        throw new Error("PrismaClientInitializationError: secret connection string")
      },
      runSyncForConnection: async () => syncResult(),
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.status, "FAILED")
    assert.equal(result.errorCode, "GMAIL_CONNECTION_LISTING_FAILED")
    assert.equal(result.error?.code, "GMAIL_CONNECTION_LISTING_FAILED")
    assert.equal(result.error?.message, "Unable to list Gmail connections")
    assert.deepEqual(result.companies, [])
    assert.deepEqual(result.globalStats, {
      fetched: 0,
      ingested: 0,
      skippedDuplicate: 0,
      rejected: 0,
      failed: 0,
    })
    assert.deepEqual(events, ["SYNC_START", "SYNC_LISTING_FAILED", "SYNC_FINISHED"])
    assert.ok(!JSON.stringify(result).includes("Prisma"))
    assert.ok(!JSON.stringify(result).includes("connection string"))
  })

  it("aucune entreprise → SUCCESS", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [],
      runSyncForConnection: async () => syncResult(),
      now: () => NOW,
      log: () => {},
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(result.companiesTotal, 0)
  })

  it("plusieurs entreprises SUCCESS → global SUCCESS", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const events: string[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1"), conn("c2")],
      runSyncForConnection: async (c) => syncResult({ companyId: c.companyId }),
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(result.companiesSucceeded, 2)
    assert.equal(events.filter((e) => e === "SYNC_COMPANY_SUCCESS").length, 2)
  })

  it("tenant SKIPPED → SYNC_COMPANY_SKIPPED", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const events: string[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1")],
      runSyncForConnection: async () =>
        syncResult({ status: "SKIPPED", skipReason: "FEATURE_DISABLED" }),
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.companies[0].status, "SKIPPED")
    assert.equal(result.companiesSkipped, 1)
    assert.ok(events.includes("SYNC_COMPANY_SKIPPED"))
    assert.ok(!events.includes("SYNC_COMPANY_SUCCESS"))
  })

  it("toutes entreprises SKIPPED → global SKIPPED", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1"), conn("c2")],
      runSyncForConnection: async () =>
        syncResult({ status: "SKIPPED", skipReason: "FEATURE_DISABLED" }),
      now: () => NOW,
      log: () => {},
    })

    assert.equal(result.status, "SKIPPED")
    assert.equal(result.companiesSkipped, 2)
    assert.equal(result.companiesSucceeded, 0)
  })

  it("tenant PARTIAL → SYNC_COMPANY_PARTIAL et global PARTIAL", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const events: string[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1"), conn("c2")],
      runSyncForConnection: async (c) =>
        c.companyId === "c1"
          ? syncResult({
              companyId: c.companyId,
              status: "PARTIAL",
              partialReason: "MESSAGE_INGESTION_FAILED",
              error: {
                code: "MESSAGE_INGESTION_FAILED",
                message: "raw internal db error",
                retryable: true,
              },
            })
          : syncResult({ companyId: c.companyId }),
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.status, "PARTIAL")
    assert.equal(result.companiesPartial, 1)
    assert.equal(result.companies[0].error?.code, "COMPANY_SYNC_PARTIAL")
    assert.equal(result.companies[0].error?.message, "Gmail synchronization partially completed for this company")
    assert.ok(events.includes("SYNC_COMPANY_PARTIAL"))
    assert.ok(!JSON.stringify(result).includes("raw internal db error"))
  })

  it("tenant FAILED → les autres continuent, global PARTIAL", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const synced: string[] = []
    const events: string[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1"), conn("c2"), conn("c3")],
      runSyncForConnection: async (c) => {
        synced.push(c.companyId)
        if (c.companyId === "c2") {
          return syncResult({
            companyId: c.companyId,
            status: "FAILED",
            error: { code: "PROVIDER_LIST_FAILED", message: "Gmail secret token leak", retryable: true },
            stats: { fetched: 0, ingested: 0, skippedDuplicate: 0, rejected: 0, failed: 0 },
          })
        }
        return syncResult({ companyId: c.companyId })
      },
      now: () => NOW,
      log: (event) => events.push(event),
    })

    assert.equal(result.status, "PARTIAL")
    assert.deepEqual(synced, ["c1", "c2", "c3"])
    assert.equal(result.companiesFailed, 1)
    assert.equal(result.companies[1].error?.code, "COMPANY_SYNC_FAILED")
    assert.ok(events.includes("SYNC_COMPANY_FAILED"))
    assert.ok(!JSON.stringify(result).includes("secret token"))
  })

  it("exception inattendue → erreur publique sanitizée", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1")],
      runSyncForConnection: async () => {
        throw new Error("stack trace with Bearer sk-live-abc")
      },
      now: () => NOW,
      log: () => {},
    })

    assert.equal(result.companies[0].error?.code, "COMPANY_SYNC_FAILED")
    assert.equal(result.companies[0].error?.message, "Gmail synchronization failed for this company")
    assert.ok(!JSON.stringify(result).includes("Bearer"))
    assert.ok(!JSON.stringify(result).includes("sk-live"))
  })

  it("C — FAILED retourné → log syncCode + internalCode sûrs, jamais le message brut", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1")],
      runSyncForConnection: async (c) =>
        syncResult({
          companyId: c.companyId,
          status: "FAILED",
          stats: { fetched: 0, ingested: 0, skippedDuplicate: 0, rejected: 0, failed: 0 },
          error: {
            code: "PROVIDER_LIST_FAILED",
            message: "Bearer ya29.secret refresh_token=1//abc",
            retryable: true,
            internalCode: "GMAIL_TOKEN_REFRESH_FAILED",
          },
        }),
      now: () => NOW,
      log: (event, payload) => logs.push({ event, payload }),
    })

    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.ok(failed)
    assert.equal(failed.payload?.code, "COMPANY_SYNC_FAILED")
    assert.equal(failed.payload?.syncCode, "PROVIDER_LIST_FAILED")
    assert.equal(failed.payload?.internalCode, "GMAIL_TOKEN_REFRESH_FAILED")
    const serialized = JSON.stringify({ logs, result })
    assert.ok(!serialized.includes("ya29"))
    assert.ok(!serialized.includes("refresh_token"))
    assert.ok(!serialized.includes("Bearer"))
  })

  it("C — internalCode non conforme (texte libre) → non journalisé", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []

    await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1")],
      runSyncForConnection: async () =>
        syncResult({
          status: "FAILED",
          error: {
            code: "PROVIDER_LIST_FAILED",
            message: "x",
            retryable: true,
            internalCode: "token ya29.leak",
          },
        }),
      now: () => NOW,
      log: (event, payload) => logs.push({ event, payload }),
    })

    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.ok(failed)
    assert.ok(!("internalCode" in (failed.payload ?? {})))
    assert.ok(!JSON.stringify(logs).includes("ya29"))
  })

  it("C — exception typée → internalCode = code Gmail, pas le message", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []

    await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1")],
      runSyncForConnection: async () => {
        throw new GmailProviderError({
          code: "GMAIL_NOT_CONNECTED",
          message: "Bearer ya29.secret",
          retryable: false,
          global: true,
        })
      },
      now: () => NOW,
      log: (event, payload) => logs.push({ event, payload }),
    })

    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.equal(failed?.payload?.internalCode, "GMAIL_NOT_CONNECTED")
    assert.ok(!JSON.stringify(logs).includes("ya29"))
  })

  it("A/B bout-en-bout — service réel + recordFailure en panne → aucune exception, syncCode réel journalisé", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []
    const failingRepo: AcquisitionScanCursorRepositoryPort = {
      getOrCreate: async (companyId) => {
        if (companyId === "cursor-down") throw new Error("db down")
        return {
          id: "cur",
          companyId,
          source: "GMAIL",
          mailboxKey: `conn-${companyId}`,
          lastHistoryId: "h",
          lastSyncedAt: null,
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastErrorAt: null,
        }
      },
      saveSuccessfulPage: async () => {
        throw new Error("not expected")
      },
      recordFailure: async () => {
        throw new Error("telemetry down")
      },
    }
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        throw new GmailProviderError({
          code: "GMAIL_TOKEN_REFRESH_FAILED",
          message: "invalid_grant",
          retryable: false,
          global: true,
        })
      },
    }
    const ingestion: AcquisitionIngestionPort = {
      isEnabled: () => true,
      registerIncomingMessage: async () => {
        throw new Error("not expected")
      },
    }

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("cursor-down"), conn("token-down")],
      runSyncForConnection: (c) =>
        syncAcquisitionMailForCompany({
          companyId: c.companyId,
          connectionId: c.connectionId,
          provider,
          ingestion,
          cursorRepository: failingRepo,
          now: () => NOW,
          mailShadow: false,
        }),
      now: () => NOW,
      log: (event, payload) => logs.push({ event, payload }),
    })

    assert.equal(result.companiesFailed, 2)
    const failed = logs.filter((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.equal(failed.length, 2)
    assert.equal(failed[0].payload?.syncCode, "CURSOR_LOAD_FAILED")
    assert.equal(failed[0].payload?.internalCode, "Error")
    assert.equal(failed[1].payload?.syncCode, "PROVIDER_LIST_FAILED")
    assert.equal(failed[1].payload?.internalCode, "GMAIL_TOKEN_REFRESH_FAILED")
    assert.ok(!JSON.stringify(logs).includes("telemetry down"))
    assert.ok(!JSON.stringify(logs).includes("invalid_grant"))
  })

  it("statistiques globales agrégées", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [conn("c1"), conn("c2")],
      runSyncForConnection: async (c) =>
        syncResult({
          companyId: c.companyId,
          stats: { fetched: 10, ingested: 5, skippedDuplicate: 3, rejected: 1, failed: 1 },
        }),
      now: () => NOW,
      log: () => {},
    })

    assert.equal(result.globalStats.fetched, 20)
    assert.equal(result.globalStats.ingested, 10)
  })
})
