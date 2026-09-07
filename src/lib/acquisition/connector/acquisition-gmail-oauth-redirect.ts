/**
 * Redirect URI OAuth Gmail Acquisition — dédié, jamais le callback Booking.
 */

export function resolveAcquisitionGmailOAuthRedirectUri(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const explicit = env.ACQUISITION_GMAIL_OAUTH_REDIRECT_URI?.trim()
  if (explicit) return explicit

  const base = env.NEXTAUTH_URL?.trim().replace(/\/$/, "")
  if (!base) return null
  return `${base}/api/acquisition/gmail/callback`
}
