"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createExpenseReport } from "@/lib/actions/expense.actions"

const CATEGORIES = [
  { value: "TRANSPORT",   label: "Transport / Carburant" },
  { value: "REPAS",       label: "Repas / Restauration" },
  { value: "HEBERGEMENT", label: "Hébergement" },
  { value: "MATERIEL",    label: "Matériel / Fournitures" },
  { value: "OTHER",       label: "Autre" },
]

export function NotesDeFraisForm() {
  const router = useRouter()
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    const result = await createExpenseReport(fd)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Note de frais soumise.")
    setOpen(false)
    ;(e.target as HTMLFormElement).reset()
    router.refresh()
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="bg-[#0f3460] hover:bg-[#0f3460]/90 text-white gap-1.5">
        <Plus className="h-4 w-4" />
        Nouvelle note de frais
      </Button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-semibold text-slate-900">Nouvelle note de frais</h2>
          <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Date *</Label>
              <Input name="date" type="date" required defaultValue={new Date().toISOString().split("T")[0]} className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Montant (€) *</Label>
              <Input name="amount" type="number" step="0.01" min="0.01" placeholder="0.00" required className="h-9 text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Catégorie *</Label>
            <select name="category" required className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Description *</Label>
            <textarea
              name="description"
              required
              placeholder="Détail de la dépense..."
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={loading} className="flex-1 bg-[#0f3460] hover:bg-[#0f3460]/90 text-white">
              {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Envoi…</> : "Soumettre"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
