// Lot C Planificator V2 : marges par chantier (prévu, engagé, réel, facturé). Drapeau WORKSITE_BUDGET_ENABLED +
// ADMIN/SUPER_ADMIN. Lecture seule ; le détail et les révisions sont sur la page du chantier.
import Link from "next/link"
import { Download, PiggyBank } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { budgetPageAccess } from "@/lib/budget/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listWorksiteMargins, MAX_WORKSITES } from "@/lib/budget/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { StockFlash } from "@/components/stock/StockFlash"
import { fmtBp, formatEuro, signedClass } from "@/components/budget/format"

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await budgetPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (même règle que les lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const includeArchived = params.archives === "1"
  const { rows, truncated } = await listWorksiteMargins(prisma, ctx.companyId, { includeArchived })
  const withBudget = rows.filter((r) => r.hasBudget).length
  const total = rows.reduce((t, r) => ({ invoiced: t.invoiced + r.invoicedHTCents, actual: t.actual + r.actualCents, committed: t.committed + r.committedCents }), { invoiced: BigInt(0), actual: BigInt(0), committed: BigInt(0) })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><PiggyBank className="h-6 w-6 text-[#0f3460]" /> Budgets et marges</h1>
          <p className="mt-1 text-sm text-slate-500">{rows.length} chantier{rows.length > 1 ? "s" : ""} · {withBudget} avec budget · montants HT</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href={includeArchived ? "/budgets" : "/budgets?archives=1"}>{includeArchived ? "Masquer les archivés" : "Inclure les archivés"}</Link></Button>
          <Button variant="outline" asChild><a href={`/budgets/export${includeArchived ? "?archives=1" : ""}`}><Download className="h-4 w-4" /> Export CSV</a></Button>
        </div>
      </div>
      <StockFlash params={params} />
      {truncated && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">Affichage, totaux et export limités aux {MAX_WORKSITES} premiers chantiers (ordre alphabétique) : chiffres partiels.</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Facturé</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatEuro(total.invoiced)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Coûts réels</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatEuro(total.actual)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Engagé non consommé</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatEuro(total.committed)}</p></CardContent></Card>
      </div>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Chantier</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Recette prévue</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Coût prévu</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Engagé</th>
              <th className="px-3 py-2 text-right">Réel</th>
              <th className="px-3 py-2 text-right">Facturé</th>
              <th className="px-3 py-2 text-right">Marge à date</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Marge estimée</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Aucun chantier.</td></tr>}
            {rows.map((r) => (
              <tr key={r.worksiteId} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2">
                  <Link href={`/budgets/${r.worksiteId}`} className="font-medium text-[#0f3460] hover:underline">{r.name}</Link>
                  <div className="text-xs text-slate-500">{r.clientName}{r.archived ? " · archivé" : ""}{r.hasBudget ? ` · budget v${r.budgetRevision}` : " · sans budget"}{r.anomalies.length > 0 ? ` · ${r.anomalies.length} point(s) à vérifier` : ""}{r.anomalies.some((a) => a.code === "EQUIPMENT_COST_MISSING") ? " · marge incomplète (coût matériel manquant)" : ""}</div>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{r.hasBudget ? formatEuro(r.plannedRevenueCents) : "—"}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{r.hasBudget ? formatEuro(r.plannedCostCents) : "—"}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">{formatEuro(r.committedCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.actualCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.invoicedHTCents)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${signedClass(r.currentMarginCents)}`}>{formatEuro(r.currentMarginCents)}<div className="text-xs text-slate-500">{fmtBp(r.currentMarginBp)}</div></td>
                <td className={`hidden px-3 py-2 text-right tabular-nums lg:table-cell ${signedClass(r.forecastMarginCents)}`}>{formatEuro(r.forecastMarginCents)}<div className="text-xs text-slate-500">{fmtBp(r.forecastMarginBp)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      <p className="text-xs text-slate-500">Marge à date = facturé − coûts réels. Marge estimée = max(recette prévue, devis signés) − somme, par nature, du plus grand de « prévu » et « réel + engagé ». La main-d&apos;œuvre n&apos;a pas de coût réel calculé (budget seulement).</p>
    </div>
  )
}
