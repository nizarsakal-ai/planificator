import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { searchParam } from "@/lib/accounting/ui/labels"
import { isCalendarDay } from "@/lib/accounting/ui/forms"
import { computeVat } from "@/lib/accounting/c5/vat"
import { listVatDeclarations } from "@/lib/accounting/c5/vat-declaration"
import { getBillingSettingsFor } from "@/lib/billing/settings"
import { bpToPercentString, formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { DeclareVatButton } from "@/components/comptabilite/C5Actions"

export const metadata: Metadata = { title: "Comptabilité — TVA" }

export default async function TvaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const settings = await getBillingSettingsFor(prisma, ctx)
  const now = new Date()
  const defStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), defEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const du = searchParam(sp.du), au = searchParam(sp.au), base = searchParam(sp.base)
  const periodStart = du && isCalendarDay(du) ? new Date(`${du}T00:00:00.000Z`) : defStart
  const periodEnd = au && isCalendarDay(au) ? new Date(`${au}T00:00:00.000Z`) : defEnd
  const basis = base === "ENCAISSEMENTS" || base === "DEBITS" ? base : settings.vatRegime
  const [v, declarations] = await Promise.all([computeVat(prisma, ctx, periodStart, periodEnd, basis), listVatDeclarations(prisma, ctx)])
  return (
    <div className="space-y-4">
      <Card><CardContent className="p-4">
        <form method="get" className="grid gap-2 sm:grid-cols-4">
          <Input name="du" type="date" defaultValue={periodStart.toISOString().slice(0, 10)} aria-label="Début" /><Input name="au" type="date" defaultValue={periodEnd.toISOString().slice(0, 10)} aria-label="Fin" />
          <select name="base" defaultValue={basis} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Base"><option value="DEBITS">TVA sur les débits</option><option value="ENCAISSEMENTS">TVA sur les encaissements</option></select>
          <Button type="submit" variant="secondary">Calculer</Button>
        </form>
      </CardContent></Card>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">TVA collectée</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(v.collectedCents)}</p><p className="text-xs text-slate-500">{basis === "DEBITS" ? `${v.documents} pièce(s) émise(s)` : `${v.payments} paiement(s)`}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">TVA déductible</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(v.deductibleCents)}</p><p className="text-xs text-slate-500">{v.supplierInvoices} facture(s) fournisseur validée(s)</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">{v.dueCents >= BigInt(0) ? "TVA à payer" : "Crédit de TVA"}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{formatEuro(v.dueCents < BigInt(0) ? -v.dueCents : v.dueCents)}</p></CardContent></Card>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Taux</th><th className="px-3 py-2 text-right">Base HT</th><th className="px-3 py-2 text-right">TVA collectée</th></tr></thead>
          <tbody>{v.collected.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Aucune opération sur la période.</td></tr>}{v.collected.map((r) => <tr key={r.vatRateBp} className="border-t"><td className="px-3 py-2">{bpToPercentString(r.vatRateBp)} %</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.baseCents)}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(r.vatCents)}</td></tr>)}</tbody></table>
        <div className="flex justify-end border-t p-3"><DeclareVatButton periodStart={periodStart.toISOString().slice(0, 10)} periodEnd={periodEnd.toISOString().slice(0, 10)} basis={basis} /></div>
      </CardContent></Card>
      <Card><CardContent className="p-4 text-sm"><p className="mb-2 font-medium text-slate-700">Déclarations enregistrées</p>
        {declarations.length === 0 ? <p className="text-slate-400">Aucune déclaration.</p> : <table className="w-full"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Période</th><th className="py-1">Base</th><th className="py-1 text-right">Collectée</th><th className="py-1 text-right">Déductible</th><th className="py-1 text-right">Due</th></tr></thead><tbody>{declarations.map((d) => <tr key={d.id} className="border-t"><td className="py-1">{dateFr.format(d.periodStart)} → {dateFr.format(d.periodEnd)}</td><td className="py-1">{d.basis === "DEBITS" ? "débits" : "encaissements"}</td><td className="py-1 text-right tabular-nums">{formatEuro(d.collectedCents)}</td><td className="py-1 text-right tabular-nums">{formatEuro(d.deductibleCents)}</td><td className="py-1 text-right tabular-nums">{formatEuro(d.dueCents)}</td></tr>)}</tbody></table>}
      </CardContent></Card>
    </div>
  )
}
