import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { accountingDashboard } from "@/lib/accounting/c5/dashboard"
import { getBillingSettingsFor } from "@/lib/billing/settings"
import { formatEuro } from "@/lib/billing/money"
import { CATEGORY_LABEL } from "@/lib/accounting/c5/supplier-invoice.service"
import { Card, CardContent } from "@/components/ui/card"
import { RevenueChart } from "@/components/comptabilite/RevenueChart"

export const metadata: Metadata = { title: "Comptabilité — Tableau de bord" }

export default async function TableauDeBordPage() {
  const ctx = await requireAccountingPage()
  const settings = await getBillingSettingsFor(prisma, ctx)
  const d = await accountingDashboard(prisma, ctx, new Date(), settings.vatRegime)
  const maxCat = d.supplierByCategory.reduce((m, c) => (c.htCents > m ? c.htCents : m), BigInt(0))
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">CA HT du mois</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(d.revenueMonthHTCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">CA HT de l&apos;année</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(d.revenueYearHTCents)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Factures impayées</p><p className="mt-1 text-2xl font-semibold tabular-nums text-blue-700">{formatEuro(d.unpaid.remainingCents)}</p><p className="text-xs text-slate-500">{d.unpaid.count} facture{d.unpaid.count > 1 ? "s" : ""} · {d.unpaid.overdueCount} en retard</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">TVA à déclarer ({d.vat.basis === "DEBITS" ? "débits" : "encaissements"}, {dateFr.format(d.vat.periodStart)} → {dateFr.format(d.vat.periodEnd)})</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(d.vat.dueCents)}</p><p className="text-xs text-slate-500">collectée {formatEuro(d.vat.collectedCents)} · déductible {formatEuro(d.vat.deductibleCents)}</p></CardContent></Card>
      </div>
      <Card><CardContent className="p-4"><p className="mb-2 text-sm font-medium text-slate-700">Chiffre d&apos;affaires HT — 12 derniers mois</p><RevenueChart data={d.revenue12Months.map((r) => ({ period: r.period, amount: Number(r.htCents) / 100 }))} /></CardContent></Card>
      <Card><CardContent className="p-4"><p className="mb-2 text-sm font-medium text-slate-700">Charges fournisseurs validées par catégorie (année)</p>
        {d.supplierByCategory.length === 0 ? <p className="text-sm text-slate-400">Aucune facture fournisseur validée cette année.</p> : (
          <ul className="space-y-2 text-sm">{d.supplierByCategory.map((c) => (
            <li key={c.category}><div className="flex justify-between"><span>{CATEGORY_LABEL[c.category] ?? c.category} <span className="text-slate-400">({c.count})</span></span><span className="tabular-nums">{formatEuro(c.htCents)}</span></div><div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-[#0f3460]" style={{ width: `${maxCat > BigInt(0) ? Number((c.htCents * BigInt(100)) / maxCat) : 0}%` }} /></div></li>
          ))}</ul>
        )}
      </CardContent></Card>
      <p className="text-xs text-slate-400">Toutes les données sont celles de votre société uniquement.</p>
    </div>
  )
}
