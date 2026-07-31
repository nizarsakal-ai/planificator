import { NextResponse } from "next/server"
import { auth } from "@/auth"
import {
  resolveGmailOAuthHmacSecret,
  signGmailOAuthPayload,
} from "@/lib/auth/gmail-oauth-state"

// Initie le flux OAuth Google Gmail
// GET /api/auth/gmail → redirige vers Google

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 })
  }

  const hmacSecret = resolveGmailOAuthHmacSecret()
  if (!hmacSecret) {
    return NextResponse.json({ error: "OAuth non configuré" }, { status: 500 })
  }

  const clientId    = process.env.GOOGLE_CLIENT_ID
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI
  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "Google OAuth non configuré" }, { status: 500 })
  }

  // Signer le state pour prévenir le CSRF
  const payload = JSON.stringify({
    companyId: session.user.companyId,
    userId:    session.user.id,
    nonce:     Date.now(),
  })
  const sig = signGmailOAuthPayload(payload, hmacSecret)
  const state = Buffer.from(JSON.stringify({ payload, sig })).toString("base64url")

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
    access_type:   "offline",
    prompt:        "consent",
    state,
  })

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}
