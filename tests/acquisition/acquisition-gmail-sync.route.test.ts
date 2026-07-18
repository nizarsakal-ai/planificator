process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { handleAcquisitionGmailSyncCron } from "@/lib/acquisition/connector/acquisition-gmail-sync.handler"
import { runAcquisitionGmailSyncDriver } from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"

const CRON_SECRET = "test-cron-secret-route"

function request(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/acquisition-gmail-sync", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe("handleAcquisitionGmailSyncCron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.ACQUISITION_GMAIL_CRON_ENABLED
  })

  it("CRON_SECRET absent → HTTP 401", async () => {
    const res = await handleAcquisitionGmailSyncCron(request())
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.deepEqual(body, { error: "Unauthorized" })
  })

  it("Bearer incorrect → HTTP 401", async () => {
    const res = await handleAcquisitionGmailSyncCron(request("Bearer wrong-secret"))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, "Unauthorized")
    assert.ok(!JSON.stringify(body).includes(CRON_SECRET))
  })

  it("réponse 401 ne contient pas le secret", async () => {
    const res = await handleAcquisitionGmailSyncCron(request("Bearer not-the-secret"))
    const text = await res.text()
    assert.ok(!text.includes(CRON_SECRET))
  })

  it("secret correct + flag OFF → HTTP 200 + statut SKIPPED", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "false"

    const res = await handleAcquisitionGmailSyncCron(request(`Bearer ${CRON_SECRET}`), {
      runDriver: () =>
        runAcquisitionGmailSyncDriver({
          listCompanyIds: async () => {
            throw new Error("should not list")
          },
          runSyncForCompany: async () => {
            throw new Error("should not sync")
          },
        }),
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "CRON_DISABLED")
  })

  it("erreur listing → FAILED structuré sans détail interne", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"

    const res = await handleAcquisitionGmailSyncCron(request(`Bearer ${CRON_SECRET}`), {
      runDriver: () =>
        runAcquisitionGmailSyncDriver({
          listCompanyIds: async () => {
            throw new Error("postgresql://user:password@host/db")
          },
          runSyncForCompany: async () => {
            throw new Error("should not sync")
          },
        }),
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "FAILED")
    assert.equal(body.errorCode, "GMAIL_CONNECTION_LISTING_FAILED")
    assert.equal(body.error.message, "Unable to list Gmail connections")
    assert.deepEqual(body.companies, [])
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes("postgresql"))
    assert.ok(!serialized.includes("password"))
  })

  it("résultat PARTIAL → HTTP 200 et statut PARTIAL", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"

    const res = await handleAcquisitionGmailSyncCron(request(`Bearer ${CRON_SECRET}`), {
      runDriver: () =>
        runAcquisitionGmailSyncDriver({
          listCompanyIds: async () => ["c1", "c2"],
          runSyncForCompany: async (companyId) =>
            companyId === "c1"
              ? {
                  companyId: "c1",
                  source: "GMAIL",
                  status: "FAILED",
                  stats: { fetched: 0, ingested: 0, skippedDuplicate: 0, rejected: 0, failed: 0 },
                  nextHistoryId: null,
                  error: { code: "PROVIDER_LIST_FAILED", message: "internal gmail raw", retryable: true },
                }
              : {
                  companyId: "c2",
                  source: "GMAIL",
                  status: "SUCCESS",
                  stats: { fetched: 1, ingested: 1, skippedDuplicate: 0, rejected: 0, failed: 0 },
                  nextHistoryId: "h1",
                },
        }),
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "PARTIAL")
    assert.ok(!JSON.stringify(body).includes("internal gmail raw"))
    assert.equal(body.companies[0].error.code, "COMPANY_SYNC_FAILED")
  })

  it("aucune erreur brute dans le JSON de réponse", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"

    const res = await handleAcquisitionGmailSyncCron(request(`Bearer ${CRON_SECRET}`), {
      runDriver: () =>
        runAcquisitionGmailSyncDriver({
          listCompanyIds: async () => ["c1"],
          runSyncForCompany: async () => {
            throw new Error("Bearer refresh_token=leaked")
          },
        }),
    })

    const serialized = JSON.stringify(await res.json())
    assert.ok(!serialized.includes("refresh_token"))
    assert.ok(!serialized.includes("Bearer"))
    assert.ok(!serialized.includes("leaked"))
  })
})
