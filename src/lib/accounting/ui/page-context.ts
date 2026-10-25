// Garde des pages Comptabilité (serveur uniquement). Redirige selon les conventions du Lot 0.
import { notFound, redirect } from "next/navigation"
import { resolveAccountingAccessForRequest } from "@/lib/accounting/access/accounting-access"
import { accountingDenialDisposition } from "@/lib/accounting/access/accounting-access.core"
import type { AccountingContext } from "@/lib/accounting/engine/posting"

export async function requireAccountingPage(): Promise<AccountingContext> {
  const access = await resolveAccountingAccessForRequest()
  if (!access.ok) {
    const disposition = accountingDenialDisposition(access.reason)
    if (disposition === "login") redirect("/login")
    if (disposition === "not-found") notFound()
    redirect("/dashboard")
  }
  return { companyId: access.context.companyId, userId: access.context.userId }
}

export const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
