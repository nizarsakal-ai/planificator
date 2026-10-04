process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import {
  extractGoogleErrorDiagnostics,
  GmailProviderError,
  mapHttpStatusToGmailError,
  MAX_ERROR_BODY_BYTES,
  readGoogleErrorDiagnostics,
  safeGmailDiagnostics,
  sanitizeGmailDiagnostics,
} from "@/lib/acquisition/connector/gmail.errors"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { runAcquisitionGmailSyncDriver } from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type { AcquisitionScanCursorRepositoryPort } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"

// Valeurs sensibles simulées — ne doivent JAMAIS ressortir des diagnostics ni des logs.
const ACCESS_TOKEN = "ya29.SIMULATED-ACCESS-TOKEN-SECRET"
const SENSITIVE = [
  ACCESS_TOKEN,
  "ya29.",
  "1//SIMULATED-REFRESH-TOKEN",
  "refresh_token",
  "access_token",
  "Authorization",
  "Bearer",
  "client@exemple.fr",
  "Objet confidentiel du devis",
  "Request had insufficient authentication scopes.",
]

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(status: number, body: string, contentType = "application/json") {
  const seen: { url: string; authorization: string | null }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({ url: String(input), authorization: headers.get("Authorization") })
    return new Response(body, { status, headers: { "Content-Type": contentType } })
  }) as typeof fetch
  return seen
}

/** Corps d'erreur au format Google, pollué de contenus sensibles simulés. */
function googleErrorBody(opts: { code: number; status?: string; reason?: string; infoReason?: string }) {
  return JSON.stringify({
    error: {
      code: opts.code,
      message: "Request had insufficient authentication scopes. Objet confidentiel du devis",
      ...(opts.status ? { status: opts.status } : {}),
      errors: opts.reason
        ? [{ message: "client@exemple.fr access_token=" + ACCESS_TOKEN, domain: "global", reason: opts.reason }]
        : [{ message: "refresh_token=1//SIMULATED-REFRESH-TOKEN", domain: "global" }],
      ...(opts.infoReason
        ? {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: opts.infoReason,
                metadata: { method: "Authorization: Bearer " + ACCESS_TOKEN },
              },
            ],
          }
        : {}),
    },
  })
}

async function listError(status: number, body: string, contentType?: string): Promise<GmailProviderError> {
  stubFetch(status, body, contentType)
  try {
    await new FetchGmailApiClient().listMessages(ACCESS_TOKEN, "after:2026/09/01", 50)
  } catch (e) {
    assert.ok(e instanceof GmailProviderError)
    return e
  }
  assert.fail("une erreur était attendue")
}

function assertNoSensitive(value: unknown) {
  const text = JSON.stringify(value)
  for (const s of SENSITIVE) assert.ok(!text.includes(s), `fuite détectée : ${s}`)
}

describe("Gmail HTTP diagnostics — client Acquisition", () => {
  it("A — HTTP 401 → GMAIL_UNAUTHORIZED + gmailHttpStatus 401 (comportement inchangé)", async () => {
    const err = await listError(401, googleErrorBody({ code: 401, status: "UNAUTHENTICATED", reason: "authError" }))
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.equal(err.retryable, false)
    assert.equal(err.global, true)
    assert.equal(err.message, "Gmail API unauthorized (list)")
    assert.deepEqual(safeGmailDiagnostics(err), {
      gmailHttpStatus: 401,
      gmailErrorReason: "authError",
      gmailErrorCode: "UNAUTHENTICATED",
    })
  })

  it("B — HTTP 403 avec reason structurée → GMAIL_UNAUTHORIZED + reason extraite", async () => {
    const err = await listError(
      403,
      googleErrorBody({ code: 403, status: "PERMISSION_DENIED", reason: "insufficientPermissions", infoReason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" })
    )
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.deepEqual(safeGmailDiagnostics(err), {
      gmailHttpStatus: 403,
      gmailErrorReason: "insufficientPermissions",
      gmailErrorCode: "PERMISSION_DENIED",
    })
  })

  it("B' — 403 sans errors[].reason mais ErrorInfo (ex. API désactivée) → reason ErrorInfo", async () => {
    const err = await listError(403, googleErrorBody({ code: 403, status: "PERMISSION_DENIED", infoReason: "SERVICE_DISABLED" }))
    assert.equal(safeGmailDiagnostics(err)?.gmailErrorReason, "SERVICE_DISABLED")
  })

  it("C — 403 sans reason ni status → reason null, code null, aucun crash", async () => {
    const err = await listError(403, JSON.stringify({ error: { code: 403, message: "x" } }))
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.deepEqual(safeGmailDiagnostics(err), { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
  })

  it("D — corps malformé / non JSON / vide / trop gros → diagnostics vides, comportement conservé", async () => {
    for (const [body, type] of [
      ["<html>Error 403 access_token=" + ACCESS_TOKEN + "</html>", "text/html"],
      ["{not json", "application/json"],
      ["", "application/json"],
      [JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }], pad: "x".repeat(20_000) } }), "application/json"],
      [JSON.stringify(["array", "body"]), "application/json"],
      [JSON.stringify({ error: "string-error" }), "application/json"],
    ] as const) {
      const err = await listError(403, body, type)
      assert.equal(err.code, "GMAIL_UNAUTHORIZED")
      assert.deepEqual(safeGmailDiagnostics(err), { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
      assertNoSensitive({ diag: safeGmailDiagnostics(err), message: err.message })
    }
  })

  it("reason / status non conformes (texte libre, injection) → null", () => {
    const d = extractGoogleErrorDiagnostics(403, {
      error: {
        status: "permission denied; access_token=" + ACCESS_TOKEN,
        errors: [{ reason: "insufficient Permissions Bearer " + ACCESS_TOKEN }, { reason: 42 }],
      },
    })
    assert.deepEqual(d, { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
  })

  it("autres statuts mappés à l'identique (429/5xx/404 history) avec diagnostic de statut", async () => {
    assert.equal((await listError(429, "{}")).code, "GMAIL_RATE_LIMITED")
    assert.equal((await listError(503, "{}")).code, "GMAIL_UNAVAILABLE")
    stubFetch(404, "{}")
    await assert.rejects(new FetchGmailApiClient().listHistory(ACCESS_TOKEN, "1", 10), (e: unknown) => {
      assert.ok(e instanceof GmailProviderError)
      assert.equal(e.code, "GMAIL_HISTORY_EXPIRED")
      assert.equal(safeGmailDiagnostics(e)?.gmailHttpStatus, 404)
      return true
    })
  })

  it("getMessage 403 → même diagnostic, champs identiques au mapping d'origine", async () => {
    stubFetch(403, googleErrorBody({ code: 403, status: "PERMISSION_DENIED", reason: "insufficientPermissions" }))
    await assert.rejects(new FetchGmailApiClient().getMessage(ACCESS_TOKEN, "msg-1"), (e: unknown) => {
      assert.ok(e instanceof GmailProviderError)
      const original = mapHttpStatusToGmailError(403, "message", "msg-1")
      assert.equal(e.code, original.code)
      assert.equal(e.message, original.message)
      assert.equal(e.retryable, original.retryable)
      assert.equal(e.global, original.global)
      assert.equal(e.messageId, original.messageId)
      assert.equal(safeGmailDiagnostics(e)?.gmailErrorReason, "insufficientPermissions")
      return true
    })
  })

  it("mapping sans diagnostic (autres appelants) strictement inchangé", () => {
    const e = mapHttpStatusToGmailError(403, "list")
    assert.equal(e.code, "GMAIL_UNAUTHORIZED")
    assert.equal(e.diagnostics, undefined)
    assert.equal(safeGmailDiagnostics(e), undefined)
    assert.equal(safeGmailDiagnostics(new Error("x")), undefined)
    assert.equal(sanitizeGmailDiagnostics({ gmailHttpStatus: "403" }), undefined)
    assert.equal(sanitizeGmailDiagnostics({ gmailHttpStatus: 99999 }), undefined)
  })
})

/** Flux « pull » : rien n'est produit tant que le lecteur ne lit pas (highWaterMark 0). */
function countingStream(totalBytes: number, chunkBytes: number, payload: string) {
  const encoded = new TextEncoder().encode(payload)
  const stats = { pulls: 0, bytesDelivered: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls++
        const remaining = totalBytes - stats.bytesDelivered
        if (remaining <= 0) {
          controller.close()
          return
        }
        const size = Math.min(chunkBytes, remaining)
        const chunk = new Uint8Array(size)
        for (let i = 0; i < size; i++) chunk[i] = encoded[(stats.bytesDelivered + i) % encoded.length]
        stats.bytesDelivered += size
        controller.enqueue(chunk)
      },
      cancel() {
        stats.cancelled = true
      },
    },
    { highWaterMark: 0 }
  )
  return { stream, stats }
}

const BIG_PAYLOAD =
  '{"error":{"code":403,"status":"PERMISSION_DENIED","errors":[{"reason":"insufficientPermissions"}],"message":"access_token=' +
  ACCESS_TOKEN +
  ' client@exemple.fr Objet confidentiel du devis"}}'

describe("Gmail HTTP diagnostics — correctifs post-revue", () => {
  it("TEST 1 — reason : ya29.*, identifiants pointés et domaines rejetés ; reasons Google connues acceptées", () => {
    for (const rejected of ["ya29.short", "jean.dupont", "gmail.googleapis.com", "auth-error", "1abc", "_x"]) {
      assert.equal(
        extractGoogleErrorDiagnostics(403, { error: { errors: [{ reason: rejected }] } }).gmailErrorReason,
        null,
        rejected
      )
      assert.equal(sanitizeGmailDiagnostics({ gmailHttpStatus: 403, gmailErrorReason: rejected })?.gmailErrorReason, null)
    }
    for (const accepted of [
      "insufficientPermissions",
      "accessNotConfigured",
      "authError",
      "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      "SERVICE_DISABLED",
      "rateLimitExceeded",
      "forbidden",
    ]) {
      assert.equal(extractGoogleErrorDiagnostics(403, { error: { errors: [{ reason: accepted }] } }).gmailErrorReason, accepted)
    }
  })

  it("TEST 2 — corps en flux > 16 KiB sans Content-Length → diagnostic null, GMAIL_UNAUTHORIZED, lecture interrompue", async () => {
    for (const status of [401, 403]) {
      const { stream, stats } = countingStream(200_000, 1024, BIG_PAYLOAD)
      globalThis.fetch = (async () => new Response(stream, { status })) as typeof fetch
      const err = await new FetchGmailApiClient()
        .listMessages(ACCESS_TOKEN, "q", 10)
        .then(() => assert.fail("erreur attendue"), (e: unknown) => e)
      assert.ok(err instanceof GmailProviderError)
      assert.equal(err.code, "GMAIL_UNAUTHORIZED")
      assert.deepEqual(safeGmailDiagnostics(err), { gmailHttpStatus: status, gmailErrorReason: null, gmailErrorCode: null })
      assert.ok(stats.cancelled, "le flux doit être annulé")
      assert.ok(stats.bytesDelivered <= MAX_ERROR_BODY_BYTES + 1024, `octets lus : ${stats.bytesDelivered}`)
      assert.ok(stats.bytesDelivered < 200_000)
      assertNoSensitive({ diag: safeGmailDiagnostics(err), message: err.message })
    }
  })

  it("corps en flux ≤ 16 KiB (multi-chunks) → analysé normalement", async () => {
    const payload = JSON.stringify({ error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } })
    const { stream } = countingStream(new TextEncoder().encode(payload).byteLength, 7, payload)
    assert.deepEqual(await readGoogleErrorDiagnostics(new Response(stream, { status: 403 })), {
      gmailHttpStatus: 403,
      gmailErrorReason: "insufficientPermissions",
      gmailErrorCode: "PERMISSION_DENIED",
    })
  })

  it("limite exprimée en octets : 16 384 caractères multi-octets (> 16 384 octets) → null", async () => {
    const body = JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }], pad: "é".repeat(9000) } })
    assert.ok(body.length < 20_000 && new TextEncoder().encode(body).byteLength > MAX_ERROR_BODY_BYTES)
    assert.equal((await readGoogleErrorDiagnostics(new Response(body, { status: 403 }))).gmailErrorReason, null)
  })

  it("TEST 3 — Content-Length > limite → corps jamais lu, diagnostic null", async () => {
    const { stream, stats } = countingStream(40_000, 1024, BIG_PAYLOAD)
    const res = new Response(stream, { status: 403, headers: { "content-length": "40000" } })
    assert.deepEqual(await readGoogleErrorDiagnostics(res), { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
    assert.equal(stats.pulls, 0, "aucun chunk ne doit être tiré du flux")
    assert.equal(stats.bytesDelivered, 0)
  })

  it("Content-Length invalide → ignoré, lecture bornée appliquée", async () => {
    const payload = JSON.stringify({ error: { errors: [{ reason: "authError" }] } })
    const res = new Response(payload, { status: 401, headers: { "content-length": "abc" } })
    assert.equal((await readGoogleErrorDiagnostics(res)).gmailErrorReason, "authError")
  })

  it("TEST 4 — corps absent → diagnostic null, mapping conservé", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch
    const err = await new FetchGmailApiClient()
      .listMessages(ACCESS_TOKEN, "q", 10)
      .then(() => assert.fail("erreur attendue"), (e: unknown) => e)
    assert.ok(err instanceof GmailProviderError)
    const original = mapHttpStatusToGmailError(403, "list")
    assert.equal(err.code, original.code)
    assert.equal(err.message, original.message)
    assert.equal(err.retryable, original.retryable)
    assert.deepEqual(safeGmailDiagnostics(err), { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
  })

  it("UTF-8 invalide → null sans crash", async () => {
    const res = new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 403 })
    assert.deepEqual(await readGoogleErrorDiagnostics(res), { gmailHttpStatus: 403, gmailErrorReason: null, gmailErrorCode: null })
  })

  it("B — getAttachment HTTP 403 → GMAIL_UNAUTHORIZED + reason/status extraits", async () => {
    stubFetch(403, googleErrorBody({ code: 403, status: "PERMISSION_DENIED", reason: "insufficientPermissions" }))
    await assert.rejects(new FetchGmailApiClient().getAttachment(ACCESS_TOKEN, "msg-1", "att-1"), (e: unknown) => {
      assert.ok(e instanceof GmailProviderError)
      assert.equal(e.code, "GMAIL_UNAUTHORIZED")
      assert.deepEqual(safeGmailDiagnostics(e), {
        gmailHttpStatus: 403,
        gmailErrorReason: "insufficientPermissions",
        gmailErrorCode: "PERMISSION_DENIED",
      })
      return true
    })
  })

  it("A — driver : exception GmailProviderError directe → champs safe journalisés, rien de sensible", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []
    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [{ companyId: "co-1", connectionId: "conn-1", gmailAddress: "acq@example.com" }],
      runSyncForConnection: async () => {
        throw new GmailProviderError({
          code: "GMAIL_UNAUTHORIZED",
          message: "Gmail API unauthorized (list)",
          retryable: false,
          global: true,
          diagnostics: {
            gmailHttpStatus: 403,
            gmailErrorReason: "insufficientPermissions",
            gmailErrorCode: "PERMISSION_DENIED",
          },
        })
      },
      log: (event, payload) => logs.push({ event, payload }),
    })
    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.ok(failed)
    assert.equal(failed.payload?.internalCode, "GMAIL_UNAUTHORIZED")
    assert.equal(failed.payload?.gmailHttpStatus, 403)
    assert.equal(failed.payload?.gmailErrorReason, "insufficientPermissions")
    assert.equal(failed.payload?.gmailErrorCode, "PERMISSION_DENIED")
    assertNoSensitive({ logs, result })
    assert.ok(!JSON.stringify(result).includes("insufficientPermissions"))
  })

  it("A' — driver : diagnostic falsifié (texte libre) dans l'exception → filtré", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const logs: { event: string; payload?: Record<string, unknown> }[] = []
    await runAcquisitionGmailSyncDriver({
      listConnections: async () => [{ companyId: "co-1", connectionId: "conn-1", gmailAddress: "acq@example.com" }],
      runSyncForConnection: async () => {
        throw new GmailProviderError({
          code: "GMAIL_UNAUTHORIZED",
          message: "Gmail API unauthorized (list)",
          retryable: false,
          global: true,
          diagnostics: {
            gmailHttpStatus: 403,
            gmailErrorReason: ACCESS_TOKEN,
            gmailErrorCode: "Bearer " + ACCESS_TOKEN,
          },
        })
      },
      log: (event, payload) => logs.push({ event, payload }),
    })
    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.equal(failed?.payload?.gmailErrorReason, null)
    assert.equal(failed?.payload?.gmailErrorCode, null)
    assertNoSensitive(logs)
  })

  it("C — recordFailure ne reçoit que le code d'erreur prévu, jamais le diagnostic ni le message Google", async () => {
    stubFetch(403, googleErrorBody({ code: 403, status: "PERMISSION_DENIED", reason: "insufficientPermissions" }))
    const api = new FetchGmailApiClient()
    const recordFailureCalls: unknown[][] = []
    const cursor = {
      id: "cur",
      companyId: "co-1",
      source: "GMAIL" as const,
      mailboxKey: "conn-1",
      lastHistoryId: null,
      lastSyncedAt: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorAt: null,
    }
    await syncAcquisitionMailForCompany({
      companyId: "co-1",
      connectionId: "conn-1",
      provider: {
        source: "GMAIL",
        listMessagesPage: async () => {
          await api.listMessages(ACCESS_TOKEN, "q", 10)
          throw new Error("unreachable")
        },
      },
      ingestion: {
        isEnabled: () => true,
        registerIncomingMessage: async () => {
          throw new Error("not expected")
        },
      },
      cursorRepository: {
        getOrCreate: async () => cursor,
        saveSuccessfulPage: async () => cursor,
        recordFailure: async (...args) => {
          recordFailureCalls.push(args)
          return cursor
        },
      },
      mailShadow: false,
    })
    assert.equal(recordFailureCalls.length, 1)
    const [companyId, source, errorCode, occurredAt, mailboxKey] = recordFailureCalls[0]
    assert.deepEqual([companyId, source, errorCode, mailboxKey], ["co-1", "GMAIL", "PROVIDER_LIST_FAILED", "conn-1"])
    assert.ok(occurredAt instanceof Date)
    assert.equal(recordFailureCalls[0].length, 5)
    // occurredAt exclu : un horodatage ISO peut contenir « 403 » par coïncidence (millisecondes).
    const serialized = JSON.stringify(recordFailureCalls.map((args) => args.filter((a) => !(a instanceof Date))))
    for (const forbidden of ["gmailHttpStatus", "gmailErrorReason", "gmailErrorCode", "insufficientPermissions", "PERMISSION_DENIED", "403"]) {
      assert.ok(!serialized.includes(forbidden), forbidden)
    }
    assertNoSensitive(recordFailureCalls)
  })
})

describe("Gmail HTTP diagnostics — E. bout-en-bout service + driver (logs)", () => {
  it("les logs SYNC_COMPANY_FAILED portent statut/reason/code, sans aucune donnée sensible", async () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    stubFetch(
      403,
      googleErrorBody({ code: 403, status: "PERMISSION_DENIED", reason: "insufficientPermissions", infoReason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" })
    )
    const api = new FetchGmailApiClient()
    const provider: MailProviderPort = {
      source: "GMAIL",
      listMessagesPage: async () => {
        await api.listMessages(ACCESS_TOKEN, "after:2026/09/01", 50)
        throw new Error("unreachable")
      },
    }
    const ingestion: AcquisitionIngestionPort = {
      isEnabled: () => true,
      registerIncomingMessage: async () => {
        throw new Error("not expected")
      },
    }
    const repo: AcquisitionScanCursorRepositoryPort = {
      getOrCreate: async (companyId) => ({
        id: "cur",
        companyId,
        source: "GMAIL",
        mailboxKey: "conn-1",
        lastHistoryId: null,
        lastSyncedAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorAt: null,
      }),
      saveSuccessfulPage: async () => {
        throw new Error("not expected")
      },
      recordFailure: async (companyId) => ({
        id: "cur",
        companyId,
        source: "GMAIL",
        mailboxKey: "conn-1",
        lastHistoryId: null,
        lastSyncedAt: null,
        consecutiveFailures: 1,
        lastErrorCode: "PROVIDER_LIST_FAILED",
        lastErrorAt: null,
      }),
    }

    const logs: { event: string; payload?: Record<string, unknown> }[] = []
    const result = await runAcquisitionGmailSyncDriver({
      listConnections: async () => [{ companyId: "co-1", connectionId: "conn-1", gmailAddress: "acq@example.com" }],
      runSyncForConnection: (c) =>
        syncAcquisitionMailForCompany({
          companyId: c.companyId,
          connectionId: c.connectionId,
          provider,
          ingestion,
          cursorRepository: repo,
          mailShadow: false,
        }),
      log: (event, payload) => logs.push({ event, payload }),
    })

    const failed = logs.find((l) => l.event === "SYNC_COMPANY_FAILED")
    assert.ok(failed)
    assert.equal(failed.payload?.syncCode, "PROVIDER_LIST_FAILED")
    assert.equal(failed.payload?.internalCode, "GMAIL_UNAUTHORIZED")
    assert.equal(failed.payload?.gmailHttpStatus, 403)
    assert.equal(failed.payload?.gmailErrorReason, "insufficientPermissions")
    assert.equal(failed.payload?.gmailErrorCode, "PERMISSION_DENIED")
    assertNoSensitive({ logs, result })
    // La réponse publique du cron n'expose pas le diagnostic.
    assert.ok(!JSON.stringify(result).includes("insufficientPermissions"))
  })
})
