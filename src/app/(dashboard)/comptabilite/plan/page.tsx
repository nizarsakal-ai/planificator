import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { listAccounts } from "@/lib/accounting/engine/queries"
import { AccountActiveToggle, NewAccountForm } from "@/components/comptabilite/AccountingActions"

export const metadata: Metadata = { title: "Plan comptable — Comptabilité" }

export default async function PlanPage() {
  const ctx = await requireAccountingPage()
  const accounts = await listAccounts(prisma, ctx)
  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-3 p-4"><p className="text-sm font-medium text-slate-700">Ajouter un compte</p><NewAccountForm /></CardContent></Card>
      <Card><CardContent className="p-0">
        {accounts.length === 0 ? <p className="p-6 text-sm text-slate-500">Aucun compte : initialisez le module depuis l&apos;accueil.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">Numéro</th><th className="p-3">Libellé</th><th className="p-3">Lignes</th><th className="p-3">État</th><th className="p-3 text-right" /></tr></thead>
            <tbody>{accounts.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="p-3 font-mono">{a.number}</td><td className="p-3">{a.label}</td><td className="p-3 tabular-nums">{a.lineCount}</td>
                <td className="p-3">{a.active ? "Actif" : <span className="text-slate-400">Désactivé</span>}</td>
                <td className="p-3 text-right"><AccountActiveToggle accountId={a.id} active={a.active} /></td>
              </tr>))}
            </tbody>
          </table>)}
      </CardContent></Card>
    </div>
  )
}
