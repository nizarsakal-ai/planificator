"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { recordPaymentAction } from "@/lib/actions/invoice-c2.actions"
import { PAYMENT_METHOD_LABEL } from "@/lib/billing/invoices/invoice-schemas"

export function PaymentDialog({ invoiceId, remaining }: { invoiceId: string; remaining: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ amount: remaining, method: "TRANSFER", paidAt: new Date().toISOString().slice(0, 10), reference: "", notes: "" })

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const r = await recordPaymentAction(invoiceId, form)
      if (!r.ok) { toast.error(r.error); return }
      toast.success(r.status === "PAID" ? "Paiement enregistré : facture soldée." : "Paiement partiel enregistré.")
      setOpen(false); router.refresh()
    } catch { toast.error("Erreur serveur : paiement non enregistré.") } finally { setLoading(false) }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">Enregistrer un paiement</Button></DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Enregistrer un paiement</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div><Label htmlFor="amount">Montant (€) — reste à payer : {remaining}</Label><Input id="amount" inputMode="decimal" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <div><Label htmlFor="method">Mode de paiement</Label>
            <select id="method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div><Label htmlFor="paidAt">Date du paiement</Label><Input id="paidAt" type="date" required value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} /></div>
          <div><Label htmlFor="reference">Référence (n° de chèque, libellé bancaire…)</Label><Input id="reference" maxLength={100} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></div>
          <div><Label htmlFor="pnotes">Notes</Label><Input id="pnotes" maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
