import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/encryption"
import { createHmac } from "crypto"

const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000"

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

  // Vérifier la signature du state
  let companyId: string, userId: string
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"))
    const expectedSig = createHmac("sha256", process.env.CRON_SECRET ?? "fallback")
      .update(decoded.payload)
      .digest("hex")
    if (expectedSig !== decoded.sig) throw new Error("Invalid signature")
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

  // Récupérer l'adresse Gmail
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = await profileRes.json()
  const gmailAddress = profile.email ?? ""

  // Chiffrer et stocker
  const expiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000)
  await prisma.gmailConnection.upsert({
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

  return NextResponse.redirect(`${APP_URL}/parametres?gmail=connected`)
}
