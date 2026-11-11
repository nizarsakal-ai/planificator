import type { Metadata } from "next"
import type { Prisma } from "@prisma/client"
import Link from "next/link"
import { notFound } from "next/navigation"
import { CreditNoteDialog } from "@/components/factures/CreditNoteDialog"
import { InvoiceActions } from "@/components/factures/InvoiceActions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { searchParam } from "@/lib/accounting/ui/labels"
import { requireBillingPage } from "@/lib/billing/access"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { formatEuro } from "@/lib/billing/money"
import { prisma } from "@/lib/prisma"

export const metadata: Metadata = { title: "Nouvel avoir" }
const path = "/factures/avoirs/nouveau"
const pageSize = 30

export default async function NewCreditNotePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { companyId } = await requireBillingPage()
  const params = await searchParams
  const invoiceId = searchParam(params.facture)
  const eligible: Prisma.InvoiceWhereInput = {
    companyId,
    status: { in: ["SENT", "PARTIAL", "PAID"] },
    OR: [
      { kind: "INVOICE", creditNotes: { none: { creditScope: "TOTAL" } } },
      { kind: "DEPOSIT", creditNotes: { none: {} }, deductedBy: { none: { releasedAt: null } } },
    ],
  }

  if (invoiceId) {
    const original = await prisma.invoice.findFirst({ where: { ...eligible, id: invoiceId }, select: { id: true } })
    if (!original) notFound()
    const invoice = await getInvoiceDetail(prisma, companyId, original.id)
    if (!invoice || invoice.kind === "CREDIT_NOTE" || !["SENT", "PARTIAL", "PAID"].includes(invoice.status)) notFound()
    const canCreditTotal = invoice.creditNotes.length === 0
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Nouvel avoir</h1>
        <Button variant="outline" asChild><Link href={path}>Changer de facture</Link></Button>
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="font-semibold">{invoice.number} · {invoice.client.name}</h2>
          <p className="text-sm text-slate-500">{invoice.worksite.name} · {formatEuro(invoice.totalTTCCents)} TTC</p>
          <div className="flex flex-wrap gap-2">
            {invoice.creditable && <CreditNoteDialog invoiceId={invoice.id} remainingLabel={formatEuro(invoice.creditableCents)} lines={invoice.lines.filter((line) => !line.deductsDepositId && line.unitPrice.toNumber() > 0).map((line) => ({
              id: line.id,
              designation: line.designation,
              quantity: line.quantity.toFixed(2).replace(/\.?0+$/, ""),
              unitPrice: line.unitPrice.toFixed(2),
            }))} />}
            {canCreditTotal && <InvoiceActions id={invoice.id} status={invoice.status} kind={invoice.kind} hasEmail={false} payable={false} creditOnly />}
          </div>
          {!canCreditTotal && !invoice.creditable && <p className="text-sm">Cette facture ne permet plus d’émettre un avoir.</p>}
        </CardContent></Card>
      </div>
    )
  }

  const q = (searchParam(params.q) ?? "").trim().slice(0, 100)
  const page = Math.max(1, Math.min(10_000, Math.trunc(Number(searchParam(params.page)) || 1)))
  const where: Prisma.InvoiceWhereInput = q
    ? { AND: [eligible, { OR: [
      { number: { contains: q, mode: "insensitive" } },
      { client: { name: { contains: q, mode: "insensitive" } } },
      { worksite: { name: { contains: q, mode: "insensitive" } } },
    ] }] }
    : eligible
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ issueDate: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: { id: true, number: true, client: { select: { name: true } }, worksite: { select: { name: true } } },
  })
  const pageHref = (value: number) => `${path}?${new URLSearchParams({ q, page: String(value) })}`

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Nouvel avoir</h1>
      <p className="text-sm text-slate-600">Sélectionnez la facture d’origine. Le client et le chantier de l’avoir en découlent.</p>
      <form action={path} className="flex flex-wrap gap-2">
        <Input name="q" defaultValue={q} maxLength={100} aria-label="Rechercher une facture" placeholder="Numéro, client ou chantier" className="max-w-sm" />
        <Button type="submit" variant="outline">Rechercher</Button>
      </form>
      {invoices.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {invoices.slice(0, pageSize).map((invoice) => (
            <li key={invoice.id}>
              <Link className="block p-3 hover:underline" href={`${path}?${new URLSearchParams({ facture: invoice.id })}`}>
                <span className="font-semibold">{invoice.number}</span> · {invoice.client.name} · {invoice.worksite.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">
            {q ? "Aucune facture ne correspond à cette recherche." : "Aucune facture disponible sur cette page. Un avoir nécessite une facture déjà émise."}
          </p>
          {!q && page === 1 && (
            <Button asChild><Link href="/factures/nouvelle">Nouvelle facture</Link></Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {page > 1 && <Button variant="outline" asChild><Link href={pageHref(page - 1)}>Précédente</Link></Button>}
        {invoices.length > pageSize && <Button variant="outline" asChild><Link href={pageHref(page + 1)}>Suivante</Link></Button>}
        <Button variant="outline" asChild><Link href="/factures/avoirs">Retour aux avoirs</Link></Button>
      </div>
    </div>
  )
}
