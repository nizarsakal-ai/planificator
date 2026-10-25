import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { listAccounts } from "@/lib/accounting/engine/queries"
import { SupplierInvoiceForm } from "@/components/comptabilite/SupplierInvoiceForm"

export const metadata: Metadata = { title: "Nouvelle facture fournisseur" }

export default async function NouvelleFactureFournisseurPage() {
  const ctx = await requireAccountingPage()
  const accounts = (await listAccounts(prisma, ctx)).filter((a) => a.active && /^6/.test(a.number))
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500"><Link href="/comptabilite/fournisseurs" className="hover:underline">Factures fournisseurs</Link> / Nouvelle</p>
      <SupplierInvoiceForm mode="create" accounts={accounts.map((a) => ({ id: a.id, number: a.number, label: a.label }))} />
    </div>
  )
}
