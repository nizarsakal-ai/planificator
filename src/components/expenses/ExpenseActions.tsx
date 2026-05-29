"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, X, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { updateExpenseStatus, deleteExpenseReport } from "@/lib/actions/expense.actions"

interface Props {
  id: string
  status: string
  isAdmin: boolean
  isOwner: boolean
}

export function ExpenseActions({ id, status, isAdmin, isOwner }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState("")

  async function approve() {
    setLoading("approve")
    const result = await updateExpenseStatus(id, "APPROVED")
    setLoading(null)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Note de frais approuvée.")
    router.refresh()
  }

  async function reject() {
    if (!rejectNote.trim()) { toast.error("La raison du refus est obligatoire."); return }
    setLoading("reject")
    const result = await updateExpenseStatus(id, "REJECTED", rejectNote)
    setLoading(null)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Note de frais refusée.")
    setRejectOpen(false)
    router.refresh()
  }

  async function del() {
    if (!confirm("Supprimer cette note de frais ?")) return
    setLoading("delete")
    const result = await deleteExpenseReport(id)
    setLoading(null)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Supprimée.")
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1">
      {isAdmin && status === "PENDING" && (
        <>
          <Button
            variant="ghost" size="sm"
            onClick={approve}
            disabled={loading === "approve"}
            className="h-7 px-2 text-green-600 hover:text-green-700 hover:bg-green-50"
          >
            {loading === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={() => setRejectOpen(true)}
            className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
      {(isAdmin || isOwner) && (
        <Button
          variant="ghost" size="sm"
          onClick={del}
          disabled={loading === "delete"}
          className="h-7 px-2 text-slate-400 hover:text-red-500 hover:bg-red-50"
        >
          {loading === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      )}

      {/* Dialog refus */}
      {rejectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRejectOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-900 mb-3">Raison du refus</h3>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Expliquez la raison du refus..."
              rows={3}
              className="w-full rounded-md border border-input px-3 py-2 text-sm resize-none mb-3"
              autoFocus
            />
            <div className="flex gap-2">
              <Button onClick={reject} disabled={loading === "reject"} className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm">
                {loading === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refuser"}
              </Button>
              <Button variant="outline" onClick={() => setRejectOpen(false)} className="text-sm">Annuler</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
