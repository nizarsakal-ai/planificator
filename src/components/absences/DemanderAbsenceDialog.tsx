"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { demanderAbsence } from "@/lib/actions/absence.actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Plus, Loader2 } from "lucide-react"

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

const today = new Date().toISOString().split("T")[0]

export function DemanderAbsenceDialog() {
  const router = useRouter()
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const fd     = new FormData(e.currentTarget)
    const result = await demanderAbsence(fd)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Demande soumise. En attente de validation.")
    setOpen(false)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0f3460]/90 text-white h-9 text-sm">
          <Plus className="h-4 w-4 mr-2" />
          Demander une absence
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Demande d&apos;absence</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="text-sm">Type d&apos;absence *</Label>
            <select
              name="type"
              defaultValue="VACATION"
              required
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0f3460]/30"
            >
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Début *</Label>
              <Input type="date" name="startDate" defaultValue={today} required className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Fin *</Label>
              <Input type="date" name="endDate" defaultValue={today} required className="h-9 text-sm" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">Motif <span className="text-slate-400">(optionnel)</span></Label>
            <Input name="reason" placeholder="Raison de la demande…" className="h-9 text-sm" />
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1 h-9 text-sm" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={loading} className="flex-1 h-9 bg-[#0f3460] hover:bg-[#0f3460]/90 text-white text-sm">
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Soumettre
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
