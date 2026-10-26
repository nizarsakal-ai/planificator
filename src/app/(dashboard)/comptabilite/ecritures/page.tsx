import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { listEntries, listFiscalYears, listJournals } from "@/lib/accounting/engine/queries"
import { formatEuros } from "@/lib/accounting/ui/forms"
import { ENTRY_STATUS, fiscalYearLabel, searchParam } from "@/lib/accounting/ui/labels"

export const metadata: Metadata = { title: "Écritures — Comptabilité" }
type SP = Promise<Record<string, string | string[] | undefined>>
const selectClass = "h-10 rounded-md border border-input bg-background px-3 text-sm"

export default async function EcrituresPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const fiscalYearId = searchParam(sp.exercice)
  const journalId = searchParam(sp.journal)
  const statusParam = searchParam(sp.statut)
  const status = statusParam === "DRAFT" || statusParam === "VALIDATED" ? statusParam : undefined
  const page = Number.parseInt(searchParam(sp.page) ?? "1", 10) || 1

  const [years, journals, result] = await Promise.all([
    listFiscalYears(prisma, ctx),
    listJournals(prisma, ctx),
    listEntries(prisma, ctx, { fiscalYearId, journalId, status, page }),
  ])
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize))
  const qs = (p: number) => {
    const q = new URLSearchParams()
    if (fiscalYearId) q.set("exercice", fiscalYearId)
    if (journalId) q.set("journal", journalId)
    if (status) q.set("statut", status)
    q.set("page", String(p))
    return `/comptabilite/ecritures?${q.toString()}`
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <select name="exercice" defaultValue={fiscalYearId ?? ""} className={selectClass} aria-label="Exercice">
            <option value="">Tous les exercices</option>
            {years.map((y) => <option key={y.id} value={y.id}>{fiscalYearLabel(y)}</option>)}
          </select>
          <select name="journal" defaultValue={journalId ?? ""} className={selectClass} aria-label="Journal">
            <option value="">Tous les journaux</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.code} — {j.label}</option>)}
          </select>
          <select name="statut" defaultValue={status ?? ""} className={selectClass} aria-label="Statut">
            <option value="">Tous les statuts</option>
            <option value="DRAFT">Brouillons</option>
            <option value="VALIDATED">Validées</option>
          </select>
          <Button type="submit" variant="outline">Filtrer</Button>
        </form>
        <Button asChild><Link href="/comptabilite/ecritures/nouvelle">Nouvelle écriture</Link></Button>
      </div>

      <Card><CardContent className="p-0">
        {result.rows.length === 0 ? <p className="p-6 text-sm text-slate-500">Aucune écriture.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600"><tr>
              <th className="p-3">Date</th><th className="p-3">Journal</th><th className="p-3">N°</th><th className="p-3">Libellé</th>
              <th className="p-3">Pièce</th><th className="p-3">Statut</th><th className="p-3 text-right">Montant</th>
            </tr></thead>
            <tbody>{result.rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-3 whitespace-nowrap">{dateFr.format(r.entryDate)}</td>
                <td className="p-3 font-mono">{r.journalCode}</td>
                <td className="p-3 tabular-nums">{r.number ?? "—"}</td>
                <td className="p-3"><Link className="hover:underline" href={`/comptabilite/ecritures/${r.id}`}>{r.label}</Link>{r.isReversal && <span className="ml-2 text-xs text-slate-500">(contre-passation)</span>}</td>
                <td className="p-3">{r.documentRef ?? ""}</td>
                <td className="p-3">{r.status === "DRAFT" ? <span className="text-amber-700">{ENTRY_STATUS.DRAFT}</span> : ENTRY_STATUS[r.status] ?? r.status}</td>
                <td className="p-3 text-right tabular-nums whitespace-nowrap">{formatEuros(r.totalCents)}</td>
              </tr>))}
            </tbody>
          </table>)}
      </CardContent></Card>

      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm text-slate-600" aria-label="Pagination">
          <span>{result.total} écritures — page {result.page} / {pages}</span>
          <span className="flex gap-2">
            {result.page > 1 && <Button asChild variant="outline" size="sm"><Link href={qs(result.page - 1)}>Précédente</Link></Button>}
            {result.page < pages && <Button asChild variant="outline" size="sm"><Link href={qs(result.page + 1)}>Suivante</Link></Button>}
          </span>
        </nav>)}
    </div>
  )
}
