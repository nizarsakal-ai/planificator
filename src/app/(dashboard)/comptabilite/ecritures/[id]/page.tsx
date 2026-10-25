import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { getEntryDetail, listFiscalYears } from "@/lib/accounting/engine/queries"
import { formatEuros } from "@/lib/accounting/ui/forms"
import { ENTRY_STATUS, defaultDayInYear, fiscalYearLabel, yearContainingToday } from "@/lib/accounting/ui/labels"
import { DraftEntryActions, ReverseEntryForm } from "@/components/comptabilite/AccountingActions"

export const metadata: Metadata = { title: "Écriture — Comptabilité" }

export default async function EcriturePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAccountingPage()
  const { id } = await params
  if (typeof id !== "string" || id.length === 0 || id.length > 64) notFound()
  const [entry, years] = await Promise.all([getEntryDetail(prisma, ctx, id), listFiscalYears(prisma, ctx)])
  if (!entry) notFound()

  const debit = entry.lines.reduce((s, l) => s + l.debitCents, BigInt(0))
  const credit = entry.lines.reduce((s, l) => s + l.creditCents, BigInt(0))
  const openYears = years.filter((y) => y.status === "OPEN")
  const canReverse = entry.status === "VALIDATED" && !entry.reversedBy && !entry.reversalOfId && openYears.length > 0
  const defaultYear = yearContainingToday(openYears)

  return (
    <div className="space-y-4">
      <p className="text-sm"><Link className="text-slate-600 hover:underline" href="/comptabilite/ecritures">← Écritures</Link></p>
      <Card><CardContent className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><span className="text-slate-500">Journal</span><p className="font-medium">{entry.journal.code} — {entry.journal.label}</p></div>
        <div><span className="text-slate-500">Numéro</span><p className="font-medium tabular-nums">{entry.number ?? "— (brouillon)"}</p></div>
        <div><span className="text-slate-500">Statut</span><p className="font-medium">{ENTRY_STATUS[entry.status] ?? entry.status}</p></div>
        <div><span className="text-slate-500">Date</span><p className="font-medium">{dateFr.format(entry.entryDate)}</p></div>
        <div><span className="text-slate-500">Pièce</span><p className="font-medium">{entry.documentRef ?? "—"}{entry.documentDate ? ` du ${dateFr.format(entry.documentDate)}` : ""}</p></div>
        <div><span className="text-slate-500">Exercice</span><p className="font-medium">{fiscalYearLabel(entry.fiscalYear)}</p></div>
        <div className="sm:col-span-2 lg:col-span-3"><span className="text-slate-500">Libellé</span><p className="font-medium">{entry.label}</p></div>
        {entry.reversalOf && <p className="sm:col-span-2 lg:col-span-3">Contre-passation de l&apos;écriture <Link className="underline" href={`/comptabilite/ecritures/${entry.reversalOf.id}`}>n° {entry.reversalOf.number}</Link>.</p>}
        {entry.reversedBy && <p className="sm:col-span-2 lg:col-span-3">Contre-passée par l&apos;écriture <Link className="underline" href={`/comptabilite/ecritures/${entry.reversedBy.id}`}>{entry.reversedBy.number ? `n° ${entry.reversedBy.number}` : "brouillon"}</Link>.</p>}
        {entry.hash && <p className="sm:col-span-2 lg:col-span-3 break-all font-mono text-xs text-slate-500">Empreinte : {entry.hash}</p>}
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">Compte</th><th className="p-3">Libellé</th><th className="p-3 text-right">Débit</th><th className="p-3 text-right">Crédit</th></tr></thead>
          <tbody>{entry.lines.map((l) => (
            <tr key={l.position} className="border-t border-slate-100">
              <td className="p-3"><span className="font-mono">{l.account.number}</span> {l.account.label}</td>
              <td className="p-3">{l.label ?? ""}</td>
              <td className="p-3 text-right tabular-nums">{l.debitCents > BigInt(0) ? formatEuros(l.debitCents) : ""}</td>
              <td className="p-3 text-right tabular-nums">{l.creditCents > BigInt(0) ? formatEuros(l.creditCents) : ""}</td>
            </tr>))}
          </tbody>
          <tfoot className="border-t border-slate-200 font-medium"><tr><td className="p-3" colSpan={2}>Totaux</td><td className="p-3 text-right tabular-nums">{formatEuros(debit)}</td><td className="p-3 text-right tabular-nums">{formatEuros(credit)}</td></tr></tfoot>
        </table>
      </CardContent></Card>

      {entry.status === "DRAFT" && <Card><CardContent className="p-4"><DraftEntryActions entryId={entry.id} /></CardContent></Card>}
      {canReverse && defaultYear && (
        <Card><CardContent className="space-y-3 p-4">
          <p className="text-sm text-slate-700">Une écriture validée ne se modifie pas : pour l&apos;annuler, créez une contre-passation.</p>
          <ReverseEntryForm entryId={entry.id} years={openYears.map((y) => ({ id: y.id, label: fiscalYearLabel(y) }))} defaultYearId={defaultYear.id} defaultDate={defaultDayInYear(defaultYear)} />
        </CardContent></Card>)}
    </div>
  )
}
