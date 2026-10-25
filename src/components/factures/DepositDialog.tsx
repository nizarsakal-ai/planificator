"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { createDepositAction } from "@/lib/actions/deposit.actions"

export function DepositDialog({ quoteId, defaultPercent, remainingLabel }: { quoteId: string; defaultPercent: string; remainingLabel: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<"PERCENT" | "AMOUNT_TTC">("PERCENT")
  const [value, setValue] = useState(defaultPercent)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const r = await createDepositAction(quoteId, { mode, value })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`Facture d'acompte ${r.number} créée (brouillon) : émettez-la depuis sa fiche.`)
      setOpen(false); router.push(`/factures/${r.id}`); router.refresh()
    } catch { toast.error("Erreur serveur : acompte non créé.") } finally { setLoading(false) }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Facture d&apos;acompte</Button></DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Créer une facture d&apos;acompte</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600">Montant encore facturable en acompte : {remainingLabel}. L&apos;acompte sera déduit automatiquement sur la facture de solde.</p>
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={mode === "PERCENT"} onChange={() => { setMode("PERCENT"); setValue(defaultPercent) }} /> Pourcentage du TTC</label>
            <label className="flex items-center gap-1"><input type="radio" checked={mode === "AMOUNT_TTC"} onChange={() => { setMode("AMOUNT_TTC"); setValue("") }} /> Montant TTC</label>
          </div>
          <div><Label htmlFor="dep">{mode === "PERCENT" ? "Pourcentage (%)" : "Montant TTC (€)"}</Label><Input id="dep" inputMode="decimal" required value={value} onChange={(e) => setValue(e.target.value)} /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Créer le brouillon</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
