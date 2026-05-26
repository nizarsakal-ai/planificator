"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Check, X, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { updateAbsenceStatus, deleteAbsence } from "@/lib/actions/absence.actions"

interface Props { absenceId: string; status: string }

export function AbsenceActions({ absenceId, status }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handle = async (action: "approve" | "reject" | "delete") => {
    setLoading(true)
    let result
    if (action === "delete") {
      result = await deleteAbsence(absenceId)
    } else {
      result = await updateAbsenceStatus(absenceId, action === "approve" ? "APPROVED" : "REJECTED")
    }
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(action === "approve" ? "Absence approuvée." : action === "reject" ? "Absence refusée." : "Absence supprimée.")
      router.refresh()
    }
  }

  return (
    <div className="flex items-center gap-1">
      {status === "PENDING" && (
        <>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600 hover:bg-green-50" disabled={loading} onClick={() => handle("approve")}>
            <Check className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500 hover:bg-red-50" disabled={loading} onClick={() => handle("reject")}>
            <X className="h-4 w-4" />
          </Button>
        </>
      )}
      <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:bg-slate-100" disabled={loading} onClick={() => handle("delete")}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
