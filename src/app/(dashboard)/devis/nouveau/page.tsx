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
      <QuoteForm mode="create" {...options} />
    </div>
  )
}
