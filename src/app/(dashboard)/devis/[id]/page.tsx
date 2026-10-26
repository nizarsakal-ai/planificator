import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { getQuoteDetail } from "@/lib/billing/quotes/quote-queries"
import { linesAndTotals, fmtDate } from "@/lib/billing/pdf/document-data"
import { Card, CardContent } from "@/components/ui/card"
import { QuoteStatusBadge } from "@/components/devis/QuoteStatusBadge"
import { QuoteActions } from "@/components/devis/QuoteActions"
import { isQuoteValidAt } from "@/lib/billing/quotes/quote-validity"
import { ClientBillingIdsForm } from "@/components/devis/ClientBillingIdsForm"
import { DepositDialog } from "@/components/factures/DepositDialog"
import { InvoiceStatusBadge } from "@/components/factures/InvoiceStatusBadge"
import { listQuoteDeposits } from "@/lib/billing/invoices/deposit.service"
import { getBillingSettings } from "@/lib/billing/settings"
import { decimalToCents, formatEuro } from "@/lib/billing/money"

export const metadata: Metadata = { title: "Devis" }
const MAIL_KIND: Record<string, string> = { QUOTE_SENT: "Envoi du devis", QUOTE_REMINDER_J3: "Relance J+3", QUOTE_REMINDER_J7: "Relance J+7", QUOTE_REMINDER_J15: "Relance J+15" }
const MAIL_STATUS: Record<string, string> = { SIMULATED: "simulé (envoi désactivé)", SENT: "envoyé", FAILED: "échec" }
const dateTimeFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })

export default async function DevisDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBillingPage()
  const { id } = await params
  const q = await getQuoteDetail(prisma, ctx.companyId, id)
  if (!q) notFound()
  const { pdfLines, totals } = linesAndTotals(q.lines, q.globalDiscountBp, q.vatReverseCharge)
  const invoice = q.invoices.find((i) => i.kind === "INVOICE") ?? null
  const [deposits, settings] = await Promise.all([listQuoteDeposits(prisma, ctx.companyId, q.id), getBillingSettings(prisma, ctx.companyId)])
  const depositsTTC = deposits.filter((d) => d.status !== "CANCELLED").reduce((s, d) => s + d.ttcCents, BigInt(0))
  const depositRemaining = decimalToCents(q.totalTTC) - depositsTTC
  const finalIssued = !!invoice && invoice.status !== "DRAFT"
  const canDeposit = (q.status === "ACCEPTED" || q.status === "CONVERTED") && !finalIssued && depositRemaining > BigInt(0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-500"><Link href="/devis" className="hover:underline">Devis</Link> / {q.number}</p>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900">{q.number} <QuoteStatusBadge status={q.status} /></h1>
          {q.subject && <p className="text-slate-600">{q.subject}</p>}
        </div>
        <QuoteActions id={q.id} status={q.status} hasEmail={!!q.client.email} invoiceId={invoice?.id ?? null} validityExpired={!isQuoteValidAt(q.validUntil, new Date())} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Client</p>
          <p className="font-medium">{q.client.name}</p>
          <p className="text-slate-600">{q.client.email ?? "aucun e-mail"}</p>
          {q.client.address && <p className="text-slate-600">{q.client.address}</p>}
          <ClientBillingIdsForm clientId={q.client.id} siret={q.client.siret} vatNumber={q.client.vatNumber} />
          <p className="mt-2 text-xs uppercase text-slate-500">Chantier</p>
          <p>{q.worksite.name}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Dates</p>
          <p>Émis le {fmtDate(q.issueDate)}</p>
          <p>Valable jusqu&apos;au {fmtDate(q.validUntil)}</p>
          {q.sentAt && <p>Envoyé le {fmtDate(q.sentAt)}</p>}
          {q.acceptedAt && <p className="text-green-700">Accepté le {fmtDate(q.acceptedAt)}{q.signerName ? ` — ${q.signerName}` : ""}</p>}
          {q.refusedAt && <p className="text-red-600">Refusé le {fmtDate(q.refusedAt)}{q.refusalReason ? ` — ${q.refusalReason}` : ""}</p>}
          {q.expiredAt && <p className="text-amber-700">Expiré le {fmtDate(q.expiredAt)}</p>}
          {q.convertedAt && <p>Converti le {fmtDate(q.convertedAt)}{invoice ? <> — <Link className="underline" href={`/factures/${invoice.id}`}>{invoice.number}</Link></> : null}</p>}
        </CardContent></Card>
        <Card><CardContent className="p-4 text-sm">
          <p className="text-xs uppercase text-slate-500">Signature et relances</p>
          {q.status === "SENT" && <p>Lien de signature {q.signatureTokenExpiresAt && q.signatureTokenExpiresAt > new Date() ? `valable jusqu'au ${fmtDate(q.signatureTokenExpiresAt)}` : "expiré (renvoyer le devis)"}</p>}
          <p className="text-slate-600">Relances : {[q.reminderJ3SentAt && "J+3", q.reminderJ7SentAt && "J+7", q.reminderJ15SentAt && "J+15"].filter(Boolean).join(", ") || "aucune"}</p>
          {q.vatReverseCharge && <p className="mt-2 font-medium text-amber-700">Autoliquidation de la TVA</p>}
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2 text-right">Qté</th><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">Remise</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">Total HT</th></tr></thead>
          <tbody>{pdfLines.map((l, i) => (
            <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}{l.description && <div className="text-xs text-slate-500">{l.description}</div>}</td><td className="px-3 py-2">{l.unit}</td><td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td><td className="px-3 py-2 text-right tabular-nums">{l.unitPrice}</td><td className="px-3 py-2 text-right">{l.discount}</td><td className="px-3 py-2 text-right">{l.vatRate}</td><td className="px-3 py-2 text-right tabular-nums">{l.lineHT}</td></tr>
          ))}</tbody>
        </table>
        <div className="flex justify-end border-t p-4">
          <dl className="w-72 space-y-1 text-sm tabular-nums">
            <div className="flex justify-between"><dt>Sous-total HT</dt><dd>{totals.subtotal}</dd></div>
            {totals.globalDiscount && <div className="flex justify-between text-slate-500"><dt>{totals.globalDiscountLabel}</dt><dd>{totals.globalDiscount}</dd></div>}
            <div className="flex justify-between font-medium"><dt>Total HT</dt><dd>{totals.totalHT}</dd></div>
            {totals.vat.map((v) => <div key={v.label} className="flex justify-between text-slate-600"><dt>{v.label} (base {v.base})</dt><dd>{v.amount}</dd></div>)}
            <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total TTC</dt><dd>{totals.totalTTC}</dd></div>
          </dl>
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-slate-700">Acomptes</p>{canDeposit && <DepositDialog quoteId={q.id} defaultPercent={String(Math.round(settings.defaultDepositBp / 100))} remainingLabel={formatEuro(depositRemaining)} />}</div>
        {deposits.length === 0 ? <p className="mt-1 text-slate-400">Aucun acompte.</p> : (
          <ul className="mt-2 space-y-1">{deposits.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2"><span><Link className="underline" href={`/factures/${d.id}`}>{d.number}</Link>{d.depositBp ? ` (${d.depositBp / 100} %)` : ""} · <InvoiceStatusBadge status={d.status} /></span><span className="tabular-nums">{formatEuro(d.ttcCents)} TTC · payé {formatEuro(d.paidCents)}</span></li>)}</ul>
        )}
      </CardContent></Card>
      {(q.notes || q.paymentTerms) && <Card><CardContent className="p-4 text-sm">{q.paymentTerms && <p><span className="font-medium">Conditions de paiement :</span> {q.paymentTerms}</p>}{q.notes && <p className="mt-1 whitespace-pre-line text-slate-600">{q.notes}</p>}</CardContent></Card>}

      <Card><CardContent className="p-4 text-sm">
        <p className="mb-2 font-medium text-slate-700">Courriers</p>
        {q.mails.length === 0 ? <p className="text-slate-400">Aucun courrier.</p> : (
          <ul className="space-y-1">{q.mails.map((m) => <li key={m.id} className="flex flex-wrap justify-between gap-2"><span>{MAIL_KIND[m.kind] ?? m.kind} → {m.to}</span><span className={m.status === "FAILED" ? "text-red-600" : "text-slate-500"}>{MAIL_STATUS[m.status] ?? m.status} · {dateTimeFr.format(m.createdAt)}</span></li>)}</ul>
        )}
      </CardContent></Card>
    </div>
  )
}
