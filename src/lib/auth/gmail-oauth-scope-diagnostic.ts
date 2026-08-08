/**
 * PLAN-BOOKING-DIAG-GMAIL-SCOPES-007 — Diagnostic temporaire des scopes OAuth Gmail.
 * Ne persiste rien. Ne log jamais tokens / email / body Google.
 */

export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly"
export const USERINFO_EMAIL_SCOPE =
  "https://www.googleapis.com/auth/userinfo.email"

export type GmailOAuthScopeDiagnostic = {
  scopeReported: boolean
  hasGmailReadonly: boolean
  hasUserinfoEmail: boolean
  scopeCount: number
}

/**
 * Extrait uniquement des indicateurs booléens / compteur depuis tokenData.scope.
 * Si `scope` est absent ou non-string → scopeReported=false (pas une preuve d'absence de permission).
 */
export function diagnoseGmailOAuthTokenScopes(
  tokenData: unknown
): GmailOAuthScopeDiagnostic {
  if (typeof tokenData !== "object" || tokenData === null) {
    return {
      scopeReported: false,
      hasGmailReadonly: false,
      hasUserinfoEmail: false,
      scopeCount: 0,
    }
  }
  const scope = (tokenData as { scope?: unknown }).scope
  if (typeof scope !== "string") {
    return {
      scopeReported: false,
      hasGmailReadonly: false,
      hasUserinfoEmail: false,
      scopeCount: 0,
    }
  }
  const scopes = scope.split(/\s+/).filter((s) => s.length > 0)
  return {
    scopeReported: true,
    hasGmailReadonly: scopes.includes(GMAIL_READONLY_SCOPE),
    hasUserinfoEmail: scopes.includes(USERINFO_EMAIL_SCOPE),
    scopeCount: scopes.length,
  }
}

/** Log sûr : jamais la chaîne scope brute, jamais de tokens. */
export function formatGmailOAuthScopeDiagnosticLog(
  diagnostic: GmailOAuthScopeDiagnostic
): string {
  return (
    "[gmail-oauth-scope-diagnostic] " +
    JSON.stringify({
      scopeReported: diagnostic.scopeReported,
      hasGmailReadonly: diagnostic.hasGmailReadonly,
      hasUserinfoEmail: diagnostic.hasUserinfoEmail,
      scopeCount: diagnostic.scopeCount,
    })
  )
}
