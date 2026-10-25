import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { PAYMENT_METHOD_LABEL } from "@/lib/billing/invoices/invoice-schemas"
import { issueBlockers } from "@/lib/billing/invoices/invoice-c2.core"
import { linesAndTotals, fmtDate } from "@/lib/billing/pdf/document-data"
import { formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { InvoiceStatusBadge } from "@/components/factures/InvoiceStatusBadge"
import { InvoiceActions, ReversePaymentButton } from "@/components/factures/InvoiceActions"
import { PaymentDialog } from "@/components/factures/PaymentDialog"

export const metadata: Metadata = { title: "Facture" }
const MAIL_KIND: Record<string, string> = { INVOICE_SENT: "Envoi de la facture", CREDIT_NOTE_SENT: "Envoi de l'avoir", INVOICE_REMINDER_30: "Relance J+30", INVOICE_REMINDER_45: "Relance J+45", INVOICE_REMINDER_60: "Relance J+60", INVOICE_REMINDER_MANUAL: "Relance manuelle" }
const MAIL_STATUS: Record<string, string> = { SIMULATED: "simulé (envoi désactivé)", SENT: "envoyé", FAILED: "échec" }
const dateTimeFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })

export default async function FactureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const inv = await getInvoiceDetail(prisma, ctx.companyId, id)
  if (!inv) notFound()
  const { pdfLines, totals } = linesAndTotals(inv.lines, inv.globalDiscountBp, inv.vatReverseCharge)
  const blockers = inv.status === "DRAFT" && inv.kind !== "CREDIT_NOTE" ? issueBlockers({ company: inv.company, client: inv.client, lineCount: inv.lines.length }) : []
  const progress = inv.status === "PAID" ? 100 : inv.totalTTCCents > BigInt(0) ? Number((inv.paidCents * BigInt(100)) / inv.totalTTCCents) : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-500"><Link href="/factures" className="hover:underline">Factures</Link> / {inv.number}</p>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900">{inv.number} <InvoiceStatusBadge status={inv.status} kind={inv.kind} overdue={inv.overdue} /></h1>
          {inv.subject && <p className="text-slate-600">{inv.subject}</p>}
        </div>
        <InvoiceActions id={inv.id} status={inv.status} kind={inv.kind} hasEmail={!!inv.client.email} payable={inv.payable} hasQuote={!!inv.quoteId} />
      </div>
      {blockers.length > 0 && <Card className="border-amber-300"><CardContent className="p-4 text-sm text-amber-800"><p className="font-medium">Avant émission, corrigez :</p><ul className="list-disc pl-5">{blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul></CardContent></Card>}

      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Client</p><p className="font-medium">{inv.client.name}</p><p className="text-slate-600">{inv.client.email ?? "aucun e-mail"}</p>{inv.client.address && <p className="text-slate-600">{inv.client.address}</p>}<p className="mt-2 text-xs uppercase text-slate-500">Chantier</p><p>{inv.worksite.name}</p>{inv.quote && <p className="text-xs">Devis <Link className="underline" href={`/devis/${inv.quote.id}`}>{inv.quote.number}</Link></p>}</CardContent></Card>
        <Card><CardContent className="p-4 text-sm"><p className="text-xs uppercase text-slate-500">Dates</p><p>{inv.status === "DRAFT" ? "Non émise (numéro provisoire)" : `Émise le ${fmtDate(inv.issueDate)}`}</p>{inv.kind !== "CREDIT_NOTE" && <p>Échéance {fmtDate(inv.dueDate)}{inv.overdue ? <span className="ml-1 font-medium text-red-600">— en retard</span> : null}</p>}{inv.paidAt && <p className="text-green-700">Soldée le {fmtDate(inv.paidAt)}</p>}{inv.creditedInvoice && <p>Avoir sur la facture <Link className="underline" href={`/factures/${inv.creditedInvoice.id}`}>{inv.creditedInvoice.number}</Link></p>}{inv.creditNotes.length > 0 && <p>Avoirs : {inv.creditNotes.map((c) => <Link key={c.id} className="underline" href={`/factures/${c.id}`}>{c.number}</Link>)}</p>}</CardContent></Card>
        <Card><CardContent className="p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Paiement</p>
          {inv.kind === "CREDIT_NOTE" ? <p className="text-slate-500">Avoir : aucun paiement attendu.</p> : inv.status === "DRAFT" || inv.status === "CANCELLED" ? <p className="text-slate-500">—</p> : (
            <>
              <div className="mt-1 h-2 w-full overflow-hidden rounded bg-slate-200" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-2 bg-green-600" style={{ width: `${Math.min(100, progress)}%` }} /></div>
              <p className="mt-1 tabular-nums">Payé {formatEuro(inv.paidCents)} / {formatEuro(inv.totalTTCCents)} — reste <strong>{formatEuro(inv.remainingCents)}</strong>{inv.settledOutside && <span className="ml-1 text-xs text-slate-500">(règlement constaté hors module)</span>}</p>
              {inv.payable && <div className="mt-2"><PaymentDialog invoiceId={inv.id} remaining={formatEuro(inv.remainingCents).replace(" €", "").replace(/ /g, "")} /></div>}
            </>
          )}
          {inv.vatReverseCharge && <p className="mt-2 font-medium text-amber-700">Autoliquidation de la TVA</p>}
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2 text-right">Qté</th><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">Remise</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">Total HT</th></tr></thead>
          <tbody>{pdfLines.map((l, i) => <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}{l.description && <div className="text-xs text-slate-500">{l.description}</div>}</td><td className="px-3 py-2">{l.unit}</td><td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td><td className="px-3 py-2 text-right tabular-nums">{l.unitPrice}</td><td className="px-3 py-2 text-right">{l.discount}</td><td className="px-3 py-2 text-right">{l.vatRate}</td><td className="px-3 py-2 text-right tabular-nums">{l.lineHT}</td></tr>)}</tbody>
        </table>
        <div className="flex justify-end border-t p-4"><dl className="w-72 space-y-1 text-sm tabular-nums">
          <div className="flex justify-between"><dt>Sous-total HT</dt><dd>{totals.subtotal}</dd></div>
          {totals.globalDiscount && <div className="flex justify-between text-slate-500"><dt>{totals.globalDiscountLabel}</dt><dd>{totals.globalDiscount}</dd></div>}
          <div className="flex justify-between font-medium"><dt>Total HT</dt><dd>{totals.totalHT}</dd></div>
          {totals.vat.map((v) => <div key={v.label} className="flex justify-between text-slate-600"><dt>{v.label} (base {v.base})</dt><dd>{v.amount}</dd></div>)}
          <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total TTC</dt><dd>{totals.totalTTC}</dd></div>
        </dl></div>
      </CardContent></Card>

      {inv.payments.length > 0 && <Card><CardContent className="p-4 text-sm">
        <p className="mb-2 font-medium text-slate-700">Paiements</p>
        <table className="w-full"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Date</th><th className="py-1">Mode</th><th className="py-1">Référence</th><th className="py-1 text-right">Montant</th><th className="py-1"></th></tr></thead>
          <tbody>{inv.payments.map((p) => <tr key={p.id} className={`border-t ${p.reversedAt ? "text-slate-400 line-through" : ""}`}><td className="py-1">{fmtDate(p.paidAt)}</td><td className="py-1">{PAYMENT_METHOD_LABEL[p.method] ?? p.method}{p.reversesPaymentId ? " (annulation)" : ""}</td><td className="py-1">{p.reference ?? p.notes ?? ""}</td><td className="py-1 text-right tabular-nums">{formatEuro(p.amountCents)}</td><td className="py-1 text-right">{!p.reversedAt && !p.reversesPaymentId && inv.status !== "CANCELLED" ? <ReversePaymentButton paymentId={p.id} /> : null}</td></tr>)}</tbody></table>
      </CardContent></Card>}

      {inv.depositDeductions.length > 0 && <Card><CardContent className="p-4 text-sm"><p className="mb-1 font-medium text-slate-700">Acomptes déduits</p><ul className="space-y-1">{inv.depositDeductions.map((d) => <li key={d.depositInvoiceId} className="flex justify-between"><Link className="underline" href={`/factures/${d.depositInvoiceId}`}>{d.deposit.number} du {fmtDate(d.deposit.issueDate)}</Link><span className="tabular-nums">−{formatEuro(d.amountTTCCents)} TTC</span></li>)}</ul></CardContent></Card>}
      {(inv.notes || inv.paymentTerms) && <Card><CardContent className="p-4 text-sm">{inv.paymentTerms && <p><span className="font-medium">Conditions de paiement :</span> {inv.paymentTerms}</p>}{inv.notes && <p className="mt-1 whitespace-pre-line text-slate-600">{inv.notes}</p>}</CardContent></Card>}
      <Card><CardContent className="p-4 text-sm"><p className="mb-2 font-medium text-slate-700">Courriers et relances</p>
        <p className="text-xs text-slate-500">Relances automatiques : {[inv.reminderDue30SentAt && "J+30", inv.reminderDue45SentAt && "J+45", inv.reminderDue60SentAt && "J+60"].filter(Boolean).join(", ") || "aucune"}</p>
        {inv.mails.length === 0 ? <p className="text-slate-400">Aucun courrier.</p> : <ul className="space-y-1">{inv.mails.map((m) => <li key={m.id} className="flex flex-wrap justify-between gap-2"><span>{MAIL_KIND[m.kind] ?? m.kind} → {m.to}</span><span className={m.status === "FAILED" ? "text-red-600" : "text-slate-500"}>{MAIL_STATUS[m.status] ?? m.status} · {dateTimeFr.format(m.createdAt)}</span></li>)}</ul>}
      </CardContent></Card>
    </div>
  )
}
