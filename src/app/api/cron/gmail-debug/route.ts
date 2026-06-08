import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const conn = await prisma.gmailConnection.findFirst()
  if (!conn) return NextResponse.json({ error: "No Gmail connection" })

  let accessToken = decrypt(conn.accessToken)
  const expirySoon = conn.tokenExpiry < new Date(Date.now() + 5 * 60 * 1000)

  let tokenRefreshed = false
  if (expirySoon) {
    const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: decrypt(conn.refreshToken),
        grant_type:    "refresh_token",
      }),
    })
    const refreshData = await refreshRes.json()
    if (refreshData.access_token) {
      accessToken = refreshData.access_token
      tokenRefreshed = true
      await prisma.gmailConnection.update({
        where: { id: conn.id },
        data: {
          accessToken: encrypt(refreshData.access_token),
          tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
        },
      })
    } else {
      return NextResponse.json({ error: "Token refresh failed", details: refreshData })
    }
  }

  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:noreply@booking.com&maxResults=5",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const listData = await listRes.json()

  return NextResponse.json({
    gmailAddress: conn.gmailAddress,
    tokenExpiry: conn.tokenExpiry,
    tokenExpired: expirySoon,
    tokenRefreshed,
    gmailApiResponse: listData,
  })
}
