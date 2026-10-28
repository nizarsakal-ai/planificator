import Link from "next/link"
import { notFound } from "next/navigation"
import { requireIntakePage, intakeAccounts, intakeInvoice } from "@/lib/supplier-intake/pages"
import { SupplierInvoiceForm } from "@/components/comptabilite/SupplierInvoiceForm"
import { bpToPercentString, formatEuro } from "@/lib/billing/money"
export default async function IntakeInvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireIntakePage()
  const invoice = await intakeInvoice((await params).id)
  if (!invoice) notFound()
  return <div className="space-y-4"><Link href="/factures-fournisseurs" className="underline">Mes dépôts</Link>
    <h2 className="text-xl font-semibold">{invoice.supplierName} — {invoice.number}</h2>
    {invoice.status === "PENDING" ? <SupplierInvoiceForm intake mode="edit" invoiceId={invoice.id} accounts={await intakeAccounts(ctx)} initial={{
      supplierName: invoice.supplierName, siret: invoice.siret ?? "", number: invoice.number,
      date: invoice.date.toISOString().slice(0,10), dueDate: invoice.dueDate?.toISOString().slice(0,10) ?? "",
      totalHT: (Number(invoice.totalHTCents)/100).toFixed(2), vat: (Number(invoice.vatCents)/100).toFixed(2), totalTTC: (Number(invoice.totalTTCCents)/100).toFixed(2),
      vatRate: invoice.vatRateBp == null ? "" : bpToPercentString(invoice.vatRateBp), category: invoice.category ?? "", expenseAccountId: invoice.expenseAccountId ?? "", notes: invoice.notes ?? "",
    }} confidence={(invoice.ocrConfidence ?? {}) as Record<string, number>} /> : <p>Facture {invoice.status === "VALIDATED" ? "validée" : "rejetée"} — consultation seule. TTC : {formatEuro(invoice.totalTTCCents)}</p>}
    {invoice.fileId && <a className="block underline" href={`/factures-fournisseurs/${invoice.id}/fichier`} target="_blank" rel="noopener">Consulter le justificatif</a>}
  </div>
}
