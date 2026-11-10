import { prisma } from "@/lib/prisma"
import { CATEGORY_LABEL, listSupplierInvoicesForExport } from "@/lib/accounting/c5/supplier-invoice.service"
import { csvFilename } from "@/lib/accounting/ui/csv"
import { csvResponse, requireAccountingRoute } from "@/lib/accounting/ui/route-guard"
import { buildSupplierExportCsv } from "@/lib/accounting/ui/supplier-export"

export const dynamic = "force-dynamic"

/** Export comptable (CSV) des factures fournisseurs : mêmes filtres que la liste, toutes pages confondues. */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireAccountingRoute()
  if (!guard.ok) return guard.response
  const sp = new URL(request.url).searchParams
  const st = sp.get("statut")
  const status = st === "PENDING" || st === "VALIDATED" || st === "REJECTED" ? st : undefined
  const { rows, truncated } = await listSupplierInvoicesForExport(prisma, guard.ctx, { search: sp.get("q") ?? undefined, status })
  const today = new Date().toISOString().slice(0, 10)
  const response = csvResponse(buildSupplierExportCsv(rows, CATEGORY_LABEL), csvFilename(`factures-fournisseurs-${today}${status ? `-${status.toLowerCase()}` : ""}`))
  if (truncated) response.headers.set("X-Export-Truncated", "true")
  return response
}
