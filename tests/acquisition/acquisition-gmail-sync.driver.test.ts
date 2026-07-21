process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { runAcquisitionGmailSyncDriver } from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import type { MailSyncResult } from "@/lib/acquisition/connector/connector.types"

const NOW = new Date("2026-07-18T14:00:00.000Z")

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
      listCompanyIds: async () => {
        listCalled = true
        return ["c1"]
      },
      runSyncForCompany: async () => syncResult(),
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
      listCompanyIds: async () => {
        listCalled = true
        return ["c1"]
      },
      runSyncForCompany: async () => syncResult(),
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
      listCompanyIds: async () => {
        throw new Error("PrismaClientInitializationError: secret connection string")
      },
      runSyncForCompany: async () => syncResult(),
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
      listCompanyIds: async () => [],
      runSyncForCompany: async () => syncResult(),
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
      listCompanyIds: async () => ["c1", "c2"],
      runSyncForCompany: async (companyId) => syncResult({ companyId }),
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
      listCompanyIds: async () => ["c1"],
      runSyncForCompany: async () =>
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
      listCompanyIds: async () => ["c1", "c2"],
      runSyncForCompany: async () =>
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
      listCompanyIds: async () => ["c1", "c2"],
      runSyncForCompany: async (companyId) =>
        companyId === "c1"
          ? syncResult({
              companyId,
              status: "PARTIAL",
              partialReason: "MESSAGE_INGESTION_FAILED",
              error: {
                code: "MESSAGE_INGESTION_FAILED",
                message: "raw internal db error",
                retryable: true,
              },
            })
          : syncResult({ companyId }),
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
      listCompanyIds: async () => ["c1", "c2", "c3"],
      runSyncForCompany: async (companyId) => {
        synced.push(companyId)
        if (companyId === "c2") {
          return syncResult({
            companyId,
            status: "FAILED",
            error: { code: "PROVIDER_LIST_FAILED", message: "Gmail secret token leak", retryable: true },
            stats: { fetched: 0, ingested: 0, skippedDuplicate: 0, rejected: 0, failed: 0 },
          })
        }
        return syncResult({ companyId })
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
      listCompanyIds: async () => ["c1"],
      runSyncForCompany: async () => {
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

  it("statistiques globales agrégées", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"

    const result = await runAcquisitionGmailSyncDriver({
      listCompanyIds: async () => ["c1", "c2"],
      runSyncForCompany: async (companyId) =>
        syncResult({
          companyId,
          stats: { fetched: 10, ingested: 5, skippedDuplicate: 3, rejected: 1, failed: 1 },
        }),
      now: () => NOW,
      log: () => {},
    })

    assert.equal(result.globalStats.fetched, 20)
    assert.equal(result.globalStats.ingested, 10)
  })
})
