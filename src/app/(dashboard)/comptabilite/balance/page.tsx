import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { listFiscalYears } from "@/lib/accounting/engine/queries"
import { trialBalance } from "@/lib/accounting/engine/reads"
import { formatEuros } from "@/lib/accounting/ui/forms"
import { fiscalYearLabel, pickFiscalYear, searchParam } from "@/lib/accounting/ui/labels"

export const metadata: Metadata = { title: "Balance — Comptabilité" }
type SP = Promise<Record<string, string | string[] | undefined>>

export default async function BalancePage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const years = await listFiscalYears(prisma, ctx)
  const year = pickFiscalYear(years, searchParam(sp.exercice))
  if (!year) return <Card><CardContent className="p-6 text-sm text-slate-500">Aucun exercice : ouvrez-en un depuis l&apos;onglet Exercices.</CardContent></Card>

  const rows = await trialBalance(prisma, ctx, year.id)
  const totalDebit = rows.reduce((s, r) => s + r.debitCents, BigInt(0))
  const totalCredit = rows.reduce((s, r) => s + r.creditCents, BigInt(0))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex items-end gap-2">
          <select name="exercice" defaultValue={year.id} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Exercice">
            {years.map((y) => <option key={y.id} value={y.id}>{fiscalYearLabel(y)}</option>)}
          </select>
          <Button type="submit" variant="outline">Afficher</Button>
        </form>
        <Button asChild variant="outline"><a href={`/comptabilite/balance/export?exercice=${encodeURIComponent(year.id)}`}>Exporter en CSV</a></Button>
      </div>
      <p className="text-xs text-slate-500">Écritures validées uniquement.</p>
      <Card><CardContent className="p-0">
        {rows.length === 0 ? <p className="p-6 text-sm text-slate-500">Aucune écriture validée sur cet exercice.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">Compte</th><th className="p-3">Libellé</th><th className="p-3 text-right">Débit</th><th className="p-3 text-right">Crédit</th><th className="p-3 text-right">Solde débiteur</th><th className="p-3 text-right">Solde créditeur</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.accountId} className="border-t border-slate-100">
                <td className="p-3 font-mono"><Link className="hover:underline" href={`/comptabilite/grand-livre?exercice=${encodeURIComponent(year.id)}&compte=${encodeURIComponent(r.accountId)}`}>{r.number}</Link></td>
                <td className="p-3">{r.label}</td>
                <td className="p-3 text-right tabular-nums">{formatEuros(r.debitCents)}</td>
                <td className="p-3 text-right tabular-nums">{formatEuros(r.creditCents)}</td>
                <td className="p-3 text-right tabular-nums">{r.balanceCents > BigInt(0) ? formatEuros(r.balanceCents) : ""}</td>
                <td className="p-3 text-right tabular-nums">{r.balanceCents < BigInt(0) ? formatEuros(-r.balanceCents) : ""}</td>
              </tr>))}
            </tbody>
            <tfoot className="border-t border-slate-200 font-medium"><tr>
              <td className="p-3" colSpan={2}>Totaux {totalDebit === totalCredit ? "" : <span className="text-red-700">(déséquilibre)</span>}</td>
              <td className="p-3 text-right tabular-nums">{formatEuros(totalDebit)}</td><td className="p-3 text-right tabular-nums">{formatEuros(totalCredit)}</td><td colSpan={2} />
            </tr></tfoot>
          </table>)}
      </CardContent></Card>
    </div>
  )
}
