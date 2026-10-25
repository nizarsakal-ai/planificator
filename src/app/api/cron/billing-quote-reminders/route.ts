// Job de relance des devis (J+3 / J+7 / J+15) et d'expiration — Bearer CRON_SECRET, désactivé par défaut.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isBillingCompleteEnabled, isBillingRemindersEnabled } from "@/lib/billing/billing-feature-flag"
import { runQuoteReminders } from "@/lib/billing/quotes/quote.service"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  if (!isBillingCompleteEnabled() || !isBillingRemindersEnabled()) return new NextResponse(null, { status: 404 })
  const denied = assertCronBearerAuth(req)
  if (denied) return denied
  try {
    const report = await runQuoteReminders(prisma, new Date())
    return NextResponse.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[cron] relances devis en échec", error instanceof Error ? error.name : "erreur")
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
