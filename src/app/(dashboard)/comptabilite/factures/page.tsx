import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { isAccountingAutoPostingEnabled } from "@/lib/billing/billing-feature-flag"
import { postingOverview } from "@/lib/accounting/c5/postings"
import { formatEuro, decimalToCents } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { PostMissingButton } from "@/components/comptabilite/C5Actions"

export const metadata: Metadata = { title: "Comptabilité — Écritures depuis les factures" }

export default async function EcrituresFacturesPage() {
  const ctx = await requireAccountingPage()
  const { postings, invoices, payments, suppliers } = await postingOverview(prisma, ctx)
  const byDoc = new Map(postings.map((p) => [`${p.sourceType}|${p.sourceId}`, p]))
  const kindOf = (k: string) => (k === "CREDIT_NOTE" ? "CREDIT_NOTE" : k === "DEPOSIT" ? "DEPOSIT" : "INVOICE")
  const missingDocs = invoices.filter((i) => !byDoc.has(`${kindOf(i.kind)}|${i.id}`)).length
  const postedPayments = postings.filter((p) => p.sourceType === "PAYMENT").length
  const postedSuppliers = postings.filter((p) => p.sourceType === "SUPPLIER_INVOICE").length
  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-3 p-4 text-sm">
        <p className="text-slate-700">Chaque pièce émise ou validée (facture, acompte, avoir, paiement, facture fournisseur) donne lieu à une écriture sourcée et idempotente du moteur comptable (journaux VT, BQ, HA). Génération automatique : <strong>{isAccountingAutoPostingEnabled() ? "activée" : "désactivée"}</strong> (drapeau serveur) ; la génération manuelle ci-dessous ne crée jamais de doublon.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Pièces de vente sans écriture</p><p className="text-lg font-semibold">{missingDocs} / {invoices.length}</p></div>
          <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Paiements comptabilisés</p><p className="text-lg font-semibold">{postedPayments} / {payments}</p></div>
          <div className="rounded bg-slate-50 p-3"><p className="text-xs uppercase text-slate-500">Factures fournisseurs comptabilisées</p><p className="text-lg font-semibold">{postedSuppliers} / {suppliers}</p></div>
        </div>
        <PostMissingButton />
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Pièce</th><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">TTC</th><th className="px-3 py-2">Écriture</th></tr></thead>
          <tbody>{invoices.map((i) => { const p = byDoc.get(`${kindOf(i.kind)}|${i.id}`); return (
            <tr key={i.id} className="border-t"><td className="px-3 py-2"><Link className="underline" href={`/factures/${i.id}`}>{i.number}</Link> <span className="text-xs text-slate-400">{i.kind === "CREDIT_NOTE" ? "avoir" : i.kind === "DEPOSIT" ? "acompte" : "facture"} · {i.status}</span></td><td className="px-3 py-2">{dateFr.format(i.issueDate)}</td><td className="px-3 py-2 text-right tabular-nums">{formatEuro(decimalToCents(i.totalTTC))}</td><td className="px-3 py-2">{p ? <Link className="underline" href={`/comptabilite/ecritures/${p.entryId}`}>{p.entry.journal.code} n° {p.entry.number}</Link> : <span className="text-amber-700">à générer</span>}</td></tr>) })}</tbody></table>
      </CardContent></Card>
    </div>
  )
}
