import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { resolveAccountingAccessForRequest } from "@/lib/accounting/access/accounting-access"
import { accountingDenialDisposition } from "@/lib/accounting/access/accounting-access.core"
import { Card, CardContent } from "@/components/ui/card"

export const metadata: Metadata = { title: "Comptabilité" }

// Lot 0 : page de câblage uniquement. Aucune donnée financière, aucun KPI, aucune lecture de facture.
export default async function ComptabilitePage() {
  // Garde serveur AVANT tout rendu : masquer le lien de menu n'est pas une protection.
  const access = await resolveAccountingAccessForRequest()
  if (!access.ok) {
    const disposition = accountingDenialDisposition(access.reason)
    if (disposition === "login") redirect("/login")
    if (disposition === "not-found") notFound()
    redirect("/dashboard")
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Comptabilité</h1>
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Module comptabilité — préparation en cours
        </CardContent>
      </Card>
    </div>
  )
}
