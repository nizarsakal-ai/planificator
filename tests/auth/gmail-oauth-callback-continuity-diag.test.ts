/**
 * PLAN-ACQ-GMAIL-CONTINUITY-DIAG-001 — write-diag OAuth callback (temporaire).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { NextRequest } from "next/server"
import { signGmailOAuthPayload } from "@/lib/auth/gmail-oauth-state"
import { encrypt } from "@/lib/encryption"
import { prisma } from "@/lib/prisma"

const ENV_KEY = "ACQUISITION_GMAIL_DIAGNOSTIC"
const WRITE_PREFIX = "[acquisition-gmail-write-diag]"
const COMPANY_ID = "cmp-continuity-write-test"
const USER_ID = "user-continuity-write-test"
const PLAIN_ACCESS = "ACCESS_TOKEN_SECRET_TEST"
const PLAIN_REFRESH = "REFRESH_TOKEN_SECRET_TEST"
const SENSITIVE = [
  PLAIN_ACCESS,
  PLAIN_REFRESH,
  "Bearer secret",
  "user@example.com",
  "ya29.",
  "client-secret-value",
]

describe("Gmail OAuth callback — write continuity diag", () => {
  let previousDiag: string | undefined
  let previousCron: string | undefined
  let previousGoogleClientId: string | undefined
  let previousGoogleClientSecret: string | undefined
  let previousRedirect: string | undefined
  let previousNextAuth: string | undefined
  let previousEncKey: string | undefined
  let infoCalls: unknown[][]
  let originalInfo: typeof console.info
  let originalFetch: typeof globalThis.fetch
  let originalUpsert: typeof prisma.gmailConnection.upsert

  function restoreEnv(key: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }

  function writeLogs(): string[] {
    return infoCalls
      .filter((args) => typeof args[0] === "string" && String(args[0]).startsWith(WRITE_PREFIX))
      .map((args) => String(args[0]))
  }

  function buildState(companyId: string, userId: string, secret: string): string {
    const payload = JSON.stringify({ companyId, userId })
    const sig = signGmailOAuthPayload(payload, secret)
    return Buffer.from(JSON.stringify({ payload, sig })).toString("base64url")
  }

  function assertSafeWritePayload(raw: string): Record<string, unknown> {
    assert.ok(raw.startsWith(`${WRITE_PREFIX} `))
    const payload = JSON.parse(raw.slice(WRITE_PREFIX.length + 1)) as Record<string, unknown>
    assert.deepEqual(Object.keys(payload).sort(), [
      "accessTokenLength",
      "companyId",
      "connectionId",
      "refreshTokenLength",
      "updatedAt",
    ])
    for (const needle of SENSITIVE) {
      assert.ok(!raw.includes(needle), `log must not contain ${needle}`)
    }
    assert.ok(!/"hash"/i.test(raw))
    assert.ok(!/"fingerprint"/i.test(raw))
    assert.ok(!raw.includes("sha256"))
    assert.ok(!raw.includes("ciphertext"))
    return payload
  }

  beforeEach(() => {
    previousDiag = process.env[ENV_KEY]
    previousCron = process.env.CRON_SECRET
    previousGoogleClientId = process.env.GOOGLE_CLIENT_ID
    previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET
    previousRedirect = process.env.GMAIL_OAUTH_REDIRECT_URI
    previousNextAuth = process.env.NEXTAUTH_URL
    previousEncKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY

    delete process.env[ENV_KEY]
    process.env.CRON_SECRET = "continuity-diag-cron-secret"
    process.env.GOOGLE_CLIENT_ID = "client-id"
    process.env.GOOGLE_CLIENT_SECRET = "client-secret-value"
    process.env.GMAIL_OAUTH_REDIRECT_URI = "https://planificator-staging.vercel.app/api/auth/gmail/callback"
    process.env.NEXTAUTH_URL = "https://planificator-staging.vercel.app"
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key-32chars-min!!"

    infoCalls = []
    originalInfo = console.info
    console.info = (...args: unknown[]) => {
      infoCalls.push(args)
    }
    originalFetch = globalThis.fetch
    originalUpsert = prisma.gmailConnection.upsert
  })

  afterEach(() => {
    console.info = originalInfo
    globalThis.fetch = originalFetch
    prisma.gmailConnection.upsert = originalUpsert
    restoreEnv(ENV_KEY, previousDiag)
    restoreEnv("CRON_SECRET", previousCron)
    restoreEnv("GOOGLE_CLIENT_ID", previousGoogleClientId)
    restoreEnv("GOOGLE_CLIENT_SECRET", previousGoogleClientSecret)
    restoreEnv("GMAIL_OAUTH_REDIRECT_URI", previousRedirect)
    restoreEnv("NEXTAUTH_URL", previousNextAuth)
    restoreEnv("GMAIL_TOKEN_ENCRYPTION_KEY", previousEncKey)
  })

  async function runSuccessfulCallback(opts: {
    upsertImpl?: typeof prisma.gmailConnection.upsert
  } = {}) {
    const accessCipher = encrypt(PLAIN_ACCESS)
    const refreshCipher = encrypt(PLAIN_REFRESH)
    const updatedAt = new Date("2026-08-10T18:00:00.000Z")
    const stored = {
      id: "gconn-write-diag-1",
      companyId: COMPANY_ID,
      gmailAddress: "user@example.com",
      accessToken: accessCipher,
      refreshToken: refreshCipher,
      tokenExpiry: new Date("2026-08-10T19:00:00.000Z"),
      connectedById: USER_ID,
      connectedAt: new Date("2026-08-10T17:00:00.000Z"),
      updatedAt,
    }

    prisma.gmailConnection.upsert = (opts.upsertImpl ??
      (async () => stored)) as typeof prisma.gmailConnection.upsert

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: PLAIN_ACCESS,
          refresh_token: PLAIN_REFRESH,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
          token_type: "Bearer",
        })
      }
      if (url.includes("googleapis.com/oauth2/v1/userinfo")) {
        return Response.json({ email: "user@example.com" })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const state = buildState(COMPANY_ID, USER_ID, process.env.CRON_SECRET!)
    const { GET } = await import("@/app/api/auth/gmail/callback/route")
    const req = new NextRequest(
      `https://planificator-staging.vercel.app/api/auth/gmail/callback?code=auth-code&state=${state}`
    )
    const res = await GET(req)
    return { res, stored, accessCipher, refreshCipher }
  }

  it("flag OFF => aucun write-diag", async () => {
    delete process.env[ENV_KEY]
    const { res } = await runSuccessfulCallback()
    assert.equal(res.status, 307)
    assert.equal(writeLogs().length, 0)
  })

  for (const value of ["", "TRUE", "1", " true "]) {
    it(`flag "${value}" => aucun write-diag`, async () => {
      process.env[ENV_KEY] = value
      const { res } = await runSuccessfulCallback()
      assert.equal(res.status, 307)
      assert.equal(writeLogs().length, 0)
    })
  }

  it("flag ON + upsert success => un write-diag avec longueurs ciphertext", async () => {
    process.env[ENV_KEY] = "true"
    const { res, stored, accessCipher, refreshCipher } = await runSuccessfulCallback()
    assert.equal(res.status, 307)
    assert.ok(String(res.headers.get("location")).includes("gmail=connected"))

    const logs = writeLogs()
    assert.equal(logs.length, 1)
    const payload = assertSafeWritePayload(logs[0]!)
    assert.equal(payload.companyId, COMPANY_ID)
    assert.equal(payload.connectionId, stored.id)
    assert.equal(payload.updatedAt, stored.updatedAt.toISOString())
    assert.equal(payload.accessTokenLength, accessCipher.length)
    assert.equal(payload.refreshTokenLength, refreshCipher.length)
    assert.notEqual(payload.accessTokenLength, PLAIN_ACCESS.length)
    assert.notEqual(payload.refreshTokenLength, PLAIN_REFRESH.length)
    assert.ok(!logs[0]!.includes(accessCipher))
    assert.ok(!logs[0]!.includes(refreshCipher))
  })

  it("upsert throw => aucun write-diag + erreur propagée", async () => {
    process.env[ENV_KEY] = "true"
    await assert.rejects(
      () =>
        runSuccessfulCallback({
          upsertImpl: (async () => {
            throw new Error("upsert failed with ACCESS_TOKEN_SECRET_TEST")
          }) as typeof prisma.gmailConnection.upsert,
        }),
      /upsert failed/
    )
    assert.equal(writeLogs().length, 0)
  })
})
