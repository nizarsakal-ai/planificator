import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { DEFAULT_LATE_PENALTY_TEXT, getBillingSettings, sirenFromSiret } from "@/lib/billing/settings"
import { BillingSettingsForm } from "@/components/factures/BillingSettingsForm"

export const metadata: Metadata = { title: "Paramètres de facturation" }

export default async function ParametresFacturationPage() {
  const ctx = await requireBillingPage()
  const [s, company] = await Promise.all([getBillingSettings(prisma, ctx.companyId), prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true, siret: true, address: true } })])
  const initial = {
    vatNumber: s.vatNumber ?? "", legalForm: s.legalForm ?? "", shareCapital: s.shareCapital ?? "", rcs: s.rcs ?? "", iban: s.iban ?? "", bic: s.bic ?? "",
    quoteValidityDays: s.quoteValidityDays, paymentTermsDays: s.paymentTermsDays, latePenaltyText: s.latePenaltyText ?? "", quoteFooter: s.quoteFooter ?? "", invoiceFooter: s.invoiceFooter ?? "",
    vatRegime: s.vatRegime, defaultDepositPercent: Math.round(s.defaultDepositBp / 100),
  }
  const siren = sirenFromSiret(company?.siret)
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500"><Link href="/factures" className="hover:underline">Factures</Link> / Paramètres</p>
      <h1 className="text-2xl font-bold text-slate-900">Paramètres de facturation</h1>
      <p className="text-sm text-slate-600">Société : <strong>{company?.name}</strong>{company?.siret ? ` — SIRET ${company.siret} (SIREN ${siren ?? "invalide"})` : " — SIRET manquant (à renseigner dans Paramètres de l'entreprise : obligatoire sur les factures et pour le FEC)"}{company?.address ? "" : " — adresse manquante"}</p>
      <BillingSettingsForm initial={initial} defaultPenalty={DEFAULT_LATE_PENALTY_TEXT} />
    </div>
  )
}
