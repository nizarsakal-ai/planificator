import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireInvoiceImportPage } from "@/lib/invoice-import/access"
import { Card, CardContent } from "@/components/ui/card"
import { InvoiceImportStart } from "@/components/factures/InvoiceImportStart"

export const metadata: Metadata = { title: "Importer des factures" }
const dateFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })
const SOURCE: Record<string, string> = { TIIME: "Tiime", OTHER: "Autre logiciel", PDF: "PDF" }

export default async function ImportFacturesPage() {
  const ctx = await requireInvoiceImportPage()
  const pending = await prisma.invoiceImportBatch.findMany({ where: { companyId: ctx.companyId, status: "PREVIEW" }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, sourceSystem: true, sourceLabel: true, createdAt: true } })
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Importer des factures</h1>
        <p className="mt-1 text-sm text-slate-500">Factures clients et avoirs émis dans Tiime ou un autre logiciel. Rien n’est enregistré avant votre validation de l’aperçu ; l’import ne consomme aucun numéro de facture et ne déclenche ni envoi, ni règlement, ni écriture comptable.</p>
      </div>
      <InvoiceImportStart />
      <p className="text-sm text-slate-500">Facture <strong>fournisseur</strong> ? Utilisez <Link className="underline" href="/comptabilite/fournisseurs/nouvelle">Comptabilité → Factures fournisseurs → Scanner / importer une facture</Link>.</p>
      {pending.length > 0 && (
        <Card><CardContent className="p-4">
          <h2 className="text-sm font-semibold text-slate-700">Imports en cours (non validés)</h2>
          <ul className="mt-2 space-y-1 text-sm">{pending.map((b) => <li key={b.id}><Link className="text-[#0f3460] underline" href={`/factures/import/${b.id}`}>{b.sourceLabel ?? SOURCE[b.sourceSystem] ?? b.sourceSystem} — {dateFr.format(b.createdAt)}</Link></li>)}</ul>
        </CardContent></Card>
      )}
      <Link className="text-sm underline" href="/factures/importees">Voir les factures importées</Link>
    </div>
  )
}
