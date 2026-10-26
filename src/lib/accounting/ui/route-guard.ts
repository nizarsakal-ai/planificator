// Garde des Route Handlers Comptabilité (exports CSV). Mêmes règles que les pages, réponses HTTP au lieu de redirections.
import { NextResponse } from "next/server"
import { resolveAccountingAccessForRequest } from "@/lib/accounting/access/accounting-access"
import { accountingDenialDisposition } from "@/lib/accounting/access/accounting-access.core"
import type { AccountingContext } from "@/lib/accounting/engine/posting"

export async function requireAccountingRoute(): Promise<{ ok: true; ctx: AccountingContext } | { ok: false; response: NextResponse }> {
  const access = await resolveAccountingAccessForRequest()
  if (access.ok) return { ok: true, ctx: { companyId: access.context.companyId, userId: access.context.userId } }
  const disposition = accountingDenialDisposition(access.reason)
  const status = disposition === "login" ? 401 : disposition === "not-found" ? 404 : 403
  return { ok: false, response: new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } }) }
}

export function csvResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
