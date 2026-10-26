import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage, dateFr, isoDay } from "@/lib/accounting/ui/page-context"
import { listFiscalYears } from "@/lib/accounting/engine/queries"
import { AdvanceFiscalYearButton, OpenFiscalYearForm } from "@/components/comptabilite/AccountingActions"

export const metadata: Metadata = { title: "Exercices — Comptabilité" }
const STATUS: Record<string, string> = { OPEN: "Ouvert", CLOSING: "En clôture", CLOSED: "Clôturé" }

export default async function ExercicesPage() {
  const ctx = await requireAccountingPage()
  const years = await listFiscalYears(prisma, ctx)
  const last = years[0]
  const nextStart = last ? new Date(last.endDate.getTime() + 86_400_000) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))
  const nextEnd = new Date(Date.UTC(nextStart.getUTCFullYear() + 1, nextStart.getUTCMonth(), nextStart.getUTCDate()) - 86_400_000)
  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-3 p-4">
        <p className="text-sm font-medium text-slate-700">Ouvrir un exercice</p>
        <OpenFiscalYearForm defaultStart={isoDay(nextStart)} defaultEnd={isoDay(nextEnd)} />
      </CardContent></Card>
      <Card><CardContent className="p-0">
        {years.length === 0 ? <p className="p-6 text-sm text-slate-500">Aucun exercice.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">Période</th><th className="p-3">État</th><th className="p-3 text-right">Actions</th></tr></thead>
            <tbody>{years.map((y) => (
              <tr key={y.id} className="border-t border-slate-100">
                <td className="p-3">{dateFr.format(y.startDate)} → {dateFr.format(y.endDate)}</td>
                <td className="p-3">{STATUS[y.status] ?? y.status}</td>
                <td className="p-3 text-right">
                  {y.status === "OPEN" && <AdvanceFiscalYearButton fiscalYearId={y.id} to="CLOSING" />}
                  {y.status === "CLOSING" && <AdvanceFiscalYearButton fiscalYearId={y.id} to="CLOSED" />}
                </td>
              </tr>))}
            </tbody>
          </table>)}
      </CardContent></Card>
    </div>
  )
}
