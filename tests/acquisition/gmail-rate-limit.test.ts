/**
 * Limite de débit Gmail (incident 16/11/2026 15:00) : Google répond 403
 * rateLimitExceeded, que l'on confondait avec un refus d'accès (arrêt sans nouvel
 * essai, alerte « reconnexion requise » erronée).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  GmailProviderError,
  isGoogleRateLimitReason,
  mapHttpStatusToGmailError,
} from "@/lib/acquisition/connector/gmail.errors"
import {
  RateLimitRetryingGmailApiClient,
  type GmailApiClient,
} from "@/lib/acquisition/connector/gmail-api.client"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import {
  assessAcquisitionMailboxHealth,
  mailboxNeedsReconnect,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"
import type { AcquisitionScanCursorRecord } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"

const diag = (reason: string) => ({ gmailHttpStatus: 403, gmailErrorReason: reason, gmailErrorCode: "PERMISSION_DENIED" })

describe("classification du 403", () => {
  it("403 rateLimitExceeded / userRateLimitExceeded → GMAIL_RATE_LIMITED, retryable", () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]) {
      const err = mapHttpStatusToGmailError(403, "message", "m1", diag(reason))
      assert.equal(err.code, "GMAIL_RATE_LIMITED", reason)
      assert.equal(err.retryable, true)
    }
  })

  it("403 insufficientPermissions et 403 sans motif restent GMAIL_UNAUTHORIZED", () => {
    assert.equal(mapHttpStatusToGmailError(403, "list", undefined, diag("insufficientPermissions")).code, "GMAIL_UNAUTHORIZED")
    assert.equal(mapHttpStatusToGmailError(403, "list").code, "GMAIL_UNAUTHORIZED")
    assert.equal(isGoogleRateLimitReason(null), false)
  })
})

const rateLimited = () =>
  new GmailProviderError({ code: "GMAIL_RATE_LIMITED", message: "rl", retryable: true, global: true })

function flakyClient(failures: number, error: () => Error = rateLimited) {
  let calls = 0
  const client = {
    getMessage: async (_t: string, id: string) => {
      calls++
      if (calls <= failures) throw error()
      return { id, payload: {} }
    },
  } as unknown as GmailApiClient
  return { client, getCalls: () => calls }
}

describe("RateLimitRetryingGmailApiClient", () => {
  it("rejoue avec attente exponentielle puis réussit", async () => {
    const sleeps: number[] = []
    const { client, getCalls } = flakyClient(2)
    const retrying = new RateLimitRetryingGmailApiClient(client, {
      sleep: async (ms) => { sleeps.push(ms) },
      random: () => 0,
    })
    const res = await retrying.getMessage("t", "m1")
    assert.equal(res.id, "m1")
    assert.equal(getCalls(), 3)
    assert.deepEqual(sleeps, [1000, 2000])
  })

  it("abandonne après maxRetries et propage GMAIL_RATE_LIMITED", async () => {
    const { client, getCalls } = flakyClient(10)
    const retrying = new RateLimitRetryingGmailApiClient(client, { maxRetries: 3, sleep: async () => {} })
    await assert.rejects(retrying.getMessage("t", "m1"), (e: unknown) => (e as GmailProviderError).code === "GMAIL_RATE_LIMITED")
    assert.equal(getCalls(), 4)
  })

  it("ne rejoue jamais un refus d'accès", async () => {
    const unauthorized = () => new GmailProviderError({ code: "GMAIL_UNAUTHORIZED", message: "403", retryable: false, global: true })
    const { client, getCalls } = flakyClient(10, unauthorized)
    const retrying = new RateLimitRetryingGmailApiClient(client, { sleep: async () => { throw new Error("no sleep expected") } })
    await assert.rejects(retrying.getMessage("t", "m1"), (e: unknown) => (e as GmailProviderError).code === "GMAIL_UNAUTHORIZED")
    assert.equal(getCalls(), 1)
  })
})

describe("synchro : limite de débit ≠ accès refusé", () => {
  it("échec persisté PROVIDER_RATE_LIMITED, aucune alerte de reconnexion", async () => {
    let cursor: AcquisitionScanCursorRecord = {
      id: "c", companyId: "co", source: "GMAIL", mailboxKey: "conn", lastHistoryId: "h0",
      lastSyncedAt: null, consecutiveFailures: 1, lastErrorCode: null, lastErrorAt: null,
    }
    const codes: string[] = []
    let alerted = false
    const result = await syncAcquisitionMailForCompany({
      companyId: "co",
      connectionId: "conn",
      provider: { source: "GMAIL", listMessagesPage: async () => { throw rateLimited() } } as never,
      ingestion: { isEnabled: () => true, registerIncomingMessage: async () => { throw new Error("x") } } as never,
      cursorRepository: {
        getOrCreate: async () => ({ ...cursor }),
        saveSuccessfulPage: async () => ({ ...cursor }),
        recordFailure: async (_c, _s, errorCode, at) => {
          codes.push(errorCode)
          cursor = { ...cursor, consecutiveFailures: cursor.consecutiveFailures + 1, lastErrorCode: errorCode, lastErrorAt: at }
          return { ...cursor }
        },
      },
      mailShadow: false,
      onProviderAccessLost: async () => { alerted = true },
    })
    assert.equal(result.status, "FAILED")
    assert.equal(result.error?.internalCode, "GMAIL_RATE_LIMITED")
    assert.deepEqual(codes, ["PROVIDER_RATE_LIMITED"])
    assert.equal(alerted, false)
  })

  it("santé : avertissement « limite Gmail atteinte », pas de bouton Reconnecter", () => {
    const h = assessAcquisitionMailboxHealth({
      active: true,
      cursor: { lastSyncedAt: null, consecutiveFailures: 5, lastErrorCode: "PROVIDER_RATE_LIMITED", lastErrorAt: new Date("2026-11-16T15:00:46Z") },
      now: new Date("2026-11-16T15:10:00Z"),
    })
    assert.equal(h.level, "warning")
    assert.equal(h.label, "limite Gmail atteinte")
    assert.equal(mailboxNeedsReconnect(h), false)
  })

  it("santé : cause inconnue répétée → avertissement, jamais « reconnexion requise »", () => {
    const h = assessAcquisitionMailboxHealth({
      active: true,
      cursor: { lastSyncedAt: null, consecutiveFailures: 9, lastErrorCode: "CURSOR_LOAD_FAILED", lastErrorAt: null },
    })
    assert.equal(h.level, "warning")
    assert.equal(mailboxNeedsReconnect(h), false)
  })
})

describe("rattrapage : les e-mails déjà traités ne sont pas relus", () => {
  async function run(knownMessageIds?: (input: { externalMessageIds: string[]; connectionId: string; companyId: string }) => Promise<Set<string>>) {
    const { GmailMailProviderAdapter } = await import("@/lib/acquisition/connector/gmail-mail-provider.adapter")
    const fetched: string[] = []
    const apiClient = {
      listHistory: async () => ({
        history: ["a", "b", "c"].map((id) => ({ messagesAdded: [{ message: { id } }] })),
        historyId: "h-next",
      }),
      getMessage: async (_t: string, id: string) => {
        fetched.push(id)
        return {
          id, threadId: "t", labelIds: [], snippet: "", internalDate: "1720000000000",
          payload: { headers: [{ name: "From", value: "x@lauralu.fr" }, { name: "Subject", value: "s" }], mimeType: "text/plain" },
        }
      },
    } as unknown as GmailApiClient
    const adapter = new GmailMailProviderAdapter({
      connectionClient: { getValidAccessToken: async () => "tok" } as never,
      apiClient,
      knownMessageIds,
    })
    const page = await adapter.listMessagesPage({ companyId: "co", connectionId: "conn", cursor: "h0", pageSize: 50, paginationMode: "history" })
    return { fetched, page }
  }

  it("seuls les ids inconnus sont lus ; le curseur suivant est conservé", async () => {
    let seen: unknown
    const { fetched, page } = await run(async (input) => { seen = input; return new Set(["a", "c"]) })
    assert.deepEqual(fetched, ["b"])
    assert.deepEqual(page.messages.map((m) => m.externalMessageId), ["b"])
    assert.equal(page.nextHistoryId, "h-next")
    assert.deepEqual(seen, { companyId: "co", connectionId: "conn", externalMessageIds: ["a", "b", "c"] })
  })

  it("panne de la lecture des ids connus → aucun filtrage (jamais de perte)", async () => {
    const { fetched } = await run(async () => { throw new Error("db down") })
    assert.deepEqual(fetched, ["a", "b", "c"])
  })

  it("sans port (tests/legacy) → comportement historique", async () => {
    const { fetched } = await run(undefined)
    assert.deepEqual(fetched, ["a", "b", "c"])
  })
})
