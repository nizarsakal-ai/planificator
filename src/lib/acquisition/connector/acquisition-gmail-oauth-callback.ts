/**
 * Callback OAuth Gmail Acquisition — handler testable (deps injectables).
 * Upsert par (companyId, gmailAddress) → multi-compte ; jamais gmail_connections.
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/encryption"
import {
  resolveGmailOAuthHmacSecret,
  verifyGmailOAuthSignature,
} from "@/lib/auth/gmail-oauth-state"
import { resolveAcquisitionGmailOAuthRedirectUri } from "@/lib/acquisition/connector/acquisition-gmail-oauth-redirect"

export type AcquisitionGmailCallbackDeps = {
  auth: () => Promise<{
    user?: { id: string; companyId?: string | null; role: string } | null
  } | null>
  prisma: Pick<typeof prisma, "acquisitionGmailConnection">
  fetch: typeof fetch
  resolveRedirectUri: typeof resolveAcquisitionGmailOAuthRedirectUri
  resolveHmacSecret: typeof resolveGmailOAuthHmacSecret
  encrypt: typeof encrypt
  appUrl: string
  env: NodeJS.ProcessEnv
}

export function defaultAcquisitionGmailCallbackDeps(
  env: NodeJS.ProcessEnv = process.env
): AcquisitionGmailCallbackDeps {
  return {
    auth,
    prisma,
    fetch,
    resolveRedirectUri: resolveAcquisitionGmailOAuthRedirectUri,
    resolveHmacSecret: resolveGmailOAuthHmacSecret,
    encrypt,
    appUrl: env.NEXTAUTH_URL ?? "http://localhost:3000",
    env,
  }
}

export async function handleAcquisitionGmailCallback(
  req: NextRequest,
  deps: AcquisitionGmailCallbackDeps = defaultAcquisitionGmailCallbackDeps()
): Promise<NextResponse> {
  const { searchParams } = req.nextUrl
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")

  const redirectError = (reason: string) =>
    NextResponse.redirect(
      `${deps.appUrl}/parametres?acquisition_gmail=error&reason=${reason}`
    )

  if (error) return redirectError(error)
  if (!code || !state) return redirectError("missing_params")

  const session = await deps.auth()
  if (!session?.user) return redirectError("unauthenticated")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return redirectError("forbidden")
  }
  if (!session.user.companyId) return redirectError("missing_tenant")

  const hmacSecret = deps.resolveHmacSecret()
  if (!hmacSecret) return redirectError("invalid_state")

  let companyId: string
  let userId: string
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
    if (parsed.purpose !== "acquisition_gmail") {
      throw new Error("Invalid purpose")
    }
    companyId = parsed.companyId
    userId = parsed.userId
  } catch {
    return redirectError("invalid_state")
  }

  if (companyId !== session.user.companyId || userId !== session.user.id) {
    return redirectError("tenant_mismatch")
  }

  const clientId = deps.env.GOOGLE_CLIENT_ID
  const clientSecret = deps.env.GOOGLE_CLIENT_SECRET
  const redirectUri = deps.resolveRedirectUri(deps.env)
  if (!clientId || !clientSecret || !redirectUri) {
    return redirectError("oauth_misconfigured")
  }

  const tokenRes = await deps.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  })
  const tokenData = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!tokenData.access_token || !tokenData.refresh_token) {
    return redirectError("no_tokens")
  }

  const profileRes = await deps.fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = (await profileRes.json()) as { email?: string }
  const gmailAddress = String(profile.email ?? "")
    .trim()
    .toLowerCase()
  if (!gmailAddress) return redirectError("no_email")

  const expiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000)

  await deps.prisma.acquisitionGmailConnection.upsert({
    where: {
      companyId_gmailAddress: { companyId, gmailAddress },
    },
    create: {
      companyId,
      gmailAddress,
      accessToken: deps.encrypt(tokenData.access_token),
      refreshToken: deps.encrypt(tokenData.refresh_token),
      tokenExpiry: expiry,
      connectedById: userId,
      active: true,
    },
    update: {
      accessToken: deps.encrypt(tokenData.access_token),
      refreshToken: deps.encrypt(tokenData.refresh_token),
      tokenExpiry: expiry,
      connectedById: userId,
      active: true,
    },
  })

  return NextResponse.redirect(
    `${deps.appUrl}/parametres?acquisition_gmail=connected&address=${encodeURIComponent(gmailAddress)}`
  )
}
