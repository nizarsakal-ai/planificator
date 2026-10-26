"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { saveBillingSettingsAction } from "@/lib/actions/billing-settings.actions"

export interface BillingSettingsFormValues {
  vatNumber: string; legalForm: string; shareCapital: string; rcs: string; iban: string; bic: string; quoteValidityDays: number; paymentTermsDays: number
  latePenaltyText: string; quoteFooter: string; invoiceFooter: string; vatRegime: "DEBITS" | "ENCAISSEMENTS"; defaultDepositPercent: number
}

export function BillingSettingsForm({ initial, defaultPenalty }: { initial: BillingSettingsFormValues; defaultPenalty: string }) {
  const router = useRouter()
  const [v, setV] = useState(initial)
  const [loading, setLoading] = useState(false)
  const set = (k: keyof BillingSettingsFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value })
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const r = await saveBillingSettingsAction({ ...v, quoteValidityDays: Number(v.quoteValidityDays), paymentTermsDays: Number(v.paymentTermsDays), defaultDepositPercent: Number(v.defaultDepositPercent) })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Paramètres enregistrés."); router.refresh()
    } catch { toast.error("Erreur serveur.") } finally { setLoading(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <div><Label htmlFor="vatNumber">TVA intracommunautaire</Label><Input id="vatNumber" value={v.vatNumber} onChange={set("vatNumber")} placeholder="FR12345678901" /></div>
        <div><Label htmlFor="legalForm">Forme juridique</Label><Input id="legalForm" value={v.legalForm} onChange={set("legalForm")} placeholder="SAS, SARL, EI…" /></div>
        <div><Label htmlFor="shareCapital">Capital social</Label><Input id="shareCapital" value={v.shareCapital} onChange={set("shareCapital")} placeholder="10 000 €" /></div>
        <div><Label htmlFor="rcs">RCS / RM</Label><Input id="rcs" value={v.rcs} onChange={set("rcs")} placeholder="RCS Paris 123 456 789" /></div>
        <div><Label htmlFor="iban">IBAN</Label><Input id="iban" value={v.iban} onChange={set("iban")} /></div>
        <div><Label htmlFor="bic">BIC</Label><Input id="bic" value={v.bic} onChange={set("bic")} /></div>
      </CardContent></Card>
      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <div><Label htmlFor="quoteValidityDays">Validité des devis (jours)</Label><Input id="quoteValidityDays" type="number" min={1} max={365} value={v.quoteValidityDays} onChange={set("quoteValidityDays")} /></div>
        <div><Label htmlFor="paymentTermsDays">Délai de paiement (jours)</Label><Input id="paymentTermsDays" type="number" min={0} max={120} value={v.paymentTermsDays} onChange={set("paymentTermsDays")} /></div>
        <div><Label htmlFor="defaultDepositPercent">Acompte par défaut (%)</Label><Input id="defaultDepositPercent" type="number" min={1} max={100} value={v.defaultDepositPercent} onChange={set("defaultDepositPercent")} /></div>
        <div><Label htmlFor="vatRegime">Régime de TVA</Label>
          <select id="vatRegime" value={v.vatRegime} onChange={set("vatRegime")} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="DEBITS">TVA sur les débits</option><option value="ENCAISSEMENTS">TVA sur les encaissements</option></select></div>
        <div className="sm:col-span-2"><Label htmlFor="latePenaltyText">Mention pénalités de retard (vide = mention légale par défaut)</Label><Textarea id="latePenaltyText" value={v.latePenaltyText} onChange={set("latePenaltyText")} placeholder={defaultPenalty} /></div>
        <div><Label htmlFor="quoteFooter">Pied de page des devis</Label><Textarea id="quoteFooter" value={v.quoteFooter} onChange={set("quoteFooter")} /></div>
        <div><Label htmlFor="invoiceFooter">Pied de page des factures</Label><Textarea id="invoiceFooter" value={v.invoiceFooter} onChange={set("invoiceFooter")} /></div>
      </CardContent></Card>
      <div className="flex justify-end"><Button type="submit" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
    </form>
  )
}
