import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { listAccounts, listFiscalYears } from "@/lib/accounting/engine/queries"
import { generalLedger } from "@/lib/accounting/engine/reads"
import { formatEuros } from "@/lib/accounting/ui/forms"
import { fiscalYearLabel, pickFiscalYear, searchParam } from "@/lib/accounting/ui/labels"

export const metadata: Metadata = { title: "Grand livre — Comptabilité" }
type SP = Promise<Record<string, string | string[] | undefined>>
const selectClass = "h-10 rounded-md border border-input bg-background px-3 text-sm"

export default async function GrandLivrePage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const [years, accounts] = await Promise.all([listFiscalYears(prisma, ctx), listAccounts(prisma, ctx)])
  const year = pickFiscalYear(years, searchParam(sp.exercice))
  if (!year) return <Card><CardContent className="p-6 text-sm text-slate-500">Aucun exercice : ouvrez-en un depuis l&apos;onglet Exercices.</CardContent></Card>
  const requestedAccount = searchParam(sp.compte)
  const account = accounts.find((a) => a.id === requestedAccount)
  const rows = account ? await generalLedger(prisma, ctx, year.id, account.id) : []

  let running = BigInt(0)
  const withBalance = rows.map((r) => { running += r.debitCents - r.creditCents; return { ...r, running } })
  const totalDebit = rows.reduce((s, r) => s + r.debitCents, BigInt(0))
  const totalCredit = rows.reduce((s, r) => s + r.creditCents, BigInt(0))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <select name="exercice" defaultValue={year.id} className={selectClass} aria-label="Exercice">
            {years.map((y) => <option key={y.id} value={y.id}>{fiscalYearLabel(y)}</option>)}
          </select>
          <select name="compte" defaultValue={account?.id ?? ""} className={selectClass} aria-label="Compte" required>
            <option value="" disabled>Choisir un compte</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.number} — {a.label}</option>)}
          </select>
          <Button type="submit" variant="outline">Afficher</Button>
        </form>
        {account && <Button asChild variant="outline"><a href={`/comptabilite/grand-livre/export?exercice=${encodeURIComponent(year.id)}&compte=${encodeURIComponent(account.id)}`}>Exporter en CSV</a></Button>}
      </div>
      <p className="text-xs text-slate-500">Écritures validées uniquement.</p>
      <Card><CardContent className="p-0">
        {!account ? <p className="p-6 text-sm text-slate-500">Choisissez un compte.</p> : rows.length === 0 ? <p className="p-6 text-sm text-slate-500">Aucun mouvement validé sur ce compte pour cet exercice.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">Date</th><th className="p-3">N°</th><th className="p-3">Libellé</th><th className="p-3 text-right">Débit</th><th className="p-3 text-right">Crédit</th><th className="p-3 text-right">Solde</th></tr></thead>
            <tbody>{withBalance.map((r, i) => (
              <tr key={`${r.entryId}-${i}`} className="border-t border-slate-100">
                <td className="p-3 whitespace-nowrap">{dateFr.format(r.entryDate)}</td>
                <td className="p-3 tabular-nums"><Link className="hover:underline" href={`/comptabilite/ecritures/${r.entryId}`}>{r.number}</Link></td>
                <td className="p-3">{r.label}</td>
                <td className="p-3 text-right tabular-nums">{r.debitCents > BigInt(0) ? formatEuros(r.debitCents) : ""}</td>
                <td className="p-3 text-right tabular-nums">{r.creditCents > BigInt(0) ? formatEuros(r.creditCents) : ""}</td>
                <td className="p-3 text-right tabular-nums">{formatEuros(r.running)}</td>
              </tr>))}
            </tbody>
            <tfoot className="border-t border-slate-200 font-medium"><tr><td className="p-3" colSpan={3}>Totaux</td><td className="p-3 text-right tabular-nums">{formatEuros(totalDebit)}</td><td className="p-3 text-right tabular-nums">{formatEuros(totalCredit)}</td><td className="p-3 text-right tabular-nums">{formatEuros(totalDebit - totalCredit)}</td></tr></tfoot>
          </table>)}
      </CardContent></Card>
    </div>
  )
}
