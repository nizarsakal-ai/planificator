"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { createPartialCreditNoteAction } from "@/lib/actions/credit-note.actions"

export interface CreditableLine { id: string; designation: string; quantity: string; unitPrice: string }

export function CreditNoteDialog({ invoiceId, lines, remainingLabel }: { invoiceId: string; lines: CreditableLine[]; remainingLabel: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<"LINES" | "AMOUNT_HT">("LINES")
  const [reason, setReason] = useState("")
  const [amount, setAmount] = useState("")
  const [qty, setQty] = useState<Record<string, string>>({})
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const r = await createPartialCreditNoteAction(invoiceId, mode === "LINES" ? { mode, reason, items: lines.map((l) => ({ lineId: l.id, quantity: qty[l.id] ?? "" })) } : { mode, reason, amount })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`Avoir ${r.number} émis${r.originStatus === "PAID" ? " — facture soldée" : ""}.`)
      setOpen(false); router.push(`/factures/${r.id}`); router.refresh()
    } catch { toast.error("Erreur serveur : avoir non émis.") } finally { setLoading(false) }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Avoir partiel</Button></DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Émettre un avoir partiel</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <p className="text-slate-600">Montant encore créditable : {remainingLabel}. L&apos;avoir est numéroté et émis immédiatement ; la facture d&apos;origine reste inchangée, son reste à payer est recalculé.</p>
          <div className="flex gap-3"><label className="flex items-center gap-1"><input type="radio" checked={mode === "LINES"} onChange={() => setMode("LINES")} /> Par lignes (quantités)</label><label className="flex items-center gap-1"><input type="radio" checked={mode === "AMOUNT_HT"} onChange={() => setMode("AMOUNT_HT")} /> Par montant HT</label></div>
          {mode === "LINES" ? (
            <div className="max-h-60 space-y-1 overflow-y-auto">{lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-2"><span className="truncate">{l.designation} <span className="text-slate-400">({l.quantity} × {l.unitPrice})</span></span><Input aria-label={`Quantité à créditer — ${l.designation}`} inputMode="decimal" className="h-8 w-24" placeholder="0" value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></div>
            ))}</div>
          ) : <div><Label htmlFor="cn-amount">Montant HT de l&apos;avoir (€)</Label><Input id="cn-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}
          <div><Label htmlFor="cn-reason">Motif *</Label><Input id="cn-reason" required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : prestation non réalisée, erreur de quantité" /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Émettre l&apos;avoir</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
