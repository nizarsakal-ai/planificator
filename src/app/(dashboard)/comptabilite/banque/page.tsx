import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { requireAccountingPage, dateFr } from "@/lib/accounting/ui/page-context"
import { searchParam } from "@/lib/accounting/ui/labels"
import { listBankTransactions, matchCandidates } from "@/lib/accounting/c5/bank.service"
import { formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BankImportDialog } from "@/components/comptabilite/BankImportDialog"
import { AutoReconcileButton, CollisionButtons, MatchButtons } from "@/components/comptabilite/C5Actions"
import { BankAccountCard, type BankAccountCardProps } from "@/components/comptabilite/BankAccountCard"
import { isBankAccountVerificationEnabled } from "@/lib/invoice-import/invoice-import-feature-flag"
import { bankFailureLabel, getBankAccountPanel } from "@/lib/bank-verification/bank-account.service"
import { PROVIDER_BLOCKED_MESSAGE, resolveBankVerificationProvider } from "@/lib/bank-verification/provider"

export const metadata: Metadata = { title: "Comptabilité — Banque et rapprochement" }
const STATUS: Record<string, string> = { PENDING: "À rapprocher", MATCHED: "Rapprochée", IGNORED: "Ignorée" }
// SPEC-BANK-VERIF-001 : message affiché au retour du parcours (le statut réel vient toujours de la base, jamais de ce paramètre).
const VERIFICATION_NOTICE: Record<string, NonNullable<BankAccountCardProps["notice"]>> = {
  ok: { tone: "ok", text: "Le prestataire a confirmé le compte." },
  echec: { tone: "error", text: "La vérification n’a pas abouti." },
  attente: { tone: "warn", text: "Le prestataire n’a pas encore répondu. Relancez la vérification plus tard." },
  invalide: { tone: "error", text: "Lien de vérification invalide ou expiré : relancez la vérification." },
  indisponible: { tone: "warn", text: "Vérification indisponible." },
  erreur: { tone: "error", text: "Erreur pendant la vérification. Réessayez." },
}

export default async function BanquePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAccountingPage()
  const sp = await searchParams
  const st = searchParam(sp.statut)
  const status = st === "PENDING" || st === "MATCHED" || st === "IGNORED" ? st : "PENDING"
  const list = await listBankTransactions(prisma, ctx, { status, page: Number(searchParam(sp.page) ?? 1) || 1 })
  const candidates = status === "PENDING" ? await Promise.all(list.rows.slice(0, 50).map((r) => matchCandidates(prisma, ctx, r.id))) : []
  // SPEC-BANK-VERIF-001 : drapeau OFF ⇒ page strictement identique à avant.
  let bankCard: BankAccountCardProps | null = null
  if (isBankAccountVerificationEnabled()) {
    const { account, companyName } = await getBankAccountPanel(prisma, ctx)
    const provider = resolveBankVerificationProvider()
    bankCard = {
      account: account ? { ibanMasked: account.ibanMasked, holderName: account.holderName, status: account.status, provider: account.provider === "sandbox" ? "le simulateur d’essai (non probant)" : account.provider, verifiedAt: account.verifiedAt ? dateFr.format(account.verifiedAt) : null, verifiedHolderName: account.verifiedHolderName, failureLabel: bankFailureLabel(account.failureCode), version: account.version, differsFromInvoiceIban: account.differsFromInvoiceIban } : null,
      defaultHolder: companyName, providerBlocked: provider.ok ? null : PROVIDER_BLOCKED_MESSAGE[provider.reason], notice: VERIFICATION_NOTICE[searchParam(sp.verification) ?? ""] ?? null,
    }
  }
  return (
    <div className="space-y-4">
      {bankCard && <BankAccountCard {...bankCard} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2 text-sm">{(["PENDING", "MATCHED", "IGNORED"] as const).map((s) => <Link key={s} href={`/comptabilite/banque?statut=${s}`} className={`rounded-md px-3 py-1.5 ${status === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>{STATUS[s]} ({list.counts[s] ?? 0})</Link>)}</div>
        <div className="flex gap-2"><BankImportDialog /><AutoReconcileButton /></div>
      </div>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Libellé</th><th className="px-3 py-2 text-right">Montant</th><th className="px-3 py-2">Rapprochement</th></tr></thead>
          <tbody>
            {list.rows.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">Aucune opération. Importez un relevé CSV.</td></tr>}
            {list.rows.map((r, i) => { const c = candidates[i]; return (
              <tr key={r.id} className="border-t align-top">
                <td className="px-3 py-2">{dateFr.format(r.date)}</td>
                <td className="px-3 py-2">{r.label}{r.reference && <div className="text-xs text-slate-400">réf. {r.reference}</div>}{r.externalId && <div className="text-xs text-slate-400">id banque {r.externalId}</div>}{r.collisionOfId && !r.collisionResolution && <div className="text-xs text-amber-700">Collision d’identité : tuple identique à une opération déjà importée{r.collisionOf ? ` (relevé ${r.collisionOf.import.fileName}, occurrence ${r.collisionOf.occurrence})` : ""} — relevés qui se chevauchent ou second mouvement réel ? Décision explicite requise avant tout rapprochement.</div>}{r.collisionResolution && <div className="text-xs text-slate-500">Collision résolue : {r.collisionResolution === "DUPLICATE" ? "doublon" : "opération distincte"}.</div>}{r.identityAmbiguous && !(r.collisionOfId && !r.collisionResolution) && <div className="text-xs text-amber-700">Identité ambiguë (opération n° {r.occurrence} d’un même tuple dans le relevé) : rapprochement manuel uniquement.</div>}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${r.amountCents < BigInt(0) ? "text-red-700" : "text-green-700"}`}>{formatEuro(r.amountCents)}</td>
                <td className="px-3 py-2">
                  {r.status === "MATCHED" && (r.matchedInvoice ? <Link className="underline" href={`/factures/${r.matchedInvoice.id}`}>Facture {r.matchedInvoice.number}</Link> : r.matchedSupplierInvoice ? <span>Fournisseur {r.matchedSupplierInvoice.supplierName} — {r.matchedSupplierInvoice.number}</span> : "Rapprochée")}
                  {r.status === "IGNORED" && <span className="text-slate-500">Ignorée{r.notes ? ` — ${r.notes}` : ""}</span>}
                  {r.status === "PENDING" && r.collisionOfId && !r.collisionResolution && <CollisionButtons transactionId={r.id} importId={r.importId} />}
                  {r.status === "PENDING" && !(r.collisionOfId && !r.collisionResolution) && c && <MatchButtons transactionId={r.id} invoices={c.invoices.slice(0, 20).map((x) => ({ id: x.id, number: x.number, label: `${x.clientName} · reste ${formatEuro(x.remainingCents)}${x.exact ? " ✓" : ""}` }))} supplierInvoices={c.supplierInvoices.slice(0, 20).map((x) => ({ id: x.id, number: x.number, label: `${x.supplierName} · ${formatEuro(x.totalTTCCents)}${x.exact ? " ✓" : ""}` }))} />}
                </td>
              </tr>) })}
          </tbody></table>
        {list.total > list.pageSize && <div className="flex justify-between border-t px-3 py-2 text-sm"><span>Page {list.page} / {Math.ceil(list.total / list.pageSize)}</span><div className="flex gap-2">{list.page > 1 && <Button variant="link" asChild><Link href={`/comptabilite/banque?statut=${status}&page=${list.page - 1}`}>Précédente</Link></Button>}{list.page * list.pageSize < list.total && <Button variant="link" asChild><Link href={`/comptabilite/banque?statut=${status}&page=${list.page + 1}`}>Suivante</Link></Button>}</div></div>}
      </CardContent></Card>
    </div>
  )
}
