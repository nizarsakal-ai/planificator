/**
 * PLAN-BOOKING-DIAG-GMAIL-SCOPES-007 — diagnostic scopes OAuth Gmail (temporaire).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  GMAIL_READONLY_SCOPE,
  USERINFO_EMAIL_SCOPE,
  diagnoseGmailOAuthTokenScopes,
  formatGmailOAuthScopeDiagnosticLog,
} from "@/lib/auth/gmail-oauth-scope-diagnostic"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

describe("diagnoseGmailOAuthTokenScopes", () => {
  it("1. scope gmail.readonly + userinfo.email → flags true", () => {
    const d = diagnoseGmailOAuthTokenScopes({
      access_token: "ya29.SECRET_MUST_NOT_LEAK",
      refresh_token: "1//REFRESH_SECRET",
      scope: `${GMAIL_READONLY_SCOPE} ${USERINFO_EMAIL_SCOPE}`,
    })
    assert.equal(d.scopeReported, true)
    assert.equal(d.hasGmailReadonly, true)
    assert.equal(d.hasUserinfoEmail, true)
    assert.equal(d.scopeCount, 2)
  })

  it("2. scope userinfo.email seul → hasGmailReadonly false", () => {
    const d = diagnoseGmailOAuthTokenScopes({
      scope: USERINFO_EMAIL_SCOPE,
    })
    assert.equal(d.scopeReported, true)
    assert.equal(d.hasGmailReadonly, false)
    assert.equal(d.hasUserinfoEmail, true)
    assert.equal(d.scopeCount, 1)
  })

  it("3. scope absent → scopeReported false, pas d'exception", () => {
    const d = diagnoseGmailOAuthTokenScopes({
      access_token: "ya29.SECRET",
      expires_in: 3600,
    })
    assert.equal(d.scopeReported, false)
    assert.equal(d.hasGmailReadonly, false)
    assert.equal(d.hasUserinfoEmail, false)
    assert.equal(d.scopeCount, 0)
  })

  it("4. scope mal typé → fail-safe", () => {
    assert.deepEqual(diagnoseGmailOAuthTokenScopes({ scope: 42 }), {
      scopeReported: false,
      hasGmailReadonly: false,
      hasUserinfoEmail: false,
      scopeCount: 0,
    })
    assert.deepEqual(diagnoseGmailOAuthTokenScopes({ scope: ["a"] }), {
      scopeReported: false,
      hasGmailReadonly: false,
      hasUserinfoEmail: false,
      scopeCount: 0,
    })
    assert.deepEqual(diagnoseGmailOAuthTokenScopes(null), {
      scopeReported: false,
      hasGmailReadonly: false,
      hasUserinfoEmail: false,
      scopeCount: 0,
    })
  })

  it("5. log sans access_token / refresh_token / Authorization / email / tokenData", () => {
    const secretAccess = "ya29.a0AfH6SMC_ACCESS_TOKEN_SECRET"
    const secretRefresh = "1//0gREFRESH_TOKEN_SECRET"
    const email = "user@example.com"
    const tokenData = {
      access_token: secretAccess,
      refresh_token: secretRefresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: `${GMAIL_READONLY_SCOPE} ${USERINFO_EMAIL_SCOPE}`,
      email,
    }
    const d = diagnoseGmailOAuthTokenScopes(tokenData)
    const logLine = formatGmailOAuthScopeDiagnosticLog(d)
    assert.match(logLine, /^\[gmail-oauth-scope-diagnostic\]/)
    assert.equal(logLine.includes(secretAccess), false)
    assert.equal(logLine.includes(secretRefresh), false)
    assert.equal(logLine.includes("Authorization"), false)
    assert.equal(logLine.includes("Bearer"), false)
    assert.equal(logLine.includes(email), false)
    assert.equal(logLine.includes("access_token"), false)
    assert.equal(logLine.includes("refresh_token"), false)
    assert.equal(logLine.includes(GMAIL_READONLY_SCOPE), false)
    assert.equal(logLine.includes(USERINFO_EMAIL_SCOPE), false)
    assert.match(logLine, /"scopeReported":true/)
    assert.match(logLine, /"hasGmailReadonly":true/)
    assert.match(logLine, /"hasUserinfoEmail":true/)
    assert.match(logLine, /"scopeCount":2/)

    const serialized = JSON.stringify(d)
    assert.equal(serialized.includes(secretAccess), false)
    assert.equal(serialized.includes(secretRefresh), false)
    assert.equal(serialized.includes(email), false)

    const callbackSrc = readFileSync(
      join(ROOT, "src/app/api/auth/gmail/callback/route.ts"),
      "utf8"
    )
    assert.ok(callbackSrc.includes("formatGmailOAuthScopeDiagnosticLog"))
    assert.ok(callbackSrc.includes("diagnoseGmailOAuthTokenScopes"))
    assert.ok(callbackSrc.includes("PLAN-BOOKING-DIAG-GMAIL-SCOPES-007"))
    // Le log ne dump pas tokenData
    assert.equal(callbackSrc.includes("JSON.stringify(tokenData)"), false)
    assert.equal(callbackSrc.includes("console.info(tokenData)"), false)
    assert.equal(callbackSrc.includes("console.log(tokenData)"), false)
  })
})
