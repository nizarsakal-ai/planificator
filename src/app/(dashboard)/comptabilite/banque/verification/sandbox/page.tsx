// Simulateur de prestataire de vérification bancaire — ESSAIS UNIQUEMENT (404 si le prestataire actif n'est pas « sandbox »,
// ce qui est toujours le cas en production).
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { isBankAccountVerificationEnabled } from "@/lib/invoice-import/invoice-import-feature-flag"
import { resolveBankVerificationProvider } from "@/lib/bank-verification/provider"
import { SandboxBankOutcome } from "@/components/comptabilite/BankAccountCard"

export const metadata: Metadata = { title: "Simulateur de vérification bancaire" }
export const dynamic = "force-dynamic"

export default async function SandboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isBankAccountVerificationEnabled()) notFound()
  await requireAccountingPage()
  const resolved = resolveBankVerificationProvider()
  if (!resolved.ok || resolved.provider.name !== "sandbox") notFound()
  const raw = (await searchParams).state
  const state = typeof raw === "string" ? raw : ""
  if (state.length < 10 || state.length > 200) notFound()
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Simulateur de vérification bancaire (essais)</h1>
      <p className="text-sm text-slate-600">Cette page remplace, en environnement de test, le parcours d’authentification chez la banque ou le prestataire. Choisissez l’issue à simuler.</p>
      <SandboxBankOutcome state={state} />
    </div>
  )
}
