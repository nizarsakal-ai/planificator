import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { searchParam } from "@/lib/accounting/ui/labels"
import { CATEGORY_LABEL, listSupplierInvoices } from "@/lib/accounting/c5/supplier-invoice.service"
import { formatEuro } from "@/lib/billing/money"
import { isBillingOcrEnabled } from "@/lib/billing/billing-feature-flag"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export const metadata: Metadata = { title: "Comptabilité — Factures fournisseurs" }
const STATUS: Record<string, { label: string; cls: string }> = { PENDING: { label: "À valider", cls: "bg-amber-50 text-amber-700" }, VALIDATED: { label: "Validée", cls: "bg-green-50 text-green-700" }, REJECTED: { label: "Rejetée", cls: "bg-red-50 text-red-600" } }

export default async function FournisseursPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const st = searchParam(sp.statut)
  const status = st === "PENDING" || st === "VALIDATED" || st === "REJECTED" ? st : undefined
  const q = searchParam(sp.q) ?? ""
  const list = await listSupplierInvoices(prisma, ctx, { search: q || undefined, status, page: Number(searchParam(sp.page) ?? 1) || 1 })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form method="get" className="flex flex-wrap gap-2"><Input name="q" placeholder="Fournisseur, n°, SIRET / SIREN" defaultValue={q} className="w-64" aria-label="Recherche" />
          <select name="statut" defaultValue={status ?? ""} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Statut"><option value="">Tous</option><option value="PENDING">À valider</option><option value="VALIDATED">Validées</option><option value="REJECTED">Rejetées</option></select>
          <Button type="submit" variant="secondary">Filtrer</Button></form>
        <Button asChild><Link href="/comptabilite/fournisseurs/nouvelle">Scanner / importer une facture</Link></Button>
      </div>
      <p className="text-xs text-slate-500">Extraction automatique (OCR Claude) : {isBillingOcrEnabled() ? "activée" : "désactivée — saisie manuelle après import du fichier"}. Les valeurs extraites doivent toujours être vérifiées avant validation.</p>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Fournisseur</th><th className="px-3 py-2">N°</th><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">HT</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">TTC</th><th className="hidden px-3 py-2 md:table-cell">Compte de charge</th><th className="px-3 py-2">Statut</th></tr></thead>
          <tbody>
            {list.rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">Aucune facture fournisseur.</td></tr>}
            {list.rows.map((s) => <tr key={s.id} className="border-t hover:bg-slate-50">
              <td className="px-3 py-2"><Link className="font-medium text-[#0f3460] hover:underline" href={`/comptabilite/fournisseurs/${s.id}`}>{s.supplier?.name ?? s.supplierName}</Link>{s.siret && <div className="text-xs text-slate-400">SIRET {s.siret}</div>}</td>
              <td className="px-3 py-2">{s.number}</td><td className="px-3 py-2">{dateFr.format(s.date)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatEuro(s.totalHTCents)}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(s.vatCents)}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(s.totalTTCCents)}</td>
              <td className="hidden px-3 py-2 md:table-cell">{s.expenseAccount ? `${s.expenseAccount.number} ${s.expenseAccount.label}` : s.category ? CATEGORY_LABEL[s.category] : "—"}</td>
              <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[s.status]?.cls}`}>{STATUS[s.status]?.label ?? s.status}</span>{s.paidAt && <div className="text-xs text-slate-400">payée {dateFr.format(s.paidAt)}</div>}</td>
            </tr>)}
          </tbody></table>
        {list.total > list.pageSize && <div className="flex justify-between border-t px-3 py-2 text-sm"><span>Page {list.page} / {Math.ceil(list.total / list.pageSize)}</span></div>}
      </CardContent></Card>
    </div>
  )
}
