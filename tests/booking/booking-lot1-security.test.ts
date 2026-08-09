/**
 * PLAN-BOOKING-FINAL LOT 1 — Auth cron fail-closed + kill-switch gmail-scan.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, it } from "node:test"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isBookingGmailScanEnabled } from "@/lib/booking/booking-gmail-scan-flag"
import { getBookingGmailScanEarlyResponse } from "@/lib/booking/booking-gmail-scan-gate"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const SECRET = "booking-lot1-cron-secret"

function request(authHeader?: string | null): Request {
  const headers = new Headers()
  if (authHeader !== undefined && authHeader !== null) {
    headers.set("authorization", authHeader)
  }
  return new Request("http://localhost/api/cron/gmail-scan", {
    method: "GET",
    headers,
  })
}

describe("assertCronBearerAuth", () => {
  const prev = process.env.CRON_SECRET
  const prevDiag = process.env.CRON_AUTH_DIAGNOSTIC
  const infoCalls: string[] = []
  const originalInfo = console.info

  beforeEach(() => {
    infoCalls.length = 0
    console.info = (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(" "))
    }
    delete process.env.CRON_AUTH_DIAGNOSTIC
  })

  afterEach(() => {
    console.info = originalInfo
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
    if (prevDiag === undefined) delete process.env.CRON_AUTH_DIAGNOSTIC
    else process.env.CRON_AUTH_DIAGNOSTIC = prevDiag
  })

  function diagPayloads(): Record<string, unknown>[] {
    return infoCalls
      .filter((line) => line.startsWith("[cron-auth-diag] "))
      .map((line) => JSON.parse(line.slice("[cron-auth-diag] ".length)))
  }

  function assertNoSecretLeak(token?: string) {
    const blob = infoCalls.join("\n")
    assert.equal(blob.includes(SECRET), false)
    if (token) assert.equal(blob.includes(token), false)
  }

  it("CRON_SECRET absent → 401", async () => {
    delete process.env.CRON_SECRET
    const res = assertCronBearerAuth(request(`Bearer ${SECRET}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.equal(JSON.stringify(body).includes(SECRET), false)
  })

  it("CRON_SECRET vide → 401", async () => {
    process.env.CRON_SECRET = ""
    const res = assertCronBearerAuth(request("Bearer "))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it("CRON_SECRET composé d’espaces → 401", async () => {
    process.env.CRON_SECRET = "   "
    const res = assertCronBearerAuth(request("Bearer    "))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it("Authorization absent → 401", async () => {
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request())
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it('Authorization = "Bearer undefined" → 401 (secret réel set)', async () => {
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request("Bearer undefined"))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it('Authorization = "Bearer undefined" → 401 (secret unset — ne jamais accepter)', async () => {
    delete process.env.CRON_SECRET
    const res = assertCronBearerAuth(request("Bearer undefined"))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it('CRON_SECRET = "undefined" + Authorization = "Bearer undefined" → 401', async () => {
    process.env.CRON_SECRET = "undefined"
    const res = assertCronBearerAuth(request("Bearer undefined"))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
  })

  it("mauvais secret → 401", async () => {
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request("Bearer wrong-secret"))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it("bon secret → null (autorisé)", () => {
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request(`Bearer ${SECRET}`))
    assert.equal(res, null)
  })

  it("secret avec espaces autour → trim, Bearer exact du secret trimé", () => {
    process.env.CRON_SECRET = `  ${SECRET}  `
    assert.equal(assertCronBearerAuth(request(`Bearer ${SECRET}`)), null)
    const bad = assertCronBearerAuth(request(`Bearer   ${SECRET}  `))
    assert.ok(bad)
    assert.equal(bad!.status, 401)
  })

  it("CRON_AUTH_DIAGNOSTIC OFF + 401 → aucun log diagnostic", async () => {
    delete process.env.CRON_AUTH_DIAGNOSTIC
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request("Bearer wrong-secret"))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.equal(diagPayloads().length, 0)
    assert.equal(infoCalls.some((l) => l.includes("[cron-auth-diag]")), false)
  })

  it("CRON_AUTH_DIAGNOSTIC ON + secret absent → métriques A", async () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    delete process.env.CRON_SECRET
    const res = assertCronBearerAuth(request(`Bearer ${SECRET}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.deepEqual(diagPayloads(), [
      {
        expectedSecretPresent: false,
        expectedSecretLength: 0,
        authorizationHeaderPresent: true,
        bearerSchemeValid: true,
        receivedTokenLength: SECRET.length,
      },
    ])
    assertNoSecretLeak(SECRET)
  })

  it("CRON_AUTH_DIAGNOSTIC ON + header absent → métriques B", async () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request())
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.deepEqual(diagPayloads(), [
      {
        expectedSecretPresent: true,
        expectedSecretLength: SECRET.length,
        authorizationHeaderPresent: false,
        bearerSchemeValid: false,
        receivedTokenLength: null,
      },
    ])
    assertNoSecretLeak()
  })

  it("CRON_AUTH_DIAGNOSTIC ON + mauvais scheme → métriques C", async () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    process.env.CRON_SECRET = SECRET
    const badToken = "not-a-secret-token"
    const res = assertCronBearerAuth(request(`Token ${badToken}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.deepEqual(diagPayloads(), [
      {
        expectedSecretPresent: true,
        expectedSecretLength: SECRET.length,
        authorizationHeaderPresent: true,
        bearerSchemeValid: false,
        receivedTokenLength: null,
      },
    ])
    assertNoSecretLeak(badToken)
  })

  it("CRON_AUTH_DIAGNOSTIC ON + longueur différente → métriques D", async () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    process.env.CRON_SECRET = SECRET
    // Éviter une lettre présente dans les clés JSON du payload (ex. "x" dans Length).
    const shortToken = "zz"
    const res = assertCronBearerAuth(request(`Bearer ${shortToken}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.deepEqual(diagPayloads(), [
      {
        expectedSecretPresent: true,
        expectedSecretLength: SECRET.length,
        authorizationHeaderPresent: true,
        bearerSchemeValid: true,
        receivedTokenLength: shortToken.length,
      },
    ])
    assert.notEqual(SECRET.length, shortToken.length)
    assertNoSecretLeak(shortToken)
  })

  it("CRON_AUTH_DIAGNOSTIC ON + même longueur mauvaise valeur → métriques E", async () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    process.env.CRON_SECRET = SECRET
    const wrongSameLen = "z".repeat(SECRET.length)
    assert.equal(wrongSameLen.length, SECRET.length)
    assert.notEqual(wrongSameLen, SECRET)
    const res = assertCronBearerAuth(request(`Bearer ${wrongSameLen}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.deepEqual(diagPayloads(), [
      {
        expectedSecretPresent: true,
        expectedSecretLength: SECRET.length,
        authorizationHeaderPresent: true,
        bearerSchemeValid: true,
        receivedTokenLength: wrongSameLen.length,
      },
    ])
    assertNoSecretLeak(wrongSameLen)
  })

  it("CRON_AUTH_DIAGNOSTIC ON + auth correcte → aucun log", () => {
    process.env.CRON_AUTH_DIAGNOSTIC = "true"
    process.env.CRON_SECRET = SECRET
    const res = assertCronBearerAuth(request(`Bearer ${SECRET}`))
    assert.equal(res, null)
    assert.equal(diagPayloads().length, 0)
    assert.equal(infoCalls.some((l) => l.includes("[cron-auth-diag]")), false)
  })
})

describe("isBookingGmailScanEnabled", () => {
  const prev = process.env.BOOKING_GMAIL_SCAN_ENABLED

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_GMAIL_SCAN_ENABLED
    else process.env.BOOKING_GMAIL_SCAN_ENABLED = prev
  })

  it("variable absente => false", () => {
    delete process.env.BOOKING_GMAIL_SCAN_ENABLED
    assert.equal(isBookingGmailScanEnabled(), false)
  })

  it("vide => false", () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = ""
    assert.equal(isBookingGmailScanEnabled(), false)
  })

  it('"false" => false', () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "false"
    assert.equal(isBookingGmailScanEnabled(), false)
  })

  it('"TRUE" => false', () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "TRUE"
    assert.equal(isBookingGmailScanEnabled(), false)
  })

  it('"1" => false', () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "1"
    assert.equal(isBookingGmailScanEnabled(), false)
  })

  it('"true" => true', () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "true"
    assert.equal(isBookingGmailScanEnabled(), true)
  })
})

describe("getBookingGmailScanEarlyResponse (gate gmail-scan)", () => {
  const prevSecret = process.env.CRON_SECRET
  const prevFlag = process.env.BOOKING_GMAIL_SCAN_ENABLED
  const prevDiag = process.env.CRON_AUTH_DIAGNOSTIC

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    delete process.env.BOOKING_GMAIL_SCAN_ENABLED
    delete process.env.CRON_AUTH_DIAGNOSTIC
  })

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
    if (prevFlag === undefined) delete process.env.BOOKING_GMAIL_SCAN_ENABLED
    else process.env.BOOKING_GMAIL_SCAN_ENABLED = prevFlag
    if (prevDiag === undefined) delete process.env.CRON_AUTH_DIAGNOSTIC
    else process.env.CRON_AUTH_DIAGNOSTIC = prevDiag
  })

  it("auth refusée avant lecture du flag (flag serait true)", async () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "true"
    const res = getBookingGmailScanEarlyResponse(request("Bearer wrong"))
    assert.ok(res)
    assert.equal(res!.status, 401)
    const body = await res!.json()
    assert.equal(body.error, "Unauthorized")
    assert.equal(body.skipped, undefined)
    assert.equal(body.reason, undefined)
  })

  it("CRON_SECRET absent → 401 même si flag true", async () => {
    delete process.env.CRON_SECRET
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "true"
    const res = getBookingGmailScanEarlyResponse(request(`Bearer ${SECRET}`))
    assert.ok(res)
    assert.equal(res!.status, 401)
  })

  it("flag désactivé => HTTP 200 skipped DISABLED", async () => {
    delete process.env.BOOKING_GMAIL_SCAN_ENABLED
    const res = getBookingGmailScanEarlyResponse(request(`Bearer ${SECRET}`))
    assert.ok(res)
    assert.equal(res!.status, 200)
    const body = await res!.json()
    assert.deepEqual(body, { ok: true, skipped: true, reason: "DISABLED" })
  })

  it("auth OK + flag true => null (scan peut continuer — pas d’early exit)", () => {
    process.env.BOOKING_GMAIL_SCAN_ENABLED = "true"
    assert.equal(
      getBookingGmailScanEarlyResponse(request(`Bearer ${SECRET}`)),
      null
    )
  })
})

describe("gmail-scan route LOT1 wiring (structure)", () => {
  it("utilise getBookingGmailScanEarlyResponse avant prisma métier", () => {
    const src = readFileSync(
      join(ROOT, "src/app/api/cron/gmail-scan/route.ts"),
      "utf8"
    )
    const gateIdx = src.indexOf("getBookingGmailScanEarlyResponse")
    const prismaIdx = src.indexOf("prisma.gmailConnection.findMany")
    assert.ok(gateIdx >= 0, "gate import/appel requis")
    assert.ok(prismaIdx > gateIdx, "findMany doit être après le gate")
    assert.match(
      src,
      /const early = getBookingGmailScanEarlyResponse\(req\)/
    )
    assert.match(src, /if \(early\) return early/)
    assert.equal(src.includes("Bearer ${process.env.CRON_SECRET}"), false)
  })

  it("routes dangereuses absentes physiquement", () => {
    assert.equal(
      existsSync(join(ROOT, "src/app/api/cron/gmail-reset-test/route.ts")),
      false
    )
    assert.equal(
      existsSync(join(ROOT, "src/app/api/cron/gmail-debug/route.ts")),
      false
    )
  })
})
