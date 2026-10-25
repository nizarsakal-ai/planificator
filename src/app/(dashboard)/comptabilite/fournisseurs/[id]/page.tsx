import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { listAccounts } from "@/lib/accounting/engine/queries"
import { getSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { findPostingFor } from "@/lib/accounting/c5/postings"
import { bpToPercentString, formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { SupplierInvoiceForm } from "@/components/comptabilite/SupplierInvoiceForm"
import { SupplierValidateButtons } from "@/components/comptabilite/C5Actions"

export const metadata: Metadata = { title: "Facture fournisseur" }

export default async function FournisseurDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAccountingPage()
  const { id } = await params
  const s = await getSupplierInvoice(prisma, ctx, id)
  if (!s) notFound()
  const accounts = (await listAccounts(prisma, ctx)).filter((a) => a.active && /^6/.test(a.number))
  const posting = await findPostingFor(prisma, ctx, "SUPPLIER_INVOICE", s.id)
  const confidence = (s.ocrConfidence ?? {}) as Record<string, number>
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500"><Link href="/comptabilite/fournisseurs" className="hover:underline">Factures fournisseurs</Link> / {s.number}</p>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-xl font-semibold">{s.supplierName} — {s.number} <span className="text-sm font-normal text-slate-500">({s.status === "PENDING" ? "à valider" : s.status === "VALIDATED" ? "validée" : "rejetée"})</span></h2>
        {s.status === "PENDING" && <SupplierValidateButtons id={s.id} />}
      </div>
      {s.status !== "PENDING" ? (
        <Card><CardContent className="grid gap-2 p-4 text-sm sm:grid-cols-2">
          <p>Fournisseur : <strong>{s.supplier?.name ?? s.supplierName}</strong>{s.siret ? ` — SIRET ${s.siret}` : ""}</p><p>Date : {dateFr.format(s.date)}{s.dueDate ? ` · échéance ${dateFr.format(s.dueDate)}` : ""}</p>
          <p>HT {formatEuro(s.totalHTCents)} · TVA {formatEuro(s.vatCents)}{s.vatRateBp !== null ? ` (${bpToPercentString(s.vatRateBp)} %)` : ""} · <strong>TTC {formatEuro(s.totalTTCCents)}</strong></p>
          <p>Compte de charge : {s.expenseAccount ? `${s.expenseAccount.number} ${s.expenseAccount.label}` : "—"}</p>
          <p>Écriture : {posting ? <Link className="underline" href={`/comptabilite/ecritures/${posting.entryId}`}>{posting.entry.journal.code} n° {posting.entry.number}</Link> : "non générée"}</p>
          {s.paidAt && <p>Payée le {dateFr.format(s.paidAt)}</p>}{s.notes && <p className="sm:col-span-2 text-slate-600">{s.notes}</p>}
        </CardContent></Card>
      ) : (
        <SupplierInvoiceForm mode="edit" invoiceId={s.id} accounts={accounts.map((a) => ({ id: a.id, number: a.number, label: a.label }))}
          initial={{ supplierName: s.supplierName, siret: s.siret ?? "", number: s.number, date: s.date.toISOString().slice(0, 10), dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : "", totalHT: (Number(s.totalHTCents) / 100).toFixed(2), vat: (Number(s.vatCents) / 100).toFixed(2), totalTTC: (Number(s.totalTTCCents) / 100).toFixed(2), vatRate: s.vatRateBp !== null ? bpToPercentString(s.vatRateBp) : "", category: s.category ?? "", expenseAccountId: s.expenseAccountId ?? "", notes: s.notes ?? "" }}
          confidence={confidence} fileId={s.fileId} fileMime={s.file?.mime ?? null} />
      )}
      {s.file && <Card><CardContent className="p-4 text-sm"><p className="mb-2 font-medium text-slate-700">Pièce jointe</p><a className="underline" href={`/comptabilite/fournisseurs/${s.id}/fichier`} target="_blank" rel="noopener">{s.file.originalName} ({s.file.mime}, {Math.round(s.file.size / 1024)} Ko)</a>{s.ocrProvider && <p className="text-xs text-slate-500">Extraction : {s.ocrProvider}{(s.ocrRaw as { amountsAdjusted?: boolean } | null)?.amountsAdjusted ? " — montants ajustés (HT + TVA ≠ TTC lu)" : ""}</p>}</CardContent></Card>}
    </div>
  )
}
