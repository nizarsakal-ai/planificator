import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { requireAccountingPage, dateFr, isoDay } from "@/lib/accounting/ui/page-context"
import { accountingSummary, listJournals } from "@/lib/accounting/engine/queries"
import { verifyChain, type ChainReport } from "@/lib/accounting/engine/posting"
import { InitAccountingButton, OpenFiscalYearForm } from "@/components/comptabilite/AccountingActions"
import { UPCOMING_MODULES } from "@/lib/accounting/ui/labels"

export const metadata: Metadata = { title: "Comptabilité" }

export default async function ComptabilitePage() {
  const ctx = await requireAccountingPage()
  const summary = await accountingSummary(prisma, ctx)
  const journals = summary.initialized ? await listJournals(prisma, ctx) : []
  // Vérification exhaustive, journal par journal, sur un instantané cohérent (RepeatableRead : pas de fausse
  // anomalie si une écriture est validée pendant la lecture). Une panne de vérification n'empêche pas l'affichage.
  // Coût O(écritures validées) : à déplacer vers un traitement planifié quand les volumes le justifieront.
  const chains: { code: string; label: string; report: ChainReport | null }[] = []
  for (const j of journals) {
    let report: ChainReport | null = null
    try {
      report = await prisma.$transaction((tx) => verifyChain(tx, ctx, j.id), { isolationLevel: "RepeatableRead", timeout: 20_000, maxWait: 5_000 })
    } catch {
      console.error("[comptabilite] vérification de chaîne indisponible")
    }
    chains.push({ code: j.code, label: j.label, report })
  }
  const year = new Date().getUTCFullYear()

  return (
    <div className="space-y-4">
      {!summary.initialized && (
        <Card><CardContent className="space-y-3 p-6">
          <p className="text-sm text-slate-700">Le module n&apos;est pas encore initialisé pour votre société : créez le plan comptable de base et les journaux Ventes, Achats, Banque et Opérations diverses.</p>
          <InitAccountingButton />
        </CardContent></Card>
      )}
      {summary.initialized && !summary.openYear && (
        <Card><CardContent className="space-y-3 p-6">
          <p className="text-sm text-slate-700">Aucun exercice ouvert. Ouvrez un exercice pour saisir des écritures.</p>
          <OpenFiscalYearForm defaultStart={`${year}-01-01`} defaultEnd={`${year}-12-31`} />
        </CardContent></Card>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Exercice ouvert</p>
          <p className="mt-1 font-medium">{summary.openYear ? `${dateFr.format(summary.openYear.startDate)} → ${dateFr.format(summary.openYear.endDate)}` : "Aucun"}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Écritures validées</p><p className="mt-1 text-2xl font-semibold">{summary.validated}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Brouillons</p><p className="mt-1 text-2xl font-semibold">{summary.drafts}</p></CardContent></Card>
      </div>
      {summary.initialized && summary.openYear && (
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link href="/comptabilite/ecritures/nouvelle">Nouvelle écriture</Link></Button>
          <Button asChild variant="outline"><Link href={`/comptabilite/balance?exercice=${summary.openYear.id}`}>Balance de l&apos;exercice</Link></Button>
        </div>
      )}
      {chains.length > 0 && (
        <Card><CardContent className="p-4">
          <p className="mb-2 text-sm font-medium text-slate-700">Intégrité des journaux (chaînage vérifié)</p>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {chains.map((c) => (
              <li key={c.code} className="flex justify-between gap-2 rounded bg-slate-50 px-3 py-1.5">
                <span>{c.code} — {c.label}</span>
                {c.report === null
                  ? <span className="text-slate-500">vérification indisponible</span>
                  : <span className={c.report.ok ? "text-green-700" : "font-medium text-red-700"}>{c.report.ok ? `intègre (${c.report.checked})` : `ANOMALIE : ${c.report.reason ?? "?"}`}</span>}
              </li>
            ))}
          </ul>
        </CardContent></Card>
      )}
      <Card><CardContent className="p-4 text-sm text-slate-600">
        <p className="font-medium text-slate-700">Modules à venir dans la Comptabilité</p>
        <p className="mt-1">{UPCOMING_MODULES.join(" · ")}. Ils s&apos;ajouteront à ce menu sans changer vos données.</p>
        <p className="mt-1 text-xs text-slate-400">Dernière vérification : {isoDay(new Date())}</p>
      </CardContent></Card>
    </div>
  )
}
