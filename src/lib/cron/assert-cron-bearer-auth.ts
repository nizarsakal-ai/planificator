import { NextResponse } from "next/server"

/**
 * Auth HTTP Bearer pour crons / APIs machine — fail-closed.
 *
 * - `CRON_SECRET` absent, vide, seuls espaces, ou exactement `undefined` (après trim) → 401
 * - `Authorization` absent ou ≠ `Bearer ${secret}` → 401
 * - La valeur littérale `Authorization: Bearer undefined` n’est jamais acceptée
 *   (y compris si `CRON_SECRET` vaut la chaîne `"undefined"`).
 *
 * Instrumentation temporaire (PLAN-RUNTIME-DIAGNOSTIC-001) :
 * si `CRON_AUTH_DIAGNOSTIC === "true"`, logue sur 401 uniquement des métriques
 * non secrètes (longueurs / présence). Jamais de secret, token, hash, ni header brut.
 *
 * @returns `NextResponse` 401 si refus ; `null` si autorisé.
 */

const BEARER_PREFIX = "Bearer "

type CronAuthDiagPayload = {
  expectedSecretPresent: boolean
  expectedSecretLength: number
  authorizationHeaderPresent: boolean
  bearerSchemeValid: boolean
  receivedTokenLength: number | null
}

function isCronAuthDiagnosticEnabled(): boolean {
  return process.env.CRON_AUTH_DIAGNOSTIC === "true"
}

function buildCronAuthDiagPayload(
  expectedSecret: string | undefined,
  authorizationHeader: string | null
): CronAuthDiagPayload {
  const expectedSecretPresent = Boolean(
    expectedSecret && expectedSecret !== "undefined"
  )
  const expectedSecretLength = expectedSecretPresent
    ? expectedSecret!.length
    : 0
  const authorizationHeaderPresent =
    authorizationHeader !== null && authorizationHeader !== ""
  const bearerSchemeValid =
    typeof authorizationHeader === "string" &&
    authorizationHeader.startsWith(BEARER_PREFIX)
  const receivedTokenLength = bearerSchemeValid
    ? authorizationHeader!.slice(BEARER_PREFIX.length).length
    : null

  return {
    expectedSecretPresent,
    expectedSecretLength,
    authorizationHeaderPresent,
    bearerSchemeValid,
    receivedTokenLength,
  }
}

function logCronAuthDiag(
  expectedSecret: string | undefined,
  authorizationHeader: string | null
): void {
  if (!isCronAuthDiagnosticEnabled()) return
  const payload = buildCronAuthDiagPayload(expectedSecret, authorizationHeader)
  console.info(`[cron-auth-diag] ${JSON.stringify(payload)}`)
}

function unauthorized(
  expectedSecret: string | undefined,
  authorizationHeader: string | null
): NextResponse {
  logCronAuthDiag(expectedSecret, authorizationHeader)
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export function assertCronBearerAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim()
  const auth = req.headers.get("authorization")

  if (!secret || secret === "undefined") {
    return unauthorized(secret, auth)
  }

  if (auth !== `Bearer ${secret}`) {
    return unauthorized(secret, auth)
  }

  return null
}
