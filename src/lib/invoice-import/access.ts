/**
 * Garde de l'import de factures (SPEC-INVOICE-IMPORT-001) : drapeau INVOICE_IMPORT_ENABLED PUIS garde de la facturation complète
 * (drapeau, session, rôle ADMIN/SUPER_ADMIN, société active de session). Aucune entrée client. Ne jamais importer côté client.
 */
import { notFound } from "next/navigation"
import { NextResponse } from "next/server"
import { BillingAccessError, requireBillingAdmin, requireBillingPage, requireBillingRoute, type BillingContext } from "@/lib/billing/access"
import { isInvoiceImportEnabled } from "./invoice-import-feature-flag"

export async function requireInvoiceImportAdmin(): Promise<BillingContext> {
  if (!isInvoiceImportEnabled()) throw new BillingAccessError("MODULE_DISABLED")
  return requireBillingAdmin()
}
export async function requireInvoiceImportPage(): Promise<BillingContext> {
  if (!isInvoiceImportEnabled()) notFound()
  return requireBillingPage()
}
export async function requireInvoiceImportRoute(): Promise<{ ok: true; ctx: BillingContext } | { ok: false; response: NextResponse }> {
  if (!isInvoiceImportEnabled()) return { ok: false, response: new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } }) }
  return requireBillingRoute()
}
