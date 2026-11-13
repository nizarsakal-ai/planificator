import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireInvoiceImportPage } from "@/lib/invoice-import/access"
import { getBatchView } from "@/lib/invoice-import/import.service"
import { Card, CardContent } from "@/components/ui/card"
import { InvoiceImportPreview } from "@/components/factures/InvoiceImportPreview"
import { InvoiceImportStart } from "@/components/factures/InvoiceImportStart"

export const metadata: Metadata = { title: "Aperçu de l’import" }
export const dynamic = "force-dynamic"

export default async function ImportPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireInvoiceImportPage()
  const { id } = await params
  if (!id || id.length > 64) notFound()
  const view = await getBatchView(prisma, ctx, id)
  if (!view) notFound()

  if (view.status !== "PREVIEW") {
    const s = view.summary
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Import {view.status === "COMMITTED" ? "validé" : "annulé"}</h1>
        {view.status === "COMMITTED" && <Card><CardContent className="p-4 text-sm">{s.toImport} pièce(s) importée(s), {s.toAttach} PDF ajouté(s), {s.skipped} ignorée(s){s.supplier > 0 ? `, ${s.supplier} facture(s) fournisseur non importée(s)` : ""}.</CardContent></Card>}
        <div className="flex gap-4 text-sm"><Link className="underline" href="/factures/importees">Factures importées</Link><Link className="underline" href="/factures/import">Nouvel import</Link></div>
      </div>
    )
  }

  const [clients, worksites] = await Promise.all([
    prisma.client.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.worksite.findMany({ where: { companyId: ctx.companyId, archivedAt: null }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, clientId: true } }),
  ])
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Aperçu de l’import</h1>
        <p className="mt-1 text-sm text-slate-500">Vérifiez et corrigez chaque ligne. Rien n’est enregistré avant « Valider l’import ».</p>
      </div>
      <InvoiceImportPreview key={view.version} batchId={view.id} version={view.version} analyzed={view.analyzed} summary={view.summary} table={view.table} clients={clients} worksites={worksites} />
      <InvoiceImportStart batchId={view.id} />
    </div>
  )
}
