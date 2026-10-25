import { prisma } from "@/lib/prisma"
import { listAccounts, listFiscalYears } from "@/lib/accounting/engine/queries"
import { generalLedger } from "@/lib/accounting/engine/reads"
import { buildCsv, csvFilename } from "@/lib/accounting/ui/csv"
import { searchParam } from "@/lib/accounting/ui/labels"
import { csvResponse, requireAccountingRoute } from "@/lib/accounting/ui/route-guard"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const guard = await requireAccountingRoute()
  if (!guard.ok) return guard.response
  const params = new URL(request.url).searchParams
  const yearId = searchParam(params.get("exercice") ?? undefined)
  const accountId = searchParam(params.get("compte") ?? undefined)
  const [years, accounts] = await Promise.all([listFiscalYears(prisma, guard.ctx), listAccounts(prisma, guard.ctx)])
  const year = years.find((y) => y.id === yearId)
  const account = accounts.find((a) => a.id === accountId)
  if (!year || !account) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const rows = await generalLedger(prisma, guard.ctx, year.id, account.id)
  let running = BigInt(0)
  const csv = buildCsv(
    ["Date", "N° écriture", "Libellé", "Débit", "Crédit", "Solde"],
    rows.map((r) => {
      running += r.debitCents - r.creditCents
      return [{ raw: r.entryDate.toISOString().slice(0, 10) }, { raw: String(r.number) }, { text: r.label }, { amount: r.debitCents }, { amount: r.creditCents }, { amount: running }]
    }),
  )
  return csvResponse(csv, csvFilename(`grand-livre-${account.number}-${year.startDate.toISOString().slice(0, 10)}`))
}
