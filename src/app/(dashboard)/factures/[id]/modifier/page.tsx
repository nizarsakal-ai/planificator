import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { quoteFormOptions } from "@/lib/billing/quotes/quote-queries"
import { bpToPercentString, storedVatRateToBp } from "@/lib/billing/money"
import { InvoiceForm } from "@/components/factures/InvoiceForm"

export const metadata: Metadata = { title: "Modifier la facture" }

export default async function ModifierFacturePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const [inv, options] = await Promise.all([getInvoiceDetail(prisma, ctx.companyId, id), quoteFormOptions(prisma, ctx.companyId)])
  if (!inv) notFound()
  if (inv.status !== "DRAFT" || inv.kind !== "INVOICE") redirect(`/factures/${inv.id}`)
  const dec = (d: { toFixed(n: number): string }) => d.toFixed(2).replace(/\.?0+$/, "")
  const initial = {
    worksiteId: inv.worksite.id, quoteId: inv.quoteId, dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : "", subject: inv.subject ?? "", notes: inv.notes ?? "", paymentTerms: inv.paymentTerms ?? "",
    globalDiscount: inv.globalDiscountBp ? bpToPercentString(inv.globalDiscountBp) : "", vatReverseCharge: inv.vatReverseCharge,
    lines: inv.lines.map((l) => ({ articleId: l.articleId, designation: l.designation, description: l.description ?? "", unit: l.unit, quantity: dec(l.quantity), unitPrice: l.unitPrice.toFixed(2), discount: l.discountBp ? bpToPercentString(l.discountBp) : "", vatRate: bpToPercentString(storedVatRateToBp(l.vatRate)) })),
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Modifier le brouillon {inv.number}</h1>
      <InvoiceForm mode="edit" invoiceId={inv.id} initial={initial} worksites={options.worksites} articles={options.articles} />
    </div>
  )
}
