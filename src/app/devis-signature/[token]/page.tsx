// Page PUBLIQUE de signature d'un devis : aucune session ; le jeton (haché en base) est la seule autorité.
// 404 si le module est désactivé, le jeton invalide/inconnu ; aucune autre donnée de la société n'est exposée.
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { getQuoteForSignature } from "@/lib/billing/quotes/quote.service"
import { linesAndTotals, fmtDate } from "@/lib/billing/pdf/document-data"
import { SignatureForm } from "@/components/devis/SignatureForm"

export const metadata: Metadata = { title: "Signature de devis", robots: { index: false, follow: false } }
export const dynamic = "force-dynamic"

export default async function SignaturePage({ params }: { params: Promise<{ token: string }> }) {
  if (!isBillingCompleteEnabled()) notFound()
  const { token } = await params
  const q = await getQuoteForSignature(prisma, token, new Date())
  if (!q) notFound()
  if (!q.signable) {
    return (
      <div className="min-h-screen bg-slate-50 p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="rounded-lg bg-[#0f3460] p-5 text-white"><p className="text-sm opacity-80">{q.company.name}</p><h1 className="text-xl font-semibold">Devis {q.number}</h1></div>
          <div className="rounded-lg border bg-white p-4 text-sm">
            {q.status === "ACCEPTED" && <p className="text-green-700">Devis accepté{q.signerName ? ` par ${q.signerName}` : ""} le {fmtDate(q.signedAt ?? q.issueDate)}. Merci !</p>}
            {q.status === "REFUSED" && <p className="text-red-600">Devis refusé le {fmtDate(q.refusedAt)}.</p>}
            {q.status === "EXPIRED" && <p className="text-amber-700">Ce devis a expiré. Contactez {q.company.name} pour un nouveau devis.</p>}
            {q.status === "CONVERTED" && <p className="text-green-700">Devis accepté et facturé.</p>}
            {q.status === "SENT" && <p className="text-amber-700">Ce lien de signature a expiré. Contactez {q.company.name} pour en recevoir un nouveau.</p>}
            {q.status === "DRAFT" && <p className="text-slate-500">Ce devis n&apos;est pas encore disponible.</p>}
          </div>
        </div>
      </div>
    )
  }
  const { pdfLines, totals } = linesAndTotals(q.lines, q.globalDiscountBp, q.vatReverseCharge)

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="rounded-lg bg-[#0f3460] p-5 text-white"><p className="text-sm opacity-80">{q.company.name}</p><h1 className="text-xl font-semibold">Devis {q.number}</h1>{q.subject && <p className="opacity-90">{q.subject}</p>}</div>
        <div className="rounded-lg border bg-white p-4 text-sm">
          <p>Client : <strong>{q.client.name}</strong> · Émis le {fmtDate(q.issueDate)} · Valable jusqu&apos;au {fmtDate(q.validUntil)}</p>
          {q.company.address && <p className="text-slate-500">{q.company.name} — {q.company.address}{q.company.siret ? ` — SIRET ${q.company.siret}` : ""}</p>}
        </div>
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2 text-right">Qté</th><th className="px-3 py-2 text-right">PU HT</th><th className="px-3 py-2 text-right">TVA</th><th className="px-3 py-2 text-right">Total HT</th></tr></thead>
            <tbody>{pdfLines.map((l, i) => <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}{l.description && <div className="text-xs text-slate-500">{l.description}</div>}{l.discount && <div className="text-xs text-slate-500">Remise {l.discount}</div>}</td><td className="px-3 py-2 text-right">{l.quantity} {l.unit}</td><td className="px-3 py-2 text-right">{l.unitPrice}</td><td className="px-3 py-2 text-right">{l.vatRate}</td><td className="px-3 py-2 text-right">{l.lineHT}</td></tr>)}</tbody>
          </table>
          <div className="flex justify-end border-t p-4"><dl className="w-72 space-y-1 text-sm">
            {totals.globalDiscount && <div className="flex justify-between text-slate-500"><dt>{totals.globalDiscountLabel}</dt><dd>{totals.globalDiscount}</dd></div>}
            <div className="flex justify-between"><dt>Total HT</dt><dd>{totals.totalHT}</dd></div>
            {totals.vat.map((v) => <div key={v.label} className="flex justify-between text-slate-600"><dt>{v.label}</dt><dd>{v.amount}</dd></div>)}
            <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total TTC</dt><dd>{totals.totalTTC}</dd></div>
          </dl></div>
        </div>
        {q.vatReverseCharge && <p className="text-sm text-amber-700">Autoliquidation — TVA due par le preneur (art. 283-2 nonies du CGI).</p>}
        {(q.paymentTerms || q.notes) && <div className="rounded-lg border bg-white p-4 text-sm">{q.paymentTerms && <p><strong>Conditions de paiement :</strong> {q.paymentTerms}</p>}{q.notes && <p className="mt-1 whitespace-pre-line text-slate-600">{q.notes}</p>}</div>}
        <SignatureForm token={token} />
      </div>
    </div>
  )
}
