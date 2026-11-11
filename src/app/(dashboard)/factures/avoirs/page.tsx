import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireBillingPage } from "@/lib/billing/access"
import { invoiceFiltersFromParams } from "@/lib/billing/invoices/invoice-filters"
import { listInvoices } from "@/lib/billing/invoices/invoice-queries"
import { formatEuro } from "@/lib/billing/money"
import { prisma } from "@/lib/prisma"

export const metadata: Metadata = { title: "Avoirs" }

const dateFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeZone: "UTC" })

export default async function CreditNotesPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const { companyId } = await requireBillingPage()
  const { page } = invoiceFiltersFromParams(await searchParams)
  const list = await listInvoices(prisma, companyId, { kind: "CREDIT_NOTE", page })
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Avoirs</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/factures">Voir les factures</Link></Button>
          <Button asChild><Link href="/factures/avoirs/nouveau">Nouvel avoir</Link></Button>
        </div>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3">Numéro</th>
                <th scope="col" className="px-4 py-3">Client</th>
                <th scope="col" className="px-4 py-3">Date</th>
                <th scope="col" className="px-4 py-3 text-right">Montant TTC</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">Aucun avoir sur cette page.</td></tr>}
              {list.rows.map((note) => (
                <tr key={note.id} className="border-t">
                  <td className="px-4 py-3"><Link className="font-medium underline" href={`/factures/${note.id}`}>{note.number}</Link></td>
                  <td className="px-4 py-3">{note.clientName}</td>
                  <td className="px-4 py-3">{dateFr.format(note.issueDate)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatEuro(-note.totalTTCCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {(pages > 1 || list.page > 1) && (
        <nav aria-label="Pagination des avoirs" className="flex flex-wrap items-center gap-3 text-sm">
          <span>Page {list.page} / {pages}</span>
          {list.page > 1 && <Link className="underline" href={`/factures/avoirs?page=${Math.min(pages, list.page - 1)}`}>Précédente</Link>}
          {list.page < pages && <Link className="underline" href={`/factures/avoirs?page=${list.page + 1}`}>Suivante</Link>}
        </nav>
      )}
    </div>
  )
}
