import { requireIntakePage, intakeAccounts } from "@/lib/supplier-intake/pages"
import { SupplierInvoiceForm } from "@/components/comptabilite/SupplierInvoiceForm"
export default async function NewIntakeInvoice() {
  const ctx = await requireIntakePage()
  return <SupplierInvoiceForm intake mode="create" accounts={await intakeAccounts(ctx)} />
}
