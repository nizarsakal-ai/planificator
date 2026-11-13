"use client"
// Compte bancaire de la société (SPEC-BANK-VERIF-001) : saisie de l'IBAN et lancement de la liaison. Le badge « Vérifié » reflète
// uniquement le statut enregistré par le serveur après confirmation du prestataire.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { sandboxBankOutcomeAction, saveBankAccountAction, startBankVerificationAction } from "@/lib/actions/bank-account.actions"

export interface BankAccountCardProps {
  account: { ibanMasked: string; holderName: string; status: "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED"; provider: string | null; verifiedAt: string | null; verifiedHolderName: string | null; failureLabel: string; version: number; differsFromInvoiceIban: boolean } | null
  defaultHolder: string
  providerBlocked: string | null
  notice: { tone: "ok" | "warn" | "error"; text: string } | null
}
const BADGE: Record<string, { label: string; className: string }> = {
  VERIFIED: { label: "Vérifié", className: "bg-green-100 text-green-800" }, PENDING: { label: "Vérification en cours", className: "bg-amber-100 text-amber-800" },
  FAILED: { label: "Vérification échouée", className: "bg-red-100 text-red-700" }, UNVERIFIED: { label: "Non vérifié", className: "bg-slate-100 text-slate-600" },
}

export function BankAccountCard({ account, defaultHolder, providerBlocked, notice }: BankAccountCardProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(account === null)
  const [iban, setIban] = useState("")
  const [holder, setHolder] = useState(account?.holderName ?? defaultHolder)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const r = await saveBankAccountAction({ iban, holderName: holder, version: account?.version ?? null })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Compte bancaire enregistré.")
      setEditing(false); setIban(""); router.refresh()
    } finally { setBusy(false) }
  }
  async function verify() {
    setBusy(true)
    try {
      const r = await startBankVerificationAction()
      if (!r.ok) { toast.error(r.error); router.refresh(); return }
      window.location.assign(r.redirectUrl)
    } finally { setBusy(false) }
  }
  const badge = BADGE[account?.status ?? "UNVERIFIED"]

  return (
    <Card><CardContent className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">Compte bancaire de la société</h2>
        {account && <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{account.status === "VERIFIED" && <ShieldCheck className="h-3.5 w-3.5" />}{badge.label}</span>}
      </div>
      {notice && <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-green-50 text-green-800" : notice.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"}`}>{notice.text}</p>}
      {account && !editing && (
        <div className="space-y-1 text-sm">
          <p><span className="text-slate-500">IBAN :</span> <span className="font-mono">{account.ibanMasked}</span> · <span className="text-slate-500">Titulaire :</span> {account.holderName}</p>
          {account.status === "VERIFIED" && <p className="text-xs text-slate-500">Confirmé le {account.verifiedAt} par {account.provider}{account.verifiedHolderName ? ` (titulaire : ${account.verifiedHolderName})` : ""}.</p>}
          {account.status === "FAILED" && account.failureLabel && <p className="text-xs text-red-700">{account.failureLabel}</p>}
          {account.differsFromInvoiceIban && <p className="text-xs text-amber-700">L’IBAN imprimé sur vos factures (Factures → Paramètres) est différent de ce compte.</p>}
        </div>
      )}
      {editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor="bank-iban">IBAN</Label><Input id="bank-iban" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="FR76 …" autoComplete="off" spellCheck={false} maxLength={50} className="font-mono" /></div>
          <div><Label htmlFor="bank-holder">Titulaire du compte</Label><Input id="bank-holder" value={holder} onChange={(e) => setHolder(e.target.value)} maxLength={200} autoComplete="off" /></div>
          {account && <p className="text-xs text-amber-700 sm:col-span-2">Modifier l’IBAN remet le compte à « Non vérifié » : la vérification devra être refaite.</p>}
        </div>
      )}
      {providerBlocked && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{providerBlocked}</p>}
      <div className="flex flex-wrap gap-2">
        {editing ? <>
          <Button type="button" onClick={save} disabled={busy || !iban.trim() || !holder.trim()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          {account && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setIban("") }} disabled={busy}>Annuler</Button>}
        </> : <>
          <Button type="button" variant="outline" onClick={() => setEditing(true)} disabled={busy}>Modifier l’IBAN</Button>
          {account && !providerBlocked && <Button type="button" onClick={verify} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} {account.status === "VERIFIED" ? "Vérifier à nouveau" : "Lier et vérifier le compte"}</Button>}
        </>}
      </div>
    </CardContent></Card>
  )
}

const OUTCOMES: [string, string][] = [["CONFIRMED", "Compte confirmé (même IBAN, même titulaire)"], ["HOLDER_MISMATCH", "Confirmé mais titulaire différent"], ["OTHER_IBAN", "Confirmé mais autre IBAN"], ["REJECTED", "Refus / abandon du parcours"], ["PENDING", "Pas encore de réponse"]]
export function SandboxBankOutcome({ state }: { state: string }) {
  const [busy, setBusy] = useState(false)
  async function choose(outcome: string) {
    setBusy(true)
    try { const r = await sandboxBankOutcomeAction(state, outcome); if (!r.ok) toast.error(r.error); else window.location.assign(r.returnUrl) } finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2">{OUTCOMES.map(([v, l]) => <Button key={v} type="button" variant="outline" disabled={busy} onClick={() => choose(v)}>{l}</Button>)}</div>
}
