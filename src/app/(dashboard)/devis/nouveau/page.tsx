import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { quoteFormOptions } from "@/lib/billing/quotes/quote-queries"
import { QuoteForm } from "@/components/devis/QuoteForm"

export const metadata: Metadata = { title: "Nouveau devis" }

export default async function NouveauDevisPage() {
  const ctx = await requireBillingPage()
  const options = await quoteFormOptions(prisma, ctx.companyId)
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Nouveau devis</h1>
      {options.worksites.length === 0
        ? <p className="text-sm text-slate-600">Créez d&apos;abord un chantier (avec son client) pour établir un devis.</p>
        : <QuoteForm mode="create" worksites={options.worksites} articles={options.articles} />}
    </div>
  )
}
