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
import { extractNormalizedGmailBody } from "@/lib/booking/booking-gmail-body.service"
import {
  hasBookingAddress,
  truncateBookingEmailForExtract,
  truncateBookingEmailForPersist,
} from "@/lib/booking/booking-pending-merge"
import { getBookingGmailScanEarlyResponse } from "@/lib/booking/booking-gmail-scan-gate"
import { getBookingScanCutoffDate } from "@/lib/booking/booking-scan-cutoff"
import {
  BookingGmailListError,
  getBookingGmailMaxFullFetchesPerConnection,
  getBookingGmailMaxFullFetchesPerRun,
  iterateBookingGmailMessagePages,
  runBookingGmailClaimLoop,
} from "@/lib/booking/booking-gmail-pagination"

/**
 * Lifecycle adresse (PLAN-BOOKING-ADDRESS-RELIABILITY-001-R1) :
 * - adresse présente → SUCCEEDED (pending ou Accommodation)
 * - utile sans adresse → persist/enrich pending + RETRYABLE_FAILURE / MISSING_ADDRESS
 *   (1 seule reprise auto ; 2ᵉ échec → PERMANENTLY_IGNORED / ADDRESS_NOT_FOUND_AFTER_RETRY)
 * - PendingAccommodation reste PENDING pour UI / fallback manuel
 * - échec technique (réseau/provider) ≠ absence d’adresse (politique distincte)
 */

export async function GET(req: Request) {
  const early = getBookingGmailScanEarlyResponse(req)
  if (early) return early

  const scanCutoff = getBookingScanCutoffDate()

  const connections = await prisma.gmailConnection.findMany()
  const stats = {
    scanned: 0,
    detected: 0,
    errors: 0,
    skipped: 0,
    retryable: 0,
    permanent: 0,
    missingAddress: 0,
    pagesFetched: 0,
    idsExamined: 0,
    fullFetches: 0,
  }
  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null
  const lifecycle = bookingGmailMessageLifecycle

  let globalFetchesRemaining = getBookingGmailMaxFullFetchesPerRun()

  for (const conn of connections) {
    // Codex : budget global épuisé → sortir de la boucle globale immédiatement.
    if (globalFetchesRemaining <= 0) {
      break
    }

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

      const connectionFetchesRemaining = getBookingGmailMaxFullFetchesPerConnection()
      // Codex : pas de pagination / claim si budget connexion déjà à 0.
      if (connectionFetchesRemaining <= 0) {
        continue
      }
      if (globalFetchesRemaining <= 0) {
        break
      }

      const processClaimedMessage = async (messageId: string) => {
        stats.scanned++
        try {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          )
          if (!msgRes.ok) {
            throw retryableBookingError("GMAIL_TEMPORARY", `Gmail get HTTP ${msgRes.status}`)
          }
          const msgData = await msgRes.json()
          const bodyText = extractNormalizedGmailBody(msgData.payload)
          const snippet = (msgData.snippet ?? "") as string

          if (!bodyText && !snippet) {
            await lifecycle.markPermanentIgnored(
              conn.companyId,
              messageId,
              permanentBookingError("EMPTY_MESSAGE_BODY", "Corps et snippet vides")
            )
            stats.permanent++
            console.log(`[gmail-scan] PERMANENTLY_IGNORED empty body messageId=${messageId}`)
            return
          }

          const fullText = bodyText || snippet
          const emailTextForExtract = truncateBookingEmailForExtract(fullText)
          const emailTextForPersist = truncateBookingEmailForPersist(fullText)
          const parsed = await extractBookingFields(
            emailTextForExtract,
            messageId,
            anthropic as import("@/lib/booking/extract-booking-fields").BookingAiClient | null
          )

          if (parsed.startDate) {
            const startDate = new Date(parsed.startDate as string)
            if (startDate < scanCutoff) {
              await lifecycle.markPermanentIgnored(
                conn.companyId,
                messageId,
                permanentBookingError("BEFORE_CUTOFF_DATE", "Avant le 17/06/2026")
              )
              stats.permanent++
              console.log(`[gmail-scan] PERMANENTLY_IGNORED cutoff messageId=${messageId}`)
              return
            }
          }

          if (!hasUsefulBookingData(parsed)) {
            await lifecycle.markPermanentIgnored(
              conn.companyId,
              messageId,
              permanentBookingError("NO_USEFUL_BOOKING_DATA", "Parsing sans donnée utile")
            )
            stats.permanent++
            console.log(`[gmail-scan] PERMANENTLY_IGNORED no useful data messageId=${messageId}`)
            return
          }

          const admin = await prisma.user.findFirst({
            where: { companyId: conn.companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
            select: { id: true },
          })

          let matchedTeamId: string | null = null
          if (parsed.teamName) {
            const team = await prisma.team.findFirst({
              where: {
                companyId: conn.companyId,
                active: true,
                name: { contains: parsed.teamName, mode: "insensitive" },
              },
              select: { id: true },
            })
            matchedTeamId = team?.id ?? null
          }

          if (!hasBookingAddress(parsed)) {
            await prisma.$transaction(async (tx) => {
              await createOrGetBookingScanResult(tx, {
                companyId: conn.companyId,
                messageId,
                snippet,
                emailBody: emailTextForPersist,
                parsed,
                matchedTeamId,
                adminId: admin?.id ?? null,
              })
            })
            const failed = await lifecycle.markFailure({
              companyId: conn.companyId,
              messageId,
              error: retryableBookingError(
                "MISSING_ADDRESS",
                "Adresse absente après extraction — rejeu limité"
              ),
            })
            if (failed.status === "RETRYABLE_FAILURE") {
              stats.retryable++
              stats.missingAddress++
              console.warn(
                `[gmail-scan] RETRYABLE_FAILURE MISSING_ADDRESS messageId=${messageId} nextRetryAt=${failed.nextRetryAt?.toISOString() ?? "n/a"}`
              )
            } else if (failed.status === "PERMANENTLY_IGNORED") {
              stats.permanent++
              stats.missingAddress++
              console.warn(
                `[gmail-scan] PERMANENTLY_IGNORED messageId=${messageId} code=${failed.errorCode}`
              )
            }
            return
          }

          await lifecycle.markSucceededInTransaction(
            { companyId: conn.companyId, messageId },
            async (tx) => {
              const result = await createOrGetBookingScanResult(tx, {
                companyId: conn.companyId,
                messageId,
                snippet,
                emailBody: emailTextForPersist,
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
          if (
            msgErr instanceof Error &&
            msgErr.message === BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED
          ) {
            const row = await prisma.processedGmailMessage.findUnique({
              where: {
                companyId_messageId: {
                  companyId: conn.companyId,
                  messageId,
                },
              },
            })
            if (row?.status === "SUCCEEDED") {
              stats.detected++
              return
            }
          }
          const failed = await lifecycle.markFailure({
            companyId: conn.companyId,
            messageId,
            error: msgErr,
          })
          if (failed.status === "SUCCEEDED") {
            stats.detected++
            return
          }
          if (failed.status === "RETRYABLE_FAILURE") {
            stats.retryable++
            console.warn(
              `[gmail-scan] RETRYABLE_FAILURE messageId=${messageId} code=${failed.errorCode} nextRetryAt=${failed.nextRetryAt?.toISOString() ?? "n/a"}`
            )
          } else if (failed.status === "PERMANENTLY_IGNORED") {
            stats.permanent++
            console.warn(
              `[gmail-scan] PERMANENTLY_IGNORED messageId=${messageId} code=${failed.errorCode}`
            )
          }
          stats.errors++
        }
      }

      try {
        const loopResult = await runBookingGmailClaimLoop({
          pages: iterateBookingGmailMessagePages({ accessToken }),
          budget: {
            connectionRemaining: connectionFetchesRemaining,
            globalRemaining: globalFetchesRemaining,
          },
          claim: async (messageId) => {
            const claim = await lifecycle.claimForProcessing(conn.companyId, messageId)
            return claim.action === "SKIP" ? "SKIP" : "CLAIMED"
          },
          onClaimed: processClaimedMessage,
        })

        stats.skipped += loopResult.skipped
        stats.pagesFetched += loopResult.pagesFetched
        stats.idsExamined += loopResult.idsExamined
        stats.fullFetches += loopResult.claimed
        globalFetchesRemaining = loopResult.budget.globalRemaining

        if (loopResult.stopReason === "budget" && globalFetchesRemaining <= 0) {
          break
        }
      } catch (listErr) {
        if (listErr instanceof BookingGmailListError) {
          stats.errors++
          console.error(
            `[gmail-scan] Gmail list ${listErr.kind}` +
              (listErr.httpStatus != null ? ` HTTP ${listErr.httpStatus}` : "") +
              ` for company ${conn.companyId}`
          )
          continue
        }
        throw listErr
      }
    } catch (connErr) {
      console.error(`[gmail-scan] Error for company ${conn.companyId}`)
      stats.errors++
    }
  }

  console.log(
    `[CRON gmail-scan] scanned=${stats.scanned} detected=${stats.detected} skipped=${stats.skipped} retryable=${stats.retryable} permanent=${stats.permanent} missingAddress=${stats.missingAddress} errors=${stats.errors} pagesFetched=${stats.pagesFetched} idsExamined=${stats.idsExamined} fullFetches=${stats.fullFetches}`
  )
  return NextResponse.json({ ok: true, ...stats })
}
