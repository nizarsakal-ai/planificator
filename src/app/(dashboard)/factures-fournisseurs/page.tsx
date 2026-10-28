import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireIntakePage } from "@/lib/supplier-intake/pages"
import { intakeInvoiceScope } from "@/lib/supplier-intake/access.core"
import { formatEuro } from "@/lib/billing/money"
import { dateFr } from "@/lib/accounting/ui/page-context"
import { isBillingOcrEnabled } from "@/lib/billing/billing-feature-flag"
import { Button } from "@/components/ui/button"
export default async function SupplierIntakePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireIntakePage()
  const rawPage = Number((await searchParams).page ?? 1)
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.min(10000, Math.trunc(rawPage))) : 1
  const where = intakeInvoiceScope(ctx)
  const [total, invoices] = await Promise.all([
    prisma.supplierInvoice.count({ where }),
    prisma.supplierInvoice.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, skip: (page - 1) * 50,
      select: { id: true, supplierName: true, number: true, date: true, totalTTCCents: true, status: true } }),
  ])
  return <div className="space-y-4">
    <Button asChild><Link href="/factures-fournisseurs/nouvelle">Scanner / importer une facture</Link></Button>
    <p className="text-sm text-slate-500">Mes dépôts uniquement. OCR {isBillingOcrEnabled() ? "disponible : vérifiez chaque valeur extraite." : "désactivé : import et saisie manuelle disponibles."}</p>
    <div className="overflow-x-auto rounded-lg border bg-white"><table className="w-full text-sm"><thead><tr><th className="p-3 text-left">Fournisseur / N°</th><th className="p-3">Date</th><th className="p-3">TTC</th><th className="p-3">Statut</th></tr></thead><tbody>
      {invoices.length === 0 && <tr><td colSpan={4} className="p-6 text-center">Aucun dépôt.</td></tr>}
      {invoices.map(i => <tr key={i.id} className="border-t"><td className="p-3"><Link className="text-blue-900 underline" href={`/factures-fournisseurs/${i.id}`}>{i.supplierName} — {i.number}</Link></td><td className="p-3 text-center">{dateFr.format(i.date)}</td><td className="p-3 text-center">{formatEuro(i.totalTTCCents)}</td><td className="p-3 text-center">{i.status === "PENDING" ? "À valider" : i.status === "VALIDATED" ? "Validée" : "Rejetée"}</td></tr>)}
    </tbody></table></div>
    <nav aria-label="Pages des factures" className="flex gap-4">{page > 1 && <Link href={`?page=${page - 1}`}>Précédente</Link>}{page * 50 < total && <Link href={`?page=${page + 1}`}>Suivante</Link>}</nav>
  </div>
}
