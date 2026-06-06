"use client"

import { useState } from "react"
import { Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { deleteAssignmentBlock } from "@/lib/actions/chantier.actions"

interface Props {
  worksiteId: string
  teamId: string
  teamName: string
  startDate: string // YYYY-MM-DD
  endDate: string   // YYYY-MM-DD
  dayCount: number
}

export function DeleteAssignmentBlockButton({
  worksiteId,
  teamId,
  teamName,
  startDate,
  endDate,
  dayCount,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    setLoading(true)
    const result = await deleteAssignmentBlock(worksiteId, teamId, startDate, endDate)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Affectation supprimée.")
      setOpen(false)
      router.refresh()
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-slate-300 hover:text-red-500 transition-colors"
        title="Supprimer cette affectation"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer l'affectation</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            Voulez-vous supprimer l'affectation de{" "}
            <strong>{teamName}</strong> ({dayCount} jour{dayCount > 1 ? "s" : ""}) ?
            Cette action est irréversible.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
