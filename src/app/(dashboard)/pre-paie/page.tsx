// Lot H Planificator V2 : pré-paie — périodes mensuelles. Variables seulement (heures, absences, primes, frais) :
// aucun salaire, aucune cotisation, aucun bulletin, aucune DSN déposée. Drapeau PAYROLL_PREP_ENABLED +
// ADMIN/SUPER_ADMIN.
// Portage sur 90ae644 : refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour,
// MessageRetour, FormulaireRetour), liens HTML natifs vers les fiches (navigation du document).
import { CalendarCheck } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { prepayPageAccess } from "@/lib/payroll-prep/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { openableMonths, periodLabel } from "@/lib/payroll-prep/prepay.core"
import { parisToday } from "@/lib/equipment/equipment.core"
import { serverNow } from "@/lib/billing/clock"
import { listPeriods } from "@/lib/payroll-prep/queries"
import { openPeriodAction } from "@/lib/actions/payroll-prep.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

export default async function PrepayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await prepayPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const periods = await listPeriods(prisma, ctx.companyId)
  // Liste déroulante plutôt que <input type="month"> (champ texte vide sans format sous Safari macOS).
  const months = openableMonths(parisToday(serverNow()), periods)
  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><CalendarCheck className="h-6 w-6 text-[#0f3460]" /> Pré-paie</h1>
        <p className="mt-1 text-sm text-slate-500">Rassemblez chaque mois les heures, absences, primes et frais de vos salariés, vérifiez-les, puis exportez-les pour votre comptable ou votre logiciel de paie.</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Préparation des variables seulement : ce module ne calcule ni salaire ni cotisation, ne produit aucun bulletin et ne dépose aucune DSN.
      </p>
      <Card><CardContent className="p-4">
        <FormulaireRetour action={openPeriodAction} className="flex flex-wrap items-end gap-2">
          {months.length === 0 ? (
            <p className="text-sm text-slate-500">Tous les mois des deux dernières années sont déjà ouverts.</p>
          ) : (
            <>
              <label className="grid gap-1 text-sm font-medium text-slate-700">Mois à préparer
                <select name="month" required defaultValue={months[0].value} className={`${SELECT_CLASS} min-w-48 capitalize`}>
                  {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <Button type="submit">Ouvrir la période</Button>
            </>
          )}
        </FormulaireRetour>
      </CardContent></Card>
      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Périodes</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Mois</th><th scope="col" className="px-3 py-2">État</th></tr></thead>
          <tbody>
            {periods.length === 0 && <tr><td colSpan={2} className="px-3 py-8 text-center text-slate-400">Aucune période.</td></tr>}
            {periods.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-2"><a href={`/pre-paie/${p.id}`} className="font-medium text-[#0f3460] underline">{periodLabel(p.year, p.month)}</a></td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.status === "CLOSED" ? "bg-slate-100 text-slate-700" : "bg-green-50 text-green-700"}`}>{p.status === "CLOSED" ? `Clôturée${p.closedAt ? ` le ${fmtInstant(p.closedAt)}` : ""}` : "Ouverte"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
