/**
 * Signature HMAC du state OAuth Gmail — fail-closed sur CRON_SECRET.
 * Pas de fallback secret.
 */

import { createHmac, timingSafeEqual } from "crypto"

/** Même politique que assertCronBearerAuth : absent / vide / "undefined" → invalide. */
export function resolveGmailOAuthHmacSecret(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const secret = env.CRON_SECRET?.trim()
  if (!secret || secret === "undefined") return null
  return secret
}

export function signGmailOAuthPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}

export function verifyGmailOAuthSignature(
  payload: string,
  sig: string,
  secret: string
): boolean {
  const expected = signGmailOAuthPayload(payload, secret)
  try {
    const a = Buffer.from(expected, "hex")
    const b = Buffer.from(String(sig), "hex")
    if (a.length === 0 || a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
