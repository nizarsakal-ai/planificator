import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { quoteFormOptions } from "@/lib/billing/quotes/quote-queries"
import { InvoiceForm } from "@/components/factures/InvoiceForm"

export const metadata: Metadata = { title: "Nouvelle facture" }

export default async function NouvelleFacturePage() {
  const ctx = await requireBillingPage()
  const options = await quoteFormOptions(prisma, ctx.companyId)
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Nouvelle facture</h1>
      <p className="text-sm text-slate-500">Le brouillon reçoit un numéro provisoire ; le numéro légal est attribué à l&apos;émission.</p>
      {options.worksites.length === 0 ? <p className="text-sm text-slate-600">Créez d&apos;abord un chantier (avec son client).</p> : <InvoiceForm mode="create" worksites={options.worksites} articles={options.articles} />}
    </div>
  )
}
