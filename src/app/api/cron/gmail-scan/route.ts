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
  regexFallbackParser,
} from "@/lib/booking/extract-booking-fields"
import { extractNormalizedGmailBodyWithMetadata } from "@/lib/booking/booking-gmail-body.service"
import { extractGmailSubject } from "@/lib/booking/booking-email-intent"
import {
  extractGmailFromHeader,
  maybeLogAmbiguousIntentDiagnostic,
} from "@/lib/booking/booking-email-intent-diagnostics"
import { applyBookingEmailIntentGate } from "@/lib/booking/booking-email-intent-gate"
import {
  truncateBookingEmailForExtract,
  truncateBookingEmailForPersist,
} from "@/lib/booking/booking-pending-merge"
import { getBookingGmailScanEarlyResponse } from "@/lib/booking/booking-gmail-scan-gate"
import { getBookingScanCutoffDate } from "@/lib/booking/booking-scan-cutoff"
import { evaluatePendingCreationGate } from "@/lib/booking/booking-scan-pending-gate"
import {
  BookingGmailListError,
  formatBookingGmailListErrorLog,
  getBookingGmailMaxFullFetchesPerConnection,
  getBookingGmailMaxFullFetchesPerRun,
  iterateBookingGmailMessagePages,
  runBookingGmailClaimLoop,
} from "@/lib/booking/booking-gmail-pagination"

/**
 * Critères avant Pending / Acc (PLAN-BOOKING-FILTER-001) :
 * - PARSER-003 : intent CONFIRMATION uniquement avant extract/Anthropic
 * - confirmationCount = emails classifiés CONFIRMATION (pas pendings créés)
 * - ACCEPT : dates calendaires valides, adresse, plage, start >= cutoff
 * - PERMANENT_IGNORE : BEFORE_CUTOFF ou intent hors confirmation prouvé
 * - AMBIGU : retry borné (BOOKING_EMAIL_INTENT_AMBIGUOUS) puis permanent
 * - RETRYABLE_REJECT : champs manquants/invalides → markFailure, pas de Pending/Acc
 * - l’équipe n’est pas un critère (choix manuel à la confirmation)
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
    confirmationCount: 0,
    hostMessageIgnoredCount: 0,
    receiptIgnoredCount: 0,
    cancellationIgnoredCount: 0,
    otherIgnoredCount: 0,
    ambiguousCount: 0,
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
          // Observabilité OAuth uniquement — pas de tokens / secrets dans les logs.
          const oauthError =
            typeof refreshData.error === "string" ? refreshData.error : undefined
          const oauthDescription =
            typeof refreshData.error_description === "string"
              ? refreshData.error_description
              : undefined
          console.error(
            [
              "[gmail-scan] Token refresh failed",
              `company=${conn.companyId}`,
              `status=${refreshRes.status}`,
              ...(oauthError ? [`error=${oauthError}`] : []),
              ...(oauthDescription ? [`description=${oauthDescription}`] : []),
            ].join("\n")
          )
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
          const normalizedBody = extractNormalizedGmailBodyWithMetadata(msgData.payload)
          const bodyText = normalizedBody.text
          const subject = extractGmailSubject(msgData.payload)
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
          const intentGate = await applyBookingEmailIntentGate({
            companyId: conn.companyId,
            messageId,
            subject,
            bodyText: fullText,
            stats,
            markPermanentIgnored: (companyId, msgId, error) =>
              lifecycle.markPermanentIgnored(companyId, msgId, error),
            markFailure: (args) => lifecycle.markFailure(args),
          })

          // PLAN-BOOKING-INTENT-DIAG-001 — logs AMBIGU uniquement si flag ON
          maybeLogAmbiguousIntentDiagnostic({
            messageId,
            companyId: conn.companyId,
            fromHeaderValue: extractGmailFromHeader(msgData.payload),
            subject,
            classification: intentGate.classification,
          })

          if (intentGate.action === "STOP") {
            if (intentGate.telemetryKind === "retryable_failure") {
              stats.retryable++
              console.warn(
                `[gmail-scan] RETRYABLE_FAILURE intent=${intentGate.classification.intent} confidence=${intentGate.classification.confidence} code=${intentGate.code} messageId=${messageId} company=${conn.companyId} evidence=${intentGate.classification.evidence.join(",")} nextRetryAt=${intentGate.lifecycle.nextRetryAt?.toISOString() ?? "n/a"}`
              )
            } else if (intentGate.telemetryKind === "permanent_ignored") {
              stats.permanent++
              console.log(
                `[gmail-scan] PERMANENTLY_IGNORED intent=${intentGate.classification.intent} confidence=${intentGate.classification.confidence} code=${intentGate.lifecycle.errorCode ?? intentGate.code} messageId=${messageId} company=${conn.companyId} evidence=${intentGate.classification.evidence.join(",")}`
              )
            } else if (intentGate.telemetryKind === "lifecycle_race_succeeded") {
              // Course : markFailure/markPermanentIgnored n’a pas écrasé SUCCEEDED
              stats.detected++
              console.warn(
                `[gmail-scan] LIFECYCLE_RACE_SUCCEEDED intent=${intentGate.classification.intent} code=${intentGate.code} messageId=${messageId} company=${conn.companyId} — aucun compteur permanent`
              )
            } else {
              stats.errors++
              console.warn(
                `[gmail-scan] LIFECYCLE_UNEXPECTED status=${intentGate.lifecycleStatus} intent=${intentGate.classification.intent} code=${intentGate.code} messageId=${messageId} company=${conn.companyId}`
              )
            }
            return
          }

          const emailTextForExtract = truncateBookingEmailForExtract(fullText)
          const emailTextForPersist = truncateBookingEmailForPersist(fullText)
          const markerOffsets = (text: string) => {
            const offset = (pattern: RegExp) => pattern.exec(text)?.index ?? -1
            return {
              Arrivee: offset(/\bArriv[ée]e\b/i),
              Depart: offset(/\bD[ée]part\b/i),
              "Check-in": offset(/\bCheck[\s-]?in\b/i),
              "Check-out": offset(/\bCheck[\s-]?out\b/i),
            }
          }
          const extractDiagnosticContext: import("@/lib/booking/extract-booking-fields").BookingExtractDiagnosticContext =
            {
              companyId: conn.companyId,
              normalizedTextLength: fullText.length,
              sourceMime: bodyText
                ? normalizedBody.sourceMime
                : ("snippet" as const),
              normalizedMarkerOffsets: markerOffsets(fullText),
              analyzedMarkerOffsets: markerOffsets(emailTextForExtract),
              truncatedTextLength: emailTextForExtract.length,
              wasTruncated: emailTextForExtract.length < fullText.length,
            }
          const parsed = await extractBookingFields(
            emailTextForExtract,
            messageId,
            anthropic as import("@/lib/booking/extract-booking-fields").BookingAiClient | null,
            extractDiagnosticContext
          )

          const gate = evaluatePendingCreationGate(parsed, scanCutoff)
          if (gate.decision === "RETRYABLE_REJECT" && gate.code === "MISSING_START_DATE") {
            // Regex diag seulement ici si non déjà remplie par un rejet IA.
            if (
              extractDiagnosticContext.lastFallbackStartDatePresent ===
                undefined ||
              extractDiagnosticContext.lastFallbackEndDatePresent === undefined
            ) {
              const regexDiag = regexFallbackParser(emailTextForExtract)
              extractDiagnosticContext.lastFallbackStartDatePresent = Boolean(
                regexDiag.startDate
              )
              extractDiagnosticContext.lastFallbackEndDatePresent = Boolean(
                regexDiag.endDate
              )
            }
            console.warn("[booking-extract-diagnostic]", {
              event: "missing_start_date",
              messageId,
              companyId: extractDiagnosticContext.companyId,
              normalizedTextLength: extractDiagnosticContext.normalizedTextLength,
              sourceMime: extractDiagnosticContext.sourceMime,
              normalizedMarkerPresent: Object.fromEntries(
                Object.entries(
                  extractDiagnosticContext.normalizedMarkerOffsets
                ).map(([key, offset]) => [key, offset >= 0])
              ),
              normalizedMarkerOffsets:
                extractDiagnosticContext.normalizedMarkerOffsets,
              analyzedMarkerPresent: Object.fromEntries(
                Object.entries(
                  extractDiagnosticContext.analyzedMarkerOffsets
                ).map(([key, offset]) => [key, offset >= 0])
              ),
              analyzedMarkerOffsets:
                extractDiagnosticContext.analyzedMarkerOffsets,
              truncatedTextLength: extractDiagnosticContext.truncatedTextLength,
              wasTruncated: extractDiagnosticContext.wasTruncated,
              parserStartDatePresent: Boolean(parsed.startDate),
              parserEndDatePresent: Boolean(parsed.endDate),
              aiRejectionReason:
                extractDiagnosticContext.lastAiRejectionReason ?? null,
              validationField:
                extractDiagnosticContext.lastAiValidationField ?? null,
              aiStartDatePresent:
                extractDiagnosticContext.lastAiStartDatePresent ?? null,
              fallbackStartDatePresent:
                extractDiagnosticContext.lastFallbackStartDatePresent ?? false,
              fallbackEndDatePresent:
                extractDiagnosticContext.lastFallbackEndDatePresent ?? false,
            })
          }
          if (gate.decision === "PERMANENT_IGNORE") {
            await lifecycle.markPermanentIgnored(
              conn.companyId,
              messageId,
              permanentBookingError(gate.code, gate.message)
            )
            stats.permanent++
            console.log(
              `[gmail-scan] PERMANENTLY_IGNORED ${gate.code} messageId=${messageId}`
            )
            return
          }
          if (gate.decision === "RETRYABLE_REJECT") {
            const failed = await lifecycle.markFailure({
              companyId: conn.companyId,
              messageId,
              error: retryableBookingError(gate.code, gate.message),
            })
            if (gate.code === "MISSING_ADDRESS") {
              stats.missingAddress++
            }
            if (failed.status === "RETRYABLE_FAILURE") {
              stats.retryable++
              console.warn(
                `[gmail-scan] RETRYABLE_FAILURE ${gate.code} messageId=${messageId} nextRetryAt=${failed.nextRetryAt?.toISOString() ?? "n/a"}`
              )
            } else if (failed.status === "PERMANENTLY_IGNORED") {
              stats.permanent++
              console.warn(
                `[gmail-scan] PERMANENTLY_IGNORED messageId=${messageId} code=${failed.errorCode}`
              )
            }
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
          // Observabilité Gmail list : champs Google sûrs uniquement (pas de secrets).
          console.error(formatBookingGmailListErrorLog(listErr, conn.companyId))
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
    `[CRON gmail-scan] scanned=${stats.scanned} detected=${stats.detected} skipped=${stats.skipped} retryable=${stats.retryable} permanent=${stats.permanent} missingAddress=${stats.missingAddress} errors=${stats.errors} pagesFetched=${stats.pagesFetched} idsExamined=${stats.idsExamined} fullFetches=${stats.fullFetches} confirmation=${stats.confirmationCount} hostMsg=${stats.hostMessageIgnoredCount} receipt=${stats.receiptIgnoredCount} cancel=${stats.cancellationIgnoredCount} other=${stats.otherIgnoredCount} ambiguous=${stats.ambiguousCount}`
  )
  return NextResponse.json({ ok: true, ...stats })
}
