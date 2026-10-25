// Job de relance des factures impayées (J+30 / J+45 / J+60 après échéance) — Bearer CRON_SECRET, désactivé par défaut.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isBillingCompleteEnabled, isBillingRemindersEnabled } from "@/lib/billing/billing-feature-flag"
import { runInvoiceReminders } from "@/lib/billing/invoices/invoice.service"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  if (!isBillingCompleteEnabled() || !isBillingRemindersEnabled()) return new NextResponse(null, { status: 404 })
  const denied = assertCronBearerAuth(req)
  if (denied) return denied
  try {
    const report = await runInvoiceReminders(prisma, new Date())
    return NextResponse.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[cron] relances factures en échec", error instanceof Error ? error.name : "erreur")
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
