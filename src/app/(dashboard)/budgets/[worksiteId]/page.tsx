// Lot C Planificator V2 : budget et marge d'un chantier — comparaison par nature (prévu, engagé, réel), recettes
// (devis signés, facturé), historique IMMUABLE des versions, révision avec motif, imputation de factures fournisseurs.
// Drapeau WORKSITE_BUDGET_ENABLED + ADMIN/SUPER_ADMIN ; un chantier d'une autre entreprise donne 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Download, PiggyBank } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { budgetPageAccess } from "@/lib/budget/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getWorksiteBudget, listAllocatableInvoices } from "@/lib/budget/queries"
import { ALLOCATION_NATURES, COST_NATURES, COST_NATURE_LABEL, type WorksiteCostNature } from "@/lib/budget/budget.core"
import { allocateSupplierInvoiceAction, cancelAllocationAction, createBudgetAction, reviseBudgetAction } from "@/lib/actions/budget.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { fmtInstant } from "@/components/equipment/labels"
import { centsToInput, fmtBp, formatEuro, signedClass } from "@/components/budget/format"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const INVOICE_STATUS_LABEL: Record<string, string> = { PENDING: "en attente", VALIDATED: "validée", REJECTED: "refusée" }

export default async function WorksiteBudgetPage({ params, searchParams }: { params: Promise<{ worksiteId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await budgetPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (même règle que les lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { worksiteId } = await params
  if (!ID.test(worksiteId)) notFound()
  const flash = await searchParams
  const data = await getWorksiteBudget(prisma, ctx.companyId, worksiteId)
  if (!data) notFound()
  const { worksite, margin: m, budget, allocations } = data
  const invoices = await listAllocatableInvoices(prisma, ctx.companyId)
  const current = budget?.revisions.find((r) => r.number === budget.currentRevision) ?? null
  const currentAmount = (n: WorksiteCostNature) => current?.lines.find((l) => l.nature === n)
  const hidden = <input type="hidden" name="worksiteId" value={worksite.id} />
  const versionFields = (
    <>
      <label className="text-sm sm:col-span-2 lg:col-span-3"><span className="text-xs uppercase text-slate-500">Recette prévue HT (€)</span>
        <Input name="plannedRevenue" inputMode="decimal" defaultValue={current ? centsToInput(current.plannedRevenueCents) : ""} placeholder="0,00" className="mt-1" /></label>
      {COST_NATURES.map((n) => (
        <div key={n} className="grid gap-1">
          <span className="text-xs uppercase text-slate-500">{COST_NATURE_LABEL[n]} (€ HT)</span>
          <Input name={`amount_${n}`} inputMode="decimal" defaultValue={centsToInput(currentAmount(n)?.amountCents ?? BigInt(0))} placeholder="0,00" aria-label={`Budget ${COST_NATURE_LABEL[n]}`} />
          <Input name={`label_${n}`} maxLength={200} defaultValue={currentAmount(n)?.label ?? ""} placeholder="Précision (facultatif)" aria-label={`Précision ${COST_NATURE_LABEL[n]}`} />
        </div>
      ))}
    </>
  )
  const kpi = (label: string, cents: bigint, sub?: string, signed = false) => (
    <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">{label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${signed ? signedClass(cents) : ""}`}>{formatEuro(cents)}</p>{sub && <p className="text-xs text-slate-500">{sub}</p>}</CardContent></Card>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/budgets" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:underline"><ArrowLeft className="h-4 w-4" /> Budgets et marges</Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-900"><PiggyBank className="h-6 w-6 text-[#0f3460]" /> {worksite.name}</h1>
          <p className="mt-1 text-sm text-slate-500">{worksite.clientName}{worksite.archived ? " · chantier archivé (budget en lecture seule)" : ""} · {budget ? `budget version ${budget.currentRevision}` : "aucun budget"} · montants HT</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href={`/chantiers/${worksite.id}`}>Fiche chantier</Link></Button>
          <Button variant="outline" asChild><a href={`/budgets/export?chantier=${worksite.id}`}><Download className="h-4 w-4" /> Export CSV</a></Button>
        </div>
      </div>
      <StockFlash params={flash} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpi("Marge prévue", m.plannedMarginCents, `${fmtBp(m.plannedMarginBp)} de la recette prévue`, true)}
        {kpi("Marge à date", m.currentMarginCents, `facturé − réel · ${fmtBp(m.currentMarginBp)}`, true)}
        {kpi("Marge estimée", m.forecastMarginCents, `à terminaison · ${fmtBp(m.forecastMarginBp)}`, true)}
        {kpi("Reste à facturer", m.toInvoiceCents, `devis signés ${formatEuro(m.signedQuotesHTCents)} · facturé ${formatEuro(m.invoicedHTCents)}`)}
      </div>

      {m.anomalies.length > 0 && (
        <div role="status" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <p className="font-medium">Points à vérifier</p>
          <ul className="list-disc pl-5">{m.anomalies.map((a) => <li key={a.code}>{a.message}</li>)}</ul>
        </div>
      )}

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Coûts du chantier par nature : prévu, engagé, réel</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Nature</th><th className="px-3 py-2 text-right">Prévu</th><th className="px-3 py-2 text-right">Engagé</th><th className="px-3 py-2 text-right">Réel</th><th className="hidden px-3 py-2 text-right md:table-cell">Reste</th><th className="hidden px-3 py-2 text-right md:table-cell">Consommé</th></tr></thead>
          <tbody>
            {m.natures.map((n) => (
              <tr key={n.nature} className="border-t">
                <td className="px-3 py-2 font-medium">{COST_NATURE_LABEL[n.nature]}{n.nature === "LABOR" && <span className="ml-1 text-xs font-normal text-slate-500">(réel non calculé)</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(n.plannedCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(n.committedCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(n.actualCents)}</td>
                <td className={`hidden px-3 py-2 text-right tabular-nums md:table-cell ${signedClass(n.remainingCents)}`}>{formatEuro(n.remainingCents)}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{fmtBp(n.consumedBp)}</td>
              </tr>
            ))}
            <tr className="border-t bg-slate-50 font-semibold">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatEuro(m.plannedCostCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatEuro(m.committedCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatEuro(m.actualCents)}</td>
              <td className={`hidden px-3 py-2 text-right tabular-nums md:table-cell ${signedClass(m.plannedCostCents - m.actualCents - m.committedCents)}`}>{formatEuro(m.plannedCostCents - m.actualCents - m.committedCents)}</td>
              <td className="hidden px-3 py-2 md:table-cell" />
            </tr>
          </tbody>
        </table>
      </CardContent></Card>
      <p className="text-xs text-slate-500">
        Les commandes d&apos;achat sont rangées en « Matériaux et fournitures » ; suivez une sous-traitance par l&apos;imputation de sa facture. Réel : sorties de stock vers le chantier (dernier prix d&apos;achat connu à leur date), achats directs reçus sans article, locations clôturées, matériel propre rendu, frais de véhicules validés imputés aux trajets du chantier, factures fournisseurs validées imputées. Engagé : reste à recevoir des commandes passées, locations en cours, factures imputées en attente.
        {m.receivedArticlesCumulativeCents > BigInt(0) && <> Cumul historique des réceptions d&apos;articles des commandes de ce chantier : {formatEuro(m.receivedArticlesCumulativeCents)} (au prix de commande, sorties non déduites : ce n&apos;est pas un solde de stock ; le coût est compté à chaque sortie).</>}
      </p>

      {!worksite.archived && (
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">{budget ? `Réviser le budget (nouvelle version ${budget.currentRevision + 1})` : "Budget initial"}</h2>
          <form action={budget ? reviseBudgetAction : createBudgetAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{hidden}
            {budget && <input type="hidden" name="expectedRevision" value={budget.currentRevision} />}
            {versionFields}
            {budget && <label className="text-sm sm:col-span-2 lg:col-span-3"><span className="text-xs uppercase text-slate-500">Motif de la révision (obligatoire)</span><Input name="reason" required minLength={3} maxLength={500} className="mt-1" placeholder="Ex. avenant n° 2 signé, ajout du lot peinture" /></label>}
            <div className="sm:col-span-2 lg:col-span-3"><Button type="submit">{budget ? "Enregistrer la révision" : "Enregistrer le budget"}</Button>{budget && <span className="ml-2 text-xs text-slate-500">Les versions précédentes restent consultables et ne sont jamais modifiées.</span>}</div>
          </form>
        </CardContent></Card>
      )}

      {budget && (
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Historique des versions</h2>
          <ol className="space-y-3">
            {budget.revisions.map((r) => (
              <li key={r.id} className="rounded-lg border p-3">
                <p className="text-sm font-medium">Version {r.number} {r.kind === "INITIAL" ? "(initiale)" : "(révision)"}{r.number === budget.currentRevision && <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">en vigueur</span>}</p>
                <p className="text-xs text-slate-500">{fmtInstant(r.createdAt)} · {r.authorName}{r.reason ? ` · motif : ${r.reason}` : ""}</p>
                <p className="mt-1 text-sm">Recette prévue {formatEuro(r.plannedRevenueCents)} · coûts prévus {formatEuro(r.totalCostCents)} · marge {formatEuro(r.plannedRevenueCents - r.totalCostCents)}</p>
                {r.lines.length > 0 && <p className="mt-1 text-xs text-slate-500">{r.lines.map((l) => `${COST_NATURE_LABEL[l.nature]} ${formatEuro(l.amountCents)}${l.label ? ` (${l.label})` : ""}`).join(" · ")}</p>}
              </li>
            ))}
          </ol>
        </CardContent></Card>
      )}

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Factures fournisseurs imputées</h2>
        <p className="text-xs text-slate-500">Pour les factures sans réception ni location liées (sous-traitance, prestations, frais). Une facture déjà rattachée à une réception ou à une location est comptée par celle-ci et ne peut pas être imputée.</p>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Facture</th><th className="hidden px-3 py-2 md:table-cell">Nature</th><th className="px-3 py-2 text-right">Montant HT</th><th className="px-3 py-2" /></tr></thead>
          <tbody>
            {allocations.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucune imputation.</td></tr>}
            {allocations.map((a) => (
              <tr key={a.id} className={`border-t ${a.cancelledAt ? "text-slate-400 line-through" : ""}`}>
                <td className="px-3 py-2">{a.supplierInvoice.number} · {a.supplierInvoice.supplierName}<div className="text-xs text-slate-500 no-underline">{INVOICE_STATUS_LABEL[a.supplierInvoice.status] ?? a.supplierInvoice.status}{a.label ? ` · ${a.label}` : ""}{a.cancelledAt ? ` · annulée le ${fmtInstant(a.cancelledAt)}` : ""}</div></td>
                <td className="hidden px-3 py-2 md:table-cell">{COST_NATURE_LABEL[a.nature]}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatEuro(a.amountHTCents)}</td>
                <td className="px-3 py-2 text-right">{!a.cancelledAt && <form action={cancelAllocationAction}>{hidden}<input type="hidden" name="allocationId" value={a.id} /><Button type="submit" variant="outline" size="sm">Annuler</Button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {invoices.length > 0 ? (
          <form action={allocateSupplierInvoiceAction} className="grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-5">{hidden}
            <select name="supplierInvoiceId" required defaultValue="" className={`${SELECT_CLASS} lg:col-span-2`} aria-label="Facture fournisseur">
              <option value="" disabled>Facture fournisseur…</option>
              {invoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.supplierName} · reste {formatEuro(i.remainingHTCents)} HT ({INVOICE_STATUS_LABEL[i.status] ?? i.status})</option>)}
            </select>
            <select name="nature" required defaultValue="SUBCONTRACTING" className={SELECT_CLASS} aria-label="Nature">{ALLOCATION_NATURES.map((n) => <option key={n} value={n}>{COST_NATURE_LABEL[n]}</option>)}</select>
            <Input name="amount" required inputMode="decimal" placeholder="Montant HT (€)" aria-label="Montant HT à imputer" />
            <Input name="label" maxLength={200} placeholder="Précision" aria-label="Précision" />
            <div className="sm:col-span-2 lg:col-span-5"><Button type="submit" variant="secondary">Imputer au chantier</Button></div>
          </form>
        ) : <p className="border-t pt-3 text-xs text-slate-500">Aucune facture fournisseur imputable (toutes refusées, rattachées ou entièrement imputées).</p>}
      </CardContent></Card>
    </div>
  )
}
