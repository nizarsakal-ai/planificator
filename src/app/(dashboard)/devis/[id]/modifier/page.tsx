import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { getQuoteDetail, quoteFormOptions } from "@/lib/billing/quotes/quote-queries"
import { bpToPercentString, storedVatRateToBp } from "@/lib/billing/money"
import { QuoteForm } from "@/components/devis/QuoteForm"

export const metadata: Metadata = { title: "Modifier le devis" }

export default async function ModifierDevisPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const [q, options] = await Promise.all([getQuoteDetail(prisma, ctx.companyId, id), quoteFormOptions(prisma, ctx.companyId)])
  if (!q) notFound()
  if (q.status !== "DRAFT") redirect(`/devis/${q.id}`)
  const dec = (d: { toFixed(n: number): string }) => d.toFixed(2).replace(/\.?0+$/, "")
  const initial = {
    worksiteId: q.worksite.id, issueDate: q.issueDate.toISOString().slice(0, 10), validUntil: q.validUntil ? q.validUntil.toISOString().slice(0, 10) : "",
    subject: q.subject ?? "", notes: q.notes ?? "", paymentTerms: q.paymentTerms ?? "", globalDiscount: q.globalDiscountBp ? bpToPercentString(q.globalDiscountBp) : "", vatReverseCharge: q.vatReverseCharge,
    lines: q.lines.map((l) => ({ articleId: l.articleId, designation: l.designation, description: l.description ?? "", unit: l.unit, quantity: dec(l.quantity), unitPrice: l.unitPrice.toFixed(2), discount: l.discountBp ? bpToPercentString(l.discountBp) : "", vatRate: bpToPercentString(storedVatRateToBp(l.vatRate)) })),
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Modifier le devis {q.number}</h1>
      <QuoteForm mode="edit" quoteId={q.id} initial={initial} worksites={options.worksites} articles={options.articles} />
    </div>
  )
}
