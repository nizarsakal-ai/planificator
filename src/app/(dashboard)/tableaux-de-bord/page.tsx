// Lot D Planificator V2 : indicateurs commerciaux (devis, transformation, chiffre d'affaires par mois, client et
// chantier, articles les plus vendus). ESPACE DÉDIÉ : le tableau de bord existant (/dashboard) n'est pas modifié.
// Lecture seule. Drapeau SALES_DASHBOARD_ENABLED + ADMIN/SUPER_ADMIN ; autres rôles : refus rendu sur place.
// Barres en CSS (aucune bibliothèque de graphiques côté client) ; chaque montant est aussi écrit en clair.
import Link from "next/link"
import { BarChart3 } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { salesPageAccess } from "@/lib/sales-dashboard/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { salesIndicators } from "@/lib/sales-dashboard/queries"
import { periodFor, type Ranked } from "@/lib/sales-dashboard/sales.core"
import { serverNow } from "@/lib/billing/clock"
import { businessDay } from "@/lib/time/business-day"
import { formatEuro } from "@/lib/billing/money"
import { formatMilli } from "@/lib/stock/quantity"
import { Card, CardContent } from "@/components/ui/card"
import { fmtBp } from "@/components/budget/format"

const monthFr = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" })
const pct = (v: bigint, max: bigint) => (max <= BigInt("0") || v <= BigInt("0") ? 0 : Number((v * BigInt("100")) / max))

function Bars({ rows, caption }: { rows: { key: string; label: string; amountCents: bigint; sub?: string }[]; caption: string }) {
  const max = rows.reduce((m, r) => (r.amountCents > m ? r.amountCents : m), BigInt("0"))
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {rows.length === 0 && <tr><td className="px-3 py-6 text-center text-slate-400">Aucune donnée sur la période.</td></tr>}
        {rows.map((r) => (
          <tr key={r.key} className="border-t">
            <th scope="row" className="w-2/5 px-3 py-2 text-left font-normal">{r.label}{r.sub && <div className="text-xs text-slate-500">{r.sub}</div>}</th>
            <td className="px-3 py-2"><div className="h-2 rounded bg-blue-100" aria-hidden="true"><div className="h-2 rounded bg-[#0f3460]" style={{ width: `${pct(r.amountCents, max)}%` }} /></div></td>
            <td className={`w-32 px-3 py-2 text-right tabular-nums ${r.amountCents < BigInt("0") ? "text-red-700" : ""}`}>{formatEuro(r.amountCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
const rankedRows = (rs: Ranked[]) => rs.map((r) => ({ key: r.id, label: r.name, amountCents: r.amountCents }))

export default async function SalesDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await salesPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const now = serverNow()
  const period = periodFor(typeof params.annee === "string" ? params.annee : null, now)
  const k = await salesIndicators(prisma, ctx.companyId, period)
  const year = businessDay(now).getUTCFullYear()
  const choices = [{ v: "", l: "12 derniers mois" }, ...[0, 1, 2].map((d) => ({ v: String(year - d), l: `Année ${year - d}` }))]
  const tile = (label: string, value: string, sub: string) => (
    <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p><p className="text-xs text-slate-500">{sub}</p></CardContent></Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><BarChart3 className="h-6 w-6 text-[#0f3460]" /> Indicateurs commerciaux</h1>
          <p className="mt-1 text-sm text-slate-500">{period.label} · montants HT · pièces émises seulement, à leur date d&apos;émission · paiements non pris en compte</p>
        </div>
        <nav aria-label="Période" className="flex flex-wrap gap-1">
          {choices.map((c) => {
            const current = (typeof params.annee === "string" ? params.annee : "") === c.v
            return <Link key={c.v || "glissant"} href={c.v ? `/tableaux-de-bord?annee=${c.v}` : "/tableaux-de-bord"} aria-current={current ? "page" : undefined} className={`rounded-md border px-3 py-1.5 text-sm ${current ? "bg-[#0f3460] text-white" : "text-slate-700 hover:bg-slate-50"}`}>{c.l}</Link>
          })}
        </nav>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile("Chiffre d'affaires facturé", formatEuro(k.revenue.totalCents), `${k.revenue.invoicesCount} facture(s), ${k.revenue.depositsCount} acompte(s), ${k.revenue.creditNotesCount} avoir(s)`)}
        {tile("Devis émis", `${k.quotes.emitted}`, `${formatEuro(k.quotes.emittedCents)} · ${k.quotes.pending} en attente`)}
        {tile("Devis signés", `${k.quotes.signed}`, formatEuro(k.quotes.signedCents))}
        {tile("Taux de transformation", fmtBp(k.quotes.conversionBp), `en montant ${fmtBp(k.quotes.conversionValueBp)} · ${k.quotes.decided} devis décidé(s)`)}
      </div>

      <Card><CardContent className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Chiffre d&apos;affaires par mois</h2>
        <Bars caption="Chiffre d'affaires facturé HT par mois" rows={k.revenue.byMonth.map((m) => ({ key: m.month, label: monthFr.format(new Date(`${m.month}-01T00:00:00Z`)), amountCents: m.amountCents }))} />
      </CardContent></Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardContent className="p-4"><h2 className="mb-2 text-sm font-semibold text-slate-900">10 premiers clients</h2><Bars caption="Chiffre d'affaires par client" rows={rankedRows(k.topClients)} /></CardContent></Card>
        <Card><CardContent className="p-4"><h2 className="mb-2 text-sm font-semibold text-slate-900">10 premiers chantiers</h2><Bars caption="Chiffre d'affaires par chantier" rows={rankedRows(k.topWorksites)} /></CardContent></Card>
      </div>

      <Card><CardContent className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Articles les plus vendus</h2>
        <Bars caption="Articles du catalogue les plus vendus (montant HT)" rows={k.topArticles.map((a) => ({ key: a.id, label: a.name, amountCents: a.amountCents, sub: `Quantité ${formatMilli(Number(a.quantityMilli))}` }))} />
      </CardContent></Card>

      <section aria-labelledby="definitions" className="space-y-1 text-xs text-slate-500">
        <h2 id="definitions" className="font-semibold text-slate-700">Définitions</h2>
        <p><strong>Taux de transformation</strong> = devis signés (acceptés ou convertis) / devis décidés (signés, refusés ou expirés) émis sur la période, en nombre et en montant ; les devis encore en attente sont exclus ; « — » si aucun devis n&apos;est décidé.</p>
        <p><strong>Chiffre d&apos;affaires facturé</strong> = factures et acomptes émis − avoirs émis, à leur date d&apos;émission (même règle que le « facturé » des budgets). La facture de solde est nette de l&apos;acompte déjà facturé : un acompte de 300 € puis un solde net de 700 € comptent 1 000 €. Une facture annulée par un avoir total ne compte plus (contribution nulle). Brouillons et paiements exclus.</p>
        <p><strong>Articles les plus vendus</strong> = montant HT des lignes d&apos;articles des factures émises, hors déduction d&apos;acompte, moins les lignes d&apos;articles des avoirs émis (un avoir total retire les articles de la facture annulée ; un avoir partiel ne porte pas d&apos;article dans la facturation : il réduit le chiffre d&apos;affaires mais pas ce classement). Les factures d&apos;acompte ne sont jamais comptées comme des ventes d&apos;articles. La déduction d&apos;acompte n&apos;étant pas répartie par article, la somme des articles n&apos;est pas le chiffre d&apos;affaires net.</p>
        <p>Les classements montrent les 10 premiers ; un client, un chantier ou un article dont le solde net est nul n&apos;est pas classé.</p>
      </section>
    </div>
  )
}
