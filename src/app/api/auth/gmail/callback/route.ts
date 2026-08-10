import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/encryption"
import {
  resolveGmailOAuthHmacSecret,
  verifyGmailOAuthSignature,
} from "@/lib/auth/gmail-oauth-state"
import {
  diagnoseGmailOAuthTokenScopes,
  formatGmailOAuthScopeDiagnosticLog,
} from "@/lib/auth/gmail-oauth-scope-diagnostic"

const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000"

/**
 * Diagnostic temporaire (PLAN-ACQ-GMAIL-CONTINUITY-DIAG-001).
 * Flag OFF => no-op. Longueurs ciphertext uniquement — jamais de token/secret.
 */
function logAcquisitionGmailWriteDiag(
  companyId: string,
  connection: {
    id: string
    updatedAt: Date
    accessToken: string
    refreshToken: string
  }
): void {
  try {
    if (process.env.ACQUISITION_GMAIL_DIAGNOSTIC !== "true") return
    console.info(
      `[acquisition-gmail-write-diag] ${JSON.stringify({
        companyId,
        connectionId: connection.id,
        updatedAt: connection.updatedAt.toISOString(),
        accessTokenLength: connection.accessToken.length,
        refreshTokenLength: connection.refreshToken.length,
      })}`
    )
  } catch {
    // Le diagnostic ne doit jamais provoquer une nouvelle exception.
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code  = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")

  if (error) {
    return NextResponse.redirect(`${APP_URL}/parametres?gmail=error&reason=${error}`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${APP_URL}/parametres?gmail=error&reason=missing_params`)
  }

  const hmacSecret = resolveGmailOAuthHmacSecret()
  if (!hmacSecret) {
    return NextResponse.redirect(`${APP_URL}/parametres?gmail=error&reason=invalid_state`)
  }

  // Vérifier la signature du state
  let companyId: string, userId: string
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"))
    if (
      typeof decoded.payload !== "string" ||
      typeof decoded.sig !== "string" ||
      !verifyGmailOAuthSignature(decoded.payload, decoded.sig, hmacSecret)
    ) {
      throw new Error("Invalid signature")
    }
    const parsed = JSON.parse(decoded.payload)
    companyId = parsed.companyId
    userId    = parsed.userId
  } catch {
    return NextResponse.redirect(`${APP_URL}/parametres?gmail=error&reason=invalid_state`)
  }

  // Échanger le code contre les tokens
  const clientId     = process.env.GOOGLE_CLIENT_ID!
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
  const redirectUri  = process.env.GMAIL_OAUTH_REDIRECT_URI!

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  })
  const tokenData = await tokenRes.json()

  if (!tokenData.access_token || !tokenData.refresh_token) {
    return NextResponse.redirect(`${APP_URL}/parametres?gmail=error&reason=no_tokens`)
  }

  // TEMPORARY PLAN-BOOKING-DIAG-GMAIL-SCOPES-007 — scopes accordés (pas de secrets).
  console.info(
    formatGmailOAuthScopeDiagnosticLog(diagnoseGmailOAuthTokenScopes(tokenData))
  )

  // Récupérer l'adresse Gmail
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = await profileRes.json()
  const gmailAddress = profile.email ?? ""

  // Chiffrer et stocker
  const expiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000)
  const connection = await prisma.gmailConnection.upsert({
    where:  { companyId },
    create: {
      companyId,
      gmailAddress,
      accessToken:  encrypt(tokenData.access_token),
      refreshToken: encrypt(tokenData.refresh_token),
      tokenExpiry:  expiry,
      connectedById: userId,
    },
    update: {
      gmailAddress,
      accessToken:  encrypt(tokenData.access_token),
      refreshToken: encrypt(tokenData.refresh_token),
      tokenExpiry:  expiry,
      connectedById: userId,
    },
  })

  logAcquisitionGmailWriteDiag(companyId, connection)

  return NextResponse.redirect(`${APP_URL}/parametres?gmail=connected`)
}
