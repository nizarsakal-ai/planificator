"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { CheckCircle, XCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { updateAssignmentStatus } from "@/lib/actions/chantier.actions"

interface Props {
  assignmentId: string
}

export function AssignmentActions({ assignmentId }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [showRefuse, setShowRefuse] = useState(false)
  const [reason, setReason]         = useState("")
  const [loading, setLoading]       = useState(false)

  const handleConfirm = () => {
    setLoading(true)
    startTransition(async () => {
      const res = await updateAssignmentStatus(assignmentId, "CONFIRMED")
      setLoading(false)
      if (res?.error) { toast.error(res.error) } else {
        toast.success("Affectation confirmée.")
        router.refresh()
      }
    })
  }

  const handleRefuse = () => {
    if (!reason.trim()) { toast.error("La raison est obligatoire."); return }
    setLoading(true)
    startTransition(async () => {
      const res = await updateAssignmentStatus(assignmentId, "REFUSED", reason)
      setLoading(false)
      if (res?.error) { toast.error(res.error) } else {
        toast.success("Affectation refusée.")
        setShowRefuse(false)
        setReason("")
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-2 mt-3">
      {!showRefuse ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 bg-green-600 hover:bg-green-700 text-white h-8 text-xs"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Confirmer</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 border-red-200 text-red-500 hover:bg-red-50 h-8 text-xs"
            onClick={() => setShowRefuse(true)}
            disabled={loading}
          >
            <XCircle className="h-3.5 w-3.5" />
            <span className="ml-1.5">Refuser</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-2 p-3 bg-red-50 rounded-lg border border-red-100">
          <p className="text-xs font-medium text-red-700">Raison du refus *</p>
          <Input
            placeholder="Expliquez pourquoi..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-8 text-xs"
            autoFocus
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 bg-red-500 hover:bg-red-600 text-white h-8 text-xs"
              onClick={handleRefuse}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirmer le refus"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => { setShowRefuse(false); setReason("") }}
              disabled={loading}
            >
              Annuler
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
