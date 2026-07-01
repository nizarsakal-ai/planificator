import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { FileText } from "lucide-react"
import {
  NouvelleFactureDialog,
  type WorksiteOption,
  type ArticleOption,
} from "@/components/factures/NouvelleFactureDialog"
import { InvoiceStatusButtons } from "@/components/factures/InvoiceStatusButtons"

export const metadata: Metadata = { title: "Factures" }

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
const dfmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" })

const STATUS_META: Record<string, { label: string; className: string }> = {
  DRAFT:     { label: "Brouillon", className: "bg-slate-100 text-slate-600" },
  SENT:      { label: "Envoyée",   className: "bg-blue-50 text-blue-600" },
  PAID:      { label: "Payée",     className: "bg-green-50 text-green-600" },
  CANCELLED: { label: "Annulée",   className: "bg-red-50 text-red-500" },
}

export default async function FacturesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const companyId = session.user.companyId!

  const [invoicesRaw, worksitesRaw, articlesRaw] = await Promise.all([
    prisma.invoice.findMany({
      where:   { companyId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, number: true, status: true, totalTTC: true,
        periodStart: true, periodEnd: true, sentAt: true,
        worksite: { select: { name: true } },
        client:   { select: { name: true } },
      },
    }),
    prisma.worksite.findMany({
      where:   { companyId, archivedAt: null },
      orderBy: { startDate: "desc" },
      select: { id: true, name: true, startDate: true, endDate: true, client: { select: { name: true } } },
    }),
    prisma.article.findMany({
      where:   { companyId, active: true },
      orderBy: { designation: "asc" },
      select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true },
    }),
  ])

  const invoices = invoicesRaw.map((inv) => ({
    id:          inv.id,
    number:      inv.number,
    status:      inv.status,
    totalTTC:    inv.totalTTC.toNumber(),
    periodStart: inv.periodStart,
    periodEnd:   inv.periodEnd,
    sentAt:      inv.sentAt,
    worksite:    inv.worksite.name,
    client:      inv.client.name,
  }))

  const worksites: WorksiteOption[] = worksitesRaw.map((w) => ({
    id:         w.id,
    name:       w.name,
    clientName: w.client.name,
    startDate:  dfmt.format(w.startDate),
    endDate:    dfmt.format(w.endDate),
  }))

  const articles: ArticleOption[] = articlesRaw.map((a) => ({
    id:          a.id,
    designation: a.designation,
    unit:        a.unit,
    unitPrice:   a.unitPrice.toNumber(),
    vatRate:     a.vatRate.toNumber(),
  }))

  const kpi = {
    draft: invoices.filter((i) => i.status === "DRAFT").length,
    sent:  invoices.filter((i) => i.status === "SENT").length,
    paid:  invoices.filter((i) => i.status === "PAID").length,
  }

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FileText className="h-6 w-6 text-[#0f3460]" />
            Factures
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {invoices.length} facture{invoices.length > 1 ? "s" : ""} · suivi devis &amp; facturation par chantier
          </p>
        </div>
        <NouvelleFactureDialog worksites={worksites} articles={articles} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="py-4">
          <p className="text-xs text-slate-500">Brouillons</p>
          <p className="text-2xl font-bold text-slate-700">{kpi.draft}</p>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs text-slate-500">Envoyées</p>
          <p className="text-2xl font-bold text-blue-600">{kpi.sent}</p>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs text-slate-500">Payées</p>
          <p className="text-2xl font-bold text-green-600">{kpi.paid}</p>
        </CardContent></Card>
      </div>

      {/* Liste */}
      {invoices.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <FileText className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune facture pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouvelle facture&quot; pour en créer une.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-slate-500">
                    <th className="px-4 py-3 font-medium">Numéro</th>
                    <th className="px-4 py-3 font-medium">Chantier</th>
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Période</th>
                    <th className="px-4 py-3 font-medium text-right">Total TTC</th>
                    <th className="px-4 py-3 font-medium">Statut</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const meta = STATUS_META[inv.status] ?? STATUS_META.DRAFT
                    return (
                      <tr key={inv.id} className="border-b last:border-0 hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-mono text-xs text-slate-600">{inv.number}</td>
                        <td className="px-4 py-3 font-medium text-slate-800">{inv.worksite}</td>
                        <td className="px-4 py-3 text-slate-500">{inv.client}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs tabular-nums">
                          {inv.periodStart && inv.periodEnd
                            ? `${dfmt.format(inv.periodStart)} → ${dfmt.format(inv.periodEnd)}`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">
                          {eur.format(inv.totalTTC)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <InvoiceStatusButtons id={inv.id} status={inv.status} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
