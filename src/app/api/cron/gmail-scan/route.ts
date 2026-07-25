import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"
import Anthropic from "@anthropic-ai/sdk"
import {
  bookingGmailMessageLifecycle,
  BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED,
} from "@/lib/booking/gmail-message-lifecycle"
import {
  permanentBookingError,
  retryableBookingError,
} from "@/lib/booking/booking-gmail-errors"
import { createOrGetBookingScanResult } from "@/lib/booking/booking-scan-result"
import {
  extractBookingFields,
  hasUsefulBookingData,
} from "@/lib/booking/extract-booking-fields"

// Helper : extrait le texte d'un message Gmail (payload récursif)
function extractTextFromParts(parts: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[]): string {
  let text = ""
  for (const part of parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      text += Buffer.from(part.body.data, "base64url").toString("utf8")
    } else if (part.mimeType === "text/html" && part.body?.data && !text) {
      const html = Buffer.from(part.body.data, "base64url").toString("utf8")
      text += html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    } else if (part.parts) {
      text += extractTextFromParts(part.parts as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[])
    }
  }
  return text
}

function extractMessageBody(payload: { body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!payload) return ""
  if (payload.parts) return extractTextFromParts(payload.parts as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[])
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8")
  return ""
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const connections = await prisma.gmailConnection.findMany()
  const stats = {
    scanned: 0,
    detected: 0,
    errors: 0,
    skipped: 0,
    retryable: 0,
    permanent: 0,
  }
  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null
  const lifecycle = bookingGmailMessageLifecycle

  for (const conn of connections) {
    try {
      let accessToken = decrypt(conn.accessToken)
      const expirySoon = conn.tokenExpiry < new Date(Date.now() + 5 * 60 * 1000)

      if (expirySoon) {
        const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id:     process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            refresh_token: decrypt(conn.refreshToken),
            grant_type:    "refresh_token",
          }),
        })
        const refreshData = await refreshRes.json()
        if (!refreshData.access_token) {
          console.error(`[gmail-scan] Token refresh failed for company ${conn.companyId}`)
          stats.errors++
          continue
        }
        accessToken = refreshData.access_token
        await prisma.gmailConnection.update({
          where: { id: conn.id },
          data:  {
            accessToken: encrypt(refreshData.access_token),
            tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
          },
        })
      }

      const listRes  = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:noreply@booking.com&maxResults=50",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!listRes.ok) {
        console.error(`[gmail-scan] Gmail list HTTP ${listRes.status} for company ${conn.companyId}`)
        stats.errors++
        continue
      }
      const listData = await listRes.json()
      if (!listData.messages?.length) continue

      for (const msg of listData.messages as { id: string }[]) {
        const claim = await lifecycle.claimForProcessing(conn.companyId, msg.id)
        if (claim.action === "SKIP") {
          stats.skipped++
          continue
        }

        stats.scanned++
        try {
          const msgRes  = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          )
          if (!msgRes.ok) {
            throw retryableBookingError("GMAIL_TEMPORARY", `Gmail get HTTP ${msgRes.status}`)
          }
          const msgData = await msgRes.json()
          const bodyText = extractMessageBody(msgData.payload)
          const snippet  = (msgData.snippet ?? "") as string

          if (!bodyText && !snippet) {
            await lifecycle.markPermanentIgnored(
              conn.companyId,
              msg.id,
              permanentBookingError("EMPTY_MESSAGE_BODY", "Corps et snippet vides")
            )
            stats.permanent++
            console.log(`[gmail-scan] PERMANENTLY_IGNORED empty body messageId=${msg.id}`)
            continue
          }

          const emailText = (bodyText || snippet).substring(0, 4000)
          const parsed = await extractBookingFields(
            emailText,
            msg.id,
            anthropic as import("@/lib/booking/extract-booking-fields").BookingAiClient | null
          )

          if (parsed.startDate) {
            const startDate = new Date(parsed.startDate as string)
            const cutoff = new Date("2026-06-17")
            if (startDate < cutoff) {
              await lifecycle.markPermanentIgnored(
                conn.companyId,
                msg.id,
                permanentBookingError("BEFORE_CUTOFF_DATE", "Avant le 17/06/2026")
              )
              stats.permanent++
              console.log(`[gmail-scan] PERMANENTLY_IGNORED cutoff messageId=${msg.id}`)
              continue
            }
          }

          if (!hasUsefulBookingData(parsed)) {
            await lifecycle.markPermanentIgnored(
              conn.companyId,
              msg.id,
              permanentBookingError("NO_USEFUL_BOOKING_DATA", "Parsing sans donnée utile")
            )
            stats.permanent++
            console.log(`[gmail-scan] PERMANENTLY_IGNORED no useful data messageId=${msg.id}`)
            continue
          }

          const admin = await prisma.user.findFirst({
            where:  { companyId: conn.companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
            select: { id: true },
          })

          let matchedTeamId: string | null = null
          if (parsed.teamName) {
            const team = await prisma.team.findFirst({
              where: {
                companyId: conn.companyId,
                active:    true,
                name:      { contains: parsed.teamName, mode: "insensitive" },
              },
              select: { id: true },
            })
            matchedTeamId = team?.id ?? null
          }

          await lifecycle.markSucceededInTransaction(
            { companyId: conn.companyId, messageId: msg.id },
            async (tx) => {
              const result = await createOrGetBookingScanResult(tx, {
                companyId: conn.companyId,
                messageId: msg.id,
                snippet,
                parsed,
                matchedTeamId,
                adminId: admin?.id ?? null,
              })
              return {
                resultType: result.resultType,
                resultEntityId: result.resultEntityId,
              }
            }
          )

          stats.detected++
        } catch (msgErr) {
          // Course : un autre worker a déjà commit SUCCEEDED — ne pas marquer échec
          if (
            msgErr instanceof Error &&
            msgErr.message === BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED
          ) {
            const row = await prisma.processedGmailMessage.findUnique({
              where: {
                companyId_messageId: {
                  companyId: conn.companyId,
                  messageId: msg.id,
                },
              },
            })
            if (row?.status === "SUCCEEDED") {
              stats.detected++
              continue
            }
          }
          const failed = await lifecycle.markFailure({
            companyId: conn.companyId,
            messageId: msg.id,
            error: msgErr,
          })
          if (failed.status === "SUCCEEDED") {
            stats.detected++
            continue
          }
          if (failed.status === "RETRYABLE_FAILURE") {
            stats.retryable++
            console.warn(
              `[gmail-scan] RETRYABLE_FAILURE messageId=${msg.id} code=${failed.errorCode} nextRetryAt=${failed.nextRetryAt?.toISOString() ?? "n/a"}`
            )
          } else if (failed.status === "PERMANENTLY_IGNORED") {
            stats.permanent++
            console.warn(
              `[gmail-scan] PERMANENTLY_IGNORED messageId=${msg.id} code=${failed.errorCode}`
            )
          }
          stats.errors++
        }
      }
    } catch (connErr) {
      console.error(`[gmail-scan] Error for company ${conn.companyId}`)
      stats.errors++
    }
  }

  console.log(
    `[CRON gmail-scan] scanned=${stats.scanned} detected=${stats.detected} skipped=${stats.skipped} retryable=${stats.retryable} permanent=${stats.permanent} errors=${stats.errors}`
  )
  return NextResponse.json({ ok: true, ...stats })
}
