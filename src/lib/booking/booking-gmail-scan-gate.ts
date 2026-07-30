import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isBookingGmailScanEnabled } from "@/lib/booking/booking-gmail-scan-flag"

/**
 * Gate d'entrée gmail-scan : auth Bearer puis kill-switch.
 * @returns réponse early-exit (401 / 200 skipped) ou `null` pour poursuivre le scan.
 */
export function getBookingGmailScanEarlyResponse(req: Request): NextResponse | null {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  if (!isBookingGmailScanEnabled()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "DISABLED",
    })
  }

  return null
}
