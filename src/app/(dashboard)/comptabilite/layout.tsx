import type { ReactNode } from "react"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { AccountingNav } from "@/components/comptabilite/AccountingNav"

// Garde serveur commune à toutes les pages du module (chaque page la refait pour obtenir son contexte).
export default async function ComptabiliteLayout({ children }: { children: ReactNode }) {
  await requireAccountingPage()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Comptabilité</h1>
      <AccountingNav />
      {children}
    </div>
  )
}
