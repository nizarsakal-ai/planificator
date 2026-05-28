"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Check, X, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { updateAbsenceStatus, deleteAbsence } from "@/lib/actions/absence.actions"

interface Props { absenceId: string; status: string }

export function AbsenceActions({ absenceId, status }: Props) {
  const [loading,      setLoading]      = useState(false)
  const [rejectOpen,   setRejectOpen]   = useState(false)
  const [refusalNote,  setRefusalNote]  = useState("")
  const router = useRouter()

  const handleApprove = async () => {
    setLoading(true)
    const result = await updateAbsenceStatus(absenceId, "APPROVED")
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Absence approuvée.")
    router.refresh()
  }

  const handleReject = async () => {
    if (!refusalNote.trim()) { toast.error("Le motif de refus est requis."); return }
    setLoading(true)
    const result = await updateAbsenceStatus(absenceId, "REJECTED", refusalNote.trim())
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Absence refusée.")
    setRejectOpen(false)
    setRefusalNote("")
    router.refresh()
  }

  const handleDelete = async () => {
    setLoading(true)
    const result = await deleteAbsence(absenceId)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Absence supprimée.")
    router.refresh()
  }

  return (
    <>
      <div className="flex items-center gap-1">
        {status === "PENDING" && (
          <>
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7 text-green-600 hover:bg-green-50"
              disabled={loading}
              onClick={handleApprove}
              title="Approuver"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-4 w-4" />}
            </Button>
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7 text-red-500 hover:bg-red-50"
              disabled={loading}
              onClick={() => setRejectOpen(true)}
              title="Refuser"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
        <Button
          size="icon" variant="ghost"
          className="h-7 w-7 text-slate-400 hover:bg-slate-100"
          disabled={loading}
          onClick={handleDelete}
          title="Supprimer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Dialog refus */}
      <Dialog open={rejectOpen} onOpenChange={(v) => { setRejectOpen(v); if (!v) setRefusalNote("") }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Motif du refus</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-sm">Expliquez la raison du refus *</Label>
              <Textarea
                value={refusalNote}
                onChange={(e) => setRefusalNote(e.target.value)}
                placeholder="Ex : Trop d'absences déjà prévues cette semaine…"
                rows={3}
                className="resize-none text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 h-9 text-sm" onClick={() => setRejectOpen(false)}>
                Annuler
              </Button>
              <Button
                className="flex-1 h-9 text-sm bg-red-500 hover:bg-red-600 text-white"
                disabled={loading || !refusalNote.trim()}
                onClick={handleReject}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Confirmer le refus
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
