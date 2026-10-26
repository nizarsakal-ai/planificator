import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { listAccounts, listFiscalYears, listJournals } from "@/lib/accounting/engine/queries"
import { defaultDayInYear, fiscalYearLabel, yearContainingToday } from "@/lib/accounting/ui/labels"
import { EntryForm } from "@/components/comptabilite/EntryForm"

export const metadata: Metadata = { title: "Nouvelle écriture — Comptabilité" }

export default async function NouvelleEcriturePage() {
  const ctx = await requireAccountingPage()
  const [years, journals, accounts] = await Promise.all([listFiscalYears(prisma, ctx), listJournals(prisma, ctx), listAccounts(prisma, ctx)])
  // Saisie manuelle : exercices ouverts uniquement (les écritures de clôture ne sont pas dans le périmètre A2).
  const openYears = years.filter((y) => y.status === "OPEN")
  const activeAccounts = accounts.filter((a) => a.active)

  if (openYears.length === 0 || journals.length === 0 || activeAccounts.length < 2) {
    return (
      <Card><CardContent className="space-y-2 p-6 text-sm text-slate-600">
        <p>La saisie nécessite un plan comptable initialisé (au moins deux comptes actifs), des journaux et un exercice ouvert.</p>
        <p><Link className="underline" href="/comptabilite">Retour à l&apos;accueil Comptabilité</Link></p>
      </CardContent></Card>
    )
  }

  const year = yearContainingToday(openYears) ?? openYears[0]
  return (
    <Card><CardContent className="p-4">
      <EntryForm
        journals={journals.map((j) => ({ id: j.id, label: `${j.code} — ${j.label}` }))}
        years={openYears.map((y) => ({ id: y.id, label: fiscalYearLabel(y) }))}
        accounts={activeAccounts.map((a) => ({ id: a.id, label: `${a.number} — ${a.label}` }))}
        defaultYearId={year.id}
        defaultDate={defaultDayInYear(year)}
      />
    </CardContent></Card>
  )
}
