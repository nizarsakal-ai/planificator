import { prisma } from "@/lib/prisma"
import { listFiscalYears } from "@/lib/accounting/engine/queries"
import { trialBalance } from "@/lib/accounting/engine/reads"
import { buildCsv, csvFilename } from "@/lib/accounting/ui/csv"
import { searchParam } from "@/lib/accounting/ui/labels"
import { csvResponse, requireAccountingRoute } from "@/lib/accounting/ui/route-guard"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const guard = await requireAccountingRoute()
  if (!guard.ok) return guard.response
  const requested = searchParam(new URL(request.url).searchParams.get("exercice") ?? undefined)
  const year = (await listFiscalYears(prisma, guard.ctx)).find((y) => y.id === requested)
  if (!year) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const rows = await trialBalance(prisma, guard.ctx, year.id)
  const csv = buildCsv(
    ["Compte", "Libellé", "Débit", "Crédit", "Solde débiteur", "Solde créditeur"],
    rows.map((r) => [
      { text: r.number }, { text: r.label }, { amount: r.debitCents }, { amount: r.creditCents },
      { amount: r.balanceCents > BigInt(0) ? r.balanceCents : BigInt(0) }, { amount: r.balanceCents < BigInt(0) ? -r.balanceCents : BigInt(0) },
    ]),
  )
  return csvResponse(csv, csvFilename(`balance-${year.startDate.toISOString().slice(0, 10)}-${year.endDate.toISOString().slice(0, 10)}`))
}
