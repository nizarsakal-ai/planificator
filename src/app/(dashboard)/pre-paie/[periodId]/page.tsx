// Lot H Planificator V2 : une période de pré-paie — variables par salarié, contrôles, primes et frais saisis,
// clôture (instantané figé) et export CSV. Aucun calcul de paie. Drapeau PAYROLL_PREP_ENABLED + ADMIN/SUPER_ADMIN.
// Portage sur 90ae644 : refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour,
// MessageRetour, FormulaireRetour), liens HTML natifs (liste, export).
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { prepayPageAccess } from "@/lib/payroll-prep/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { ABSENCE_KINDS, ABSENCE_LABEL, ANOMALY_LABEL, VARIABLE_LABEL, eurosPlain, hoursDecimal, periodLabel, type VariableKind } from "@/lib/payroll-prep/prepay.core"
import { getPeriodView } from "@/lib/payroll-prep/queries"
import { addVariableAction, closePeriodAction, removeVariableAction } from "@/lib/actions/payroll-prep.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function PeriodPage({ params, searchParams }: { params: Promise<{ periodId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await prepayPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { periodId } = await params
  const sp = await searchParams
  if (!ID.test(periodId)) notFound()
  const v = await getPeriodView(prisma, ctx.companyId, periodId)
  if (!v) notFound()
  const open = v.period.status === "OPEN"
  const blocking = v.anomalies.filter((a) => a.blocking).length
  const names = new Map(v.lines.map((l) => [l.employeeId, l.name]))
  const employees = open ? await prisma.employee.findMany({ where: { companyId: ctx.companyId, active: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 500, select: { id: true, firstName: true, lastName: true } }) : []

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <a href="/pre-paie" className="text-xs text-[#0f3460] underline">← Pré-paie</a>
        <h1 className="text-2xl font-bold text-slate-900">Pré-paie · {periodLabel(v.period.year, v.period.month)}</h1>
        <p className="text-sm text-slate-500">{open ? "Ouverte : variables calculées en direct (provisoires)" : "Clôturée : variables figées"} · <a href={`/pre-paie/${v.period.id}/export`} className="text-[#0f3460] underline">Exporter (CSV{open ? ", provisoire" : ""})</a></p>
      </div>
      <MessageRetour><StockFlash params={sp} /></MessageRetour>
      {!v.intact && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Empreinte de l&apos;instantané non conforme : export bloqué.</p>}

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Variables par salarié</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th scope="col" className="px-3 py-2">Salarié</th><th scope="col" className="px-3 py-2 text-right">Heures</th><th scope="col" className="px-3 py-2 text-right">Jours</th>
            {ABSENCE_KINDS.map((k) => <th key={k} scope="col" className="px-3 py-2 text-right">{ABSENCE_LABEL[k]} (j)</th>)}
            <th scope="col" className="px-3 py-2 text-right">Primes (€)</th><th scope="col" className="px-3 py-2 text-right">Frais (€)</th>
          </tr></thead>
          <tbody>
            {v.lines.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Aucun salarié.</td></tr>}
            {v.lines.map((l) => (
              <tr key={l.employeeId} className="border-t tabular-nums">
                <td className="px-3 py-2">{l.name}</td><td className="px-3 py-2 text-right">{hoursDecimal(l.workedMinutes)}</td><td className="px-3 py-2 text-right">{l.workedDays}</td>
                {ABSENCE_KINDS.map((k) => <td key={k} className="px-3 py-2 text-right">{l.absenceDays[k]}</td>)}
                <td className="px-3 py-2 text-right">{eurosPlain(l.bonusCents)}</td><td className="px-3 py-2 text-right">{eurosPlain(l.expenseCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3 py-2 text-xs text-slate-500">Absences validées en jours ouvrés du lundi au vendredi ; jours fériés non déduits.</p>
      </CardContent></Card>

      <Card><CardContent className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Contrôles ({blocking} bloquant{blocking > 1 ? "s" : ""}, {v.anomalies.length - blocking} signalé{v.anomalies.length - blocking > 1 ? "s" : ""})</h2>
        {v.anomalies.length === 0 ? <p className="text-sm text-slate-400">Aucun écart.</p> : (
          <ul className="space-y-1 text-sm">{v.anomalies.map((a, i) => <li key={i} className={a.blocking ? "text-red-700" : "text-amber-700"}>{a.day} · {names.get(a.employeeId) ?? a.employeeId} · {ANOMALY_LABEL[a.code]}{a.blocking ? " (bloquant)" : ""}</li>)}</ul>
        )}
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Primes et frais saisis</h2>
        {open && <p className="text-xs text-slate-500">Liste limitée aux 500 premiers salariés actifs par ordre alphabétique.</p>}
        {v.variables.length === 0 ? <p className="text-sm text-slate-400">Aucune variable saisie.</p> : (
          <ul className="space-y-1 text-sm">{v.variables.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2">
              {x.employee.lastName} {x.employee.firstName} · {VARIABLE_LABEL[x.kind as VariableKind]} « {x.label} » · {eurosPlain(x.amountCents.toString())} €
              {open && <FormulaireRetour action={removeVariableAction}><input type="hidden" name="periodId" value={v.period.id} /><input type="hidden" name="variableId" value={x.id} /><Button type="submit" size="sm" variant="outline">Supprimer</Button></FormulaireRetour>}
            </li>
          ))}</ul>
        )}
        {open && (
          <FormulaireRetour action={addVariableAction} className="grid gap-2 sm:grid-cols-4">
            <input type="hidden" name="periodId" value={v.period.id} />
            <select name="employeeId" required defaultValue="" className={SELECT_CLASS} aria-label="Salarié"><option value="" disabled>Salarié…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}</select>
            <select name="kind" required defaultValue="BONUS" className={SELECT_CLASS} aria-label="Type"><option value="BONUS">Prime</option><option value="EXPENSE">Frais</option></select>
            <Input name="amount" required inputMode="decimal" maxLength={30} placeholder="Montant (€)" aria-label="Montant en euros" />
            <Input name="label" required minLength={2} maxLength={120} placeholder="Libellé" aria-label="Libellé" />
            <div className="sm:col-span-4"><Button type="submit" variant="outline">Ajouter</Button></div>
          </FormulaireRetour>
        )}
      </CardContent></Card>

      {open && (
        <Card><CardContent className="p-4">
          <FormulaireRetour action={closePeriodAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="periodId" value={v.period.id} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="oui" required /> Clôturer : les variables seront figées et la période ne sera plus modifiable</label>
            <Button type="submit" disabled={blocking > 0}>Clôturer la période</Button>
            {blocking > 0 && <span className="text-xs text-red-700">Résolvez d&apos;abord les contrôles bloquants.</span>}
          </FormulaireRetour>
        </CardContent></Card>
      )}
    </div>
    </ZoneRetour>
  )
}
