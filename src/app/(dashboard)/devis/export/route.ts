import { prisma } from "@/lib/prisma"
import { requireBillingRoute } from "@/lib/billing/access"
import { exportQuotesCsv } from "@/lib/billing/quotes/quote.service"
import { csvResponse } from "@/lib/accounting/ui/route-guard"
import { filtersFromParams } from "@/lib/billing/quotes/quote-filters"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const access = await requireBillingRoute()
  if (!access.ok) return access.response
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries())
  const f = filtersFromParams(sp)
  const csv = await exportQuotesCsv(prisma, access.ctx.companyId, f)
  return csvResponse(csv, `devis-${new Date().toISOString().slice(0, 10)}`)
}
