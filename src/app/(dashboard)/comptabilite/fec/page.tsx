import type { Metadata } from "next"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { listFiscalYears } from "@/lib/accounting/engine/queries"
import { fiscalYearLabel, pickFiscalYear, searchParam } from "@/lib/accounting/ui/labels"
import { buildFec } from "@/lib/accounting/c5/fec"
import { formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = { title: "Comptabilité — Export FEC" }

export default async function FecPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const years = await listFiscalYears(prisma, ctx)
  const year = pickFiscalYear(years, searchParam(sp.exercice))
  const fec = year ? await buildFec(prisma, ctx, year.id) : null
  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-3 p-4 text-sm">
        <p className="text-slate-700">Fichier des écritures comptables (art. A47 A-1 du LPF) : écritures <strong>validées</strong> de l&apos;exercice, 18 colonnes séparées par « | », ordre chronologique, nom <code>SIRENFECAAAAMMJJ.txt</code>.</p>
        <form method="get" className="flex flex-wrap items-center gap-2">
          <select name="exercice" defaultValue={year?.id} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Exercice">{years.map((y) => <option key={y.id} value={y.id}>{fiscalYearLabel(y)}</option>)}</select>
          <Button type="submit" variant="secondary">Aperçu</Button>
          {year && fec && fec.lines > 0 && <Button asChild><a href={`/comptabilite/fec/export?exercice=${year.id}`}>Télécharger {fec.filename}</a></Button>}
        </form>
        {fec && (
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Lignes</p><p className="text-lg font-semibold">{fec.lines}</p></div>
            <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Total débit</p><p className="text-lg font-semibold tabular-nums">{formatEuro(fec.debitCents)}</p></div>
            <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Total crédit</p><p className={`text-lg font-semibold tabular-nums ${fec.debitCents === fec.creditCents ? "text-green-700" : "text-red-700"}`}>{formatEuro(fec.creditCents)}</p></div>
          </div>
        )}
        {fec?.sirenMissing && <p className="text-amber-700">SIREN manquant (SIRET de la société non renseigné) : le fichier est nommé 000000000FEC… — à corriger dans les paramètres de l&apos;entreprise avant transmission.</p>}
        {fec && fec.lines === 0 && <p className="text-slate-500">Aucune écriture validée sur cet exercice.</p>}
      </CardContent></Card>
      {fec && fec.lines > 0 && <Card><CardContent className="p-4"><p className="mb-2 text-sm font-medium text-slate-700">Aperçu (10 premières lignes)</p><pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{fec.content.split("\r\n").slice(0, 11).join("\n")}</pre></CardContent></Card>}
    </div>
  )
}
